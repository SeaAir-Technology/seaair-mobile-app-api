import { budgetUsedPct, cockpitAt, latestT } from '../lib/chartSeries';
import type { AnalyticsSeries } from '../lib/types';
import { modeTheme } from '../lib/modeColors';
import { titleCase } from '../lib/heartbeat';

const DASH = '—';

// Speed 0 on the wire is the Auto setting, not "stopped" — the firmware picks
// the actual speed from the temperature delta.
function speedLabel(speed: number | undefined): string {
  if (speed === undefined) return DASH;
  return speed === 0 ? 'Auto' : String(speed);
}

function Cell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | undefined;
  tone?: 'amber' | 'emerald';
}): JSX.Element {
  const valueClass =
    value === undefined
      ? 'text-ink-300'
      : tone === 'amber'
      ? 'text-amber-700'
      : tone === 'emerald'
      ? 'text-emerald-700'
      : 'text-ink-800';
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-ink-400 whitespace-nowrap">
        {label}
      </div>
      <div
        className={`text-[13px] font-semibold tabular-nums whitespace-nowrap ${valueClass}`}
      >
        {value ?? DASH}
      </div>
    </div>
  );
}

// Docked readout under each analytics chart: the machine's full state at the
// hovered timestamp, in one fixed strip that never covers the plot. With the
// pointer off the chart it shows the newest values in the window, so it
// doubles as a "now" readout. Same visual language as the Current State
// cockpit — the mode cell uses the chart shading colors.
export function ChartStateStrip({
  series,
  hoverT,
}: {
  series: AnalyticsSeries;
  hoverT: number | null;
}): JSX.Element | null {
  const t = hoverT ?? latestT(series);
  if (t === null) return null;
  const c = cockpitAt(series, t);
  const theme = modeTheme(c.mode);
  const budgetPct = budgetUsedPct(c);
  const delta =
    c.temp !== undefined && c.setpoint !== undefined ? c.temp - c.setpoint : undefined;

  return (
    // Phone: two decks — mode + timestamp header over a 3-column cell grid.
    // md+: everything joins one flex row (the wrappers become display:
    // contents), identical to the desktop strip.
    <div className="mt-2 bg-ink-50 border border-ink-200 rounded px-3 py-1.5 flex flex-col gap-2 md:flex-row md:items-center md:gap-x-4 md:gap-y-1 md:flex-wrap">
      <div className="flex items-center justify-between gap-2 md:contents">
        <div
          className="rounded px-2 py-0.5 md:self-stretch flex flex-col justify-center"
          style={{ backgroundColor: theme.bg, border: `1px solid ${theme.border}` }}
        >
          <div
            className="text-[10px] uppercase tracking-wide whitespace-nowrap"
            style={{ color: theme.label }}
          >
            Mode
          </div>
          <div
            className="text-[13px] font-semibold whitespace-nowrap"
            style={{ color: theme.value }}
          >
            {c.mode ? titleCase(c.mode) : DASH}
          </div>
        </div>
        <div className="text-right md:order-last md:ml-auto">
          <div className="text-[10px] uppercase tracking-wide text-ink-400">
            {hoverT === null ? 'Latest' : 'At'}
          </div>
          <div className="text-[12px] text-ink-600 tabular-nums whitespace-nowrap">
            {new Date(t).toLocaleString()}
            {c.version ? ` · fw ${c.version}` : ''}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 md:contents">
      <Cell
        label="Cabin → set"
        value={
          c.temp !== undefined || c.setpoint !== undefined
            ? `${c.temp !== undefined ? `${c.temp}°` : DASH} → ${
                c.setpoint !== undefined ? `${c.setpoint}°` : DASH
              }`
            : undefined
        }
        tone={
          delta === undefined ? undefined : delta === 0 ? 'emerald' : 'amber'
        }
      />
      <Cell
        label="Humidity"
        value={
          c.humidity !== undefined || c.targetHumidity !== undefined
            ? `${c.humidity !== undefined ? `${c.humidity}%` : DASH} / ${
                c.targetHumidity !== undefined ? `${c.targetHumidity}%` : DASH
              }`
            : undefined
        }
      />
      <Cell
        label="Comp · fan"
        value={
          c.compressorState !== undefined ||
          c.compressorSpeed !== undefined ||
          c.fanSpeed !== undefined
            ? `${c.compressorState ? titleCase(c.compressorState) : DASH}·${speedLabel(
                c.compressorSpeed
              )} · ${speedLabel(c.fanSpeed)}`
            : undefined
        }
      />
      <Cell label="Rate" value={c.powerRate?.toFixed(1)} />
      <Cell label="Total" value={c.powerTotal?.toFixed(1)} />
      {/* powerTotal counted against the run's budget limit — a machine at
          100% has hit its budget and cycles down until the counter resets. */}
      {c.budgetEnabled && (
        <Cell
          label="Budget"
          value={budgetPct !== undefined ? `${Math.round(budgetPct)}%` : undefined}
          tone={budgetPct !== undefined && budgetPct >= 90 ? 'amber' : undefined}
        />
      )}
      <Cell
        label="Volts"
        value={c.voltage !== undefined ? c.voltage.toFixed(2) : undefined}
      />
      <div className="min-w-0 col-span-3 md:col-span-1">
        <div className="text-[10px] uppercase tracking-wide text-ink-400">
          Alarms
        </div>
        {c.alarms.length === 0 ? (
          <div className="text-[13px] font-semibold text-emerald-700 whitespace-nowrap">
            None
          </div>
        ) : (
          <div className="flex items-center gap-1 flex-wrap">
            {c.alarms.map((a) => (
              <span
                key={a}
                className="inline-flex items-center bg-red-50 text-red-700 border border-red-200 rounded px-1.5 text-[11px] font-medium whitespace-nowrap"
              >
                {a}
              </span>
            ))}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
