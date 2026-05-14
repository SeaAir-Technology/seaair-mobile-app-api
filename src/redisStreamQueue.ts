/**
 * Redis Streams-backed message broker.
 *
 * Stream layout (one pair per controller):
 *   stream:fw2mobile:{controllerId}   firmware writes (heartbeat/status), mobile reads
 *   stream:mobile2fw:{controllerId}   mobile writes (commands),       firmware reads
 *
 * Plus a global firehose:
 *   stream:global:recent              every XADD to a per-controller stream
 *                                     also writes a small metadata record
 *                                     here so the dashboard can show the
 *                                     last N messages across all controllers
 *                                     in O(1) without scanning. MAXLEN ~ 200.
 *
 * Delivery:
 *   - Mobile -> FW commands consumed via Redis consumer group "fw" with
 *     XREADGROUP COUNT 1 / XACK. This preserves at-most-once delivery
 *     semantics matching the legacy in-memory FIFO behavior.
 *   - FW -> Mobile heartbeats read via XREVRANGE COUNT 1 (latest only),
 *     with an 11-minute freshness window applied based on the entry's
 *     stream id timestamp.
 *
 * Retention: MAXLEN ~ STREAM_MAXLEN on every per-controller XADD. ACK state
 * never trims stream history; the dashboard reads via XRANGE/XREVRANGE
 * independent of the consumer group.
 */

import { Redis } from 'ioredis';
import { IMessageBroker, Message, QueueStats } from './types';

const FRESHNESS_WINDOW_MS = 11 * 60 * 1000;
const FW_GROUP = 'fw';
const FIREHOSE_KEY = 'stream:global:recent';
const FIREHOSE_MAXLEN = 200;

type Direction = 'fw2mobile' | 'mobile2fw';

export interface FirehoseEntry {
  firehoseId: string;       // ID in stream:global:recent
  controllerId: number;
  direction: Direction;
  streamId: string;          // ID in the per-controller stream
  timestamp: string;         // ISO 8601
  senderType: 'mobile' | 'controller';
  authId?: string;
}

