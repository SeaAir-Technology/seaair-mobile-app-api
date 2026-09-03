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
import {
  wrappedHvacHeartbeat,
  versionlessHvacHeartbeat,
  idleHvacHeartbeat,
  runningHvacHeartbeat,
  budgetedHvacHeartbeat,
  budgetDisabledHvacHeartbeat,
} from '../helpers/proto';

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

  it('emits long-held archive change-points at both span ends, powerTotal end-only', async () => {
    const now = Date.now();
    const spanStart = now - 2 * 60 * 60 * 1000;
    const spanEnd = spanStart + 15 * 60 * 1000; // machine ran steadily for 15 min
    const getRange = vi.fn(async () => [
      {
        controllerId: '101',
        ts: spanStart,
        lastTs: spanEnd,
        payloadRaw: runningHvacHeartbeat('Cabin Air'),
      },
    ]);
    const getStreamHistory = vi.fn(async () => []);
    app.locals.archiveStore = { getRange };
    app.locals.messageBroker = { getStreamHistory };

    const res = await request(app)
      .get('/dashboard/api/devices/101/analytics')
      .query({ window: '7d' });

    expect(res.status).toBe(200);
    // The fingerprint proves powerRate held for the whole span: a two-point
    // step the chart can draw a line through, not an isolated point.
    const rate = res.body.series['syncDevice2Controller.hvac.powerRate'];
    expect(rate.map((p: { t: number }) => p.t)).toEqual([spanStart, spanEnd]);
    expect(rate[0].v).toBeCloseTo(54.7);
    // Mode/state strings span too, so shading segments start where the run did
    const mode = res.body.series['syncDevice2Controller.hvac.config.mode'];
    expect(mode.map((p: { t: number }) => p.t)).toEqual([spanStart, spanEnd]);
    // powerTotal climbs within the span (latest-wins stores the end value), so
    // it is only stamped at the end
    const total = res.body.series['syncDevice2Controller.hvac.powerTotal'];
    expect(total).toHaveLength(1);
    expect(total[0].t).toBe(spanEnd);
  });

  it('emits zero samples for always-populated numerics but not absent-when-zero ones', async () => {
    process.env.ARCHIVE_ENABLED = 'false';
    const getStreamHistory = vi.fn(async () => [
      // Machine holding setpoint: powerRate 0, fan speed 0 (Auto) are dropped
      // from the wire by proto3 but are real readings — without zero samples
      // the strip pairs a stale 54.7A rate with a fresh compressor "Off".
      { streamId: `${Date.now()}-0`, protobufPayload: idleHvacHeartbeat('Cabin Air') },
    ]);
    app.locals.messageBroker = { getStreamHistory };
    app.locals.archiveStore = { getRange: vi.fn() };

    const res = await request(app)
      .get('/dashboard/api/devices/101/analytics')
      .query({ window: '24h' });

    expect(res.status).toBe(200);
    expect(res.body.series['syncDevice2Controller.hvac.powerRate'][0].v).toBe(0);
    expect(res.body.series['syncDevice2Controller.hvac.powerTotal'][0].v).toBe(0);
    expect(res.body.series['syncDevice2Controller.hvac.config.fan.speed'][0].v).toBe(0);
    expect(res.body.series['syncDevice2Controller.hvac.config.compressor.speed'][0].v).toBe(0);
    // voltage 0 means "no digipot fitted", not a 0V bus — stays absent
    expect(res.body.series['syncDevice2Controller.hvac.voltage']).toBeUndefined();
    // no Budget submessage on the wire -> no fake enabled=0 samples either
    expect(res.body.series['syncDevice2Controller.hvac.config.budget.enabled']).toBeUndefined();
  });

  it('emits budget config, including the zero when budget mode turns off', async () => {
    process.env.ARCHIVE_ENABLED = 'false';
    const now = Date.now();
    const getStreamHistory = vi.fn(async () => [
      // newest-first, like Redis: budget switched off after a budgeted run.
      // `enabled: false` is a proto3 zero dropped from the wire — without the
      // defaults-view zero the strip would show the run as budgeted forever.
      { streamId: `${now}-0`, protobufPayload: budgetDisabledHvacHeartbeat('Cabin Air', 40) },
      { streamId: `${now - 60_000}-0`, protobufPayload: budgetedHvacHeartbeat('Cabin Air', 40, 25.6) },
    ]);
    app.locals.messageBroker = { getStreamHistory };
    app.locals.archiveStore = { getRange: vi.fn() };

    const res = await request(app)
      .get('/dashboard/api/devices/101/analytics')
      .query({ window: '24h' });

    expect(res.status).toBe(200);
    const enabled = res.body.series['syncDevice2Controller.hvac.config.budget.enabled'];
    expect(enabled.map((p: { v: number }) => p.v)).toEqual([1, 0]);
    expect(res.body.series['syncDevice2Controller.hvac.config.budget.limit'][0].v).toBe(40);
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
