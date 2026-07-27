import { describe, it, expect } from 'vitest';
import {
  mergeSeries,
  medianInterval,
  stateAt,
  groupState,
  modeSegments,
  alarmEdges,
  GAP_FACTOR,
} from '../../web/src/lib/chartSeries';

const PRIMARY = 'hvac.powerTotal';
const SECONDARY = 'hvac.temperture';

// Build a {t,v} series from [t, v] pairs (timestamps in seconds for
// readability; scaled to ms).
function pts(pairs: Array<[number, number]>) {
  return pairs.map(([t, v]) => ({ t: t * 1000, v }));
}

describe('medianInterval', () => {
  it('returns the median spacing between consecutive points', () => {
    expect(medianInterval(pts([[0, 0], [10, 0], [20, 0], [90, 0]]))).toBe(
      10_000
    );
  });

  it('returns null with fewer than two points', () => {
    expect(medianInterval([])).toBeNull();
    expect(medianInterval(pts([[5, 1]]))).toBeNull();
  });
});

describe('mergeSeries', () => {
  it('merges rows and sorts by timestamp', () => {
    const rows = mergeSeries(
      {
        [PRIMARY]: pts([[10, 100], [20, 110]]),
        [SECONDARY]: pts([[20, 72], [5, 71]]),
      },
      PRIMARY,
      SECONDARY
    );
    expect(rows.map((r) => r.t)).toEqual([5_000, 10_000, 20_000]);
    expect(rows[2]).toEqual({ t: 20_000, primary: 110, secondary: 72 });
  });

  it('interpolates usage on temperature-only rows within a normal interval', () => {
    // Usage every 10s; a temp sample lands between two usage samples.
    const rows = mergeSeries(
      {
        [PRIMARY]: pts([[0, 100], [10, 200], [20, 300]]),
        [SECONDARY]: pts([[15, 70]]),
      },
      PRIMARY,
      SECONDARY
    );
    const tempRow = rows.find((r) => r.t === 15_000)!;
    expect(tempRow.primary).toBe(250);
  });

  it('leaves usage undefined across a real outage so the chart shows a gap', () => {
    // Usage every 10s, then silent from t=20 to t=100 (well past
    // GAP_FACTOR x median). Temp keeps reporting through the outage.
    const rows = mergeSeries(
      {
        [PRIMARY]: pts([[0, 100], [10, 100], [20, 100], [100, 100], [110, 100]]),
        [SECONDARY]: pts([[40, 70], [60, 71], [80, 72]]),
      },
      PRIMARY,
      SECONDARY
    );
    for (const t of [40_000, 60_000, 80_000]) {
      const row = rows.find((r) => r.t === t)!;
      expect(row.primary).toBeUndefined();
      expect(row.secondary).toBeDefined();
    }
  });

  it('does not extrapolate usage before the first or after the last sample', () => {
    const rows = mergeSeries(
      {
        [PRIMARY]: pts([[10, 100], [20, 100]]),
        [SECONDARY]: pts([[0, 70], [30, 71]]),
      },
      PRIMARY,
      SECONDARY
    );
    expect(rows.find((r) => r.t === 0)!.primary).toBeUndefined();
    expect(rows.find((r) => r.t === 30_000)!.primary).toBeUndefined();
  });

  it('treats a gap just under the threshold as machine-on', () => {
    const interval = 10;
    const justUnder = interval * GAP_FACTOR - 1;
    const rows = mergeSeries(
      {
        [PRIMARY]: pts([
          [0, 100],
          [interval, 100],
          [interval * 2, 100],
          [interval * 2 + justUnder, 100],
        ]),
        [SECONDARY]: pts([[interval * 2 + 5, 70]]),
      },
      PRIMARY,
      SECONDARY
    );
    expect(rows.find((r) => r.t === (interval * 2 + 5) * 1000)!.primary).toBeDefined();
  });

  it('skips interpolation entirely when usage has one or zero samples', () => {
    const rows = mergeSeries(
      {
        [PRIMARY]: pts([[10, 100]]),
        [SECONDARY]: pts([[0, 70], [20, 71]]),
      },
      PRIMARY,
      SECONDARY
    );
    expect(rows.find((r) => r.t === 0)!.primary).toBeUndefined();
    expect(rows.find((r) => r.t === 20_000)!.primary).toBeUndefined();
    expect(rows.find((r) => r.t === 10_000)!.primary).toBe(100);
  });

  it('handles a missing series without throwing', () => {
    const rows = mergeSeries(
      { [SECONDARY]: pts([[0, 70]]) },
      PRIMARY,
      SECONDARY
    );
    expect(rows).toEqual([{ t: 0, secondary: 70 }]);
  });
});

describe('stateAt', () => {
  it('returns the latest sample at or before t for every path', () => {
    const state = stateAt(
      {
        [PRIMARY]: pts([[0, 100], [10, 110], [20, 120]]),
        [SECONDARY]: pts([[5, 70], [15, 71]]),
      },
      12_000
    );
    expect(state).toEqual([
      { path: PRIMARY, v: 110, sampleT: 10_000 },
      { path: SECONDARY, v: 70, sampleT: 5_000 },
    ]);
  });

  it('uses an exact-match sample when t lands on one', () => {
    const state = stateAt({ [PRIMARY]: pts([[0, 100], [10, 110]]) }, 10_000);
    expect(state).toEqual([{ path: PRIMARY, v: 110, sampleT: 10_000 }]);
  });

  it('omits paths with no sample at or before t', () => {
    const state = stateAt(
      {
        [PRIMARY]: pts([[20, 120]]),
        [SECONDARY]: pts([[5, 70]]),
      },
      10_000
    );
    expect(state).toEqual([{ path: SECONDARY, v: 70, sampleT: 5_000 }]);
  });

  it('sorts results by path name', () => {
    const state = stateAt(
      {
        'z.last': pts([[0, 1]]),
        'a.first': pts([[0, 2]]),
      },
      1_000
    );
    expect(state.map((s) => s.path)).toEqual(['a.first', 'z.last']);
  });
});

