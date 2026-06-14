import { describe, it, expect, vi, afterEach } from 'vitest';
import { RateLimiter } from '../../src/rateLimiter';

describe('RateLimiter', () => {
  let rl: RateLimiter;

  afterEach(() => {
    rl?.destroy();
    vi.useRealTimers();
  });

  it('allows requests up to the limit and blocks the 61st', () => {
    rl = new RateLimiter();
    const key = 'auth:user-1';
    for (let i = 0; i < 60; i++) {
      expect(rl.checkLimit(key)).toBe(true);
      rl.recordRequest(key);
    }
    // 60 recorded -> next check is over the limit
    expect(rl.checkLimit(key)).toBe(false);
  });

  it('checkLimit does not itself record a request', () => {
    rl = new RateLimiter();
    const key = 'ip:1.2.3.4';
    for (let i = 0; i < 100; i++) {
      expect(rl.checkLimit(key)).toBe(true);
    }
    expect(rl.getStats().trackedKeys).toBe(1);
  });

  it('tracks separate keys independently', () => {
    rl = new RateLimiter();
    for (let i = 0; i < 60; i++) rl.recordRequest('auth:a');
    expect(rl.checkLimit('auth:a')).toBe(false);
    expect(rl.checkLimit('auth:b')).toBe(true);
  });

  it('frees the budget once the 30s window slides past', () => {
    vi.useFakeTimers();
    rl = new RateLimiter();
    const key = 'auth:windowed';
    for (let i = 0; i < 60; i++) rl.recordRequest(key);
    expect(rl.checkLimit(key)).toBe(false);

    vi.advanceTimersByTime(31_000);
    expect(rl.checkLimit(key)).toBe(true);
  });

  it('reports the number of tracked keys', () => {
    rl = new RateLimiter();
    rl.recordRequest('auth:a');
    rl.recordRequest('ip:b');
    expect(rl.getStats().trackedKeys).toBe(2);
  });
});
