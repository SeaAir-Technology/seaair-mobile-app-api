import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useFirehose } from '../hooks/useFirehose';
import { SearchBar } from '../components/SearchBar';
import { DirectionBadge } from '../components/DirectionBadge';
import { Spinner } from '../components/Spinner';
import { formatRelativeTime, formatTimestamp } from '../lib/format';
import type { FirehoseEntry, PayloadFilter } from '../lib/types';
import { DeviceDetail } from './DeviceDetail';

// Two-column layout: live firehose on the left, selected-device detail on
// the right. URL is the source of truth for which controller is selected,
// so beacon click-throughs (which navigate to /devices/:id) just work.
export function DevicesPage(): JSX.Element {
  const { controllerId: cidStr } = useParams<{ controllerId?: string }>();
  const controllerId = cidStr ? parseInt(cidStr, 10) : null;
  const navigate = useNavigate();
  const [filters, setFilters] = useState<PayloadFilter[]>([]);

  return (
    <div className="h-full flex flex-col">
      <SearchBar
        controllerId={controllerId}
        onControllerIdChange={(id) =>
          navigate(id ? `/devices/${id}` : '/devices')
        }
        filters={filters}
        onFiltersChange={setFilters}
      />
      <div className="flex-1 grid grid-cols-2 overflow-hidden">
        <FirehoseColumn
          activeControllerId={controllerId}
          onSelect={(id) => navigate(`/devices/${id}`)}
        />
        <div className="border-l border-ink-200 overflow-y-auto bg-ink-50">
          {controllerId ? (
            <DeviceDetail controllerId={controllerId} filters={filters} />
          ) : (
            <div className="p-8 text-ink-500 text-sm">
              Select or search a controller to inspect its state, history, and
              analytics.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FirehoseColumn({
  activeControllerId,
  onSelect,
}: {
  activeControllerId: number | null;
  onSelect: (id: number) => void;
}): JSX.Element {
  const { data, isLoading, error, isFetching } = useFirehose(100);
  return (
    <div className="overflow-y-auto">
      <div className="px-4 py-2 text-xs text-ink-500 flex items-center justify-between border-b border-ink-200 sticky top-0 bg-white z-10">
        <span>Live (last 100)</span>
        {isFetching && <Spinner />}
      </div>
      {isLoading && (
        <div className="p-4">
          <Spinner label="Loading messages…" />
        </div>
      )}
      {error && (
        <div className="p-4 text-red-600 text-sm">
          {(error as Error).message}
        </div>
      )}
      {data && (
        <ul className="divide-y divide-ink-100">
          {data.entries.map((e) => (
            <FirehoseRow
              key={e.firehoseId}
              entry={e}
              active={activeControllerId === e.controllerId}
              onClick={() => onSelect(e.controllerId)}
            />
          ))}
          {data.entries.length === 0 && (
            <li className="p-4 text-ink-500 text-sm">No messages yet.</li>
          )}
        </ul>
      )}
    </div>
  );
}

function FirehoseRow({
  entry,
  active,
  onClick,
}: {
  entry: FirehoseEntry;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <li>
      <button
        onClick={onClick}
        className={`w-full text-left px-4 py-2 hover:bg-ink-50 ${
          active ? 'bg-ink-100' : ''
        }`}
      >
        <div className="flex items-center gap-2 text-xs text-ink-500">
          <DirectionBadge direction={entry.direction} />
          <span className="font-mono">#{entry.controllerId}</span>
          <span
            className="ml-auto"
            title={formatTimestamp(entry.timestamp)}
          >
            {formatRelativeTime(entry.timestamp)}
          </span>
        </div>
        <div className="text-xs text-ink-600 mt-0.5 font-mono truncate">
          {entry.streamId}
        </div>
      </button>
    </li>
  );
}
