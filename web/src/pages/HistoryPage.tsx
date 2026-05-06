import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFirehose } from '../hooks/useFirehose';
import { SearchBar } from '../components/SearchBar';
import { DirectionBadge } from '../components/DirectionBadge';
import { Spinner } from '../components/Spinner';
import { formatRelativeTime, formatTimestamp } from '../lib/format';
import type { FirehoseEntry, PayloadFilter } from '../lib/types';

const PAGE_SIZE = 50;
const FIREHOSE_LIMIT = 200;

// History view: every event flowing through the cross-controller firehose,
// regardless of recency. Same SearchBar pattern as the Devices page so the
// controller-identifier search narrows down to a single controller's events
// here too. Click a row to drop into the per-controller detail view.
export function HistoryPage(): JSX.Element {
  const navigate = useNavigate();
  const [searchText, setSearchText] = useState('');
  const [page, setPage] = useState(0);
  // The History page only shows event-stream metadata (no per-event payload
  // is returned by the firehose endpoint), so payload-filter chips don't
  // apply here \u2014 the SearchBar still requires the props for now, kept inert.
  const [filters, setFilters] = useState<PayloadFilter[]>([]);
  const [filterText, setFilterText] = useState('');

  const { data, isLoading, error, isFetching } = useFirehose(FIREHOSE_LIMIT);

  const filteredEntries = useMemo(() => {
    if (!data) return [];
    const trimmed = searchText.trim();
    if (!trimmed) return data.entries;
    return data.entries.filter((e) =>
      String(e.controllerId).includes(trimmed)
    );
  }, [data, searchText]);

  const pageCount = Math.max(1, Math.ceil(filteredEntries.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filteredEntries.slice(
    safePage * PAGE_SIZE,
    safePage * PAGE_SIZE + PAGE_SIZE
  );

  return (
    <div className="h-full flex flex-col">
      <SearchBar
        controllerId={null}
        onControllerIdChange={(id) => {
          if (id) navigate(`/devices/${id}`);
        }}
        searchText={searchText}
        onSearchTextChange={(t) => {
          setSearchText(t);
          setPage(0);
        }}
        filters={filters}
        onFiltersChange={setFilters}
        filterText={filterText}
        onFilterTextChange={setFilterText}
      />
      <div className="flex-1 overflow-y-auto flex flex-col">
        <div className="px-4 py-2 text-xs text-ink-500 flex items-center justify-between border-b border-ink-200 sticky top-0 bg-white z-10">
          <span>
            All stream history (last {FIREHOSE_LIMIT} events)
            {data &&
              ` (showing ${filteredEntries.length}${
                filteredEntries.length !== data.entries.length
                  ? ` of ${data.entries.length}`
                  : ''
              })`}
          </span>
          {isFetching && <Spinner />}
        </div>
        {isLoading && (
          <div className="p-4">
            <Spinner label="Loading history\u2026" />
          </div>
        )}
        {error && (
          <div className="p-4 text-red-600 text-sm">
            {(error as Error).message}
          </div>
        )}
        {data && (
          <ul className="divide-y divide-ink-100 flex-1">
            {visible.map((e) => (
              <HistoryRow
                key={e.firehoseId}
                entry={e}
                onClick={() => navigate(`/devices/${e.controllerId}`)}
              />
            ))}
            {visible.length === 0 && (
              <li className="p-4 text-ink-500 text-sm">
                {searchText.trim()
                  ? `No events match "${searchText}".`
                  : 'No events in the firehose yet.'}
              </li>
            )}
          </ul>
        )}
        {filteredEntries.length > PAGE_SIZE && (
          <div className="border-t border-ink-200 bg-white px-4 py-2 flex items-center justify-between text-xs text-ink-600 sticky bottom-0">
            <button
              type="button"
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
              className="px-2 py-1 border border-ink-200 rounded disabled:opacity-40"
            >
              Previous
            </button>
            <span>
              Page {safePage + 1} of {pageCount}
            </span>
            <button
              type="button"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage(safePage + 1)}
              className="px-2 py-1 border border-ink-200 rounded disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryRow({
  entry,
  onClick,
}: {
  entry: FirehoseEntry;
  onClick: () => void;
}): JSX.Element {
  return (
    <li>
      <button
        onClick={onClick}
        className="w-full text-left px-4 py-2.5 hover:bg-ink-50 transition-colors border-l-4 border-l-transparent"
      >
        <div className="flex items-center gap-2 min-w-0">
          <DirectionBadge direction={entry.direction} />
          <span className="font-mono text-sm truncate">
            Controller #{entry.controllerId}
          </span>
          <span
            className="ml-auto text-xs text-ink-500 shrink-0"
            title={formatTimestamp(entry.timestamp)}
          >
            {formatRelativeTime(entry.timestamp)}
          </span>
        </div>
        <div className="text-xs text-ink-500 mt-1 font-mono truncate">
          Stream entry {entry.streamId}
        </div>
      </button>
    </li>
  );
}
