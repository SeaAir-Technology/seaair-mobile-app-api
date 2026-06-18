import { useState } from 'react';
import { useDeviceState } from '../../hooks/useDeviceState';
import { ProtoTree } from '../../components/ProtoTree';
import { Spinner } from '../../components/Spinner';
import { formatRelativeTime, formatTimestamp } from '../../lib/format';
import { summarizeHeartbeat, type StatItem } from '../../lib/heartbeat';

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

  const summary = data.latest ? summarizeHeartbeat(data.latest.decoded) : null;

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
        {summary?.name && (
          <span className="text-sm font-medium text-ink-900">{summary.name}</span>
        )}
        {data.latest && (
          <span
            className="text-xs text-ink-500"
            title={formatTimestamp(data.latest.timestamp)}
          >
            last heartbeat {formatRelativeTime(data.latest.timestamp)}
          </span>
        )}
        {isFetching && <Spinner />}
      </div>

      {!data.latest && (
        <div className="text-ink-500 text-sm">
          No heartbeats received from this controller yet.
        </div>
      )}

      {data.latest && summary && summary.alarms.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {summary.alarms.map((a) => (
            <span
              key={a}
              className="inline-flex items-center gap-1 bg-red-50 text-red-700 border border-red-200 rounded px-2 py-0.5 text-xs font-medium"
            >
              {a} alarm
            </span>
          ))}
        </div>
      )}

      {data.latest && summary && summary.stats.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {summary.stats.map((s) => (
            <StatCard key={s.label} item={s} />
          ))}
        </div>
      )}

      {data.latest && summary && summary.stats.length === 0 && (
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

function StatCard({ item }: { item: StatItem }): JSX.Element {
  const tone =
    item.tone === 'alarm'
      ? 'text-red-700'
      : item.tone === 'warn'
      ? 'text-amber-700'
      : item.tone === 'good'
      ? 'text-emerald-700'
      : 'text-ink-900';
  return (
    <div className="bg-white border border-ink-200 rounded px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-ink-500 truncate">
        {item.label}
      </div>
      <div className={`text-lg font-semibold tabular-nums ${tone}`}>{item.value}</div>
    </div>
  );
}
