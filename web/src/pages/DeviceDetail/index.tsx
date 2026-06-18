import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CurrentState } from './CurrentState';
import { History } from './History';
import { Analytics } from './Analytics';
import { useMarkAllReceived } from '../../hooks/useDeviceMutations';
import { useDeviceQueue } from '../../hooks/useDeviceQueue';
import type { PayloadFilter } from '../../lib/types';

// Overview combines the formatted current-state summary with the analytics
// charts (history stays its own tab). On phones the device list and this
// detail pane are shown one at a time; the back button returns to the list.
type Tab = 'overview' | 'history';

interface Props {
  controllerId: number;
  filters: PayloadFilter[];
}

export function DeviceDetail({ controllerId, filters }: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('overview');
  const navigate = useNavigate();
  return (
    <div className="h-full flex flex-col">
      <div className="px-4 pt-3 pb-0 border-b border-ink-200 bg-white sticky top-0 z-10">
        <button
          type="button"
          onClick={() => navigate('/devices')}
          className="md:hidden inline-flex items-center gap-1 text-sm text-ink-600 hover:text-ink-900 mb-2 -ml-1"
        >
          <span aria-hidden>←</span> Devices
        </button>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-ink-500 mb-1">Controller</div>
            <div className="font-mono text-lg text-ink-900 mb-2">
              #{controllerId}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <QueueBadge controllerId={controllerId} />
            <MarkAllReceivedButton controllerId={controllerId} />
          </div>
        </div>
        <div className="flex gap-1">
          {(['overview', 'history'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-sm border-b-2 -mb-px ${
                tab === t
                  ? 'border-ink-800 text-ink-900 font-medium'
                  : 'border-transparent text-ink-500 hover:text-ink-900'
              }`}
            >
              {t === 'overview' ? 'Overview' : 'History'}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === 'overview' && (
          <>
            <CurrentState controllerId={controllerId} />
            <div className="border-t border-ink-200 mx-4" />
            <div className="px-1 pt-2 pb-1">
              <div className="px-3 text-xs font-medium uppercase tracking-wide text-ink-500">
                Analytics
              </div>
            </div>
            <Analytics controllerId={controllerId} />
          </>
        )}
        {tab === 'history' && (
          <History controllerId={controllerId} filters={filters} />
        )}
      </div>
    </div>
  );
}

// Live counter of how many mobile→firmware commands are sitting in this
// controller's Redis stream past the consumer group's last-delivered-id.
// Polls every 2s via useDeviceQueue so the user can watch it tick down as
// the firmware drains the queue (or jump to zero after Mark All Received).
function QueueBadge({ controllerId }: { controllerId: number }): JSX.Element {
  const { data, isLoading, error } = useDeviceQueue(controllerId);

  if (error) {
    return (
      <span
        className="text-[11px] text-red-600 whitespace-nowrap"
        role="alert"
        title={(error as Error).message}
      >
        queue unavailable
      </span>
    );
  }

  const unread = data?.unread ?? 0;
  const pending = data?.pending ?? 0;
  const total = unread + pending;
  const hasMessages = total > 0;

  const title =
    pending > 0
      ? `${unread} undelivered + ${pending} delivered-but-unacked in the mobile→firmware queue`
      : 'Messages queued for the firmware to fetch. Updates every 2s.';

  return (
    <span
      className={`text-xs px-2.5 py-1 rounded border whitespace-nowrap inline-flex items-center gap-1.5 ${
        hasMessages
          ? 'bg-amber-50 border-amber-300 text-amber-900'
          : 'bg-ink-50 border-ink-200 text-ink-600'
      }`}
      title={title}
      aria-label={`${total} unread queued message${total === 1 ? '' : 's'}`}
    >
      <span className="font-mono font-medium tabular-nums">
        {isLoading ? '…' : total}
      </span>
      <span>unread</span>
      {data?.capped && <span className="text-[10px] opacity-70">(10k+)</span>}
    </span>
  );
}

// Two-stage button so it takes a deliberate confirm before discarding
// queued mobile commands. First click stages the action and the label
// flips to "Click again to confirm"; second click within 4 seconds fires
// the mutation. Auto-resets if the user walks away.
function MarkAllReceivedButton({
  controllerId,
}: {
  controllerId: number;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [recentResult, setRecentResult] = useState<{
    skipped: number;
    pelAcked: number;
  } | null>(null);
  const mutation = useMarkAllReceived();

  // Auto-cancel the staged confirmation after 4s of no action.
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  // Reset the staged confirmation when switching to a different controller.
  useEffect(() => {
    setConfirming(false);
    setRecentResult(null);
  }, [controllerId]);

  // Hide the success summary after 6s so the button comes back.
  useEffect(() => {
    if (!recentResult) return;
    const t = setTimeout(() => setRecentResult(null), 6000);
    return () => clearTimeout(t);
  }, [recentResult]);

  if (recentResult) {
    const { skipped, pelAcked } = recentResult;
    const total = skipped + pelAcked;
    return (
      <span
        className="text-xs text-emerald-700 self-center whitespace-nowrap"
        role="status"
      >
        {total === 0
          ? 'Queue was already empty'
          : `Marked ${skipped} skipped, ${pelAcked} acknowledged`}
      </span>
    );
  }

  const onClick = (): void => {
    if (mutation.isPending) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    mutation.mutate(controllerId, {
      onSuccess: (data) => {
        setRecentResult({ skipped: data.skipped, pelAcked: data.pelAcked });
      },
    });
  };

  return (
    <div className="flex flex-col items-end gap-1 self-start">
      <button
        type="button"
        onClick={onClick}
        disabled={mutation.isPending}
        className={`text-xs px-2.5 py-1.5 rounded border whitespace-nowrap transition-colors ${
          confirming
            ? 'bg-amber-50 border-amber-400 text-amber-900'
            : 'border-ink-300 text-ink-700 hover:bg-ink-50'
        } disabled:opacity-50`}
        title="Skip every queued mobile-to-firmware message so the firmware ignores them"
      >
        {mutation.isPending
          ? 'Marking\u2026'
          : confirming
          ? 'Click again to confirm'
          : 'Mark all received'}
      </button>
      {mutation.isError && (
        <span className="text-[11px] text-red-600" role="alert">
          {(mutation.error as Error).message}
        </span>
      )}
    </div>
  );
}
