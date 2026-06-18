/**
 * Tier-2 durable archive of controller heartbeats (DynamoDB).
 *
 * Why this exists: Redis Streams are the live transport (Tier 1), trimmed to a
 * small live window so the broker can never OOM. Days of per-controller
 * analytics history live here instead, in DynamoDB with a TTL so it
 * self-purges. See the Tiered Retention spec.
 *
 * Compression (FR-6): heartbeats arrive every ~5s and are mostly identical.
 * Rather than store ~17k points/controller/day, we store only *change-points*:
 * a new item is written when the decoded telemetry changes (or comms resumed
 * after a gap). An unchanged heartbeat just bumps the previous item's
 * `repeated` counter and extends `lastTs`, proving the machine kept
 * communicating without growing the table. The query layer expands these
 * sparse change-points back into time buckets for graphing.
 *
 * Best-effort (FR-3): every write is fire-and-forget from the heartbeat path.
 * A failure here is logged and swallowed; it must never fail device delivery.
 * Toggled by ARCHIVE_ENABLED (FR-10) — off by default.
 *
 * Single table, PK `controllerId` (S) / SK `ts` (N, epoch ms). No separate
 * rollup table: change-point storage already does the compression a 1-minute
 * rollup would, and the query layer aggregates app-side.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { getAWSConfig } from '../config/cognito';
import { decodePayload, DecodedPayload } from './protoDecoder';

export type Resolution = 'raw' | '1m' | '5m' | '1h';
const RESOLUTION_MS: Record<Exclude<Resolution, 'raw'>, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '1h': 3_600_000,
};

/** Input handed to the archive from the heartbeat ingest path. */
export interface ArchiveWriteInput {
  controllerId: number;
  ts: number; // epoch ms
  streamId: string;
  senderType: string;
  senderIp?: string;
  payloadRaw: string; // protobuf-as-base64, verbatim
}

/** Decoded telemetry split into numeric measures (aggregatable) and categorical state. */
export interface Telemetry {
  kind: 'hvac' | 'utility';
  measures: Record<string, number>;
  state: Record<string, string | number | boolean>;
}

export interface AnalyticsPoint {
  ts: number;
  [measure: string]: number | { avg: number; min: number; max: number };
}

export interface AnalyticsResult {
  controllerId: number;
  from: number;
  to: number;
  resolution: Resolution;
  points: AnalyticsPoint[];
}

/** A stored change-point, minus storage-only fields. Returned by getSince. */
export interface ArchivedItem {
  controllerId: string;
  ts: number;
  streamId: string;
  senderType: string;
  senderIp?: string;
  payloadRaw: string;
  kind: string;
  measures: Record<string, number>;
  state: Record<string, string | number | boolean>;
  repeated: number;
  lastTs: number;
  commsResumed?: boolean;
}

interface HistoryItem extends ArchivedItem {
  ttl: number;
}

// --- config helpers (read at call time so tests / App Runner env changes apply) ---

