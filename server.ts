/**
 * SeaAir Mobile App API
 * Transport layer for mobile app and controller communication.
 *
 * Uses MESSAGE_BROKER=memory|redis to select the broker implementation.
 */

import express, { Request, Response, NextFunction, Application } from 'express';
import morgan from 'morgan';
import { createMessageBroker, getBrokerType } from './src/messageBroker';
import { closeRedisClient } from './src/redisClient';
import { RateLimiter } from './src/rateLimiter';
import controllerRoutes from './src/routes/controller';
import mobileRoutes from './src/routes/mobile';
import configRoutes from './src/routes/config';
import adminRoutes from './src/routes/admin';
import beaconRoutes from './src/routes/beacon';
import dashboardRoutes from './src/routes/dashboard';
import { requireDashboardAdmin } from './src/middleware/requireDashboardAdmin';
import { initProtoDecoder } from './src/services/protoDecoder';
import { isCognitoConfigured, COGNITO_USER_POOL_ID, AWS_REGION } from './src/auth';
import { HealthDetailResponse, QueueContents, IMessageBroker } from './src/types';

const app: Application = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '256kb' }));
app.use(morgan('combined'));

// Routes are mounted before async startup so request handlers work as soon as
// the server is listening; handlers read the broker off app.locals at request
// time, so as long as start() has populated it before the first request lands,
// we are fine. App Runner waits for /health to pass before routing traffic.
app.use('/controller', controllerRoutes);
app.use('/mobile', mobileRoutes);
app.use('/mobile/beacon', beaconRoutes);
app.use('/config', configRoutes);
app.use('/admin', adminRoutes);

// Dashboard backend: gated by Cognito JWT + dashboard-admin group membership.
// Served on the same App Runner service (reachable via api.seaair.com or
// dashboard.seaair.com — App Runner doesn't host-discriminate by default).
app.use('/dashboard/api', requireDashboardAdmin, dashboardRoutes);

app.get('/health', async (_req: Request, res: Response): Promise<void> => {
  const broker = app.locals.messageBroker as IMessageBroker | undefined;
  let brokerOk = false;
  if (broker) {
    try {
      brokerOk = await broker.ping();
    } catch {
      brokerOk = false;
    }
  }
  const status = {
    status: brokerOk ? 'healthy' : 'degraded',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    broker: {
      type: getBrokerType(),
      connected: brokerOk,
    },
    cognito: {
      configured: isCognitoConfigured(),
    },
  };
  res.status(brokerOk ? 200 : 503).json(status);
});

app.get('/health-detail', async (_req: Request, res: Response): Promise<void> => {
  const broker = app.locals.messageBroker as IMessageBroker | undefined;
  if (!broker) {
    res.status(503).json({ status: 'broker not initialized' });
    return;
  }
  const stats = await broker.getStats();
  const rateLimiterStats = app.locals.rateLimiter.getStats();
  const queueData = await broker.getAllQueueContents();

  const queueContents: QueueContents = { mobileAppQueue: {}, controllerQueue: {} };
  for (const [cid, msgs] of queueData.mobileAppQueue.entries()) {
    queueContents.mobileAppQueue[cid.toString()] = msgs;
  }
  for (const [cid, msg] of queueData.controllerQueue.entries()) {
    queueContents.controllerQueue[cid.toString()] = msg;
  }

  const response: HealthDetailResponse = {
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    queues: stats,
    queueContents,
    rateLimiter: rateLimiterStats,
    cognito: {
      configured: isCognitoConfigured(),
      userPoolId: COGNITO_USER_POOL_ID || 'not-set',
      region: AWS_REGION,
    },
    broker: {
      type: getBrokerType(),
      connected: await broker.ping().catch(() => false),
    },
  };
  res.status(200).json(response);
});

app.use((req: Request, res: Response): void => {
  console.log(`[Server] 404: ${req.method} ${req.path}`);
  res.status(404).json({ error: 'Route not found' });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction): void => {
  console.error('[Server] Error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

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
    console.log('[Server] Routes: /controller /mobile /mobile/beacon /config /admin /dashboard/api /health /health-detail');
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
