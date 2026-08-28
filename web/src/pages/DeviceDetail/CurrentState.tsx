import { useState } from 'react';
import { useDeviceState } from '../../hooks/useDeviceState';
import { ProtoTree } from '../../components/ProtoTree';
import { Spinner } from '../../components/Spinner';
import { formatRelativeTime, formatTimestamp } from '../../lib/format';
import {
  extractCockpit,
  titleCase,
  formatVoltage,
  type CockpitData,
} from '../../lib/heartbeat';
import { modeTheme } from '../../lib/modeColors';

// Em dash for any absent value: every slot always renders, so nothing pops
// in or out and the eye always lands in the same place.
const DASH = '—';

export function CurrentState({
  controllerId,
}: {
  controllerId: number;
}): JSX.Element {
  const { data, isLoading, error, isFetching } = useDeviceState(controllerId);
  const [showRaw, setShowRaw] = useState(false);

  if (isLoading) {
    return (
      <div className="p-4">
        <Spinner label="Loading state…" />
      </div>
    );
  }
  if (error) {
    return <div className="p-4 text-red-600 text-sm">{(error as Error).message}</div>;
  }
  if (!data) return <div />;

  const cockpit = data.latest ? extractCockpit(data.latest.decoded) : null;

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${
            data.alive
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
              : 'bg-ink-100 text-ink-600 border border-ink-200'
          }`}
        >
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              data.alive ? 'bg-emerald-500' : 'bg-ink-400'
            }`}
          />
          {data.alive ? 'Alive' : 'Stale'}
        </span>
        {cockpit?.name && (
          <span className="text-sm font-medium text-ink-900">{cockpit.name}</span>
        )}
        {data.latest && (
          <span
            className="text-xs text-ink-500 order-last basis-full sm:order-none sm:basis-auto"
            title={formatTimestamp(data.latest.timestamp)}
          >
            last heartbeat {formatRelativeTime(data.latest.timestamp)}
          </span>
        )}
        {isFetching && <Spinner />}
        <span className="ml-auto text-[11px] font-mono text-ink-500 bg-ink-100 border border-ink-200 rounded px-2 py-0.5">
          fw {cockpit?.version ?? DASH}
        </span>
      </div>

      {!data.latest && (
        <div className="text-ink-500 text-sm">
          No heartbeats received from this controller yet.
        </div>
      )}

      {data.latest && cockpit && cockpit.kind === 'hvac' && (
        <HvacCockpit c={cockpit} />
      )}
      {data.latest && cockpit && cockpit.kind === 'utility' && (
        <UtilityCockpit c={cockpit} />
      )}
      {data.latest && !cockpit && (
        <div className="text-ink-500 text-sm">
          No recognized telemetry in the latest heartbeat.
        </div>
      )}

      {data.latest?.decoded && (
        <div>
          <button
            onClick={() => setShowRaw((v) => !v)}
            className="text-xs text-ink-500 hover:text-ink-900 underline"
          >
            {showRaw ? 'Hide' : 'Show'} raw decoded payload
            {data.latest.decoded.typeName && (
              <span className="font-mono"> ({data.latest.decoded.typeName})</span>
            )}
          </button>
          {showRaw && (
            <div className="bg-white border border-ink-200 rounded p-3 mt-2 overflow-x-auto">
              <ProtoTree data={data.latest.decoded.data} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SmallLabel({ children }: { children: string }): JSX.Element {
  return (
    <div className="text-[11px] uppercase tracking-wide text-ink-500">
      {children}
    </div>
  );
}

function MiniStat({
  label,
  value,
}: {
  label: string;
  value: string | undefined;
}): JSX.Element {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-ink-400">
        {label}
      </div>
      <div
        className={`text-[13px] font-semibold tabular-nums ${
          value === undefined ? 'text-ink-300' : 'text-ink-800'
        }`}
      >
        {value ?? DASH}
      </div>
    </div>
  );
}

function HealthColumn({ c }: { c: CockpitData }): JSX.Element {
  return (
    <div className="md:border-l border-ink-100 px-4 py-2.5 md:py-3.5 flex flex-row items-center justify-between gap-2 md:flex-col md:items-stretch md:justify-center">
      {c.alarms.length === 0 ? (
        <div className="flex items-center gap-2">
          <svg
            viewBox="0 0 20 20"
            width="14"
            height="14"
            fill="none"
            stroke="#10b981"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="10" cy="10" r="7.5" />
            <path d="M6.8 10.2l2.2 2.2 4.2-4.6" />
          </svg>
          <span className="text-xs font-medium text-ink-600">
            No active alarms
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <svg viewBox="0 0 20 20" width="14" height="14">
            <path d="M10 2.5 18.5 17H1.5z" fill="#dc2626" />
            <path
              d="M10 8v4"
              stroke="#ffffff"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <circle cx="10" cy="14.6" r="1" fill="#ffffff" />
          </svg>
          {c.alarms.map((a) => (
            <span
              key={a}
              className="inline-flex items-center bg-red-50 text-red-700 border border-red-200 rounded px-1.5 py-0.5 text-[11px] font-medium"
            >
              {a}
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-4">
        <MiniStat label="Rate" value={c.powerRate?.toFixed(1)} />
        <MiniStat label="Total" value={c.powerTotal?.toFixed(1)} />
        <MiniStat
          label="Volts"
          value={c.voltageMv !== undefined ? formatVoltage(c.voltageMv) : undefined}
        />
      </div>
    </div>
  );
}

function SettingsLine({ c }: { c: CockpitData }): JSX.Element {
  const item = (label: string, value: string | undefined): JSX.Element => (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-ink-400">{label}</span>
      <span
        className={`font-medium tabular-nums ${
          value === undefined ? 'text-ink-300' : 'text-ink-800'
        }`}
      >
        {value ?? DASH}
      </span>
    </span>
  );
  return (
    <div className="flex items-baseline gap-x-3 gap-y-1 flex-wrap text-xs px-0.5">
      <span className="text-[11px] uppercase tracking-wide text-ink-400">
        Settings
      </span>
      {item('setpoint', c.setpoint !== undefined ? `${c.setpoint}°F` : undefined)}
      {item(
        'humidity',
        c.targetHumidity !== undefined ? `${c.targetHumidity}%` : undefined
      )}
      {item('fan', c.fanSpeed !== undefined ? String(c.fanSpeed) : undefined)}
      {item(
        'compressor',
        c.compressorSpeed !== undefined ? String(c.compressorSpeed) : undefined
      )}
      {item(
        'budget',
        c.budgetEnabled === undefined ? undefined : c.budgetEnabled ? 'On' : 'Off'
      )}
      {item(
        'limit',
        c.budgetLimit !== undefined ? String(c.budgetLimit) : undefined
      )}
      {item(
        'PIN',
        c.adminPinSet === undefined ? undefined : c.adminPinSet ? 'Set' : 'Not set'
      )}
    </div>
  );
}

// Option B "cockpit band": what is it doing, is it getting there, is anything
// wrong — one strip, fixed slots. The mode block uses the same colors as the
// analytics charts' background shading.
function HvacCockpit({ c }: { c: CockpitData }): JSX.Element {
  const theme = modeTheme(c.mode);
  const delta =
    c.temp !== undefined && c.setpoint !== undefined ? c.temp - c.setpoint : undefined;
  const deltaText =
    delta === undefined
      ? DASH
      : delta === 0
      ? 'at setpoint'
      : delta > 0
      ? `+${delta}° to go`
      : `${delta}° to go`;
  const deltaClass =
    delta === undefined
      ? 'text-ink-300'
      : delta === 0
      ? 'text-emerald-700'
      : 'text-amber-700';

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-[180px_minmax(0,1fr)_260px] bg-white border border-ink-200 rounded overflow-hidden">
        <div
          className="px-4 py-3 md:py-3.5 flex items-center justify-between gap-2 border-b md:border-b-0 md:border-r md:flex-col md:items-start md:justify-center md:gap-1"
          style={{ backgroundColor: theme.bg, borderColor: theme.border }}
        >
          <div>
            <div
              className="text-[11px] uppercase tracking-wide"
              style={{ color: theme.label }}
            >
              Mode
            </div>
            <div
              className="text-[24px] leading-7 font-bold"
              style={{ color: theme.value }}
            >
              {c.mode ? titleCase(c.mode) : DASH}
            </div>
          </div>
          <div className="text-xs text-right md:text-left" style={{ color: theme.sub }}>
            compressor {c.compressorState ? titleCase(c.compressorState) : DASH} ·{' '}
            {c.compressorSpeed ?? DASH} · fan {c.fanSpeed ?? DASH}
          </div>
        </div>

        <div className="px-4 md:px-5 py-3.5 flex items-center gap-3 md:gap-5 min-w-0 border-b border-ink-100 md:border-b-0">
          <div>
            <SmallLabel>Cabin</SmallLabel>
            <div className="text-[26px] leading-7 md:text-[28px] md:leading-8 font-bold text-ink-900 tabular-nums">
              {c.temp !== undefined ? `${c.temp}°F` : DASH}
            </div>
          </div>
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="#aab3c2"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 12h14" />
            <path d="M13 6l6 6-6 6" />
          </svg>
          <div>
            <SmallLabel>Setpoint</SmallLabel>
            <div className="text-[26px] leading-7 md:text-[28px] md:leading-8 font-bold text-ink-500 tabular-nums">
              {c.setpoint !== undefined ? `${c.setpoint}°F` : DASH}
            </div>
          </div>
          <div className="ml-auto text-right">
            <div className={`text-xs font-semibold tabular-nums ${deltaClass}`}>
              {deltaText}
            </div>
            <div className="text-xs text-ink-400 tabular-nums">
              humidity {c.humidity !== undefined ? `${c.humidity}%` : DASH} /{' '}
              {c.targetHumidity !== undefined ? `${c.targetHumidity}%` : DASH}
            </div>
          </div>
        </div>

        <HealthColumn c={c} />
      </div>
      <SettingsLine c={c} />
    </div>
  );
}

function UtilityCockpit({ c }: { c: CockpitData }): JSX.Element {
  const batteryClass =
    c.battery === undefined
      ? 'text-ink-300'
      : c.battery < 20
      ? 'text-amber-700'
      : 'text-ink-900';
  return (
    <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_260px] bg-white border border-ink-200 rounded overflow-hidden">
      <div className="px-4 md:px-5 py-3.5 flex items-center gap-5 md:gap-8 border-b border-ink-100 md:border-b-0">
        <div>
          <SmallLabel>Temperature</SmallLabel>
          <div className="text-[26px] leading-7 md:text-[28px] md:leading-8 font-bold text-ink-900 tabular-nums">
            {c.temp !== undefined ? `${c.temp}°F` : DASH}
          </div>
        </div>
        <div>
          <SmallLabel>Humidity</SmallLabel>
          <div className="text-[26px] leading-7 md:text-[28px] md:leading-8 font-bold text-ink-900 tabular-nums">
            {c.humidity !== undefined ? `${c.humidity}%` : DASH}
          </div>
        </div>
        <div>
          <SmallLabel>Battery</SmallLabel>
          <div className={`text-[26px] leading-7 md:text-[28px] md:leading-8 font-bold tabular-nums ${batteryClass}`}>
            {c.battery !== undefined ? `${c.battery}%` : DASH}
          </div>
        </div>
      </div>
      <div className="border-l border-ink-100 px-4 py-3.5 flex flex-col justify-center gap-2">
        <div className="flex gap-4">
          <MiniStat
            label="Volts"
            value={c.voltageMv !== undefined ? formatVoltage(c.voltageMv) : undefined}
          />
        </div>
      </div>
    </div>
  );
}