export function archiveEnabled(): boolean {
  return process.env.ARCHIVE_ENABLED === 'true';
}
function tableName(): string {
  return process.env.DDB_HISTORY_TABLE || 'controller-history';
}
export function retentionDays(): number {
  const raw = parseInt(process.env.ARCHIVE_RETENTION_DAYS || '4', 10);
  const n = Number.isFinite(raw) && raw > 0 ? raw : 4;
  return Math.min(n, 7); // hard cap per spec FR-4
}
function maxRawPoints(): number {
  const raw = parseInt(process.env.ANALYTICS_MAX_RAW_POINTS || '5000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}
/** Gap beyond which an unchanged heartbeat is treated as comms-resume, not a repeat. */
function gapMs(): number {
  const raw = parseInt(process.env.ARCHIVE_GAP_SECONDS || '60', 10);
  return (Number.isFinite(raw) && raw > 0 ? raw : 60) * 1000;
}

/** Cheap, network-free snapshot of archive config for health/observability. */
export function archiveConfig(): {
  enabled: boolean;
  store: string;
  table: string;
  retentionDays: number;
} {
  return {
    enabled: archiveEnabled(),
    store: process.env.ARCHIVE_STORE || 'dynamodb',
    table: tableName(),
    retentionDays: retentionDays(),
  };
}

// --- telemetry extraction (pure, exported for tests) ---

function findTelemetryNode(value: unknown, depth = 0): Record<string, any> | null {
  if (depth > 8 || value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, any>;
  // Hvac: `temperture` (sic, per bossmarine.proto). Utility: `temperature` + `battery`.
  if (typeof obj.temperture === 'number') return obj;
  if (typeof obj.temperature === 'number' && typeof obj.battery === 'number') return obj;
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = findTelemetryNode(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Pull the numeric measures + categorical state out of a decoded heartbeat.
 * Returns null for payloads that aren't telemetry (command responses, etc.) —
 * those are not archived.
 */
export function extractTelemetry(decoded: DecodedPayload | null): Telemetry | null {
  if (!decoded) return null;
  const node = findTelemetryNode(decoded.data);
  if (!node) return null;

  const measures: Record<string, number> = {};
  const state: Record<string, string | number | boolean> = {};
  const set = (k: string, v: number | undefined) => {
    if (v !== undefined) measures[k] = v;
  };

  if (typeof node.temperture === 'number') {
    // Hvac
    set('temperatureF', num(node.temperture));
    set('humidity', num(node.humidity));
    set('voltageMv', num(node.voltage));
    set('powerRate', num(node.powerRate));
    set('powerTotal', num(node.powerTotal));
    set('budgetSecondsSinceReset', num(node.budget_seconds_since_reset));
    const cfg = node.config;
    if (cfg && typeof cfg === 'object') {
      set('fanSpeed', num(cfg.fan?.speed));
      set('compressorSpeed', num(cfg.compressor?.speed));
      if (cfg.mode !== undefined) state.mode = cfg.mode;
      if (cfg.compressor?.state !== undefined) state.compressorState = cfg.compressor.state;
    }
    if (node.high_pressure !== undefined) state.highPressure = node.high_pressure;
    if (node.low_pressure !== undefined) state.lowPressure = node.low_pressure;
    return { kind: 'hvac', measures, state };
  }

  // Utility
  set('temperatureF', num(node.temperature));
  set('humidity', num(node.humidity));
  set('battery', num(node.battery));
  set('voltageMv', num(node.voltage));
  return { kind: 'utility', measures, state };
}

/**
 * Measures intentionally excluded from change-detection. `powerTotal` is a
 * monotonic accumulator and `powerRate` drifts continuously, so including
 * either would force a brand-new change-point on nearly every heartbeat of a
 * running machine — defeating compression. They are still stored on every
 * retained point and, via latest-wins on duplicates, always reflect the most
 * recent reading at `lastTs`. (`budgetSecondsSinceReset` is another monotonic
 * counter that could be added here if firmware starts emitting it.)
 */
const FINGERPRINT_EXCLUDED_MEASURES = new Set(['powerRate', 'powerTotal']);

/**
 * Deterministic fingerprint of a telemetry reading for change-detection.
 * Floats are rounded to 2 decimals so jitter doesn't defeat the dedup, and
 * continuously-moving power measures are excluded entirely. Keys sorted for
 * stability.
 */
export function fingerprint(t: Telemetry): string {
  const round = (n: number) => Math.round(n * 100) / 100;
  const m = Object.keys(t.measures)
    .filter((k) => !FINGERPRINT_EXCLUDED_MEASURES.has(k))
    .sort()
    .map((k) => `${k}=${round(t.measures[k])}`)
    .join(',');
  const s = Object.keys(t.state)
    .sort()
    .map((k) => `${k}=${t.state[k]}`)
    .join(',');
  return `${t.kind}|${m}|${s}`;
}

// --- store ---

interface DedupEntry {
  sk: number; // ts (sort key) of the active change-point item
  fingerprint: string;
  lastTs: number;
  seeded: boolean;
}

export class ArchiveStore {
  private doc: DynamoDBDocumentClient;
  private dedup = new Map<number, DedupEntry>();

  constructor(doc?: DynamoDBDocumentClient) {
    this.doc = doc ?? ArchiveStore.defaultClient();
  }

  private static defaultClient(): DynamoDBDocumentClient {
    const cfg = getAWSConfig();
    const hasCreds = !!(cfg.accessKeyId && cfg.secretAccessKey);
    const base = new DynamoDBClient({
      region: cfg.region,
      ...(hasCreds && {
        credentials: { accessKeyId: cfg.accessKeyId!, secretAccessKey: cfg.secretAccessKey! },
      }),
    });
    return DynamoDBDocumentClient.from(base);
  }

  /**
   * Persist a heartbeat as a change-point, or extend the previous one's
   * `repeated`/`lastTs` if telemetry is unchanged. Best-effort: callers must
   * NOT await this on the hot path, and any throw is swallowed.
   */
  async write(input: ArchiveWriteInput): Promise<void> {
    if (!archiveEnabled()) return;
    try {
      const telemetry = extractTelemetry(decodePayload(input.payloadRaw));
      if (!telemetry) return; // not a heartbeat — nothing to archive

      const fp = fingerprint(telemetry);
      const prev = await this.getDedup(input.controllerId);

      const unchanged = prev && prev.fingerprint === fp;
      const gapped = prev && input.ts - prev.lastTs > gapMs();

      if (unchanged && !gapped) {
        // Latest-wins: bump repeated, advance lastTs, and refresh the stored
        // reading to this (newest) heartbeat. The change-point's `ts` (sort
        // key) stays anchored at when the value first appeared, but its
        // measures/payload/streamId now correspond to `lastTs` — so power
        // measures match the current/end position of the run rather than its
        // start. (`state` is a DynamoDB reserved word, hence the alias.)
        await this.doc.send(
          new UpdateCommand({
            TableName: tableName(),
            Key: { controllerId: String(input.controllerId), ts: prev!.sk },
            UpdateExpression:
              'ADD repeated :one SET lastTs = :ts, measures = :m, #state = :s, payloadRaw = :p, streamId = :sid',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':one': 1,
              ':ts': input.ts,
              ':m': telemetry.measures,
              ':s': telemetry.state,
              ':p': input.payloadRaw,
              ':sid': input.streamId,
            },
          }),
        );
        prev!.lastTs = input.ts;
        return;
      }

      const item: HistoryItem = {
        controllerId: String(input.controllerId),
        ts: input.ts,
        streamId: input.streamId,
        senderType: input.senderType,
        ...(input.senderIp ? { senderIp: input.senderIp } : {}),
        payloadRaw: input.payloadRaw,
        kind: telemetry.kind,
        measures: telemetry.measures,
        state: telemetry.state,
        repeated: 0,
        lastTs: input.ts,
        ...(gapped ? { commsResumed: true } : {}),
        ttl: Math.floor(input.ts / 1000) + retentionDays() * 86400,
      };
      await this.doc.send(new PutCommand({ TableName: tableName(), Item: item }));
      this.dedup.set(input.controllerId, {
        sk: input.ts,
        fingerprint: fp,
        lastTs: input.ts,
        seeded: true,
      });
    } catch (err: any) {
      console.warn(`[Archive] write failed (non-fatal) for controller ${input.controllerId}: ${err?.message ?? err}`);
    }
  }

  /**
   * Seed/return the dedup entry for a controller. On a cold cache we read the
   * latest stored change-point so a process restart doesn't emit a spurious
   * change-point for an unchanged device.
   */
  private async getDedup(controllerId: number): Promise<DedupEntry | null> {
    const cached = this.dedup.get(controllerId);
    if (cached) return cached;
    try {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: tableName(),
          KeyConditionExpression: 'controllerId = :c',
          ExpressionAttributeValues: { ':c': String(controllerId) },
          ScanIndexForward: false,
          Limit: 1,
        }),
      );
      const latest = res.Items?.[0] as HistoryItem | undefined;
      if (!latest) return null;
      const entry: DedupEntry = {
        sk: latest.ts,
        fingerprint: fingerprint({ kind: latest.kind as any, measures: latest.measures, state: latest.state }),
        lastTs: latest.lastTs ?? latest.ts,
        seeded: true,
      };
      this.dedup.set(controllerId, entry);
      return entry;
    } catch {
      return null; // treat as no prior — write will PutItem a fresh point
    }
  }

  /**
   * Query history for one controller over [from, to], optionally downsampled.
   * Change-points are piecewise-constant: a value holds until the next point.
   * For raw we return the change-points directly (already deduped); for a
   * time resolution we bucket and emit avg/min/max per numeric measure.
   * Returns the *effective* resolution, which may be escalated past `raw` if
   * the change-point count would exceed ANALYTICS_MAX_RAW_POINTS.
   */
  async query(
    controllerId: number,
    from: number,
    to: number,
    resolution: Resolution = 'raw',
    measures?: string[],
  ): Promise<AnalyticsResult> {
    const nowSec = Math.floor(Date.now() / 1000);

    // Carry-in: the change-point active at `from` (last point with ts <= from).
    const carry = await this.doc.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'controllerId = :c AND ts <= :from',
        FilterExpression: '#ttl > :now',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':c': String(controllerId), ':from': from, ':now': nowSec },
        ScanIndexForward: false,
        Limit: 1,
      }),
    );

    // In-window change-points (from, to].
    const inWindow = await this.doc.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'controllerId = :c AND ts BETWEEN :from AND :to',
        FilterExpression: '#ttl > :now',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':c': String(controllerId),
          ':from': from + 1,
          ':to': to,
          ':now': nowSec,
        },
        ScanIndexForward: true,
      }),
    );

    const carryItem = carry.Items?.[0] as HistoryItem | undefined;
    const windowItems = (inWindow.Items ?? []) as HistoryItem[];
    const points: HistoryItem[] = [...(carryItem ? [carryItem] : []), ...windowItems];

    let effective = resolution;
    if (resolution === 'raw' && windowItems.length > maxRawPoints()) {
      effective = windowItems.length > maxRawPoints() * 12 ? '1h' : windowItems.length > maxRawPoints() ? '5m' : '1m';
    }

    const measureFilter = measures && measures.length > 0 ? new Set(measures) : null;

    if (effective === 'raw') {
      return {
        controllerId,
        from,
        to,
        resolution: 'raw',
        points: points
          .filter((p) => p.ts >= from && p.ts <= to)
          .map((p) => this.rawPoint(p, measureFilter)),
      };
    }

    return {
      controllerId,
      from,
      to,
      resolution: effective,
      points: this.bucket(points, from, to, RESOLUTION_MS[effective as Exclude<Resolution, 'raw'>], measureFilter),
    };
  }

  private rawPoint(item: HistoryItem, measureFilter: Set<string> | null): AnalyticsPoint {
    const p: AnalyticsPoint = { ts: item.ts };
    for (const [k, v] of Object.entries(item.measures || {})) {
      if (!measureFilter || measureFilter.has(k)) p[k] = v;
    }
    return p;
  }

  /**
   * Bucket piecewise-constant change-points into fixed windows. For each
   * bucket we aggregate every value *active* during the window: the change-
   * points landing inside it plus the value carried in from before it.
   */
  private bucket(
    points: HistoryItem[],
    from: number,
    to: number,
    width: number,
    measureFilter: Set<string> | null,
  ): AnalyticsPoint[] {
    const out: AnalyticsPoint[] = [];
    const sorted = points.slice().sort((a, b) => a.ts - b.ts);
    const bucketStart = Math.floor(from / width) * width;

    for (let b = bucketStart; b < to; b += width) {
      const bEnd = b + width;
      // carry = last change-point at or before bucket start
      let carry: HistoryItem | undefined;
      const inside: HistoryItem[] = [];
      for (const p of sorted) {
        if (p.ts < b) carry = p;
        else if (p.ts >= b && p.ts < bEnd) inside.push(p);
      }
      const active = [...(carry ? [carry] : []), ...inside];
      if (active.length === 0) continue;

      const agg: Record<string, number[]> = {};
      for (const p of active) {
        for (const [k, v] of Object.entries(p.measures || {})) {
          if (measureFilter && !measureFilter.has(k)) continue;
          (agg[k] ??= []).push(v);
        }
      }
      if (Object.keys(agg).length === 0) continue;

      const point: AnalyticsPoint = { ts: b };
      for (const [k, vals] of Object.entries(agg)) {
        point[k] = {
          avg: vals.reduce((s, v) => s + v, 0) / vals.length,
          min: Math.min(...vals),
          max: Math.max(...vals),
        };
      }
      out.push(point);
    }
    return out;
  }

  /**
   * Reconnect fallback (FR-7): change-points strictly after `sinceTs`, oldest
   * first, as raw history items. The caller merges these with live Redis
   * entries. Returns deduped state-changes, not every redundant heartbeat.
   */
  async getSince(controllerId: number, sinceTs: number, limit: number): Promise<ArchivedItem[]> {
    const nowSec = Math.floor(Date.now() / 1000);
    const res = await this.doc.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'controllerId = :c AND ts > :since',
        FilterExpression: '#ttl > :now',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':c': String(controllerId), ':since': sinceTs, ':now': nowSec },
        ScanIndexForward: true,
        Limit: limit,
      }),
    );
    return (res.Items ?? []) as HistoryItem[];
  }

  async health(): Promise<{ enabled: boolean; store: string; table: string; reachable?: boolean }> {
    const base = { enabled: archiveEnabled(), store: 'dynamodb', table: tableName() };
    if (!base.enabled) return base;
    try {
      await this.doc.send(
        new QueryCommand({
          TableName: tableName(),
          KeyConditionExpression: 'controllerId = :c',
          ExpressionAttributeValues: { ':c': '__health__' },
          Limit: 1,
        }),
      );
      return { ...base, reachable: true };
    } catch {
      return { ...base, reachable: false };
    }
  }
}

let singleton: ArchiveStore | null = null;
export function getArchiveStore(): ArchiveStore {
  if (!singleton) singleton = new ArchiveStore();
  return singleton;
}
