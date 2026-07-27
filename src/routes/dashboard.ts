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
  extractDeviceName,
  parseFilterParam,
  evaluateFilters,
  PayloadFilter,
  DecodedPayload,
} from '../services/protoDecoder';
import {
  listBeacons,
  listBeaconsForController,
  resolveBeacon,
  Beacon,
} from '../services/beacons';
import {
  listAllDashboardUsers,
  searchUsers,
  grantDashboardAccess,
  revokeDashboardAccess,
  getUserBySub,
} from '../services/dashboardAdmin';
import { archiveEnabled, getArchiveStore, ArchiveStore } from '../services/archiveStore';

const router = express.Router();

const FRESHNESS_MS = 11 * 60 * 1000;
const ACTIVE_BEACONS_FETCH_LIMIT = 200;
// Most-recent window served live from Redis in the analytics view, with older
// history coming from the durable archive. Keeps the live edge real-time and
// immune to archive write lag / change-point compression.
const ANALYTICS_LIVE_EDGE_MS = 5 * 60 * 1000;

// ---- helpers ----------------------------------------------------------------

function getRedisBroker(req: Request): RedisStreamQueue | null {
  const broker = req.app.locals.messageBroker as IMessageBroker | undefined;
  if (!broker) return null;
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
    isDashboardAdmin: true,
  });
});

// ---- Devices: rolled-up list for the past N seconds/minutes ----------------
//
// One row per controller that has at least one heartbeat in the lookback
// window. Beacon flag is sourced from the active-beacons table (DynamoDB):
// any controller with at least one beacon whose `expiresAt > now` gets
// beacon: true. That float-to-top sort happens both server-side here and
// client-side in DevicesPage; either is sufficient.

