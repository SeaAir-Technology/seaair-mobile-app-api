import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';

// Dashboard routes are gated by Cognito + group membership; replace the gate
// with a pass-through so we exercise the route logic, not the auth.
vi.mock('../../src/middleware/requireDashboardAdmin', () => ({
  requireDashboardAdmin: (req: any, _res: any, next: any) => {
    req.auth = { sub: 'admin-1' };
    next();
  },
}));

// The /devices route reads active beacons from DynamoDB; stub the service so
// the test is offline and we control which controllers are flagged.
const mockBeacons = vi.fn(async () => ({ beacons: [] as Array<{ controllerId: number }> }));
vi.mock('../../src/services/beacons', () => ({
  listBeacons: (...args: any[]) => mockBeacons(...(args as [])),
  listBeaconsForController: async () => [],
  resolveBeacon: async () => ({}),
}));

import { createApp } from '../../src/app';
import { RateLimiter } from '../../src/rateLimiter';
import { hvacHeartbeat, utilityHeartbeat, namelessHeartbeat, wrappedHvacHeartbeat } from '../helpers/proto';

// Minimal stand-in for RedisStreamQueue exposing only what /devices calls.
// Each controller maps to its latest heartbeat payload and an age (ms ago).
function fakeBroker(devices: Record<number, { payload: string; ageMs: number }>) {
  const now = Date.now();
  return {
    async listStreamKeys() {
      return Object.keys(devices).map((id) => `stream:fw2mobile:${id}`);
    },
    async getStreamHistory(controllerId: number, _channel: string, _count: number) {
      const d = devices[controllerId];
      if (!d) return [];
      return [{ streamId: `${now - d.ageMs}-0`, protobufPayload: d.payload }];
    },
  };
}

describe('GET /dashboard/api/devices', () => {
  let app: Application;
  const MIN = 60 * 1000;

  beforeAll(() => {
    // getRedisBroker() only returns the broker when MESSAGE_BROKER=redis.
    process.env.MESSAGE_BROKER = 'redis';
  });
  afterAll(() => {
    delete process.env.MESSAGE_BROKER;
  });

  beforeEach(() => {
    mockBeacons.mockResolvedValue({ beacons: [] });
    app = createApp();
    app.locals.rateLimiter = new RateLimiter();
  });

  function mountDevices() {
    app.locals.messageBroker = fakeBroker({
      // 101 uses the wire-realistic BLE.Msg-wrapped shape; 202 a bare type.
      101: { payload: wrappedHvacHeartbeat('Cabin Air'), ageMs: 1_000 },
      202: { payload: utilityHeartbeat('Bilge Sensor'), ageMs: 2_000 },
      303: { payload: hvacHeartbeat('Old Device'), ageMs: 5 * MIN },
      404: { payload: namelessHeartbeat(), ageMs: 3_000 },
    });
  }

  it('extracts the device name from the latest heartbeat', async () => {
    mountDevices();
    const res = await request(app).get('/dashboard/api/devices');

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.devices.map((d: any) => [d.controllerId, d]));
    expect(byId[101].name).toBe('Cabin Air');
    expect(byId[202].name).toBe('Bilge Sensor');
    // Firmware version rides along from the sync wrapper; the bare Utility
    // heartbeat has no version field.
    expect(byId[101].firmwareVersion).toBe('1.2.3');
    expect(byId[202].firmwareVersion).toBeUndefined();
  });

  it('omits the name when the heartbeat has none', async () => {
    mountDevices();
    const res = await request(app).get('/dashboard/api/devices');
    const dev404 = res.body.devices.find((d: any) => d.controllerId === 404);
    expect(dev404).toBeDefined();
    expect(dev404.name).toBeUndefined();
  });

  it('floats beaconed controllers to the top, then sorts by recency', async () => {
    mockBeacons.mockResolvedValue({ beacons: [{ controllerId: 202 }] });
    mountDevices();

    const res = await request(app).get('/dashboard/api/devices');
    // 303 is outside the default 1m window -> 101, 202, 404 remain.
    expect(res.body.count).toBe(3);
    expect(res.body.devices[0].controllerId).toBe(202);
    expect(res.body.devices[0].beacon).toBe(true);
    // After the beacon, most-recent-first: 101 (1s) before 404 (3s).
    expect(res.body.devices.slice(1).map((d: any) => d.controllerId)).toEqual([101, 404]);
  });

  it('excludes devices last seen before the lookback window', async () => {
    mountDevices();
    const res = await request(app).get('/dashboard/api/devices');
    expect(res.body.devices.find((d: any) => d.controllerId === 303)).toBeUndefined();
  });

  it('includes older devices when the window is widened', async () => {
    mountDevices();
    const res = await request(app).get('/dashboard/api/devices').query({ window: '10m' });
    expect(res.body.count).toBe(4);
    const dev303 = res.body.devices.find((d: any) => d.controllerId === 303);
    expect(dev303.name).toBe('Old Device');
  });

  it('returns each device with the expected summary shape', async () => {
    mountDevices();
    const res = await request(app).get('/dashboard/api/devices');
    for (const d of res.body.devices) {
      expect(d).toHaveProperty('controllerId');
      expect(d).toHaveProperty('lastSeenAt');
      expect(d).toHaveProperty('ageMs');
      expect(typeof d.alive).toBe('boolean');
      expect(typeof d.beacon).toBe('boolean');
    }
  });
});
