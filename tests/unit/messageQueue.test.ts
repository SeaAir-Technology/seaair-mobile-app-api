import { describe, it, expect, afterEach, vi } from 'vitest';
import { MessageQueue } from '../../src/messageQueue';
import { Message } from '../../src/types';

function msg(overrides: Partial<Message> = {}): Message {
  return {
    timestamp: new Date().toISOString(),
    sender: { ip: '1.2.3.4', type: 'mobile', authId: 'user-1' },
    controllerId: 1,
    protobufPayload: 'AAEC',
    ...overrides,
  };
}

describe('MessageQueue (in-memory broker)', () => {
  let q: MessageQueue;

  afterEach(async () => {
    await q?.destroy();
    vi.useRealTimers();
  });

  describe('mobile app queue (FIFO, drained on read)', () => {
    it('returns messages in insertion order and drains them', async () => {
      q = new MessageQueue();
      await q.addMobileAppMessage(1, msg({ protobufPayload: 'first' }));
      await q.addMobileAppMessage(1, msg({ protobufPayload: 'second' }));

      expect((await q.getMobileAppMessage(1))?.protobufPayload).toBe('first');
      expect((await q.getMobileAppMessage(1))?.protobufPayload).toBe('second');
      expect(await q.getMobileAppMessage(1)).toBeNull();
    });

    it('returns null for an empty controller', async () => {
      q = new MessageQueue();
      expect(await q.getMobileAppMessage(999)).toBeNull();
    });

    it('expires messages past their TTL', async () => {
      vi.useFakeTimers();
      q = new MessageQueue();
      await q.addMobileAppMessage(1, msg());
      vi.advanceTimersByTime(12 * 60 * 1000); // TTL is 11 minutes
      expect(await q.getMobileAppMessage(1)).toBeNull();
    });
  });

  describe('controller queue (single latest slot)', () => {
    it('keeps only the latest message', async () => {
      q = new MessageQueue();
      await q.addControllerMessage(1, msg({ protobufPayload: 'old' }));
      await q.addControllerMessage(1, msg({ protobufPayload: 'new' }));
      expect((await q.getControllerMessage(1))?.protobufPayload).toBe('new');
    });

    it('does not drain the slot on read', async () => {
      q = new MessageQueue();
      await q.addControllerMessage(1, msg({ protobufPayload: 'keep' }));
      expect((await q.getControllerMessage(1))?.protobufPayload).toBe('keep');
      expect((await q.getControllerMessage(1))?.protobufPayload).toBe('keep');
    });

    it('returns null when nothing is stored', async () => {
      q = new MessageQueue();
      expect(await q.getControllerMessage(1)).toBeNull();
    });
  });

  describe('getControllerMessagesSince (checkpoint reads)', () => {
    it('returns the message when its synthesized id is newer than the checkpoint', async () => {
      q = new MessageQueue();
      const ts = new Date('2026-01-01T00:00:10.000Z').toISOString();
      await q.addControllerMessage(1, msg({ timestamp: ts }));

      const result = await q.getControllerMessagesSince(1, '0-0', 50);
      expect(result.messages).toHaveLength(1);
      expect(result.highWaterMark).toBe(`${Date.parse(ts)}-0`);
      expect(result.hasMore).toBe(false);
    });

    it('returns nothing when the checkpoint is already at/after the message', async () => {
      q = new MessageQueue();
      const ts = new Date('2026-01-01T00:00:10.000Z').toISOString();
      await q.addControllerMessage(1, msg({ timestamp: ts }));

      const result = await q.getControllerMessagesSince(1, `${Date.parse(ts)}-0`, 50);
      expect(result.messages).toHaveLength(0);
      expect(result.highWaterMark).toBe(`${Date.parse(ts)}-0`);
    });

    it('returns empty for an unknown controller', async () => {
      q = new MessageQueue();
      const result = await q.getControllerMessagesSince(404, '5-0', 50);
      expect(result.messages).toHaveLength(0);
      expect(result.highWaterMark).toBe('5-0');
    });
  });

  describe('getStats', () => {
    it('counts controllers and messages across both queues', async () => {
      q = new MessageQueue();
      await q.addMobileAppMessage(1, msg());
      await q.addMobileAppMessage(1, msg());
      await q.addMobileAppMessage(2, msg());
      await q.addControllerMessage(3, msg());

      const stats = await q.getStats();
      expect(stats.mobileAppControllers).toBe(2);
      expect(stats.mobileAppMessages).toBe(3);
      expect(stats.controllerMessages).toBe(1);
      expect(stats.brokerType).toBe('memory');
    });
  });
});
