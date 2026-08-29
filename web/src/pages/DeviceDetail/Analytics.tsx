import { useEffect, useState } from 'react';
import { useDeviceAnalytics } from '../../hooks/useDeviceAnalytics';
import { Spinner } from '../../components/Spinner';
import { ChartStateStrip } from '../../components/ChartStateStrip';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Customized,
} from 'recharts';
import {
  mergeSeries,
  modeSegments,
  alarmEdges,
  numericPoints,
} from '../../lib/chartSeries';
import { MODE_FILL } from '../../lib/modeColors';
import {
  TEMP_SCALES,
  TempScaleKey,
  tempDomain,
  gradientStops,
  segmentScales,
} from '../../lib/tempScale';

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
    secondary: { path: TEMP_PATH, label: 'temperture (°F)', color: '#ca8a04' },
  },
  {
    id: 'power-vs-temp',
    label: 'Power use vs temperature',
    primary: {
      path: 'syncDevice2Controller.hvac.powerTotal',
      label: 'powerTotal',
      color: '#1c2230',
    },
    secondary: { path: TEMP_PATH, label: 'temperture (°F)', color: '#ca8a04' },
  },
] as const;

type ComboId = (typeof COMBOS)[number]['id'];

const CHART_MARGIN = { top: 14, right: 5, bottom: 5, left: 5 };

interface ScaleSpan {
  from: number;
  to: number;
  scaleKey: TempScaleKey;
}