export interface MarkAllReceivedResult {
  controllerId: number;
  direction: Direction;
  pelAcked: number;          // pending-entries-list entries acknowledged
  skipped: number;            // undelivered entries skipped past via SETID
  cursorAdvancedTo: string;   // new last-delivered-id for the consumer group
  streamLength: number;       // total stream length after the operation
}

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
    this.maxLen = parseInt(process.env.STREAM_MAXLEN || '1000000', 10);
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

  /**
   * Best-effort write to the global firehose. Failures are logged but never
   * propagate -- losing a firehose entry doesn't block message delivery.
   */
  private async writeFirehose(
    direction: Direction,
    controllerId: number,
    streamId: string,
    message: Message
  ): Promise<void> {
    try {
      const fields = [
        'controllerId', String(controllerId),
        'direction', direction,
        'streamId', streamId,
        'timestamp', message.timestamp,
        'senderType', message.sender.type,
      ];
      if (message.sender.authId) {
        fields.push('authId', message.sender.authId);
      }
      await this.redis.xadd(FIREHOSE_KEY, 'MAXLEN', '~', FIREHOSE_MAXLEN, '*', ...fields);
    } catch (err: any) {
      console.warn(`[RedisBroker] Firehose write failed (non-fatal): ${err.message}`);
    }
  }

  async addMobileAppMessage(controllerId: number, message: Message): Promise<void> {
    const stream = streamKey('mobile2fw', controllerId);
    await this.ensureConsumerGroup(stream, FW_GROUP);
    const fields = this.serialize(message);
    const id = await this.redis.xadd(stream, 'MAXLEN', '~', this.maxLen, '*', ...fields);
    console.log(`[RedisBroker] XADD ${stream} -> ${id} (controller ${controllerId})`);
    await this.writeFirehose('mobile2fw', controllerId, id || '', message);
  }

  async addControllerMessage(controllerId: number, message: Message): Promise<void> {
    const stream = streamKey('fw2mobile', controllerId);
    const fields = this.serialize(message);
    const id = await this.redis.xadd(stream, 'MAXLEN', '~', this.maxLen, '*', ...fields);
    console.log(`[RedisBroker] XADD ${stream} -> ${id} (controller ${controllerId})`);
    await this.writeFirehose('fw2mobile', controllerId, id || '', message);
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

  /**
   * Mark every currently-queued message for a controller as already received.
   * Backs the dashboard's "Mark all received" button.
   *
   * Two things have to happen for a future XREADGROUP `>` call to come back
   * empty:
   *   1. Anything in the consumer group's pending-entries-list (PEL) gets
   *      explicitly XACK'd. PEL entries don't reappear under `>` reads but
   *      they stick around forever otherwise; cleaning them keeps Redis
   *      memory tidy and matches the user expectation of "the queue is
   *      empty after I clicked this".
   *   2. The group's last-delivered-id gets advanced to `$` (the latest
   *      entry). Any entries that were XADDed but never delivered to the
   *      consumer group are now skipped — the firmware will never see them.
   *
   * Both operations are idempotent. Calling twice in a row is harmless.
   * Direction defaults to mobile2fw because that's the only channel the
   * firmware drains via consumer group; fw2mobile is supported as an
   * argument for future symmetry but is effectively a no-op there.
   */
  async markAllReceived(
    controllerId: number,
    direction: Direction = 'mobile2fw'
  ): Promise<MarkAllReceivedResult> {
    const stream = streamKey(direction, controllerId);
    await this.ensureConsumerGroup(stream, FW_GROUP);

    // 1. Inspect the group cursor before we move it so we can report how
    //    many undelivered entries we just skipped. XINFO GROUPS returns a
    //    flat array of key/value pairs per group; we walk it to find ours.
    const groupsRaw = (await this.redis.xinfo('GROUPS', stream)) as any[];
    let lastDeliveredId = '0-0';
    if (Array.isArray(groupsRaw)) {
      for (const g of groupsRaw) {
        if (!Array.isArray(g)) continue;
        const obj: Record<string, any> = {};
        for (let i = 0; i < g.length; i += 2) obj[g[i]] = g[i + 1];
        if (obj.name === FW_GROUP) {
          lastDeliveredId = String(obj['last-delivered-id'] || '0-0');
          break;
        }
      }
    }

    // 2. Acknowledge anything sitting in the PEL. XPENDING summary returns
    //    [count, smallestId, greatestId, [[consumer, count]]]; we then
    //    enumerate ids via XPENDING <stream> <group> - + <count>.
    const summary = (await this.redis.xpending(stream, FW_GROUP)) as any;
    const pelCount = Array.isArray(summary) ? Number(summary[0]) : 0;
    let pelAcked = 0;
    if (pelCount > 0) {
      const details = (await this.redis.xpending(
        stream, FW_GROUP, '-', '+', pelCount
      )) as any[];
      if (Array.isArray(details) && details.length > 0) {
        const ids = details.map((d) => d[0]);
        pelAcked = (await this.redis.xack(stream, FW_GROUP, ...ids)) || 0;
      }
    }

    // 3. Count entries strictly after the previous cursor; that's how
    //    many undelivered messages we're about to skip. Range is
    //    exclusive on the low end via the `(<id>` parenthesis syntax.
    let skipped = 0;
    try {
      const skippedEntries = await this.redis.xrange(
        stream, `(${lastDeliveredId}`, '+'
      );
      skipped = Array.isArray(skippedEntries) ? skippedEntries.length : 0;
    } catch {
      skipped = 0;
    }

    // 4. Advance the cursor. After this, XREADGROUP `>` returns nothing
    //    until a fresh XADD lands.
    await this.redis.xgroup('SETID', stream, FW_GROUP, '$');

    // 5. Pull the new cursor + total stream length for reporting.
    const latest = await this.redis.xrevrange(stream, '+', '-', 'COUNT', 1);
    const cursorAdvancedTo =
      latest && latest.length > 0 ? (latest[0] as any)[0] : '0-0';
    const streamLength = await this.redis.xlen(stream);

    console.log(
      `[RedisBroker] markAllReceived ${stream} (controller ${controllerId}): ` +
        `pelAcked=${pelAcked} skipped=${skipped} cursorAdvancedTo=${cursorAdvancedTo} streamLength=${streamLength}`
    );

    return {
      controllerId,
      direction,
      pelAcked,
      skipped,
      cursorAdvancedTo,
      streamLength,
    };
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

  /**
   * Read the most recent N entries from the global firehose, newest first.
   * Used by the dashboard to show "last 100 messages across all devices".
   */
  async readFirehose(count: number): Promise<FirehoseEntry[]> {
    const entries = await this.redis.xrevrange(FIREHOSE_KEY, '+', '-', 'COUNT', count);
    return entries.map(([id, fields]: [string, string[]]) => {
      const obj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        obj[fields[i]] = fields[i + 1];
      }
      return {
        firehoseId: id,
        controllerId: parseInt(obj.controllerId, 10),
        direction: obj.direction as Direction,
        streamId: obj.streamId,
        timestamp: obj.timestamp,
        senderType: obj.senderType as 'mobile' | 'controller',
        ...(obj.authId ? { authId: obj.authId } : {}),
      };
    });
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
