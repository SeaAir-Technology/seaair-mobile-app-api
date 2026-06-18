import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RedisStreamQueue } from '../../src/redisStreamQueue';
import type { Message } from '../../src/types';

/**
 * Minimal fake ioredis: records every xadd call's arguments so we can assert
 * the trim strategy without a live Redis. Only the methods exercised here are
 * implemented; everything else throws if accidentally hit.
 */
function fakeRedis() {
  const xaddCalls: any[][] = [];
  return {
    xaddCalls,
    xadd: vi.fn(async (...args: any[]) => {
      xaddCalls.push(args);
      return '1-0';
    }),
    status: 'ready',
  } as any;
}

function heartbeat(controllerId: number): Message {
  return {
    timestamp: new Date('2026-06-17T00:00:00.000Z').toISOString(),
    sender: { ip: 'fw', type: 'controller' },
    controllerId,
    protobufPayload: 'AAAA',
  };
}

const SAVED = { live: process.env.STREAM_LIVE_MAXLEN, legacy: process.env.STREAM_MAXLEN };

describe('RedisStreamQueue live-window trim (Task 1)', () => {
  beforeEach(() => {
    delete process.env.STREAM_LIVE_MAXLEN;
    delete process.env.STREAM_MAXLEN;
  });

  afterEach(() => {
    if (SAVED.live === undefined) delete process.env.STREAM_LIVE_MAXLEN;
    else process.env.STREAM_LIVE_MAXLEN = SAVED.live;
    if (SAVED.legacy === undefined) delete process.env.STREAM_MAXLEN;
    else process.env.STREAM_MAXLEN = SAVED.legacy;
  });

  describe('resolveLiveMaxLen', () => {
    it('prefers STREAM_LIVE_MAXLEN', () => {
      process.env.STREAM_LIVE_MAXLEN = '5000';
      process.env.STREAM_MAXLEN = '1000000';
      expect(RedisStreamQueue.resolveLiveMaxLen()).toBe(5000);
    });

    it('falls back to legacy STREAM_MAXLEN when the new var is unset', () => {
      process.env.STREAM_MAXLEN = '1234';
      expect(RedisStreamQueue.resolveLiveMaxLen()).toBe(1234);
    });

    it('defaults to 5000 when neither var is set', () => {
      expect(RedisStreamQueue.resolveLiveMaxLen()).toBe(5000);
    });

    it('rejects non-positive / non-numeric values and falls back to 5000', () => {
      for (const bad of ['0', '-1', 'abc', '']) {
        process.env.STREAM_LIVE_MAXLEN = bad;
        expect(RedisStreamQueue.resolveLiveMaxLen()).toBe(5000);
      }
    });
  });

  it('trims fw2mobile heartbeats with approximate MAXLEN at the live window', async () => {
    process.env.STREAM_LIVE_MAXLEN = '5000';
    const redis = fakeRedis();
    const q = new RedisStreamQueue(redis);

    await q.addControllerMessage(101, heartbeat(101));

    // First xadd is the per-controller stream; firehose write follows.
    const call = redis.xaddCalls[0];
    expect(call[0]).toBe('stream:fw2mobile:101');
    expect(call[1]).toBe('MAXLEN');
    expect(call[2]).toBe('~');
    expect(call[3]).toBe(5000);
  });

  describe('Tier-2 archive wiring (Task 2)', () => {
    it('fire-and-forget archives every fw2mobile heartbeat', async () => {
      const redis = fakeRedis();
      const archive = { write: vi.fn(async () => undefined) };
      const q = new RedisStreamQueue(redis, archive);

      await q.addControllerMessage(101, heartbeat(101));

      expect(archive.write).toHaveBeenCalledTimes(1);
      expect(archive.write).toHaveBeenCalledWith(
        expect.objectContaining({
          controllerId: 101,
          streamId: '1-0',
          senderType: 'controller',
          payloadRaw: 'AAAA',
        }),
      );
    });

    it('a rejected archive write never fails the heartbeat', async () => {
      const redis = fakeRedis();
      const archive = { write: vi.fn(async () => { throw new Error('ddb down'); }) };
      const q = new RedisStreamQueue(redis, archive);

      // addControllerMessage must resolve even though the archive rejects.
      await expect(q.addControllerMessage(101, heartbeat(101))).resolves.toBeUndefined();
    });

    it('does not archive when no writer is attached', async () => {
      const redis = fakeRedis();
      const q = new RedisStreamQueue(redis);
      await expect(q.addControllerMessage(101, heartbeat(101))).resolves.toBeUndefined();
    });
  });

  describe('getControllerMessagesSince — archive reconnect fallback (Task 5 / FR-7)', () => {
    const SAVED_ENABLED = process.env.ARCHIVE_ENABLED;

    function cmpIds(a: string, b: string): number {
      const [am, as_] = a.split('-').map((n) => parseInt(n, 10));
      const [bm, bs_] = b.split('-').map((n) => parseInt(n, 10));
      return am !== bm ? am - bm : (as_ || 0) - (bs_ || 0);
    }

    function fields(payload: string): string[] {
      return [
        'timestamp', new Date(1000).toISOString(),
        'senderType', 'controller',
        'senderIp', 'fw',
        'controllerId', '101',
        'payload', payload,
      ];
    }

    // Fake Redis backed by an ascending list of [id, fields]; implements the
    // two xrange shapes the broker uses: `(since +` and `- + COUNT 1`.
    function streamRedis(entries: Array<[string, string[]]>) {
      return {
        xadd: vi.fn(async () => '9-0'),
        xrange: vi.fn(async (_stream: string, start: string, _end: string, ...rest: any[]) => {
          let count = Infinity;
          const ci = rest.indexOf('COUNT');
          if (ci >= 0) count = parseInt(rest[ci + 1], 10);
          let result = entries.slice();
          if (typeof start === 'string' && start.startsWith('(')) {
            const lo = start.slice(1);
            result = result.filter(([id]) => cmpIds(id, lo) > 0);
          }
          return result.slice(0, count);
        }),
        status: 'ready',
      } as any;
    }

    function archived(ts: number, payload: string) {
      return {
        controllerId: '101',
        ts,
        streamId: `${ts}-0`,
        senderType: 'controller',
        senderIp: 'fw',
        payloadRaw: payload,
        kind: 'hvac',
        measures: {},
        state: {},
        repeated: 0,
        lastTs: ts,
      };
    }

    beforeEach(() => {
      process.env.ARCHIVE_ENABLED = 'true';
    });
    afterEach(() => {
      if (SAVED_ENABLED === undefined) delete process.env.ARCHIVE_ENABLED;
      else process.env.ARCHIVE_ENABLED = SAVED_ENABLED;
    });

    it('prepends archived gap entries when the checkpoint predates the live window', async () => {
      // Live window holds only 1000-0 and 2000-0 (older entries were trimmed).
      const redis = streamRedis([
        ['1000-0', fields('REDIS_A')],
        ['2000-0', fields('REDIS_B')],
      ]);
      const archive = {
        write: vi.fn(async () => undefined),
        getSince: vi.fn(async () => [archived(100, 'ARCH_1'), archived(200, 'ARCH_2')]),
      };
      const q = new RedisStreamQueue(redis, archive);

      const result = await q.getControllerMessagesSince(101, '0-0', 50);

      expect(archive.getSince).toHaveBeenCalledWith(101, 0, 51);
      expect(result.messages.map((m) => m.protobufPayload)).toEqual([
        'ARCH_1', 'ARCH_2', 'REDIS_A', 'REDIS_B',
      ]);
      expect(result.highWaterMark).toBe('2000-0');
      expect(result.hasMore).toBe(false);
    });

    it('does not touch the archive when the checkpoint is within the live window', async () => {
      const redis = streamRedis([
        ['1000-0', fields('REDIS_A')],
        ['2000-0', fields('REDIS_B')],
      ]);
      const archive = {
        write: vi.fn(async () => undefined),
        getSince: vi.fn(async () => []),
      };
      const q = new RedisStreamQueue(redis, archive);

      const result = await q.getControllerMessagesSince(101, '1500-0', 50);

      expect(archive.getSince).not.toHaveBeenCalled();
      expect(result.messages.map((m) => m.protobufPayload)).toEqual(['REDIS_B']);
    });

    it('falls back to Redis-only when the archive read fails', async () => {
      const redis = streamRedis([['1000-0', fields('REDIS_A')]]);
      const archive = {
        write: vi.fn(async () => undefined),
        getSince: vi.fn(async () => { throw new Error('ddb down'); }),
      };
      const q = new RedisStreamQueue(redis, archive);

      const result = await q.getControllerMessagesSince(101, '0-0', 50);
      expect(result.messages.map((m) => m.protobufPayload)).toEqual(['REDIS_A']);
    });
  });
});
