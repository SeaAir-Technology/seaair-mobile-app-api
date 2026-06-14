/**
 * SeaAir Mobile App API
 * Transport layer for mobile app and controller communication.
 *
 * Uses MESSAGE_BROKER=memory|redis to select the broker implementation.
 *
 * App assembly (routes, middleware, health, SPA) lives in src/app.ts so it can
 * be mounted in tests without a listener. This file owns the runtime lifecycle:
 * broker init, app.locals, listen, periodic health log, and graceful shutdown.
 */

import { Application } from 'express';
import { createApp } from './src/app';
import { createMessageBroker, getBrokerType } from './src/messageBroker';
import { closeRedisClient } from './src/redisClient';
import { RateLimiter } from './src/rateLimiter';
import { initProtoDecoder } from './src/services/protoDecoder';
import { isCognitoConfigured, COGNITO_USER_POOL_ID, AWS_REGION } from './src/auth';
import { IMessageBroker } from './src/types';

const app: Application = createApp();
const PORT = process.env.PORT || 3000;

let healthInterval: NodeJS.Timeout | null = null;

async function start(): Promise<void> {
  console.log('[Server] Starting SeaAir Mobile App API...');
  console.log(`[Server] MESSAGE_BROKER=${getBrokerType()}`);

  // Load proto definitions up front so the dashboard's payload-decoding path
  // doesn't pay a cold-start cost on the first request.
  initProtoDecoder();

  app.locals.rateLimiter = new RateLimiter();
  app.locals.messageBroker = await createMessageBroker();
  console.log(`[Server] Broker initialized: ${getBrokerType()}`);

  if (isCognitoConfigured()) {
    console.log(`[Server] Cognito: ${COGNITO_USER_POOL_ID} (${AWS_REGION})`);
  } else {
    console.warn('[Server] WARNING: Cognito not configured - mobile auth will fail');
  }

  app.listen(PORT, () => {
    console.log(`[Server] Listening on port ${PORT}`);
    console.log(
      '[Server] Routes: /controller /mobile /mobile/beacon /mobile/consent /config /admin ' +
        '/dashboard/api /health /health-detail (+ SPA at /)'
    );
  });

  healthInterval = setInterval(async () => {
    const broker = app.locals.messageBroker as IMessageBroker;
    const stats = await broker.getStats().catch(() => null);
    if (stats) {
      console.log(
        `[Health] uptime=${Math.floor(process.uptime())}s broker=${getBrokerType()} ` +
          `mobileAppControllers=${stats.mobileAppControllers} ` +
          `mobileAppMessages=${stats.mobileAppMessages} ` +
          `controllerMessages=${stats.controllerMessages}`
      );
    }
  }, 60000);
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[Server] ${signal} received, shutting down`);
  if (healthInterval) clearInterval(healthInterval);
  const broker = app.locals.messageBroker as IMessageBroker | undefined;
  if (broker) await broker.destroy().catch(() => undefined);
  await closeRedisClient().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

start().catch((err) => {
  console.error('[Server] Startup failed:', err);
  process.exit(1);
});

export default app;
