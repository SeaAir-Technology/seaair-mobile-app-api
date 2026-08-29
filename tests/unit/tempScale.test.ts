import { describe, it, expect } from 'vitest';
import {
  TEMP_SCALES,
  bandColor,
  tempDomain,
  gradientStops,
  segmentScales,
} from '../../web/src/lib/tempScale';
import type { ModeSegment } from '../../web/src/lib/chartSeries';

describe('bandColor', () => {
  it('maps cooling bands per the spec (5° buckets)', () => {
    const cool = TEMP_SCALES.COOL;
    expect(bandColor(cool, 92)).toBe('#dc2626'); // red 90+
    expect(bandColor(cool, 87)).toBe('#ea580c'); // orange 85–90
    expect(bandColor(cool, 82)).toBe('#ca8a04'); // amber 80–85
    expect(bandColor(cool, 77)).toBe('#0d9488'); // green-blue 75–80
    expect(bandColor(cool, 72)).toBe('#2563eb'); // blue 70–75
    expect(bandColor(cool, 65)).toBe('#4338ca'); // purple-blue below 70
  });

  it('shifts the heating scale −15° so warmth reads from 65+', () => {
    const heat = TEMP_SCALES.HEAT;
    expect(bandColor(heat, 77)).toBe('#dc2626');
    expect(bandColor(heat, 67)).toBe('#ca8a04');
    expect(bandColor(heat, 52)).toBe('#4338ca');
  });
});

describe('tempDomain', () => {
  it('pads to even bounds around the data', () => {
    expect(tempDomain([79.8, 88.7])).toEqual([78, 90]);
  });

  it('enforces a minimum 8° span on flat data', () => {
    const [lo, hi] = tempDomain([80, 80.4])!;
    expect(hi - lo).toBeGreaterThanOrEqual(8);
    expect(lo).toBeLessThan(80);
    expect(hi).toBeGreaterThan(80.4);
  });

  it('returns null with no samples', () => {
    expect(tempDomain([])).toBeNull();
  });
});

describe('gradientStops', () => {
  it('feathers each band edge by ±1° and stays sorted 0..1', () => {
    const stops = gradientStops(TEMP_SCALES.COOL, 78, 90);
    expect(stops[0]).toEqual({ offset: 0, color: '#0d9488' });
    // 90° edge sits on the domain bound: orange holds until 89°, red at the top
    expect(stops[stops.length - 1]).toEqual({ offset: 1, color: '#dc2626' });
    // 80° edge: teal until 79°, amber from 81°
    const teal = stops.find((s) => s.color === '#0d9488' && s.offset > 0);
    const amber = stops.find((s) => s.color === '#ca8a04');
    const orange = stops.filter((s) => s.color === '#ea580c').pop();
    expect(teal!.offset).toBeCloseTo((79 - 78) / 12);
    expect(amber!.offset).toBeCloseTo((81 - 78) / 12);
    expect(orange!.offset).toBeCloseTo((89 - 78) / 12);
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i].offset).toBeGreaterThanOrEqual(stops[i - 1].offset);
    }
  });

  it('skips edges outside the visible domain', () => {
    const stops = gradientStops(TEMP_SCALES.COOL, 81, 84); // entirely inside amber
    expect(stops).toEqual([
      { offset: 0, color: '#ca8a04' },
      { offset: 1, color: '#ca8a04' },
    ]);
  });
});

describe('segmentScales', () => {
  const seg = (mode: string): ModeSegment => ({ from: 0, to: 1, mode });

  it('gives conditioning modes their own scale', () => {
    expect(segmentScales([seg('COOL'), seg('HEAT')])).toEqual(['COOL', 'HEAT']);
  });

  it('standby inherits the previous run, or the next when leading', () => {
    expect(
      segmentScales([seg('STANDBY'), seg('HEAT'), seg('STANDBY'), seg('COOL'), seg('STANDBY')])
    ).toEqual(['HEAT', 'HEAT', 'HEAT', 'COOL', 'COOL']);
  });

  it('defaults to the cooling scale when nothing conditions', () => {
    expect(segmentScales([seg('STANDBY'), seg('FAN')])).toEqual(['COOL', 'COOL']);
    expect(segmentScales([])).toEqual([]);
  });
});
