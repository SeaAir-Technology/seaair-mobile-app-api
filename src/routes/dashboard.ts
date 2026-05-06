/**
 * Dashboard backend routes.
 *
 * Mounted at /dashboard/api. Every route requires a valid Cognito JWT AND
 * membership in the dashboard-admin Cognito group (via requireDashboardAdmin
 * middleware applied at mount time in server.ts).
 *
 * Read endpoints back the Devices and Beacons sections of the dashboard.
 * Admin endpoints back the user-management panel that toggles dashboard
 * access for individual Cognito users.
 *
 * Stacked search: history endpoints accept any number of `filter` query
 * params, each parseable as `path[=op]:value` (e.g. `filter=hvac.mode=cool`,
 * `filter=hvac.temperature=gt:70`). Filters are AND-combined and evaluated
 * against the *decoded* protobuf payload of each entry. Entries that fail
 * to decode are excluded when any filter is supplied.
 */

import express, { Request, Response } from 'express';
import { RedisStreamQueue, FirehoseEntry } from '../redisStreamQueue';
import { Message, IMessageBroker } from '../types';
import { getBrokerType } from '../messageBroker';
import {
  decodePayload,
  parseFilterParam,
  evaluateFilters,
  PayloadFilter,
  DecodedPayload,
} from '../services/protoDecoder';
import {
  listBeacons,
  listBeaconsForController,
  Beacon,
} from '../services/beacons';
import {
  listAllDashboardUsers,
  searchUsers,
  grantDashboardAccess,
  revokeDashboardAccess,
  getUserBySub,
} from '../services/dashboardAdmin';

const router = express.Router();

// ---- helpers ----------------------------------------------------------------

function getRedisBroker(req: Request): RedisStreamQueue | null {
  const broker = req.app.locals.messageBroker as IMessageBroker | undefined;
  if (!broker) return null;
  // The dashboard requires Redis Streams; the in-memory MessageQueue can't
  // satisfy it. Routes return 503 cleanly if the broker isn't a Redis one.
  if (getBrokerType() !== 'redis') return null;
  return broker as unknown as RedisStreamQueue;
}

function brokerError(res: Response): void {
  res.status(503).json({
    error: 'Dashboard requires Redis broker',
    message: 'Set MESSAGE_BROKER=redis to enable dashboard endpoints',
  });
}

function readFiltersFromQuery(query: any): PayloadFilter[] {
  const raw = query.filter;
  const list: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: PayloadFilter[] = [];
  for (const r of list) {
    const f = parseFilterParam(String(r));
    if (f) out.push(f);
  }
  return out;
}

interface EnrichedMessage extends Message {
  decoded: DecodedPayload | null;
}

function enrich(msg: Message): EnrichedMessage {
  return { ...msg, decoded: decodePayload(msg.protobufPayload) };
}

// ---- /me --------------------------------------------------------------------

router.get('/me', async (req: Request, res: Response): Promise<void> => {
  if (!req.auth) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }
  res.json({
    sub: req.auth.sub,
    username: req.auth.username || req.auth['cognito:username'],
    email: req.auth.email,
    groups: req.auth['cognito:groups'] || [],
    isDashboardAdmin: true, // gate already enforced
  });
});

// ---- Devices: live recent across all controllers ---------------------------

