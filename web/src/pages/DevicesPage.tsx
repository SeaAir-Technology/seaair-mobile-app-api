import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDeviceList } from '../hooks/useDeviceList';
import { SearchBar } from '../components/SearchBar';
import { Spinner } from '../components/Spinner';
import { formatRelativeTime, formatTimestamp, formatWindow } from '../lib/format';
import type { DeviceSummary, PayloadFilter } from '../lib/types';
import { DeviceDetail } from './DeviceDetail';

const PAGE_SIZE = 50;
const WINDOW = '1m';

// Two-column layout: rolled-up device list on the left (one row per
// controller seen in the active window, beacon-active devices floated to
// the top, paginated client-side, filtered live by the controller-identifier
// search field), selected-device detail on the right. URL is the source of
// truth for the selected controller, so beacon click-throughs (which navigate
// to /devices/:id) just work.
export function DevicesPage(): JSX.Element {
  const { controllerId: cidStr } = useParams<{ controllerId?: string }>();
  const controllerId = cidStr ? parseInt(cidStr, 10) : null;
  const navigate = useNavigate();
  const [filters, setFilters] = useState<PayloadFilter[]>([]);
  const [filterText, setFilterText] = useState('');
  const [searchText, setSearchText] = useState('');
  const [page, setPage] = useState(0);

  return (
    <div className="h-full flex flex-col">
      <SearchBar
        controllerId={controllerId}
        onControllerIdChange={(id) =>
          navigate(id ? `/devices/${id}` : '/devices')
        }
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
      <div className="flex-1 grid grid-cols-2 overflow-hidden">
        <DeviceListColumn
          activeControllerId={controllerId}
          searchText={searchText}
          page={page}
          onPageChange={setPage}
          onSelect={(id) => navigate(`/devices/${id}`)}
        />
        <div className="border-l border-ink-200 overflow-y-auto bg-ink-50">
          {controllerId ? (
            <DeviceDetail controllerId={controllerId} filters={filters} />
          ) : (
            <div className="p-8 text-ink-500 text-sm">
              Select a controller from the list, or type a controller
              identifier above to filter the list and open a controller.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DeviceListColumn({
  activeControllerId,
  searchText,
  page,
  onPageChange,
  onSelect,
}: {
  activeControllerId: number | null;
  searchText: string;
  page: number;
  onPageChange: (p: number) => void;
  onSelect: (id: number) => void;
}): JSX.Element {
  const { data, isLoading, error, isFetching } = useDeviceList(WINDOW);

  const filteredDevices = useMemo(() => {
    if (!data) return [];
    const trimmed = searchText.trim();
    if (!trimmed) return data.devices;
    return data.devices.filter((d) =>
      String(d.controllerId).includes(trimmed)
    );
  }, [data, searchText]);

  const pageCount = Math.max(1, Math.ceil(filteredDevices.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filteredDevices.slice(
    safePage * PAGE_SIZE,
    safePage * PAGE_SIZE + PAGE_SIZE
  );
  const windowLabel = data ? formatWindow(data.windowMs) : '…';

  return (
    <div className="overflow-y-auto flex flex-col">
      <div className="px-4 py-2 text-xs text-ink-500 flex items-center justify-between border-b border-ink-200 sticky top-0 bg-white z-10">
        <span>
          Devices active in the last {windowLabel}
          {data &&
            ` (showing ${filteredDevices.length}${
              filteredDevices.length !== data.devices.length
                ? ` of ${data.devices.length}`
                : ''
            })`}
        </span>
        {isFetching && <Spinner />}
      </div>
      {isLoading && (
        <div className="p-4">
          <Spinner label="Loading devices…" />
        </div>
      )}
      {error && (
        <div className="p-4 text-red-600 text-sm">
          {(error as Error).message}
        </div>
      )}
      {data && (
        <ul className="divide-y divide-ink-100 flex-1">
          {visible.map((d) => (
            <DeviceRow
              key={d.controllerId}
              device={d}
              active={activeControllerId === d.controllerId}
              onClick={() => onSelect(d.controllerId)}
            />
          ))}
          {visible.length === 0 && (
            <li className="p-4 text-ink-500 text-sm">
              {searchText.trim()
                ? `No devices match "${searchText}".`
                : `No devices have reported in the last ${windowLabel}.`}
            </li>
          )}
        </ul>
      )}
      {filteredDevices.length > PAGE_SIZE && (
        <div className="border-t border-ink-200 bg-white px-4 py-2 flex items-center justify-between text-xs text-ink-600 sticky bottom-0">
          <button
            type="button"
            disabled={safePage === 0}
            onClick={() => onPageChange(safePage - 1)}
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
            onClick={() => onPageChange(safePage + 1)}
            className="px-2 py-1 border border-ink-200 rounded disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function DeviceRow({
  device,
  active,
  onClick,
}: {
  device: DeviceSummary;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <li>
      <button
        onClick={onClick}
        className={`w-full text-left px-4 py-3 hover:bg-ink-50 ${
          active ? 'bg-ink-100' : ''
        } ${device.beacon ? 'border-l-4 border-l-amber-500' : ''}`}
      >
        <div className="flex items-center gap-2">
          {device.beacon && (
            <span
              className="inline-flex items-center bg-amber-100 text-amber-800 border border-amber-300 rounded px-1.5 py-0.5 text-[10px] font-medium"
              title="Firmware has raised a beacon flag in its latest heartbeat"
            >
              Beacon raised
            </span>
          )}
          <span className="font-mono text-sm">
            Controller #{device.controllerId}
          </span>
          <span
            className={`ml-auto text-xs ${
              device.alive ? 'text-emerald-700' : 'text-ink-500'
            }`}
            title={formatTimestamp(device.lastSeenAt)}
          >
            Last message {formatRelativeTime(device.lastSeenAt)}
          </span>
        </div>
      </button>
    </li>
  );
}
