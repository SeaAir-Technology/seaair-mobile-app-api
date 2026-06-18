/**
 * Express app assembly.
 *
 * Builds and returns the fully-wired Express application WITHOUT starting a
 * listener or initializing the broker. server.ts owns the lifecycle (broker
 * init, app.locals, listen, health interval, shutdown); tests call createApp()
 * and inject their own app.locals so they exercise the real route mounting
 * with in-memory / fake dependencies.
 *
 * Request handlers read the broker and rate limiter off app.locals at request
 * time, so callers must populate app.locals.messageBroker and
 * app.locals.rateLimiter before serving traffic.
 */

import express, { Request, Response, NextFunction, Application } from 'express';
import morgan from 'morgan';
import path from 'path';
import { getBrokerType } from './messageBroker';
import controllerRoutes from './routes/controller';
import mobileRoutes from './routes/mobile';
import configRoutes from './routes/config';
import adminRoutes from './routes/admin';
import beaconRoutes from './routes/beacon';
import consentRoutes from './routes/consent';
import dashboardRoutes from './routes/dashboard';
import analyticsRoutes from './routes/analytics';
import { requireDashboardAdmin } from './middleware/requireDashboardAdmin';
import { isCognitoConfigured, COGNITO_USER_POOL_ID, AWS_REGION } from './auth';
import { archiveConfig } from './services/archiveStore';
import { HealthDetailResponse, QueueContents, IMessageBroker } from './types';

export function createApp(): Application {
  const app: Application = express();

  app.use(express.json({ limit: '256kb' }));
  // Skip request logging under test to keep test output readable.
  if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('combined'));
  }

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
  //
  // Analytics (Tier-2 archive history) mounts first under the same gate so its
  // specific prefix wins before the general dashboard router.
  app.use('/dashboard/api/analytics', requireDashboardAdmin, analyticsRoutes);
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
      archive: archiveConfig(),
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

  return app;
}
