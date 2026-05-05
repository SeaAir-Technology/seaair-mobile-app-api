/**
 * Redis Streams-backed message broker.
 *
 * Stream layout (one pair per controller):
 *   stream:fw2mobile:{controllerId}   firmware writes (heartbeat/status), mobile reads
 *   stream:mobile2fw:{controllerId}   mobile writes (commands),       firmware reads
 *
 * Delivery:
 *   - Mobile -> FW commands consumed via Redis consumer group "fw" with
 *     XREADGROUP COUNT 1 / XACK. This preserves at-most-once delivery
 *     semantics matching the legacy in-memory FIFO behavior.
 *   - FW -> Mobile heartbeats read via XREVRANGE COUNT 1 (latest only),
 *     with an 11-minute freshness window applied based on the entry's
 *     stream id timestamp.
 *
 * Retention: MAXLEN ~ STREAM_MAXLEN on every XADD. ACK state never trims
 * stream history; the dashboard reads via XRANGE/XREVRANGE independent
 * of the consumer group.
 */

import { Redis } from 'ioredis';
import { IMessageBroker, Message, QueueStats } from './types';

const FRESHNESS_WINDOW_MS = 11 * 60 * 1000;
const FW_GROUP = 'fw';

type Direction = 'fw2mobile' | 'mobile2fw';

function streamKey(direction: Direction, controllerId: number): string {
  return `stream:${direction}:${controllerId}`;
}

function fwConsumerName(): string {
  return `fw-${process.env.AWS_APPRUNNER_SERVICE_ID || process.env.HOSTNAME || 'instance'}`;
}

export class RedisStreamQueue implements IMessageBroker {
  private redis: Redis;
  private maxLen: number;
  private groupsEnsured: Set<string> = new Set();

  constructor(redis: Redis) {
    this.redis = redis;
    this.maxLen = parseInt(process.env.STREAM_MAXLEN || '100000', 10);
  }

  private serialize(message: Message): string[] {
    const fields: string[] = [
      'timestamp', message.timestamp,
      'senderType', message.sender.type,
      'senderIp', message.sender.ip,
      'controllerId', String(message.controllerId),
      'payload', message.protobufPayload
    ];
    if (message.sender.authId) {
      fields.push('authId', message.sender.authId);
    }
    return fields;
  }

