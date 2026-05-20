/**
 * Rate limiter to prevent abuse
 * Tracks requests per controller and per source (IP/account)
 * Blocks if 60 or more requests in 30 seconds
 */

import { RateLimiterStats } from './types';

export class RateLimiter {
  private requests: Map<string, number[]>;
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Track requests: key -> array of timestamps
    this.requests = new Map<string, number[]>();
    
    // Cleanup old entries periodically
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60 * 1000); // Every minute
  }

  /**
   * Check if a request should be allowed
   * Does not record the request - use recordRequest() after checking both auth and IP limits
   * @param key - Identifier (auth:userId or ip:address)
   * @returns True if allowed, false if rate limited
   */
  checkLimit(key: string): boolean {
    const now = Date.now();
    const windowStart = now - (30 * 1000); // 30 seconds ago

    if (!this.requests.has(key)) {
      this.requests.set(key, []);
    }

    const timestamps = this.requests.get(key);
    
    if (!timestamps) {
      return true;
    }

    // Remove timestamps older than 30 seconds
    const recentTimestamps = timestamps.filter(ts => ts > windowStart);
    this.requests.set(key, recentTimestamps);

    // Check if rate limit exceeded
    if (recentTimestamps.length >= 60) {
      console.log(`[RateLimiter] Rate limit exceeded for ${key}. Request count: ${recentTimestamps.length}`);
      return false;
    }

    return true;
  }

  /**
   * Record a request for rate limiting
   * @param key - Identifier to record
   */
  recordRequest(key: string): void {
    const now = Date.now();
    
    if (!this.requests.has(key)) {
      this.requests.set(key, []);
    }
    
    const timestamps = this.requests.get(key);
    if (timestamps) {
      timestamps.push(now);
    }
  }

  /**
   * Clean up old entries
   */
  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - (30 * 1000);
    let removedCount = 0;

    for (const [key, timestamps] of this.requests.entries()) {
      const recentTimestamps = timestamps.filter(ts => ts > windowStart);
      
      if (recentTimestamps.length === 0) {
        this.requests.delete(key);
        removedCount++;
      } else {
        this.requests.set(key, recentTimestamps);
      }
    }

    if (removedCount > 0) {
      console.log(`[RateLimiter] Cleanup: Removed ${removedCount} empty rate limit entries`);
    }
  }

  /**
   * Get statistics
   */
  getStats(): RateLimiterStats {
    return {
      trackedKeys: this.requests.size
    };
  }

  /**
   * Stop the cleanup interval (useful for testing)
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}