router.get('/devices', async (req: Request, res: Response): Promise<void> => {
  const broker = getRedisBroker(req);
  if (!broker) {
    brokerError(res);
    return;
  }
  const windowMs = parseWindow((req.query.window as string) || '1m');
  const cutoff = Date.now() - windowMs;

  try {
    // Pull stream keys + active beacons in parallel; both are needed before
    // assembling the response and neither blocks the other.
    const [streamKeys, activeBeaconsResult] = await Promise.all([
      broker.listStreamKeys(),
      listBeacons(ACTIVE_BEACONS_FETCH_LIMIT),
    ]);
    const fw2mobileKeys = streamKeys.filter((k) =>
      k.startsWith('stream:fw2mobile:')
    );
    const activeBeaconControllers = new Set<number>(
      activeBeaconsResult.beacons.map((b) => b.controllerId)
    );

    type Lookup = { controllerId: number; lastSeenMs: number; name?: string };
    const lookups = await Promise.all(
      fw2mobileKeys.map(async (key): Promise<Lookup | null> => {
        const idStr = key.split(':')[2];
        const controllerId = parseInt(idStr, 10);
        if (!Number.isFinite(controllerId) || controllerId <= 0) return null;
        const history = await broker.getStreamHistory(controllerId, 'fw2mobile', 1);
        if (history.length === 0) return null;
        const msg = history[0];
        const tsMs = msg.streamId ? parseInt(msg.streamId.split('-')[0], 10) : 0;
        if (tsMs < cutoff) return null;
        const name = extractDeviceName(decodePayload(msg.protobufPayload));
        return { controllerId, lastSeenMs: tsMs, name };
      })
    );

    const now = Date.now();
    const devices = lookups
      .filter((x): x is Lookup => x !== null)
      .map(({ controllerId, lastSeenMs, name }) => ({
        controllerId,
        name,
        lastSeenAt: new Date(lastSeenMs).toISOString(),
        ageMs: now - lastSeenMs,
        alive: now - lastSeenMs <= FRESHNESS_MS,
        beacon: activeBeaconControllers.has(controllerId),
      }));

    devices.sort((a, b) => {
      if (a.beacon !== b.beacon) return a.beacon ? -1 : 1;
      return a.ageMs - b.ageMs;
    });

    res.json({
      windowMs,
      count: devices.length,
      devices,
    });
  } catch (err: any) {
    console.error(`[Dashboard] /devices failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---- Devices: live recent across all controllers (firehose) ----------------

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
      alive: ageMs <= FRESHNESS_MS,
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

// ---- Devices: queue depth (unread counter for the dashboard badge) --------

router.get('/devices/:controllerId/queue', async (req: Request, res: Response): Promise<void> => {
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
  const directionParam = (req.query.direction as string) || 'mobile2fw';
  if (directionParam !== 'mobile2fw' && directionParam !== 'fw2mobile') {
    res.status(400).json({ error: 'direction must be mobile2fw or fw2mobile' });
    return;
  }
  try {
    const result = await broker.getQueueDepth(
      controllerId,
      directionParam as 'mobile2fw' | 'fw2mobile'
    );
    res.json(result);
  } catch (err: any) {
    console.error(`[Dashboard] /devices/:id/queue failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---- Devices: "Mark all received" ------------------------------------------

router.post('/devices/:controllerId/mark-all-received', async (req: Request, res: Response): Promise<void> => {
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
  const directionParam = (req.query.direction as string) || 'mobile2fw';
  if (directionParam !== 'mobile2fw' && directionParam !== 'fw2mobile') {
    res.status(400).json({ error: 'direction must be mobile2fw or fw2mobile' });
    return;
  }
  const direction = directionParam as 'mobile2fw' | 'fw2mobile';

  try {
    const result = await broker.markAllReceived(controllerId, direction);
    const actor = req.auth?.email || req.auth?.username || req.auth?.sub;
    console.log(
      `[Dashboard] mark-all-received by ${actor} on controller ${controllerId} (${direction}): ` +
        `pelAcked=${result.pelAcked} skipped=${result.skipped}`
    );
    res.json(result);
  } catch (err: any) {
    console.error(`[Dashboard] mark-all-received failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---- Devices: analytics -----------------------------------------------------
//
// Charts numeric telemetry over a window. Prefers the durable Tier-2 archive
// (days of history, change-point compressed) and only falls back to sampling
// the short Redis live window when archiving is disabled. Either way we decode
// each payload and emit the same {path: [{t,v}]} series shape the dashboard
// expects, so the data source is transparent to the frontend.

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
  const now = Date.now();
  const cutoff = now - windowMs;
  const sampleCap = 5000;

  try {
    const series: Record<string, Array<{ t: number; v: number | string }>> = {};
    let scanned = 0;
    let source: 'archive+live' | 'live' = 'live';

    const decodeInto = (payload: string, t: number): void => {
      const decoded = decodePayload(payload);
      if (!decoded) return;
      scanned++;
      // Numbers/booleans come from the sparse decode so absent fields don't
      // become fake zero samples. Enum strings come from the defaults:true
      // view: their zero values (mode STANDBY, compressor ON) are omitted
      // from the wire, and skipping them would leave the series stuck on the
      // last non-zero value.
      walkTelemetryFields(decoded.data, '', (path, value) => {
        if (typeof value === 'number') (series[path] ??= []).push({ t, v: value });
      });
      walkTelemetryFields(decoded.dataFull ?? decoded.data, '', (path, value) => {
        if (typeof value === 'string') (series[path] ??= []).push({ t, v: value });
      });
    };

    const archive = (req.app.locals.archiveStore as ArchiveStore | undefined) ?? getArchiveStore();
    const liveEdge = now - ANALYTICS_LIVE_EDGE_MS;

    if (archiveEnabled() && typeof archive.getRange === 'function') {
      // Hybrid read: deep history from the durable archive for everything older
      // than the live edge, then the recent window straight from Redis. The
      // live edge is real-time and immune to archive write lag / change-point
      // compression. Archive covers [cutoff, liveEdge); Redis covers [liveEdge, now].
      source = 'archive+live';
      if (cutoff < liveEdge) {
        const items = await archive.getRange(controllerId, cutoff, liveEdge - 1, sampleCap);
        for (const item of items) {
          // Value reflects lastTs (latest-wins); cap at the live edge so an
          // archived run spanning the boundary doesn't overlap the live window.
          decodeInto(item.payloadRaw, Math.min(item.lastTs ?? item.ts, liveEdge - 1));
        }
      }
    }

    // Recent live-edge window from Redis (or the whole window when archiving is off).
    const liveCut = source === 'archive+live' ? Math.max(cutoff, liveEdge) : cutoff;
    if (typeof broker.getStreamHistory === 'function') {
      const history = await broker.getStreamHistory(controllerId, 'fw2mobile', sampleCap);
      for (const msg of history) {
        const tsMs = msg.streamId ? parseInt(msg.streamId.split('-')[0], 10) : 0;
        if (tsMs < liveCut) break; // newest-first: stop once past the cut
        decodeInto(msg.protobufPayload, tsMs);
      }
    }

    // Archive points were appended ascending, live points descending — sort each.
    for (const k of Object.keys(series)) series[k].sort((a, b) => a.t - b.t);

    res.json({
      controllerId,
      windowMs,
      source,
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

// Enum fields decode as strings (enums: String); these leaves are emitted so
// mode/compressor state show up in the state tooltip. An allowlist rather
// than all strings so free-text fields (config.name, wifi ssid/password)
// never leak into the series.
const ENUM_LEAVES = new Set(['mode', 'state', 'status', 'resetStrategy']);

// Numbers chart directly; booleans (pressure alarms, budget.enabled, …) are
// emitted as 0/1 so they show up in the state tooltip and can be charted too.
function walkTelemetryFields(
  obj: any,
  prefix: string,
  visit: (path: string, value: number | string) => void
): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'number' || typeof obj === 'boolean') {
    if (prefix) visit(prefix, Number(obj));
    return;
  }
  if (typeof obj === 'string') {
    if (prefix && ENUM_LEAVES.has(prefix.split('.').pop()!)) visit(prefix, obj);
    return;
  }
  if (typeof obj !== 'object') return;
  for (const [key, val] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${key}` : key;
    walkTelemetryFields(val, next, visit);
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

/**
 * POST /dashboard/api/beacons/:createdAt/:beaconId/resolve
 *
 * Clears (resolves) a beacon by setting its expiresAt to now. Both
 * createdAt and beaconId are needed because the DynamoDB sort key is the
 * composite `{createdAt}#{beaconId}`. Path params are URL-decoded by
 * Express, so the client must encodeURIComponent both segments before
 * sending (createdAt is an ISO 8601 string with `:` chars).
 */
router.post('/beacons/:createdAt/:beaconId/resolve', async (req: Request, res: Response): Promise<void> => {
  const { createdAt, beaconId } = req.params;
  if (!createdAt || !beaconId) {
    res.status(400).json({ error: 'createdAt and beaconId path params required' });
    return;
  }
  const actor = req.auth?.email || req.auth?.username || req.auth?.sub;
  try {
    await resolveBeacon(createdAt, beaconId);
    console.log(`[Dashboard] beacon ${beaconId} resolved by ${actor}`);
    res.json({ success: true, beaconId, createdAt });
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      res.status(404).json({ error: 'Beacon not found' });
      return;
    }
    console.error(`[Dashboard] resolve beacon failed: ${err.message}`);
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
