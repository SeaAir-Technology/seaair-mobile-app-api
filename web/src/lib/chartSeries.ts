import type { AnalyticsSeries } from './types';
import { effectiveCompressorState } from './heartbeat';

type NumericPoint = { t: number; v: number };

// Series can carry enum strings ("COOL") alongside numbers; charts only draw
// the numeric points.
export function numericPoints(
  points: Array<{ t: number; v: number | string }> | undefined
): NumericPoint[] {
  return (points || []).filter(
    (p): p is NumericPoint => typeof p.v === 'number'
  );
}

// The machine reports power samples on a steady cadence while it is running,
// so a stretch with no primary samples means it was powered off. A gap counts
// as "off" when it exceeds GAP_FACTOR × the series' median reporting interval.
export const GAP_FACTOR = 2.5;

export function medianInterval(points: Array<{ t: number }>): number | null {
  if (points.length < 2) return null;
  const deltas: number[] = [];
  for (let i = 1; i < points.length; i++) {
    deltas.push(points[i].t - points[i - 1].t);
  }
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)];
}

// Snapshot of every series' value as of time t: for each path, the latest
// sample at or before t. The archive is change-point compressed, so an old
// sample simply means the value hasn't changed since — it is still the
// machine's state at t. Paths with no sample at or before t are omitted.
// Relies on each series being sorted ascending by t (the API guarantees this).
export function stateAt(
  series: AnalyticsSeries,
  t: number
): Array<{ path: string; v: number | string; sampleT: number }> {
  const out: Array<{ path: string; v: number | string; sampleT: number }> = [];
  for (const path of Object.keys(series).sort()) {
    const points = series[path];
    let lo = 0;
    let hi = points.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found >= 0) {
      out.push({ path, v: points[found].v, sampleT: points[found].t });
    }
  }
  return out;
}

// The latched *Alarm config flags plus the real-time pressure event fields.
function isAlarmLeaf(leaf: string): boolean {
  return (
    /alarm$/i.test(leaf) ||
    leaf === 'compressorShutdown' ||
    leaf === 'lowPressure' ||
    leaf === 'lowVoltage' ||
    leaf === 'highVoltage'
  );
}

const ALARM_LABELS: Record<string, string> = {
  compressorShutdown: 'Compressor shutdown',
  lowPressure: 'Low pressure',
  lowVoltage: 'Low voltage',
  highVoltage: 'High voltage',
};

// The machine's state at time t, shaped for the docked chart strip: known
// leaves picked off a stateAt() snapshot by path suffix. Voltage arrives
// already converted to volts by the analytics hook. Alarms combine the
// real-time event fields and the latched *Alarm config flags, deduped, in
// stable severity-agnostic order.
export interface StripState {
  at: number;
  mode?: string; // raw enum: STANDBY, COOL, HEAT, HUMIDITY, FAN
  temp?: number;
  setpoint?: number;
  humidity?: number;
  targetHumidity?: number;
  fanSpeed?: number;
  compressorState?: string; // raw enum: ON, OFF
  compressorSpeed?: number;
  powerRate?: number;
  powerTotal?: number;
  voltage?: number; // volts
  version?: string;
  alarms: string[];
}

export function cockpitAt(series: AnalyticsSeries, t: number): StripState {
  const out: StripState = { at: t, alarms: [] };
  const alarmSet = new Set<string>();
  for (const row of stateAt(series, t)) {
    const segments = row.path.split('.');
    const leaf = segments[segments.length - 1];
    const parent = segments[segments.length - 2];
    const inConfig = segments.includes('config');
    const n = typeof row.v === 'number' ? row.v : undefined;
    const s = typeof row.v === 'string' ? row.v : undefined;
    if (inConfig) {
      if (leaf === 'mode' && s) out.mode = s;
      else if (leaf === 'tempreature' && n) out.setpoint = n; // (sic); 0 = unset
      else if (leaf === 'humidity' && n) out.targetHumidity = n;
      else if (leaf === 'speed' && parent === 'fan' && n !== undefined) out.fanSpeed = n;
      else if (leaf === 'speed' && parent === 'compressor' && n !== undefined) out.compressorSpeed = n;
      else if (leaf === 'state' && parent === 'compressor' && s) out.compressorState = s;
      else if (/Alarm$/.test(leaf) && n) {
        const label = ALARM_LABELS[leaf.replace(/Alarm$/, '')];
        if (label) alarmSet.add(label);
      }
    } else {
      if (leaf === 'temperture' && n !== undefined) out.temp = n; // (sic)
      else if (leaf === 'humidity' && n !== undefined) out.humidity = n;
      else if (leaf === 'powerRate' && n !== undefined) out.powerRate = n;
      else if (leaf === 'powerTotal' && n !== undefined) out.powerTotal = n;
      else if (leaf === 'voltage' && n !== undefined) out.voltage = n;
      else if (leaf === 'version' && s) out.version = s;
      else if (ALARM_LABELS[leaf] && n) alarmSet.add(ALARM_LABELS[leaf]);
    }
  }
  out.alarms = Object.values(ALARM_LABELS).filter((l) => alarmSet.has(l));
  // Pre-v3.2 firmware reports the commanded config flag, not the live relay,
  // so the state can say "Off" mid-draw; the power rate is authoritative when
  // present (see effectiveCompressorState).
  out.compressorState = effectiveCompressorState(out.compressorState, out.powerRate);
  return out;
}

