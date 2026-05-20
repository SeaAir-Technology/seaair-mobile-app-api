/**
 * Shared type definitions for the SeaAir Mobile App API
 */

export interface MessageSender {
  ip: string;
  type: 'mobile' | 'controller';
  authId?: string;
}

export interface Message {
  timestamp: string;
  sender: MessageSender;
  controllerId: number;
  protobufPayload: string;
  expiresAt?: number;
  // Stream-specific fields populated when reading from Redis Streams.
  streamId?: string;
  streamKey?: string;
}

export interface QueueStats {
  mobileAppControllers: number;
  mobileAppMessages: number;
  controllerMessages: number;
  brokerType?: 'memory' | 'redis';
  redisConnected?: boolean;
  totalStreams?: number;
}

export interface RateLimiterStats {
  trackedKeys: number;
}

export interface AuthInfo {
  sub: string;
  username?: string;
  email?: string;
  [key: string]: any;
}

export interface CognitoStatus {
  configured: boolean;
  userPoolId: string;
  region: string;
}

export interface HealthResponse {
  status: string;
  uptime: number;
  timestamp: string;
  queues: QueueStats;
  rateLimiter: RateLimiterStats;
  cognito: CognitoStatus;
}

export interface QueueContents {
  mobileAppQueue: { [controllerId: string]: Message[] };
  controllerQueue: { [controllerId: string]: Message };
}

export interface HealthDetailResponse {
  status: string;
  uptime: number;
  timestamp: string;
  queues: QueueStats;
  queueContents: QueueContents;
  rateLimiter: RateLimiterStats;
  cognito: CognitoStatus;
  broker: {
    type: 'memory' | 'redis';
    connected: boolean;
    info?: any;
  };
}

/**
 * Result returned by `getControllerMessagesSince`.
 *
 * `highWaterMark` is the stream id the caller should pass as `sinceStreamId`
 * on the next poll. When `messages` is non-empty, it's the id of the LAST
 * entry in the array. When `messages` is empty (nothing new since the
 * caller's checkpoint), it's the caller's input id, unchanged — passing it
 * back is still safe and idempotent.
 *
 * `hasMore` is true when the per-call cap was hit and the caller should
 * re-poll immediately with the new `highWaterMark` to avoid falling behind.
 */
export interface ControllerMessagesSinceResult {
  messages: Message[];
  highWaterMark: string;
  hasMore: boolean;
}

/**
 * Common interface implemented by both the legacy in-memory MessageQueue
 * and the Redis-backed RedisStreamQueue. Methods are async so callers can
 * transparently swap implementations via the MESSAGE_BROKER env var.
 */
export interface IMessageBroker {
  addMobileAppMessage(controllerId: number, message: Message): Promise<void>;
  addControllerMessage(controllerId: number, message: Message): Promise<void>;
  getMobileAppMessage(controllerId: number): Promise<Message | null>;
  getControllerMessage(controllerId: number): Promise<Message | null>;
  // Returns controller-pushed messages with stream ids strictly greater than
  // `sinceStreamId`, capped at `maxCount`. Mobile uses this to drain command
  // responses (PIN, WiFi-config, …) that would otherwise be buried under a
  // newer heartbeat by the time the single-latest `getControllerMessage` was
  // called. See the route handler in `routes/mobile.ts` for the rationale.
  getControllerMessagesSince(
    controllerId: number,
    sinceStreamId: string,
    maxCount: number,
  ): Promise<ControllerMessagesSinceResult>;
  getStats(): Promise<QueueStats>;
  getAllQueueContents(): Promise<{
    mobileAppQueue: Map<number, Message[]>;
    controllerQueue: Map<number, Message>;
  }>;
  ping(): Promise<boolean>;
  destroy(): Promise<void>;
  // Optional inspection methods (Redis only — memory broker is undefined here).
  listStreamKeys?(): Promise<string[]>;
  getStreamHistory?(controllerId: number, direction: 'fw2mobile' | 'mobile2fw', count: number): Promise<Message[]>;
  getStreamLength?(controllerId: number, direction: 'fw2mobile' | 'mobile2fw'): Promise<number>;
}
