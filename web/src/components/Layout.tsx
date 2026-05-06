import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth, useAccessToken } from '../auth/useAuth';
import { apiFetch } from '../lib/api';
import type { MeResponse } from '../lib/types';

export function Layout(): JSX.Element {
  const auth = useAuth();
  const navigate = useNavigate();
  const token = useAccessToken();
  const me = useQuery<MeResponse>({
    queryKey: ['me'],
    queryFn: () => apiFetch<MeResponse>(token!, '/me'),
    enabled: !!token,
    staleTime: 60_000,
  });

  const navClass = ({ isActive }: { isActive: boolean }): string =>
    `block px-4 py-2 rounded text-sm ${
      isActive ? 'bg-ink-800 text-white' : 'text-ink-600 hover:bg-ink-100'
    }`;

  return (
    <div className="h-full flex">
      <aside className="w-56 shrink-0 border-r border-ink-200 bg-white flex flex-col">
        <div className="px-4 py-5 border-b border-ink-200">
          <Link to="/devices" className="text-ink-900 font-semibold">
            SeaAir Support
          </Link>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-1">
          <NavLink to="/devices" className={navClass}>
            Devices
          </NavLink>
          <NavLink to="/beacons" className={navClass}>
            Beacons
          </NavLink>
          <NavLink to="/admin" className={navClass}>
            Admin
          </NavLink>
        </nav>
        <div className="px-4 py-3 border-t border-ink-200 text-xs text-ink-500">
          <div className="truncate" title={me.data?.username}>
            {me.data?.email || me.data?.username || '…'}
          </div>
          <button
            className="mt-2 text-ink-600 hover:text-ink-900 underline"
            onClick={() => auth.signoutRedirect().catch(() => navigate('/'))}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
