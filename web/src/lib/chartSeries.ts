import type { AnalyticsSeries } from './types';

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
): Array<{ path: string; v: number; sampleT: number }> {
  const out: Array<{ path: string; v: number; sampleT: number }> = [];
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
  v: number;
  // Set on alarm-typed fields. The tooltip renders these as Yes/No, groups
  // them after the data rows, and highlights the row when v is truthy.
  alarm?: boolean;
}

// The latched *Alarm config flags plus the real-time pressure event fields.
function isAlarmLeaf(leaf: string): boolean {
  return /alarm$/i.test(leaf) || leaf === 'highPressure' || leaf === 'lowPressure';
}

// Split a stateAt() snapshot into user-facing tooltip sections: anything
// routed through a `config` node is a Setting, everything else is live State.
// Labels are shortened — settings keep the path after `config.` (so fan.speed
// and compressor.speed stay distinct) and state drops the message + device
// prefix (e.g. syncDevice2Controller.hvac.). The controllerId leaf is just
// the device's own id, so it is dropped.
export function groupState(rows: Array<{ path: string; v: number }>): {
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
        label: segments.slice(configIdx + 1).join('.'),
        v: row.v,
        ...alarm,
      });
    } else {
      state.push({
        label: segments.length > 2 ? segments.slice(2).join('.') : leaf,
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
  for (const p of series[primaryPath] || []) {
    map.set(p.t, { t: p.t, primary: p.v });
  }
  for (const p of series[secondaryPath] || []) {
    const row = map.get(p.t);
    if (row) row.secondary = p.v;
    else map.set(p.t, { t: p.t, secondary: p.v });
  }
  const rows = Array.from(map.values()).sort((a, b) => a.t - b.t);

  const primaryPoints = [...(series[primaryPath] || [])].sort(
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
