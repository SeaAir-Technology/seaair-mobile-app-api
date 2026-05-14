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
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { AnalyticsSeries } from '../../lib/types';

const WINDOWS = ['1h', '6h', '24h', '7d'] as const;

const TEMP_PATH = 'syncDevice2Controller.hvac.temperture';

const COMBOS = [
  {
    id: 'cycle-vs-temp',
    label: 'Cycle time vs temperature',
    primary: {
      path: 'syncDevice2Controller.hvac.powerRate',
      label: 'powerRate',
      color: '#1c2230',
    },
    secondary: { path: TEMP_PATH, label: 'temperture (°F)', color: '#c2410c' },
  },
  {
    id: 'power-vs-temp',
    label: 'Power use vs temperature',
    primary: {
      path: 'syncDevice2Controller.hvac.powerTotal',
      label: 'powerTotal',
      color: '#1c2230',
    },
    secondary: { path: TEMP_PATH, label: 'temperture (°F)', color: '#c2410c' },
  },
] as const;

type ComboId = (typeof COMBOS)[number]['id'];

// Merge two {t,v} series into one row-per-timestamp dataset suitable for
// a recharts LineChart with two Lines. Missing samples are left undefined
// and the lines are drawn with connectNulls so a sparse series doesn't
// punch holes through the denser one.
function mergeSeries(
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
  return Array.from(map.values()).sort((a, b) => a.t - b.t);
}

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
  const [activeComboId, setActiveComboId] = useState<ComboId>(COMBOS[0].id);
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

  const activeCombo =
    COMBOS.find((c) => c.id === activeComboId) || COMBOS[0];
  const comboData = data
    ? mergeSeries(data.series, activeCombo.primary.path, activeCombo.secondary.path)
    : [];
  const comboPrimaryAvailable = !!data?.series[activeCombo.primary.path]?.length;
  const comboSecondaryAvailable = !!data?.series[activeCombo.secondary.path]?.length;

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
            <span className="text-xs text-ink-500">Custom:</span>
            {COMBOS.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveComboId(c.id)}
                className={`px-2 py-0.5 text-xs rounded ${
                  activeComboId === c.id
                    ? 'bg-ink-800 text-white'
                    : 'border border-ink-300 text-ink-700'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="bg-white border border-ink-200 rounded p-3">
            <div className="text-xs text-ink-500 mb-2">{activeCombo.label}</div>
            {comboData.length === 0 ? (
              <div className="text-xs text-ink-500 py-8 text-center">
                No samples for{' '}
                <span className="font-mono">{activeCombo.primary.path}</span>{' '}
                or{' '}
                <span className="font-mono">{activeCombo.secondary.path}</span>{' '}
                in this window.
              </div>
            ) : (
              <>
                <div style={{ width: '100%', height: 280 }}>
                  <ResponsiveContainer>
                    <LineChart data={comboData}>
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
                      <YAxis
                        yAxisId="left"
                        tick={{ fontSize: 11, fill: activeCombo.primary.color }}
                      />
                      <YAxis
                        yAxisId="right"
                        orientation="right"
                        tick={{ fontSize: 11, fill: activeCombo.secondary.color }}
                      />
                      <Tooltip
                        labelFormatter={(t) =>
                          new Date(t as number).toLocaleString()
                        }
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Line
                        yAxisId="left"
                        type="monotone"
                        dataKey="primary"
                        name={activeCombo.primary.label}
                        stroke={activeCombo.primary.color}
                        dot={false}
                        strokeWidth={1.5}
                        connectNulls
                      />
                      <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="secondary"
                        name={activeCombo.secondary.label}
                        stroke={activeCombo.secondary.color}
                        dot={false}
                        strokeWidth={1.5}
                        connectNulls
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                {(!comboPrimaryAvailable || !comboSecondaryAvailable) && (
                  <div className="text-xs text-amber-700 mt-2">
                    {!comboPrimaryAvailable && (
                      <>
                        No samples for{' '}
                        <span className="font-mono">
                          {activeCombo.primary.path}
                        </span>
                        .{' '}
                      </>
                    )}
                    {!comboSecondaryAvailable && (
                      <>
                        No samples for{' '}
                        <span className="font-mono">
                          {activeCombo.secondary.path}
                        </span>
                        .
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
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
