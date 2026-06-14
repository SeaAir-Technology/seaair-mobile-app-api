import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';

// Bypass Cognito: every request is authenticated as a fixed user. Mocking the
// auth module (not a real token) keeps these tests offline and deterministic.
vi.mock('../../src/auth', () => ({
  verifyJWT: (req: any, _res: any, next: any) => {
    req.auth = { sub: 'user-1' };
    next();
  },
  isCognitoConfigured: () => true,
  COGNITO_USER_POOL_ID: 'test-pool',
  COGNITO_CLIENT_ID: 'test-client',
  AWS_REGION: 'us-east-2',
}));

import { createApp } from '../../src/app';
import { MessageQueue } from '../../src/messageQueue';
import { RateLimiter } from '../../src/rateLimiter';
import { hvacHeartbeat, legacyDeviceInfoRequest } from '../helpers/proto';

describe('mobile routes', () => {
  let app: Application;
  let broker: MessageQueue;
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    app = createApp();
    broker = new MessageQueue();
    rateLimiter = new RateLimiter();
    app.locals.messageBroker = broker;
    app.locals.rateLimiter = rateLimiter;
  });

  afterEach(async () => {
    await broker.destroy();
    rateLimiter.destroy();
  });

  describe('POST /mobile/message', () => {
    it('rejects a missing controllerId', async () => {
      const res = await request(app).post('/mobile/message').send({ protobufPayload: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/controllerId is required/);
    });

    it('rejects a non-positive / non-integer controllerId', async () => {
      for (const bad of [0, -5, 1.5, 'abc']) {
        const res = await request(app)
          .post('/mobile/message')
          .send({ controllerId: bad, protobufPayload: 'x' });
        expect(res.status).toBe(400);
      }
    });

    it('rejects a missing protobufPayload', async () => {
      const res = await request(app).post('/mobile/message').send({ controllerId: 101 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/protobufPayload is required/);
    });

    it('queues a valid message and the broker receives it', async () => {
      const payload = hvacHeartbeat('Cabin Air');
      const res = await request(app)
        .post('/mobile/message')
        .send({ controllerId: 101, protobufPayload: payload });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, controllerId: 101 });

      const queued = await broker.getMobileAppMessage(101);
      expect(queued?.protobufPayload).toBe(payload);
      expect(queued?.sender).toMatchObject({ type: 'mobile', authId: 'user-1' });
    });

    it('silently drops a legacy BLE.Msg{deviceInfoRequest} without queueing it', async () => {
      const res = await request(app)
        .post('/mobile/message')
        .send({ controllerId: 101, protobufPayload: legacyDeviceInfoRequest() });

      // Legacy clients must see a normal success so they don't retry-storm...
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // ...but nothing actually lands in the command queue.
      expect(await broker.getMobileAppMessage(101)).toBeNull();
    });

    it('returns 429 once the rate limit is exceeded', async () => {
      const body = { controllerId: 101, protobufPayload: hvacHeartbeat('A') };
      for (let i = 0; i < 60; i++) {
        const ok = await request(app).post('/mobile/message').send(body);
        expect(ok.status).toBe(200);
      }
      const limited = await request(app).post('/mobile/message').send(body);
      expect(limited.status).toBe(429);
      expect(limited.body.error).toMatch(/Rate limit exceeded/);
    });
  });

  describe('GET /mobile/status/:controllerId', () => {
    it('returns the latest controller message', async () => {
      await broker.addControllerMessage(101, {
        timestamp: new Date().toISOString(),
        sender: { ip: 'fw', type: 'controller' },
        controllerId: 101,
        protobufPayload: hvacHeartbeat('Cabin Air'),
      });

      const res = await request(app).get('/mobile/status/101');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status.protobufPayload).toBe(hvacHeartbeat('Cabin Air'));
    });

    it('returns null status when nothing is stored', async () => {
      const res = await request(app).get('/mobile/status/101');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, status: null });
    });

    it('rejects an invalid controllerId', async () => {
      const res = await request(app).get('/mobile/status/-1');
      expect(res.status).toBe(400);
    });

    it('serves the since-checkpoint shape when ?since is provided', async () => {
      await broker.addControllerMessage(101, {
        timestamp: new Date('2026-01-01T00:00:10.000Z').toISOString(),
        sender: { ip: 'fw', type: 'controller' },
        controllerId: 101,
        protobufPayload: hvacHeartbeat('Cabin Air'),
      });

      const res = await request(app).get('/mobile/status/101').query({ since: '0-0' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.statuses)).toBe(true);
      expect(res.body.statuses).toHaveLength(1);
      expect(res.body).toHaveProperty('highWaterMark');
      expect(res.body).toHaveProperty('hasMore', false);
    });
  });
});
