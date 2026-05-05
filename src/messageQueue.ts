/**
 * In-memory message broker implementation (legacy / fallback).
 * Implements IMessageBroker so it is hot-swappable with RedisStreamQueue
 * via the MESSAGE_BROKER env var.
 *
 * - Mobile app queue: Array of messages per controller (FIFO, drained on read)
 * - Controller queue: Single latest message per controller
 * - Messages expire after 11 minutes
 */

import { IMessageBroker, Message, QueueStats } from './types';

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