router.get('/messages/recent', async (req: Request, res: Response): Promise<void> => {
  const broker = getRedisBroker(req);
  if (!broker) {
    brokerError(res);
    return;
  }
  const limit = Math.min(parseInt((req.query.limit as string) || '100', 10), 200);
  try {
    const entries: FirehoseEntry[] = await broker.readFirehose(limit);
    res.json({ count: entries.length, entries });
  } catch (err: any) {
    console.error(`[Dashboard] /messages/recent failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---- Devices: current state -------------------------------------------------

router.get('/devices/:controllerId/state', async (req: Request, res: Response): Promise<void> => {
  const broker = getRedisBroker(req);
  if (!broker) {
    brokerError(res);
    return;
  }
  const controllerId = parseInt(req.params.controllerId, 10);
  if (isNaN(controllerId) || controllerId <= 0) {
    res.status(400).json({ error: 'controllerId must be a positive integer' });
    return;
  }
  try {
    const history = await broker.getStreamHistory(controllerId, 'fw2mobile', 1);
    if (history.length === 0) {
      res.json({ controllerId, latest: null, alive: false });
      return;
    }
    const msg = history[0];
    const tsMs = msg.streamId ? parseInt(msg.streamId.split('-')[0], 10) : Date.now();
    const ageMs = Date.now() - tsMs;
    res.json({
      controllerId,
      alive: ageMs <= 11 * 60 * 1000,
      ageMs,
      latest: enrich(msg),
    });
  } catch (err: any) {
    console.error(`[Dashboard] /devices/:id/state failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---- Devices: history with stacked search ----------------------------------

router.get('/devices/:controllerId/history', async (req: Request, res: Response): Promise<void> => {
  const broker = getRedisBroker(req);
  if (!broker) {
    brokerError(res);
    return;
  }
  const controllerId = parseInt(req.params.controllerId, 10);
  if (isNaN(controllerId) || controllerId <= 0) {
    res.status(400).json({ error: 'controllerId must be a positive integer' });
    return;
  }
  const count = Math.min(parseInt((req.query.count as string) || '200', 10), 1000);
  const direction = (req.query.direction as string) || 'both';
  const filters = readFiltersFromQuery(req.query);

  try {
    const buckets: Array<{ direction: 'fw2mobile' | 'mobile2fw'; messages: Message[] }> = [];
    if (direction === 'fw2mobile' || direction === 'both') {
      const m = await broker.getStreamHistory(controllerId, 'fw2mobile', count);
      buckets.push({ direction: 'fw2mobile', messages: m });
    }
    if (direction === 'mobile2fw' || direction === 'both') {
      const m = await broker.getStreamHistory(controllerId, 'mobile2fw', count);
      buckets.push({ direction: 'mobile2fw', messages: m });
    }

    // Merge newest-first across both directions, then optionally filter on
    // decoded protobuf contents.
    const merged: Array<EnrichedMessage & { direction: 'fw2mobile' | 'mobile2fw' }> = [];
    for (const b of buckets) {
      for (const msg of b.messages) {
        merged.push({ ...enrich(msg), direction: b.direction });
      }
    }
    merged.sort((a, b) => {
      const aMs = a.streamId ? parseInt(a.streamId.split('-')[0], 10) : 0;
      const bMs = b.streamId ? parseInt(b.streamId.split('-')[0], 10) : 0;
      return bMs - aMs;
    });

    const filtered = filters.length === 0
      ? merged
      : merged.filter(m => evaluateFilters(m.decoded, filters));

    res.json({
      controllerId,
      direction,
      filters,
      count: filtered.length,
      totalScanned: merged.length,
      messages: filtered.slice(0, count),
    });
  } catch (err: any) {
    console.error(`[Dashboard] /devices/:id/history failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---- Devices: analytics (skeleton) -----------------------------------------
//
// Returns numeric time-series for any decoded payload field discovered in
// the requested window. The Devices > Analytics tab in the SPA picks which
// series to chart. Specific known series (power, temp, runtime, cycle freq)
// can be added once the proto field names are confirmed.

router.get('/devices/:controllerId/analytics', async (req: Request, res: Response): Promise<void> => {
  const broker = getRedisBroker(req);
  if (!broker) {
    brokerError(res);
    return;
  }
  const controllerId = parseInt(req.params.controllerId, 10);
  if (isNaN(controllerId) || controllerId <= 0) {
    res.status(400).json({ error: 'controllerId must be a positive integer' });
    return;
  }
  const windowMs = parseWindow((req.query.window as string) || '24h');
  const cutoff = Date.now() - windowMs;
  const sampleCap = 5000;

  try {
    const history = await broker.getStreamHistory(controllerId, 'fw2mobile', sampleCap);
    const series: Record<string, Array<{ t: number; v: number }>> = {};
    let scanned = 0;

    for (const msg of history) {
      const tsMs = msg.streamId ? parseInt(msg.streamId.split('-')[0], 10) : 0;
      if (tsMs < cutoff) break;
      scanned++;
      const decoded = decodePayload(msg.protobufPayload);
      if (!decoded) continue;
      walkNumericFields(decoded.data, '', (path, value) => {
        if (!series[path]) series[path] = [];
        series[path].push({ t: tsMs, v: value });
      });
    }

    // Reverse each series so it's chronological (oldest -> newest).
    for (const k of Object.keys(series)) series[k].reverse();

    res.json({
      controllerId,
      windowMs,
      scanned,
      series,
      seriesNames: Object.keys(series).sort(),
    });
  } catch (err: any) {
    console.error(`[Dashboard] /devices/:id/analytics failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

function parseWindow(s: string): number {
  const m = s.match(/^(\d+)([smhd])$/);
  if (!m) return 24 * 60 * 60 * 1000;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}

function walkNumericFields(
  obj: any,
  prefix: string,
  visit: (path: string, value: number) => void
): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'number') {
    if (prefix) visit(prefix, obj);
    return;
  }
  if (typeof obj !== 'object') return;
  for (const [key, val] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${key}` : key;
    walkNumericFields(val, next, visit);
  }
}

// ---- Beacons ----------------------------------------------------------------

router.get('/beacons', async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
  const before = req.query.before as string | undefined;
  try {
    const result = await listBeacons(limit, before);
    res.json({
      count: result.beacons.length,
      beacons: result.beacons,
      nextCursor: result.nextCursor,
    });
  } catch (err: any) {
    console.error(`[Dashboard] /beacons failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/beacons/controller/:controllerId', async (req: Request, res: Response): Promise<void> => {
  const controllerId = parseInt(req.params.controllerId, 10);
  if (isNaN(controllerId) || controllerId <= 0) {
    res.status(400).json({ error: 'controllerId must be a positive integer' });
    return;
  }
  const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
  try {
    const beacons: Beacon[] = await listBeaconsForController(controllerId, limit);
    res.json({ controllerId, count: beacons.length, beacons });
  } catch (err: any) {
    console.error(`[Dashboard] /beacons/controller/:id failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---- Admin: dashboard-access management -----------------------------------

router.get('/admin/users', async (_req: Request, res: Response): Promise<void> => {
  try {
    const users = await listAllDashboardUsers(60);
    res.json({ count: users.length, users });
  } catch (err: any) {
    console.error(`[Dashboard] /admin/users failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/users/search', async (req: Request, res: Response): Promise<void> => {
  const q = (req.query.q as string) || '';
  if (!q.trim()) {
    res.status(400).json({ error: 'q query parameter required' });
    return;
  }
  try {
    const users = await searchUsers(q.trim(), 20);
    res.json({ q, count: users.length, users });
  } catch (err: any) {
    console.error(`[Dashboard] /admin/users/search failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/users/:sub', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserBySub(req.params.sub);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user });
  } catch (err: any) {
    console.error(`[Dashboard] /admin/users/:sub failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/users/:username/grant', async (req: Request, res: Response): Promise<void> => {
  try {
    await grantDashboardAccess(req.params.username);
    res.json({ success: true, username: req.params.username, action: 'granted' });
  } catch (err: any) {
    console.error(`[Dashboard] grant failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/users/:username/revoke', async (req: Request, res: Response): Promise<void> => {
  // Don't let an admin revoke themselves and lock everyone out by accident.
  const selfUsername = req.auth?.username || req.auth?.['cognito:username'] || req.auth?.sub;
  if (selfUsername && selfUsername === req.params.username) {
    res.status(400).json({ error: 'Cannot revoke your own dashboard access' });
    return;
  }
  try {
    await revokeDashboardAccess(req.params.username);
    res.json({ success: true, username: req.params.username, action: 'revoked' });
  } catch (err: any) {
    console.error(`[Dashboard] revoke failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
