import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';

// Pass-through the dashboard-admin gate, same as the other dashboard tests.
vi.mock('../../src/middleware/requireDashboardAdmin', () => ({
  requireDashboardAdmin: (req: any, _res: any, next: any) => {
    req.auth = { sub: 'admin-1' };
    next();
  },
}));

import { createApp } from '../../src/app';
import { RateLimiter } from '../../src/rateLimiter';
import { wrappedHvacHeartbeat } from '../helpers/proto';

const SAVED = { broker: process.env.MESSAGE_BROKER, archive: process.env.ARCHIVE_ENABLED };

describe('GET /dashboard/api/devices/:id/analytics', () => {
  let app: Application;

  beforeAll(() => {
    process.env.MESSAGE_BROKER = 'redis'; // getRedisBroker only returns a broker for redis
  });
  afterAll(() => {
    if (SAVED.broker === undefined) delete process.env.MESSAGE_BROKER;
    else process.env.MESSAGE_BROKER = SAVED.broker;
  });

  beforeEach(() => {
    process.env.ARCHIVE_ENABLED = 'true';
    app = createApp();
    app.locals.rateLimiter = new RateLimiter();
    app.locals.messageBroker = {}; // present so getRedisBroker returns non-null
  });
  afterEach(() => {
    if (SAVED.archive === undefined) delete process.env.ARCHIVE_ENABLED;
    else process.env.ARCHIVE_ENABLED = SAVED.archive;
  });

  it('serves series from the durable archive (not the Redis live window) when archiving is on', async () => {
    const t0 = 1_781_700_000_000;
    const getRange = vi.fn(async () => [
      { controllerId: '101', ts: t0, lastTs: t0 + 1000, payloadRaw: wrappedHvacHeartbeat('Cabin Air') },
      { controllerId: '101', ts: t0 + 5000, lastTs: t0 + 6000, payloadRaw: wrappedHvacHeartbeat('Cabin Air') },
    ]);
    app.locals.archiveStore = { getRange };

    const res = await request(app)
      .get('/dashboard/api/devices/101/analytics')
      .query({ window: '7d' });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('archive');
    expect(getRange).toHaveBeenCalledTimes(1);
    // Decoded protobuf paths the frontend charts on.
    expect(res.body.seriesNames).toContain('syncDevice2Controller.hvac.temperture');
    const temp = res.body.series['syncDevice2Controller.hvac.temperture'];
    expect(temp).toHaveLength(2);
    expect(temp[0].t).toBe(t0 + 1000); // plotted at lastTs (latest-wins position)
    expect(temp[0].v).toBe(74);
    expect(res.body.scanned).toBe(2);
  });

  it('falls back to the Redis live window when archiving is disabled', async () => {
    process.env.ARCHIVE_ENABLED = 'false';
    const getStreamHistory = vi.fn(async () => [
      { streamId: `${Date.now()}-0`, protobufPayload: wrappedHvacHeartbeat('Cabin Air') },
    ]);
    app.locals.messageBroker = { getStreamHistory };
    app.locals.archiveStore = { getRange: vi.fn() };

    const res = await request(app)
      .get('/dashboard/api/devices/101/analytics')
      .query({ window: '24h' });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('live');
    expect(getStreamHistory).toHaveBeenCalled();
    expect((app.locals.archiveStore.getRange as any)).not.toHaveBeenCalled();
  });
});
