import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';

// Same dashboard-admin gate bypass as the other dashboard tests.
vi.mock('../../src/middleware/requireDashboardAdmin', () => ({
  requireDashboardAdmin: (req: any, _res: any, next: any) => {
    req.auth = { sub: 'admin-1' };
    next();
  },
}));

import { createApp } from '../../src/app';
import { RateLimiter } from '../../src/rateLimiter';
import type { AnalyticsResult } from '../../src/services/archiveStore';

const SAVED_ENABLED = process.env.ARCHIVE_ENABLED;

/** Fake ArchiveStore exposing only query(); records the args it was called with. */
function fakeArchive(result: Partial<AnalyticsResult> = {}) {
  const calls: any[] = [];
  return {
    calls,
    query: vi.fn(async (controllerId: number, from: number, to: number, resolution: any, measures: any) => {
      calls.push({ controllerId, from, to, resolution, measures });
      return {
        controllerId,
        from,
        to,
        resolution: result.resolution ?? resolution,
        points: result.points ?? [],
      };
    }),
  } as any;
}

describe('GET /dashboard/api/analytics/controller/:id', () => {
  let app: Application;
  const NOW = Date.now();

  beforeEach(() => {
    process.env.ARCHIVE_ENABLED = 'true';
    app = createApp();
    app.locals.rateLimiter = new RateLimiter();
  });

  afterEach(() => {
    if (SAVED_ENABLED === undefined) delete process.env.ARCHIVE_ENABLED;
    else process.env.ARCHIVE_ENABLED = SAVED_ENABLED;
  });

  it('503s when archiving is disabled', async () => {
    process.env.ARCHIVE_ENABLED = 'false';
    app.locals.archiveStore = fakeArchive();
    const res = await request(app)
      .get('/dashboard/api/analytics/controller/101')
      .query({ from: NOW - 1000 });
    expect(res.status).toBe(503);
  });

  it('400s without a from param', async () => {
    app.locals.archiveStore = fakeArchive();
    const res = await request(app).get('/dashboard/api/analytics/controller/101');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/from/);
  });

  it('400s when from is outside the retention window', async () => {
    app.locals.archiveStore = fakeArchive();
    const tooOld = NOW - 30 * 86_400_000; // 30 days ago, well past default 4-day retention
    const res = await request(app)
      .get('/dashboard/api/analytics/controller/101')
      .query({ from: tooOld });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/retention/);
  });

  it('400s on an invalid resolution', async () => {
    app.locals.archiveStore = fakeArchive();
    const res = await request(app)
      .get('/dashboard/api/analytics/controller/101')
      .query({ from: NOW - 1000, resolution: '2m' });
    expect(res.status).toBe(400);
  });

  it('400s on a non-positive controllerId', async () => {
    app.locals.archiveStore = fakeArchive();
    const res = await request(app)
      .get('/dashboard/api/analytics/controller/0')
      .query({ from: NOW - 1000 });
    expect(res.status).toBe(400);
  });

  it('passes parsed params through to the store and returns its result', async () => {
    const archive = fakeArchive({
      resolution: '5m',
      points: [{ ts: NOW - 1000, cabinTemp: { avg: 22.4, min: 21.9, max: 23.1 } } as any],
    });
    app.locals.archiveStore = archive;

    const from = NOW - 3_600_000;
    const res = await request(app)
      .get('/dashboard/api/analytics/controller/101')
      .query({ from, to: NOW, resolution: '5m', measures: 'cabinTemp,compressorRpm' });

    expect(res.status).toBe(200);
    expect(res.body.resolution).toBe('5m');
    expect(res.body.points).toHaveLength(1);
    expect(archive.calls[0]).toMatchObject({
      controllerId: 101,
      from,
      to: NOW,
      resolution: '5m',
      measures: ['cabinTemp', 'compressorRpm'],
    });
  });
});
