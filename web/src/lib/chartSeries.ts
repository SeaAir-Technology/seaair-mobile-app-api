import type { AnalyticsSeries } from './types';

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

export interface GroupedStateRow {
  label: string;
  v: number | string;
  // Set on alarm-typed fields. The tooltip renders these as Yes/No, groups
  // them after the data rows, and highlights the row when v is truthy.
  alarm?: boolean;
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

// The proto misspells temperature two different ways (hvac.temperture,
// config.tempreature). Those are wire field names we can't rename, but the
// tooltip labels don't have to repeat them.
const LEAF_SPELLING: Record<string, string> = {
  temperture: 'temperature',
  tempreature: 'temperature',
};

function fixSpelling(label: string): string {
  return label
    .split('.')
    .map((s) => LEAF_SPELLING[s] ?? s)
    .join('.');
}

// Split a stateAt() snapshot into user-facing tooltip sections: anything
// routed through a `config` node is a Setting, everything else is live State.
// Labels are shortened — settings keep the path after `config.` (so fan.speed
// and compressor.speed stay distinct) and state drops the message + device
// prefix (e.g. syncDevice2Controller.hvac.). The controllerId leaf is just
// the device's own id, so it is dropped.
export function groupState(rows: Array<{ path: string; v: number | string }>): {
  settings: GroupedStateRow[];
  state: GroupedStateRow[];
} {
  const settings: GroupedStateRow[] = [];
  const state: GroupedStateRow[] = [];
  for (const row of rows) {
    const segments = row.path.split('.');
    const leaf = segments[segments.length - 1];
    if (leaf === 'controllerId') continue;
    const alarm = isAlarmLeaf(leaf) ? { alarm: true } : {};
    const configIdx = segments.indexOf('config');
    if (configIdx >= 0 && configIdx < segments.length - 1) {
      settings.push({
        label: fixSpelling(segments.slice(configIdx + 1).join('.')),
        v: row.v,
        ...alarm,
      });
    } else {
      state.push({
        label: fixSpelling(
          segments.length > 2 ? segments.slice(2).join('.') : leaf
        ),
        v: row.v,
        ...alarm,
      });
    }
  }
  // Data rows first (alphabetical), then alarm rows grouped at the bottom.
  const byGroup = (a: GroupedStateRow, b: GroupedStateRow) =>
    Number(!!a.alarm) - Number(!!b.alarm) || a.label.localeCompare(b.label);
  settings.sort(byGroup);
  state.sort(byGroup);
  return { settings, state };
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
