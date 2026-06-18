/**
 * Message broker factory.
 * Returns the in-memory MessageQueue (default) or a Redis-backed
 * RedisStreamQueue based on the MESSAGE_BROKER env var.
 */

import { IMessageBroker } from './types';
import { MessageQueue } from './messageQueue';
import { RedisStreamQueue } from './redisStreamQueue';
import { getRedisClient } from './redisClient';
import { getArchiveStore } from './services/archiveStore';

export type BrokerType = 'memory' | 'redis';

export function getBrokerType(): BrokerType {
  return ((process.env.MESSAGE_BROKER || 'memory').toLowerCase() === 'redis') ? 'redis' : 'memory';
}

export async function createMessageBroker(): Promise<IMessageBroker> {
  const type = getBrokerType();
  if (type === 'redis') {
    console.log('[Broker] MESSAGE_BROKER=redis -- initializing RedisStreamQueue');
    const redis = await getRedisClient();
    // The archive store is always attached; it no-ops unless ARCHIVE_ENABLED=true
    // (FR-10), so wiring it here costs nothing until the flag is flipped.
    return new RedisStreamQueue(redis, getArchiveStore());
  }
  console.log('[Broker] MESSAGE_BROKER=memory -- using in-memory MessageQueue');
  return new MessageQueue();
}