  private deserialize(streamKeyName: string, id: string, fields: string[]): Message {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      obj[fields[i]] = fields[i + 1];
    }
    return {
      timestamp: obj.timestamp,
      sender: {
        type: (obj.senderType as 'mobile' | 'controller'),
        ip: obj.senderIp || 'unknown',
        ...(obj.authId ? { authId: obj.authId } : {})
      },
      controllerId: parseInt(obj.controllerId, 10),
      protobufPayload: obj.payload,
      streamId: id,
      streamKey: streamKeyName
    };
  }

  private async ensureConsumerGroup(stream: string, group: string): Promise<void> {
    const cacheKey = `${stream}::${group}`;
    if (this.groupsEnsured.has(cacheKey)) return;
    try {
      await this.redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
      console.log(`[RedisBroker] Consumer group created: ${stream} / ${group}`);
    } catch (err: any) {
      if (!(err && err.message && err.message.includes('BUSYGROUP'))) {
        throw err;
      }
    }
    this.groupsEnsured.add(cacheKey);
  }

  async addMobileAppMessage(controllerId: number, message: Message): Promise<void> {
    const stream = streamKey('mobile2fw', controllerId);
    await this.ensureConsumerGroup(stream, FW_GROUP);
    const fields = this.serialize(message);
    const id = await this.redis.xadd(stream, 'MAXLEN', '~', this.maxLen, '*', ...fields);
    console.log(`[RedisBroker] XADD ${stream} -> ${id} (controller ${controllerId})`);
  }

  async addControllerMessage(controllerId: number, message: Message): Promise<void> {
    const stream = streamKey('fw2mobile', controllerId);
    const fields = this.serialize(message);
    const id = await this.redis.xadd(stream, 'MAXLEN', '~', this.maxLen, '*', ...fields);
    console.log(`[RedisBroker] XADD ${stream} -> ${id} (controller ${controllerId})`);
  }

  async getMobileAppMessage(controllerId: number): Promise<Message | null> {
    const stream = streamKey('mobile2fw', controllerId);
    await this.ensureConsumerGroup(stream, FW_GROUP);
    const consumer = fwConsumerName();
    let result: any;
    try {
      result = await this.redis.xreadgroup(
        'GROUP', FW_GROUP, consumer,
        'COUNT', 1,
        'STREAMS', stream, '>'
      );
    } catch (err: any) {
      if (err && err.message && err.message.includes('NOGROUP')) return null;
      throw err;
    }
    if (!result || result.length === 0) return null;
    const entries = result[0][1];
    if (!entries || entries.length === 0) return null;
    const [id, fields] = entries[0];
    const msg = this.deserialize(stream, id, fields as string[]);
    await this.redis.xack(stream, FW_GROUP, id);
    console.log(`[RedisBroker] XREADGROUP+XACK ${stream} -> ${id} (controller ${controllerId})`);
    return msg;
  }

  async getControllerMessage(controllerId: number): Promise<Message | null> {
    const stream = streamKey('fw2mobile', controllerId);
    const entries = await this.redis.xrevrange(stream, '+', '-', 'COUNT', 1);
    if (!entries || entries.length === 0) return null;
    const [id, fields] = entries[0];
    const msg = this.deserialize(stream, id, fields as string[]);
    const tsMs = parseInt(id.split('-')[0], 10);
    if (Date.now() - tsMs > FRESHNESS_WINDOW_MS) {
      console.log(`[RedisBroker] Latest heartbeat for controller ${controllerId} is stale (${Date.now() - tsMs}ms)`);
      return null;
    }
    return msg;
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.redis.ping();
      return r === 'PONG';
    } catch {
      return false;
    }
  }

  async listStreamKeys(): Promise<string[]> {
    const keys: string[] = [];
    for (const pattern of ['stream:fw2mobile:*', 'stream:mobile2fw:*']) {
      let cursor = '0';
      do {
        const [next, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        keys.push(...batch);
        cursor = next;
      } while (cursor !== '0');
    }
    return keys.sort();
  }

  async getStreamLength(controllerId: number, direction: Direction): Promise<number> {
    return await this.redis.xlen(streamKey(direction, controllerId));
  }

  async getStreamHistory(controllerId: number, direction: Direction, count: number): Promise<Message[]> {
    const stream = streamKey(direction, controllerId);
    const entries = await this.redis.xrevrange(stream, '+', '-', 'COUNT', count);
    return entries.map(([id, fields]: [string, string[]]) => this.deserialize(stream, id, fields));
  }

  async getStats(): Promise<QueueStats> {
    const keys = await this.listStreamKeys();
    let mobileAppMessages = 0;
    let controllerMessages = 0;
    const mobileAppControllers = new Set<string>();
    for (const key of keys) {
      const len = await this.redis.xlen(key);
      if (key.startsWith('stream:mobile2fw:')) {
        mobileAppMessages += len;
        mobileAppControllers.add(key.split(':')[2]);
      } else if (key.startsWith('stream:fw2mobile:') && len > 0) {
        controllerMessages += 1;
      }
    }
    return {
      mobileAppControllers: mobileAppControllers.size,
      mobileAppMessages,
      controllerMessages,
      brokerType: 'redis',
      redisConnected: this.redis.status === 'ready',
      totalStreams: keys.length
    };
  }

  async getAllQueueContents(): Promise<{ mobileAppQueue: Map<number, Message[]>; controllerQueue: Map<number, Message> }> {
    const mobileAppQueue = new Map<number, Message[]>();
    const controllerQueue = new Map<number, Message>();
    const keys = await this.listStreamKeys();
    for (const key of keys) {
      const parts = key.split(':');
      const direction = parts[1] as Direction;
      const controllerId = parseInt(parts[2], 10);
      if (Number.isNaN(controllerId)) continue;
      const entries = await this.redis.xrevrange(key, '+', '-', 'COUNT', 50);
      const messages = entries.map(([id, fields]: [string, string[]]) => this.deserialize(key, id, fields));
      if (direction === 'mobile2fw') {
        mobileAppQueue.set(controllerId, messages.reverse());
      } else if (messages.length > 0) {
        controllerQueue.set(controllerId, messages[0]);
      }
    }
    return { mobileAppQueue, controllerQueue };
  }

  async destroy(): Promise<void> {
    // Connection lifecycle owned by redisClient.ts; nothing to release here.
  }
}
