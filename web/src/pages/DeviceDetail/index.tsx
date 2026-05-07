import { useEffect, useState } from 'react';
import { CurrentState } from './CurrentState';
import { History } from './History';
import { Analytics } from './Analytics';
import { useMarkAllReceived } from '../../hooks/useDeviceMutations';
import type { PayloadFilter } from '../../lib/types';

type Tab = 'state' | 'history' | 'analytics';

interface Props {
  controllerId: number;
  filters: PayloadFilter[];
}

export function DeviceDetail({ controllerId, filters }: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('state');
  return (
    <div className="h-full flex flex-col">
      <div className="px-4 pt-3 pb-0 border-b border-ink-200 bg-white sticky top-0 z-10">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-ink-500 mb-1">Controller</div>
            <div className="font-mono text-lg text-ink-900 mb-2">
              #{controllerId}
            </div>
          </div>
          <MarkAllReceivedButton controllerId={controllerId} />
        </div>
        <div className="flex gap-1">
          {(['state', 'history', 'analytics'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-sm border-b-2 -mb-px ${
                tab === t
                  ? 'border-ink-800 text-ink-900 font-medium'
                  : 'border-transparent text-ink-500 hover:text-ink-900'
              }`}
            >
              {t === 'state'
                ? 'Current State'
                : t === 'history'
                ? 'History'
                : 'Analytics'}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === 'state' && <CurrentState controllerId={controllerId} />}
        {tab === 'history' && (
          <History controllerId={controllerId} filters={filters} />
        )}
        {tab === 'analytics' && <Analytics controllerId={controllerId} />}
      </div>
    </div>
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
