import { useState } from 'react';
import { useDeviceAnalytics } from '../../hooks/useDeviceAnalytics';
import { Spinner } from '../../components/Spinner';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

const WINDOWS = ['1h', '6h', '24h', '7d'] as const;

// The backend's analytics endpoint extracts every numeric leaf from decoded
// protobuf payloads in the window and returns them as named series. We just
// let the user pick which series to chart. Once the proto field semantics
// are firmer (power, runtime, cycle freq), we can promote those into a
// dedicated set of always-visible cards.
export function Analytics({
  controllerId,
}: {
  controllerId: number;
}): JSX.Element {
  const [windowExpr, setWindowExpr] = useState<string>('24h');
  const [selectedSeries, setSelectedSeries] = useState<string | null>(null);
  const { data, isLoading, error } = useDeviceAnalytics(
    controllerId,
    windowExpr
  );

  const allSeries = data?.seriesNames || [];
  const active =
    selectedSeries && allSeries.includes(selectedSeries)
      ? selectedSeries
      : allSeries[0] || null;
  const chartData =
    data && active ? data.series[active].map((p) => ({ t: p.t, v: p.v })) : [];

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-ink-500">Window:</span>
        {WINDOWS.map((w) => (
          <button
            key={w}
            onClick={() => setWindowExpr(w)}
            className={`px-2 py-0.5 text-xs rounded ${
              windowExpr === w
                ? 'bg-ink-800 text-white'
                : 'border border-ink-300 text-ink-700'
            }`}
          >
            {w}
          </button>
        ))}
      </div>
      {isLoading && <Spinner label="Loading analytics…" />}
      {error && (
        <div className="text-red-600 text-sm">{(error as Error).message}</div>
      )}
      {data && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-ink-500">Series:</span>
            {allSeries.length === 0 && (
              <span className="text-xs text-ink-500">
                No numeric fields found in window.
              </span>
            )}
            {allSeries.map((name) => (
              <button
                key={name}
                onClick={() => setSelectedSeries(name)}
                className={`px-2 py-0.5 text-xs rounded font-mono ${
                  active === name
                    ? 'bg-ink-800 text-white'
                    : 'border border-ink-300 text-ink-700'
                }`}
              >
                {name}
              </button>
            ))}
          </div>
          {active && chartData.length > 0 && (
            <div className="bg-white border border-ink-200 rounded p-3">
              <div className="text-xs text-ink-500 mb-2 font-mono">{active}</div>
              <div style={{ width: '100%', height: 280 }}>
                <ResponsiveContainer>
                  <LineChart data={chartData}>
                    <CartesianGrid stroke="#eef0f3" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="t"
                      tickFormatter={(t) =>
                        new Date(t).toLocaleTimeString(undefined, {
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      }
                      tick={{ fontSize: 11 }}
                    />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip
                      labelFormatter={(t) =>
                        new Date(t as number).toLocaleString()
                      }
                    />
                    <Line
                      type="monotone"
                      dataKey="v"
                      stroke="#1c2230"
                      dot={false}
                      strokeWidth={1.5}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="text-xs text-ink-500 mt-2">
                {chartData.length} samples · scanned {data.scanned} messages
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
