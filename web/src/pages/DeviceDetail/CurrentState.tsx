import { useDeviceState } from '../../hooks/useDeviceState';
import { ProtoTree } from '../../components/ProtoTree';
import { Spinner } from '../../components/Spinner';
import { formatRelativeTime, formatTimestamp } from '../../lib/format';

export function CurrentState({
  controllerId,
}: {
  controllerId: number;
}): JSX.Element {
  const { data, isLoading, error, isFetching } = useDeviceState(controllerId);

  if (isLoading) {
    return (
      <div className="p-4">
        <Spinner label="Loading state…" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-4 text-red-600 text-sm">
        {(error as Error).message}
      </div>
    );
  }
  if (!data) return <div />;

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-3">
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
      {data.latest ? (
        <div className="bg-white border border-ink-200 rounded p-3">
          <div className="text-xs text-ink-500 mb-2">
            Decoded payload{' '}
            {data.latest.decoded?.typeName && (
              <span className="font-mono">
                ({data.latest.decoded.typeName})
              </span>
            )}
          </div>
          {data.latest.decoded ? (
            <ProtoTree data={data.latest.decoded.data} />
          ) : (
            <div className="text-ink-500 text-xs">
              Could not decode protobuf payload.
            </div>
          )}
        </div>
      ) : (
        <div className="text-ink-500 text-sm">
          No heartbeats received from this controller yet.
        </div>
      )}
    </div>
  );
}
