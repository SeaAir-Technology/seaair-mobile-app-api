import { describe, it, expect } from 'vitest';
import {
  mergeSeries,
  medianInterval,
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
