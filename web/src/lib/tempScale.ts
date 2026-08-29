// Thermal color scale for the analytics temperature line.
//
// The line is colored by 5°F bands with a ±1° feather at each edge, and each
// operating mode uses its own scale: cool runs read against the cooling
// bands, heat runs against the heating bands (shifted −15°F so warmth reads
// from 65°+). Standby stretches inherit the scale of the run they follow —
// in real-world use that matches the season. Position on the axis still
// encodes the exact value, so the color is a redundant read.

import type { ModeSegment } from './chartSeries';

export type TempScaleKey = 'COOL' | 'HEAT';

/** [upper bound °F, color] — last band is open-ended. */
export interface TempScale {
  bands: Array<[number, string]>;
}

const INDIGO = '#4338ca';
const BLUE = '#2563eb';
const TEAL = '#0d9488';
// The 80–85 "yellow" band is amber: pure yellow disappears against the white
// standby background even with the line's white casing.
const AMBER = '#ca8a04';
const ORANGE = '#ea580c';
const RED = '#dc2626';

export const TEMP_SCALES: Record<TempScaleKey, TempScale> = {
  COOL: {
    bands: [
      [70, INDIGO],
      [75, BLUE],
      [80, TEAL],
      [85, AMBER],
      [90, ORANGE],
      [Infinity, RED],
    ],
  },
  HEAT: {
    bands: [
      [55, INDIGO],
      [60, BLUE],
      [65, TEAL],
      [70, AMBER],
      [75, ORANGE],
      [Infinity, RED],
    ],
  },
};

export function bandColor(scale: TempScale, temp: number): string {
  for (const [upper, color] of scale.bands) {
    if (temp < upper) return color;
  }
  return scale.bands[scale.bands.length - 1][1];
}

/**
 * Padded, even-numbered axis domain for the temperature line, never spanning
 * less than 8°F so sensor jitter on a flat day can't fill the plot. Null when
 * there are no samples.
 */
export function tempDomain(values: number[]): [number, number] | null {
  if (values.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  let lo = Math.floor((min - 1.2) / 2) * 2;
  let hi = Math.ceil((max + 1.2) / 2) * 2;
  while (hi - lo < 8) {
    lo -= 1;
    hi += 1;
  }
  return [lo, hi];
}

export interface GradientStop {
  /** 0 at `lo`, 1 at `hi`. */
  offset: number;
  color: string;
}

/**
 * Gradient stops for a scale across [lo, hi]: solid within each band, with a
 * ±1° blend at every band edge so a line hovering around an edge doesn't
 * flicker between colors.
 */
export function gradientStops(scale: TempScale, lo: number, hi: number): GradientStop[] {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const off = (v: number) => clamp((v - lo) / (hi - lo));
  const stops: GradientStop[] = [{ offset: 0, color: bandColor(scale, lo) }];
  for (const [upper] of scale.bands.slice(0, -1)) {
    // Include any edge whose ±1° feather overlaps the domain, clamped — an
    // edge sitting exactly on a domain bound still blends instead of leaving
    // a long unfeathered gradient to the endpoint stop.
    if (upper - 1 >= hi || upper + 1 <= lo) continue;
    stops.push({ offset: off(upper - 1), color: bandColor(scale, upper - 0.01) });
    stops.push({ offset: off(upper + 1), color: bandColor(scale, upper + 0.01) });
  }
  stops.push({ offset: 1, color: bandColor(scale, hi) });
  return stops.sort((a, b) => a.offset - b.offset);
}

/**
 * The scale each mode segment's stretch of line should use. COOL and HEAT map
 * to their own scale; everything else (STANDBY, HUMIDITY, FAN — modes that
 * don't condition temperature toward a warm/cool target) inherits the
 * previous conditioning run's scale, or the next one when the window opens
 * without a prior run. A window with no conditioning at all reads as COOL.
 */
export function segmentScales(segments: ModeSegment[]): TempScaleKey[] {
  const keys: Array<TempScaleKey | null> = segments.map((s) =>
    s.mode === 'COOL' || s.mode === 'HEAT' ? s.mode : null
  );
  for (let i = 1; i < keys.length; i++) {
    if (keys[i] === null) keys[i] = keys[i - 1];
  }
  for (let i = keys.length - 2; i >= 0; i--) {
    if (keys[i] === null) keys[i] = keys[i + 1];
  }
  return keys.map((k) => k ?? 'COOL');
}
