import { useState } from 'react';
import { useDeviceHistory } from '../../hooks/useDeviceHistory';
import { ProtoTree } from '../../components/ProtoTree';
import { Spinner } from '../../components/Spinner';
import { DirectionBadge } from '../../components/DirectionBadge';
import { formatRelativeTime, formatTimestamp } from '../../lib/format';
import type { PayloadFilter } from '../../lib/types';

interface Props {
  controllerId: number;
  filters: PayloadFilter[];
}

export function History({ controllerId, filters }: Props): JSX.Element {
  const [direction, setDirection] = useState<'both' | 'fw2mobile' | 'mobile2fw'>(
    'both'
  );
  const { data, isLoading, error, isFetching } = useDeviceHistory({
    controllerId,
    direction,
    filters,
  });

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-ink-500">Direction:</span>
        {(['both', 'fw2mobile', 'mobile2fw'] as const).map((d) => (
          <button
            key={d}
            onClick={() => setDirection(d)}
            className={`px-2 py-0.5 text-xs rounded ${
              direction === d
                ? 'bg-ink-800 text-white'
                : 'border border-ink-300 text-ink-700'
            }`}
          >
            {d === 'both'
              ? 'Both'
              : d === 'fw2mobile'
              ? 'Firmware → Mobile'
              : 'Mobile → Firmware'}
          </button>
        ))}
        {isFetching && (
          <span className="ml-auto">
            <Spinner />
          </span>
        )}
      </div>
      {filters.length > 0 && (
        <div className="text-xs text-ink-500">
          {filters.length} filter{filters.length === 1 ? '' : 's'} active —{' '}
          {data?.count ?? '…'} match{(data?.count ?? 0) === 1 ? '' : 'es'} of{' '}
          {data?.totalScanned ?? '…'} scanned
        </div>
      )}
      {isLoading && <Spinner label="Loading history…" />}
      {error && (
        <div className="text-red-600 text-sm">{(error as Error).message}</div>
      )}
      {data && (
        <ul className="space-y-2">
          {data.messages.map((m) => (
            <li
              key={`${m.streamKey}-${m.streamId}`}
              className="bg-white border border-ink-200 rounded p-3"
            >
              <div className="flex items-center gap-2 text-xs text-ink-500 mb-2">
                {m.direction && <DirectionBadge direction={m.direction} />}
                <span
                  className="ml-auto"
                  title={formatTimestamp(m.timestamp)}
                >
                  {formatRelativeTime(m.timestamp)}
                </span>
              </div>
              {m.decoded ? (
                <ProtoTree data={m.decoded.data} />
              ) : (
                <div className="text-ink-400 text-xs font-mono break-all">
                  {m.protobufPayload.slice(0, 80)}
                  {m.protobufPayload.length > 80 && '…'}
                </div>
              )}
            </li>
          ))}
          {data.messages.length === 0 && (
            <li className="text-ink-500 text-sm">
              No messages match these criteria.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