// The temperature line, drawn per mode span with that span's thermal
// gradient over the white casing the recharts Line beneath provides. Rendered
// through recharts' <Customized> so it can use the chart's own scales; the
// chart injects xAxisMap/yAxisMap at render time.
function TempGradientOverlay(props: {
  xAxisMap?: Record<string, { scale: (v: number) => number }>;
  yAxisMap?: Record<string, { scale: (v: number) => number }>;
  rows: Array<{ t: number; secondary?: number }>;
  spans: ScaleSpan[];
  domain: [number, number] | null;
  gradId: string;
}): JSX.Element | null {
  const { xAxisMap, yAxisMap, rows, spans, domain, gradId } = props;
  const xScale = xAxisMap?.[Object.keys(xAxisMap)[0]]?.scale;
  const yScale = yAxisMap?.right?.scale;
  if (!xScale || !yScale || !domain) return null;
  const [lo, hi] = domain;

  const pts = rows.filter(
    (r): r is { t: number; secondary: number } => r.secondary !== undefined
  );
  if (pts.length < 2) return null;

  const paths: Array<{ d: string; scaleKey: TempScaleKey; key: string }> = [];
  let idx = 0;
  let prev: { t: number; secondary: number } | null = null;
  for (const span of spans) {
    const seg: Array<{ t: number; secondary: number }> = prev ? [prev] : [];
    while (idx < pts.length && pts[idx].t < span.to) {
      seg.push(pts[idx]);
      idx++;
    }
    if (seg.length >= 2) {
      const d = seg
        .map(
          (p, i) =>
            `${i ? 'L' : 'M'}${xScale(p.t).toFixed(2)},${yScale(p.secondary).toFixed(2)}`
        )
        .join('');
      paths.push({ d, scaleKey: span.scaleKey, key: `${span.scaleKey}-${span.from}` });
    }
    if (seg.length > 0) prev = seg[seg.length - 1];
  }

  const usedScales = Array.from(new Set(paths.map((p) => p.scaleKey)));
  return (
    <g>
      <defs>
        {usedScales.map((k) => (
          <linearGradient
            key={k}
            id={`${gradId}-${k}`}
            gradientUnits="userSpaceOnUse"
            x1={0}
            y1={yScale(lo)}
            x2={0}
            y2={yScale(hi)}
          >
            {gradientStops(TEMP_SCALES[k], lo, hi).map((s, i) => (
              <stop key={i} offset={s.offset} stopColor={s.color} />
            ))}
          </linearGradient>
        ))}
      </defs>
      {paths.map((p) => (
        <path
          key={p.key}
          d={p.d}
          fill="none"
          stroke={`url(#${gradId}-${p.scaleKey})`}
          strokeWidth={3.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
    </g>
  );
}

// Red triangle rendered above the plot at an alarm's x position, via
// ReferenceLine's label slot (viewBox.x is the line's pixel x, viewBox.y the
// plot top).
function AlarmFlag({
  viewBox,
}: {
  viewBox?: { x?: number; y?: number };
}): JSX.Element | null {
  if (!viewBox || viewBox.x === undefined) return null;
  const { x, y = 0 } = viewBox;
  return (
    <g transform={`translate(${x - 5.5}, ${y - 12})`}>
      <path d="M5.5 0 L11 9.5 H0 Z" fill="#dc2626" />
      <path d="M5.5 3v2.9" stroke="white" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="5.5" cy="7.6" r="0.8" fill="white" />
    </g>
  );
}

function ModeLegend(): JSX.Element {
  const items: Array<[string, string]> = [
    ['Cool', MODE_FILL.COOL],
    ['Heat', MODE_FILL.HEAT],
    ['Humidity', MODE_FILL.HUMIDITY],
    ['Fan', MODE_FILL.FAN],
    ['Standby', '#ffffff'],
  ];
  return (
    <div className="flex items-center gap-3 flex-wrap mt-2 text-[10px] text-ink-500">
      {items.map(([label, color]) => (
        <span key={label} className="flex items-center gap-1">
          <span
            className="inline-block w-3 h-3 rounded-sm border border-ink-200"
            style={{ backgroundColor: color }}
          />
          {label}
        </span>
      ))}
      <span className="flex items-center gap-1">
        <svg viewBox="0 0 11 10" width="11" height="10">
          <path d="M5.5 0 L11 9.5 H0 Z" fill="#dc2626" />
          <path d="M5.5 3v2.9" stroke="white" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="5.5" cy="7.6" r="0.8" fill="white" />
        </svg>
        Alarm raised
      </span>
    </div>
  );
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// "updated Ns ago" counter plus a manual refresh button, shown in the top
// right corner of each chart card. Ticks once a second so the age counts up
// between the 5s auto-refreshes.
function RefreshControl({
  updatedAt,
  isFetching,
  onRefresh,
}: {
  updatedAt: number;
  isFetching: boolean;
  onRefresh: () => void;
}): JSX.Element {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const age = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  return (
    <div className="flex items-center gap-1.5 text-xs text-ink-500">
      {updatedAt > 0 && <span>updated {formatAge(age)} ago</span>}
      <button
        onClick={onRefresh}
        title="Refresh now"
        className="p-0.5 rounded border border-ink-300 text-ink-700 hover:bg-ink-100"
      >
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={isFetching ? 'animate-spin' : undefined}
        >
          <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89" />
          <path d="M13.5 2.5v3h-3" />
        </svg>
      </button>
    </div>
  );
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
  const [activeComboId, setActiveComboId] = useState<ComboId>(COMBOS[0].id);
  // Hovered chart timestamp, feeding the docked state strip.
  const [hoverT, setHoverT] = useState<number | null>(null);
  const { data, isLoading, error, refetch, dataUpdatedAt, isFetching } =
    useDeviceAnalytics(controllerId, windowExpr);

  const handleChartMove = (s: { activeLabel?: string | number } | null): void =>
    setHoverT(typeof s?.activeLabel === 'number' ? s.activeLabel : null);
  const handleChartLeave = (): void => setHoverT(null);

  const activeCombo =
    COMBOS.find((c) => c.id === activeComboId) || COMBOS[0];
  const comboData = data
    ? mergeSeries(data.series, activeCombo.primary.path, activeCombo.secondary.path)
    : [];
  const comboPrimaryAvailable = !!data?.series[activeCombo.primary.path]?.length;
  const comboSecondaryAvailable = !!data?.series[activeCombo.secondary.path]?.length;

  const comboEnd = comboData.length ? comboData[comboData.length - 1].t : 0;
  const comboModes = data ? modeSegments(data.series, comboEnd) : [];
  const alarms = data ? alarmEdges(data.series) : [];

  // Auto-fit axis for the temperature line (min 8° span), and one thermal
  // scale span per mode segment, stretched to cover the whole window so the
  // line is colored edge to edge.
  const tDomain = data
    ? tempDomain(numericPoints(data.series[TEMP_PATH]).map((p) => p.v))
    : null;
  const scaleKeys = segmentScales(comboModes);
  let tempSpans: ScaleSpan[] = comboModes.map((s, i) => ({
    from: s.from,
    to: s.to,
    scaleKey: scaleKeys[i],
  }));
  if (tempSpans.length === 0) {
    tempSpans = [{ from: -Infinity, to: Infinity, scaleKey: 'COOL' }];
  } else {
    tempSpans[0] = { ...tempSpans[0], from: -Infinity };
    tempSpans[tempSpans.length - 1] = { ...tempSpans[tempSpans.length - 1], to: Infinity };
  }

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
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-ink-500">{activeCombo.label}</div>
              <RefreshControl
                updatedAt={dataUpdatedAt}
                isFetching={isFetching}
                onRefresh={() => refetch()}
              />
            </div>
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
                <div className="w-full h-[200px] md:h-[280px]">
                  <ResponsiveContainer>
                    <LineChart
                      data={comboData}
                      margin={CHART_MARGIN}
                      onMouseMove={handleChartMove}
                      onMouseLeave={handleChartLeave}
                    >
                      <CartesianGrid stroke="#eef0f3" strokeDasharray="3 3" />
                      {comboModes.map(
                        (s) =>
                          MODE_FILL[s.mode] && (
                            <ReferenceArea
                              key={`mode-${s.from}`}
                              yAxisId="left"
                              x1={s.from}
                              x2={s.to}
                              fill={MODE_FILL[s.mode]}
                              fillOpacity={0.5}
                              stroke="none"
                            />
                          )
                      )}
                      <XAxis
                        dataKey="t"
                        type="number"
                        domain={['dataMin', 'dataMax']}
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
                        domain={tDomain ?? ['auto', 'auto']}
                        tick={{ fontSize: 11, fill: activeCombo.secondary.color }}
                      />
                      <Tooltip
                        content={() => null}
                        cursor={{ stroke: '#7a8497', strokeDasharray: '3 3' }}
                      />
                      <Legend
                        wrapperStyle={{ fontSize: 11 }}
                        payload={[
                          {
                            value: activeCombo.primary.label,
                            type: 'line',
                            color: activeCombo.primary.color,
                          },
                          {
                            value: activeCombo.secondary.label,
                            type: 'line',
                            color: activeCombo.secondary.color,
                          },
                        ]}
                      />
                      <Line
                        yAxisId="left"
                        type="monotone"
                        dataKey="primary"
                        name={activeCombo.primary.label}
                        stroke={activeCombo.primary.color}
                        dot={false}
                        strokeWidth={1.5}
                      />
                      {/* White casing under the thermal gradient line so it
                          stays legible over the pastel mode shading. The
                          colored line itself is the Customized overlay. */}
                      <Line
                        yAxisId="right"
                        type="linear"
                        dataKey="secondary"
                        name={activeCombo.secondary.label}
                        stroke="#ffffff"
                        legendType="none"
                        dot={false}
                        strokeWidth={6.5}
                        connectNulls
                        isAnimationActive={false}
                      />
                      <Customized
                        key={`tempgrad-${activeCombo.id}`}
                        component={
                          <TempGradientOverlay
                            rows={comboData}
                            spans={tempSpans}
                            domain={tDomain}
                            gradId={`tempgrad-${activeCombo.id}`}
                          />
                        }
                      />
                      {alarms.map((t) => (
                        <ReferenceLine
                          key={`alarm-${t}`}
                          yAxisId="left"
                          x={t}
                          stroke="#dc2626"
                          strokeDasharray="3 3"
                          label={<AlarmFlag />}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <ChartStateStrip series={data.series} hoverT={hoverT} />
                <ModeLegend />
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
        </>
      )}
    </div>
  );
}
