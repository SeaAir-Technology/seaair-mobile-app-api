import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeacons, useResolveBeacon } from '../hooks/useBeacons';
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
          Help requests from app users — auto-purged after 1 day. Click a row
          to inspect that controller, or use Clear to resolve it now.
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
          <div className="text-ink-500 text-sm">No active beacons.</div>
        )}
        {beacons.length > 0 && (
          <ul className="divide-y divide-ink-100 bg-white border border-ink-200 rounded">
            {beacons.map((b) => (
              <BeaconRow
                key={b.beaconId}
                beacon={b}
                onOpen={() => navigate(`/devices/${b.controllerId}`)}
              />
            ))}
          </ul>
        )}
        {hasNextPage && (
          <button
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="px-3 py-1.5 text-sm border border-ink-300 rounded text-ink-700"
          >
            {isFetchingNextPage ? 'Loading\u2026' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}

// One beacon, two affordances: clicking the body opens the controller's
// detail page (same DeviceDetail with Current State / History / Analytics
// tabs as the Live view); clicking Clear resolves the beacon. Two-stage
// confirm on Clear so the operator doesn't fire it by accident.
function BeaconRow({
  beacon,
  onOpen,
}: {
  beacon: Beacon;
  onOpen: () => void;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [recentlyResolved, setRecentlyResolved] = useState(false);
  const resolve = useResolveBeacon();

  // Auto-cancel staged confirmation after 4s of inactivity.
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  // Brief success state before the row vanishes from the list.
  useEffect(() => {
    if (!recentlyResolved) return;
    const t = setTimeout(() => setRecentlyResolved(false), 4000);
    return () => clearTimeout(t);
  }, [recentlyResolved]);

  const onClearClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (resolve.isPending) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    resolve.mutate(
      { createdAt: beacon.createdAt, beaconId: beacon.beaconId },
      {
        onSuccess: () => setRecentlyResolved(true),
      }
    );
  };

  return (
    <li>
      <div className="flex items-stretch hover:bg-ink-50">
        <button
          onClick={onOpen}
          className="flex-1 text-left px-4 py-3 min-w-0"
        >
          <div className="flex items-center gap-3 min-w-0">
            <span className="font-mono text-sm text-ink-900 shrink-0">
              #{beacon.controllerId}
            </span>
            <span className="text-sm text-ink-700 truncate">
              {beacon.userEmail}
            </span>
            <span
              className="ml-auto text-xs text-ink-500 shrink-0"
              title={formatTimestamp(beacon.createdAt)}
            >
              {formatRelativeTime(beacon.createdAt)}
            </span>
          </div>
          {beacon.message && (
            <div className="text-xs text-ink-600 mt-1 line-clamp-2">
              {beacon.message}
            </div>
          )}
        </button>
        <div className="flex items-center pr-3">
          {recentlyResolved ? (
            <span
              className="text-[11px] text-emerald-700 whitespace-nowrap"
              role="status"
            >
              Cleared
            </span>
          ) : (
            <button
              onClick={onClearClick}
              disabled={resolve.isPending}
              className={`text-xs px-2.5 py-1 rounded border whitespace-nowrap transition-colors ${
                confirming
                  ? 'bg-amber-50 border-amber-400 text-amber-900'
                  : 'border-ink-300 text-ink-700 hover:bg-ink-100'
              } disabled:opacity-50`}
              title="Resolve this beacon now (sets expiresAt to current time)"
            >
              {resolve.isPending
                ? 'Clearing\u2026'
                : confirming
                ? 'Confirm clear'
                : 'Clear'}
            </button>
          )}
        </div>
      </div>
      {resolve.isError && (
        <div className="px-4 pb-2 text-[11px] text-red-600" role="alert">
          {(resolve.error as Error).message}
        </div>
      )}
    </li>
  );
}
