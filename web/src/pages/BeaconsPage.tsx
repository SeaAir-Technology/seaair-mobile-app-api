import { useNavigate } from 'react-router-dom';
import { useBeacons } from '../hooks/useBeacons';
import { Spinner } from '../components/Spinner';
import { formatRelativeTime, formatTimestamp } from '../lib/format';
import type { Beacon } from '../lib/types';

export function BeaconsPage(): JSX.Element {
  const navigate = useNavigate();
  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useBeacons(50);
  const beacons: Beacon[] = data?.pages.flatMap((p) => p.beacons) ?? [];

  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-ink-200 bg-white px-4 py-3">
        <h1 className="text-sm text-ink-900 font-semibold">Help Beacons</h1>
        <p className="text-xs text-ink-500 mt-0.5">
          Help requests from app users — auto-purged after 1 year. Click to
          inspect that controller.
        </p>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {isLoading && <Spinner label="Loading beacons…" />}
        {error && (
          <div className="text-red-600 text-sm">
            {(error as Error).message}
          </div>
        )}
        {beacons.length === 0 && !isLoading && (
          <div className="text-ink-500 text-sm">No beacons received yet.</div>
        )}
        {beacons.length > 0 && (
          <ul className="divide-y divide-ink-100 bg-white border border-ink-200 rounded">
            {beacons.map((b) => (
              <li key={b.beaconId}>
                <button
                  onClick={() => navigate(`/devices/${b.controllerId}`)}
                  className="w-full text-left px-4 py-3 hover:bg-ink-50"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm text-ink-900">
                      #{b.controllerId}
                    </span>
                    <span className="text-sm text-ink-700">{b.userEmail}</span>
                    <span
                      className="ml-auto text-xs text-ink-500"
                      title={formatTimestamp(b.createdAt)}
                    >
                      {formatRelativeTime(b.createdAt)}
                    </span>
                  </div>
                  {b.message && (
                    <div className="text-xs text-ink-600 mt-1 line-clamp-2">
                      {b.message}
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {hasNextPage && (
          <button
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="px-3 py-1.5 text-sm border border-ink-300 rounded text-ink-700"
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}