// Newest sample timestamp across all series — what the strip shows when the
// pointer isn't over the chart.
export function latestT(series: AnalyticsSeries): number | null {
  let max: number | null = null;
  for (const points of Object.values(series)) {
    const last = points[points.length - 1];
    if (last && (max === null || last.t > max)) max = last.t;
  }
  return max;
}

export interface ModeSegment {
  from: number;
  to: number;
  mode: string;
}

// Contiguous run-mode intervals for background shading. Reads the hvac
// config.mode series (found by path shape, so the message wrapper can vary)
// and merges consecutive same-mode samples. The last segment extends to endT
// (the chart's right edge); time before the first sample has unknown mode and
// gets no segment.
export function modeSegments(
  series: AnalyticsSeries,
  endT: number
): ModeSegment[] {
  const key = Object.keys(series).find((k) => {
    const segments = k.split('.');
    return segments[segments.length - 1] === 'mode' && segments.includes('config');
  });
  if (!key) return [];
  const points = series[key].filter(
    (p): p is { t: number; v: string } => typeof p.v === 'string'
  );
  if (points.length === 0) return [];
  const out: ModeSegment[] = [];
  let from = points[0].t;
  let mode = points[0].v;
  for (let i = 1; i < points.length; i++) {
    if (points[i].v !== mode) {
      out.push({ from, to: points[i].t, mode });
      from = points[i].t;
      mode = points[i].v;
    }
  }
  out.push({ from, to: Math.max(endT, from), mode });
  return out;
}

// Timestamps where any alarm goes from inactive to active (including an
// alarm already active at the first sample in the window), deduped across
// alarm fields for marker rendering.
export function alarmEdges(series: AnalyticsSeries): number[] {
  const edges = new Set<number>();
  for (const key of Object.keys(series)) {
    const segments = key.split('.');
    if (!isAlarmLeaf(segments[segments.length - 1])) continue;
    let prev = 0;
    for (const p of series[key]) {
      const v = typeof p.v === 'number' ? p.v : 0;
      if (v !== 0 && prev === 0) edges.add(p.t);
      prev = v;
    }
  }
  return Array.from(edges).sort((a, b) => a - b);
}

// Merge two {t,v} series into one row-per-timestamp dataset suitable for
// a recharts LineChart with two Lines. The secondary (temperature) line is
// drawn with connectNulls, so its sparse samples stay continuous. The primary
// (usage) line is not: rows inside a normal reporting interval get a linearly
// interpolated value so temperature-only timestamps don't punch holes in it,
// while rows inside a real outage stay undefined and render as a gap.
export function mergeSeries(
  series: AnalyticsSeries,
  primaryPath: string,
  secondaryPath: string
): Array<{ t: number; primary?: number; secondary?: number }> {
  const map = new Map<number, { t: number; primary?: number; secondary?: number }>();
  for (const p of numericPoints(series[primaryPath])) {
    map.set(p.t, { t: p.t, primary: p.v });
  }
  for (const p of numericPoints(series[secondaryPath])) {
    const row = map.get(p.t);
    if (row) row.secondary = p.v;
    else map.set(p.t, { t: p.t, secondary: p.v });
  }
  const rows = Array.from(map.values()).sort((a, b) => a.t - b.t);

  const primaryPoints = numericPoints(series[primaryPath]).sort(
    (a, b) => a.t - b.t
  );
  const interval = medianInterval(primaryPoints);
  if (interval === null || interval <= 0) return rows;
  const maxGap = interval * GAP_FACTOR;
  let next = 0;
  for (const row of rows) {
    if (row.primary !== undefined) continue;
    while (next < primaryPoints.length && primaryPoints[next].t <= row.t) {
      next++;
    }
    const before = primaryPoints[next - 1];
    const after = primaryPoints[next];
    if (!before || !after || after.t - before.t > maxGap) continue;
    const f = (row.t - before.t) / (after.t - before.t);
    row.primary = before.v + (after.v - before.v) * f;
  }
  return rows;
}
