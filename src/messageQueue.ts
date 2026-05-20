/**
 * In-memory message broker implementation (legacy / fallback).
 * Implements IMessageBroker so it is hot-swappable with RedisStreamQueue
 * via the MESSAGE_BROKER env var.
 *
 * - Mobile app queue: Array of messages per controller (FIFO, drained on read)
 * - Controller queue: Single latest message per controller
 * - Messages expire after 11 minutes
 */

import { ControllerMessagesSinceResult, IMessageBroker, Message, QueueStats } from './types';

/**
 * Synthesize a Redis-Streams-style "<ms>-0" id from an ISO timestamp.
 * The in-memory broker doesn't have real stream ids, but the route handler
 * promises a consistent shape across brokers. We use the message's
 * `timestamp` (the moment the firmware posted it) so comparisons against a
 * client-supplied checkpoint still order chronologically — even if the
 * client persisted a checkpoint while connected to the Redis broker and
 * later falls through to the memory broker, "newer than" still means what
 * the client expects.
 */
function synthIdFromTimestamp(ts: string): string {
  const ms = Date.parse(ts);
  return `${Number.isFinite(ms) ? ms : 0}-0`;
}

/**
 * Compare two stream ids ("<ms>-<seq>"). Returns negative, zero, or positive
 * the same way Array.sort comparators do. Tolerates malformed inputs by
 * falling back to 0 — a malformed checkpoint just means "treat as oldest."
 */
function compareStreamIds(a: string, b: string): number {
  const [ams, aseq] = a.split('-').map((s) => parseInt(s, 10));
  const [bms, bseq] = b.split('-').map((s) => parseInt(s, 10));
  const am = Number.isFinite(ams) ? ams : 0;
  const bm = Number.isFinite(bms) ? bms : 0;
  if (am !== bm) return am - bm;
  const aq = Number.isFinite(aseq) ? aseq : 0;
  const bq = Number.isFinite(bseq) ? bseq : 0;
  return aq - bq;
}

export class MessageQueue implements IMessageBroker {
  private mobileAppQueue: Map<number, Message[]>;
  private controllerQueue: Map<number, Message>;
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    this.mobileAppQueue = new Map<number, Message[]>();
    this.controllerQueue = new Map<number, Message>();
    this.cleanupInterval = this.startCleanup();
  }

  async addMobileAppMessage(controllerId: number, message: Message): Promise<void> {
    const messageWithExpiry: Message = {
      ...message,
      expiresAt: Date.now() + (11 * 60 * 1000)
    };
    if (!this.mobileAppQueue.has(controllerId)) {
      this.mobileAppQueue.set(controllerId, []);
    }
    const queue = this.mobileAppQueue.get(controllerId)!;
    queue.push(messageWithExpiry);
    console.log(`[MemoryBroker] Added mobile app message for controller ${controllerId}. Queue size: ${queue.length}`);
  }

  async addControllerMessage(controllerId: number, message: Message): Promise<void> {
    const messageWithExpiry: Message = {
      ...message,
      expiresAt: Date.now() + (11 * 60 * 1000)
    };
    this.controllerQueue.set(controllerId, messageWithExpiry);
    console.log(`[MemoryBroker] Updated controller message for controller ${controllerId}`);
  }

  async getMobileAppMessage(controllerId: number): Promise<Message | null> {
    const queue = this.mobileAppQueue.get(controllerId);
    if (!queue || queue.length === 0) return null;
    this.cleanupExpiredMessages(controllerId, queue);
    if (queue.length === 0) return null;
    const message = queue.shift()!;
    if (queue.length === 0) {
      this.mobileAppQueue.delete(controllerId);
    }
    console.log(`[MemoryBroker] Retrieved and deleted mobile app message for controller ${controllerId}`);
    return message;
  }

  async getControllerMessage(controllerId: number): Promise<Message | null> {
    const message = this.controllerQueue.get(controllerId);
    if (!message) return null;
    if (message.expiresAt && Date.now() > message.expiresAt) {
      this.controllerQueue.delete(controllerId);
      return null;
    }
    return message;
  }

  async getControllerMessagesSince(
    controllerId: number,
    sinceStreamId: string,
    _maxCount: number,
  ): Promise<ControllerMessagesSinceResult> {
    // The memory broker keeps a single slot per controller; previous
    // messages are gone. Return the slot's current contents iff its
    // synthesized id is newer than the caller's checkpoint.
    const message = this.controllerQueue.get(controllerId);
    if (!message) {
      return { messages: [], highWaterMark: sinceStreamId, hasMore: false };
    }
    if (message.expiresAt && Date.now() > message.expiresAt) {
      this.controllerQueue.delete(controllerId);
      return { messages: [], highWaterMark: sinceStreamId, hasMore: false };
    }
    const synthId = synthIdFromTimestamp(message.timestamp);
    if (compareStreamIds(synthId, sinceStreamId) <= 0) {
      return { messages: [], highWaterMark: sinceStreamId, hasMore: false };
    }
    // Stamp the synthesized id so the client's checkpoint advances. Cloning
    // (rather than mutating the stored message) keeps the slot intact for
    // future reads — the message stays until it expires or gets overwritten.
    const stamped: Message = { ...message, streamId: synthId };
    return { messages: [stamped], highWaterMark: synthId, hasMore: false };
  }

  private cleanupExpiredMessages(controllerId: number, queue: Message[]): void {
    const now = Date.now();
    let removedCount = 0;
    while (queue.length > 0 && queue[0].expiresAt && now > queue[0].expiresAt) {
      queue.shift();
      removedCount++;
    }
    if (removedCount > 0) {
      console.log(`[MemoryBroker] Removed ${removedCount} expired messages for controller ${controllerId}`);
    }
  }

  private startCleanup(): NodeJS.Timeout {
    return setInterval(() => this.cleanupAllExpiredMessages(), 60 * 1000);
  }

  private cleanupAllExpiredMessages(): void {
    const now = Date.now();
    let totalRemoved = 0;
    for (const [controllerId, queue] of this.mobileAppQueue.entries()) {
      const originalLength = queue.length;
      const filteredQueue = queue.filter(msg => !msg.expiresAt || now <= msg.expiresAt);
      if (filteredQueue.length === 0) {
        this.mobileAppQueue.delete(controllerId);
      } else if (filteredQueue.length !== originalLength) {
        this.mobileAppQueue.set(controllerId, filteredQueue);
      }
      totalRemoved += (originalLength - filteredQueue.length);
    }
    for (const [controllerId, message] of this.controllerQueue.entries()) {
      if (message.expiresAt && now > message.expiresAt) {
        this.controllerQueue.delete(controllerId);
        totalRemoved++;
      }
    }
    if (totalRemoved > 0) {
      console.log(`[MemoryBroker] Cleanup: Removed ${totalRemoved} expired messages`);
    }
  }

  async getStats(): Promise<QueueStats> {
    let mobileAppCount = 0;
    for (const queue of this.mobileAppQueue.values()) {
      mobileAppCount += queue.length;
    }
    return {
      mobileAppControllers: this.mobileAppQueue.size,
      mobileAppMessages: mobileAppCount,
      controllerMessages: this.controllerQueue.size,
      brokerType: 'memory',
      redisConnected: false
    };
  }

  async getAllQueueContents(): Promise<{ mobileAppQueue: Map<number, Message[]>; controllerQueue: Map<number, Message> }> {
    return {
      mobileAppQueue: new Map(this.mobileAppQueue),
      controllerQueue: new Map(this.controllerQueue)
    };
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async destroy(): Promise<void> {
    clearInterval(this.cleanupInterval);
  }
}
