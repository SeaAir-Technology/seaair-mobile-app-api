import { useState } from 'react';
import {
  useAdminUsers,
  useGrantUser,
  useRevokeUser,
} from '../hooks/useAdminUsers';
import { Spinner } from '../components/Spinner';
import type { DashboardUser } from '../lib/types';

// Toggle dashboard-admin group membership for any Cognito user. The backend
// rejects self-revoke, so we don't need to guard for that here.
export function AdminPage(): JSX.Element {
  const { data, isLoading, error } = useAdminUsers();
  const [filter, setFilter] = useState('');
  const grant = useGrantUser();
  const revoke = useRevokeUser();
  const f = filter.toLowerCase().trim();
  const users =
    data?.users.filter(
      (u) =>
        !f ||
        (u.email && u.email.toLowerCase().includes(f)) ||
        (u.username && u.username.toLowerCase().includes(f))
    ) ?? [];

  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-ink-200 bg-white px-4 py-3">
        <h1 className="text-sm text-ink-900 font-semibold">Dashboard Admins</h1>
        <p className="text-xs text-ink-500 mt-0.5">
          Toggle dashboard access for any Cognito user. Members of the
          dashboard-admin group can sign in here.
        </p>
      </div>
      <div className="px-4 py-2 border-b border-ink-200 bg-white">
        <input
          type="text"
          placeholder="Search by email or username"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-full max-w-sm px-3 py-1.5 border border-ink-200 rounded text-sm"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {isLoading && <Spinner label="Loading users…" />}
        {error && (
          <div className="text-red-600 text-sm">
            {(error as Error).message}
          </div>
        )}
        {data && (
          <ul className="divide-y divide-ink-100 bg-white border border-ink-200 rounded">
            {users.map((u) => (
              <UserRow
                key={u.sub || u.username}
                user={u}
                onGrant={() => grant.mutate(u.username)}
                onRevoke={() => revoke.mutate(u.username)}
                pending={
                  (grant.isPending && grant.variables === u.username) ||
                  (revoke.isPending && revoke.variables === u.username)
                }
              />
            ))}
            {users.length === 0 && (
              <li className="px-4 py-3 text-ink-500 text-sm">
                No users match.
              </li>
            )}
          </ul>
        )}
        {(grant.error || revoke.error) && (
          <div className="text-red-600 text-sm">
            {((grant.error || revoke.error) as Error).message}
          </div>
        )}
      </div>
    </div>
  );
}

function UserRow({
  user,
  onGrant,
  onRevoke,
  pending,
}: {
  user: DashboardUser;
  onGrant: () => void;
  onRevoke: () => void;
  pending: boolean;
}): JSX.Element {
  return (
    <li className="px-4 py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-ink-900 truncate">
          {user.email || user.username}
        </div>
        <div className="text-xs text-ink-500 font-mono truncate">
          {user.username} · {user.status}
          {!user.enabled && ' · disabled'}
        </div>
      </div>
      <span
        className={`text-xs px-2 py-0.5 rounded border ${
          user.isDashboardAdmin
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
            : 'bg-ink-50 text-ink-500 border-ink-200'
        }`}
      >
        {user.isDashboardAdmin ? 'Admin' : 'No access'}
      </span>
      {user.isDashboardAdmin ? (
        <button
          onClick={onRevoke}
          disabled={pending}
          className="px-3 py-1 text-xs border border-ink-300 text-ink-700 rounded disabled:opacity-50"
        >
          Revoke
        </button>
      ) : (
        <button
          onClick={onGrant}
          disabled={pending}
          className="px-3 py-1 text-xs bg-ink-800 text-white rounded disabled:opacity-50"
        >
          Grant
        </button>
      )}
    </li>
  );
}
