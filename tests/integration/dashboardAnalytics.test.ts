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
import { wrappedHvacHeartbeat, versionlessHvacHeartbeat } from '../helpers/proto';

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

  it('merges deep archive history with the live Redis edge when archiving is on', async () => {
    const now = Date.now();
    const archivedTs = now - 2 * 60 * 60 * 1000; // 2h ago -> archive domain
    const liveTs = now - 60 * 1000; // 1 min ago -> live-edge domain
    const getRange = vi.fn(async () => [
      { controllerId: '101', ts: archivedTs, lastTs: archivedTs, payloadRaw: wrappedHvacHeartbeat('Cabin Air') },
    ]);
    const getStreamHistory = vi.fn(async () => [
      { streamId: `${liveTs}-0`, protobufPayload: wrappedHvacHeartbeat('Cabin Air') },
    ]);
    app.locals.archiveStore = { getRange };
    app.locals.messageBroker = { getStreamHistory };

    const res = await request(app)
      .get('/dashboard/api/devices/101/analytics')
      .query({ window: '7d' });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('archive+live');
    expect(getRange).toHaveBeenCalledTimes(1); // older history from the archive
    expect(getStreamHistory).toHaveBeenCalledTimes(1); // recent edge from Redis
    expect(res.body.seriesNames).toContain('syncDevice2Controller.hvac.temperture');
    // Boolean fields (alarms) are emitted as 0/1 series
    expect(res.body.seriesNames).toContain('syncDevice2Controller.hvac.compressorShutdown');
    expect(res.body.series['syncDevice2Controller.hvac.compressorShutdown'][0].v).toBe(1);
    // Enum fields (mode etc.) are emitted as string series
    expect(res.body.seriesNames).toContain('syncDevice2Controller.hvac.config.mode');
    expect(res.body.series['syncDevice2Controller.hvac.config.mode'][0].v).toBe('COOL');
    // Firmware version string rides along for the state tooltip
    expect(res.body.series['syncDevice2Controller.version'][0].v).toBe('1.2.3');
    const temp = res.body.series['syncDevice2Controller.hvac.temperture'];
    expect(temp).toHaveLength(2); // one archived (old) + one live (recent), stitched
    expect(temp[0].t).toBeLessThan(temp[1].t); // sorted ascending: archive before live
    expect(temp[1].t).toBe(liveTs); // live edge point at its real timestamp
    expect(res.body.scanned).toBe(2);
  });

  it('emits zero-valued enums (STANDBY) via the defaults-aware decode', async () => {
    process.env.ARCHIVE_ENABLED = 'false';
    const getStreamHistory = vi.fn(async () => [
      // mode 0 = STANDBY: omitted from the wire by proto3, must still be
      // emitted so the dashboard doesn't show a stale previous mode
      { streamId: `${Date.now()}-0`, protobufPayload: wrappedHvacHeartbeat('Cabin Air', 0) },
    ]);
    app.locals.messageBroker = { getStreamHistory };
    app.locals.archiveStore = { getRange: vi.fn() };

    const res = await request(app)
      .get('/dashboard/api/devices/101/analytics')
      .query({ window: '24h' });

    expect(res.status).toBe(200);
    expect(res.body.series['syncDevice2Controller.hvac.config.mode'][0].v).toBe('STANDBY');
  });

  it('omits unset string fields instead of emitting blank series values', async () => {
    process.env.ARCHIVE_ENABLED = 'false';
    const getStreamHistory = vi.fn(async () => [
      // Heartbeat without a version — the defaults:true view renders it as
      // "" and it must not become a blank tooltip row
      { streamId: `${Date.now()}-0`, protobufPayload: versionlessHvacHeartbeat('Cabin Air') },
    ]);
    app.locals.messageBroker = { getStreamHistory };
    app.locals.archiveStore = { getRange: vi.fn() };

    const res = await request(app)
      .get('/dashboard/api/devices/101/analytics')
      .query({ window: '24h' });

    expect(res.status).toBe(200);
    expect(res.body.series['syncDevice2Controller.version']).toBeUndefined();
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
