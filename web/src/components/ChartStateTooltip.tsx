import { stateAt, groupState } from '../lib/chartSeries';
import type { GroupedStateRow } from '../lib/chartSeries';
import type { AnalyticsSeries } from '../lib/types';

function formatValue(r: GroupedStateRow): string {
  if (r.alarm) return r.v !== 0 ? 'Yes' : 'No';
  if (typeof r.v === 'string') {
    // Enum values arrive as ALL_CAPS ("COOL", "BUDGET_RESET_HOURS_12");
    // prettify only those so other strings (firmware version) stay verbatim.
    if (/^[A-Z][A-Z0-9_]*$/.test(r.v)) {
      const s = r.v.toLowerCase().replace(/_/g, ' ');
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
    return r.v;
  }
  return Number.isInteger(r.v) ? String(r.v) : r.v.toFixed(2);
}

function AlarmIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      className="inline-block align-[-1px] mr-1 text-red-600"
      aria-label="alarm active"
    >
      <path d="M8 1.8 15 14H1z" fill="currentColor" />
      <path
        d="M8 6v3.6"
        stroke="white"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.9" r="1" fill="white" />
    </svg>
  );
}

function Section({
  title,
  rows,
}: {
  title: string;
  rows: GroupedStateRow[];
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <div className="mt-1.5">
      <div className="text-[10px] uppercase tracking-wide text-ink-400">
        {title}
      </div>
      <table>
        <tbody>
          {rows.map((r) => {
            const active = !!r.alarm && r.v !== 0;
            return (
              <tr key={r.label}>
                <td
                  className={`font-mono pr-3 whitespace-nowrap ${
                    active ? 'text-red-700' : 'text-ink-500'
                  }`}
                >
                  {active && <AlarmIcon />}
                  {r.label}
                </td>
                <td
                  className={`font-mono text-right whitespace-nowrap ${
                    active ? 'text-red-700' : 'text-ink-800'
                  }`}
                >
                  {formatValue(r)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Custom recharts tooltip that shows the machine's full state at the hovered
// timestamp — every series the analytics endpoint returned, not just the
// plotted lines — split into Settings (config) and State sections.
// recharts injects `active` and `label` (the x-axis t value).
export function ChartStateTooltip({
  series,
  active,
  label,
}: {
  series: AnalyticsSeries;
  active?: boolean;
  label?: number | string;
}): JSX.Element | null {
  if (!active || typeof label !== 'number') return null;
  const { settings, state } = groupState(stateAt(series, label));
  if (settings.length === 0 && state.length === 0) return null;
  return (
    <div className="bg-white border border-ink-200 rounded shadow-lg px-3 py-2 text-[11px] leading-4">
      <div className="text-ink-500">{new Date(label).toLocaleString()}</div>
      <Section title="Settings" rows={settings} />
      <Section title="State" rows={state} />
    </div>
  );
}
