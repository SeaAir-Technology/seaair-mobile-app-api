import { useState } from 'react';
import { CurrentState } from './CurrentState';
import { History } from './History';
import { Analytics } from './Analytics';
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
        <div className="text-xs text-ink-500 mb-1">Controller</div>
        <div className="font-mono text-lg text-ink-900 mb-2">
          #{controllerId}
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
