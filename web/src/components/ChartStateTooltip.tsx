import { stateAt } from '../lib/chartSeries';
import type { AnalyticsSeries } from '../lib/types';

function formatValue(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

// Custom recharts tooltip that shows the machine's full state at the hovered
// timestamp — every series the analytics endpoint returned, not just the
// plotted lines. recharts injects `active` and `label` (the x-axis t value).
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
  const rows = stateAt(series, label);
  if (rows.length === 0) return null;
  return (
    <div className="bg-white border border-ink-200 rounded shadow-lg px-3 py-2 text-[11px] leading-4">
      <div className="text-ink-500 mb-1">
        {new Date(label).toLocaleString()}
      </div>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.path}>
              <td className="font-mono text-ink-500 pr-3 whitespace-nowrap">
                {r.path}
              </td>
              <td className="font-mono text-ink-800 text-right whitespace-nowrap">
                {formatValue(r.v)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