describe('groupState', () => {
  const row = (path: string, v: number) => ({ path, v });

  it('routes config paths to settings and the rest to state', () => {
    const { settings, state } = groupState([
      row('syncDevice2Controller.hvac.config.tempreature', 72),
      row('syncDevice2Controller.hvac.temperture', 74),
      row('syncDevice2Controller.hvac.highPressure', 1),
    ]);
    expect(settings).toEqual([{ label: 'tempreature', v: 72 }]);
    expect(state).toEqual([
      { label: 'temperture', v: 74 },
      { label: 'highPressure', v: 1, alarm: true },
    ]);
  });

  it('flags alarm fields regardless of value and groups them last', () => {
    const { settings, state } = groupState([
      row('syncDevice2Controller.hvac.lowPressure', 1),
      row('syncDevice2Controller.hvac.voltage', 12000),
      row('syncDevice2Controller.hvac.highPressure', 0),
      row('syncDevice2Controller.hvac.config.highPressureAlarm', 1),
      row('syncDevice2Controller.hvac.config.fan.speed', 2),
      row('syncDevice2Controller.hvac.config.lowPressureAlarm', 0),
    ]);
    expect(state).toEqual([
      { label: 'voltage', v: 12000 },
      { label: 'highPressure', v: 0, alarm: true },
      { label: 'lowPressure', v: 1, alarm: true },
    ]);
    expect(settings).toEqual([
      { label: 'fan.speed', v: 2 },
      { label: 'highPressureAlarm', v: 1, alarm: true },
      { label: 'lowPressureAlarm', v: 0, alarm: true },
    ]);
  });

  it('keeps the sub-path after config so sibling leaves stay distinct', () => {
    const { settings } = groupState([
      row('syncDevice2Controller.hvac.config.fan.speed', 1),
      row('syncDevice2Controller.hvac.config.compressor.speed', 3),
      row('syncDevice2Controller.hvac.config.highPressureAlarm', 0),
    ]);
    expect(settings.map((s) => s.label)).toEqual([
      'compressor.speed',
      'fan.speed',
      'highPressureAlarm',
    ]);
  });

  it('drops the controllerId leaf', () => {
    const { settings, state } = groupState([
      row('syncDevice2Controller.hvac.controllerId', 101),
      row('syncDevice2Controller.hvac.voltage', 12000),
    ]);
    expect(settings).toEqual([]);
    expect(state).toEqual([{ label: 'voltage', v: 12000 }]);
  });

  it('falls back to the leaf name for short paths', () => {
    const { state } = groupState([row('hvac.humidity', 50)]);
    expect(state).toEqual([{ label: 'humidity', v: 50 }]);
  });

  it('carries enum string values through', () => {
    const { settings, state } = groupState([
      { path: 'syncDevice2Controller.hvac.config.mode', v: 'COOL' },
      { path: 'syncDevice2Controller.hvac.config.compressor.state', v: 'ON' },
    ]);
    expect(settings).toEqual([
      { label: 'compressor.state', v: 'ON' },
      { label: 'mode', v: 'COOL' },
    ]);
    expect(state).toEqual([]);
  });
});

describe('modeSegments', () => {
  const MODE = 'syncDevice2Controller.hvac.config.mode';

  it('merges consecutive same-mode samples and extends the last to endT', () => {
    const segs = modeSegments(
      {
        [MODE]: [
          { t: 0, v: 'COOL' },
          { t: 10, v: 'COOL' },
          { t: 20, v: 'HEAT' },
          { t: 30, v: 'STANDBY' },
        ],
      },
      50
    );
    expect(segs).toEqual([
      { from: 0, to: 20, mode: 'COOL' },
      { from: 20, to: 30, mode: 'HEAT' },
      { from: 30, to: 50, mode: 'STANDBY' },
    ]);
  });

  it('returns empty when no config.mode series exists', () => {
    expect(modeSegments({ 'hvac.temperture': [{ t: 0, v: 70 }] }, 10)).toEqual(
      []
    );
  });

  it('never ends the last segment before its start', () => {
    const segs = modeSegments({ [MODE]: [{ t: 40, v: 'FAN' }] }, 10);
    expect(segs).toEqual([{ from: 40, to: 40, mode: 'FAN' }]);
  });
});

describe('alarmEdges', () => {
  it('marks inactive-to-active transitions across all alarm series', () => {
    const edges = alarmEdges({
      'syncDevice2Controller.hvac.highPressure': [
        { t: 0, v: 0 },
        { t: 10, v: 1 },
        { t: 20, v: 1 },
        { t: 30, v: 0 },
        { t: 40, v: 1 },
      ],
      'syncDevice2Controller.hvac.config.lowPressureAlarm': [
        { t: 5, v: 1 }, // active at first sample counts as an edge
      ],
      'syncDevice2Controller.hvac.temperture': [{ t: 10, v: 99 }], // not an alarm
    });
    expect(edges).toEqual([5, 10, 40]);
  });

  it('returns empty when no alarms fire', () => {
    expect(
      alarmEdges({
        'syncDevice2Controller.hvac.highPressure': [
          { t: 0, v: 0 },
          { t: 10, v: 0 },
        ],
      })
    ).toEqual([]);
  });
});
