/**
 * SeaAir Mobile App API
 * Transport layer for mobile app and controller communication.
 *
 * Uses MESSAGE_BROKER=memory|redis to select the broker implementation.
 */

import express, { Request, Response, NextFunction, Application } from 'express';
import morgan from 'morgan';
import path from 'path';
import { createMessageBroker, getBrokerType } from './src/messageBroker';
import { closeRedisClient } from './src/redisClient';
import { RateLimiter } from './src/rateLimiter';
import controllerRoutes from './src/routes/controller';
import mobileRoutes from './src/routes/mobile';
import configRoutes from './src/routes/config';
import adminRoutes from './src/routes/admin';
import beaconRoutes from './src/routes/beacon';
import consentRoutes from './src/routes/consent';
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
app.use('/mobile/consent', consentRoutes);
app.use('/config', configRoutes);
app.use('/admin', adminRoutes);

// Dashboard backend: gated by Cognito JWT + dashboard-admin group membership.
// Same App Runner service as the SPA below, so requests from the SPA are
// same-origin even when the SPA is reached via a different custom domain
// (App Runner doesn't host-discriminate by default).
app.use('/dashboard/api', requireDashboardAdmin, dashboardRoutes);

// Dashboard SPA. Served at the host root so users on dashboard.seaair.com see
// https://dashboard.seaair.com/ rather than /dashboard/. The static middleware
// is mounted AFTER all API routers so the API still wins on its own paths;
// static only sees requests that didn't match a registered route.
const WEB_DIST = path.resolve(process.cwd(), 'web/dist');
app.use(express.static(WEB_DIST));

// SPA HTML fallback for client-side routing. Triggers on GETs that didn't
// match any API router or static file. Two safety checks keep API 404s from
// being masked with index.html:
//   1. Explicit skip for /dashboard/api (the only API path a SPA dev would
//      plausibly hit with an HTML-accepting client).
//   2. Accept-header check: real browser navigations send 'text/html'; API
//      clients send 'application/json' or '*/*' and fall through to 404.
app.use((req: Request, res: Response, next: NextFunction): void => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (
    req.path === '/dashboard/api' ||
    req.path.startsWith('/dashboard/api/') ||
    req.path === '/health' ||
    req.path === '/health-detail'
  ) {
    return next();
  }
  const accept = req.headers.accept || '';
  if (!accept.includes('text/html')) return next();
  res.sendFile(path.join(WEB_DIST, 'index.html'), (err) => {
    if (err) next();
  });
});

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
    console.log(
      '[Server] Routes: /controller /mobile /mobile/beacon /mobile/consent /config /admin ' +
        '/dashboard/api /health /health-detail (+ SPA at /)'
    );
    console.log(`[Server] Dashboard SPA served from ${WEB_DIST}`);
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
