import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth, useAccessToken } from '../auth/useAuth';
import { apiFetch } from '../lib/api';
import type { MeResponse } from '../lib/types';

const LOGO = 'https://seaair.com/cdn/shop/files/SeaAir-logos_SeaAir_2C_Horiz_120x@2x.png?v=1761525842';

export function Layout(): JSX.Element {
  const auth = useAuth();
  const navigate = useNavigate();
  const token = useAccessToken();
  const [navOpen, setNavOpen] = useState(false);
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

  // Shared sidebar body, reused by the desktop rail and the mobile drawer.
  // Tapping a link closes the drawer (no-op on desktop).
  const sidebar = (
    <>
      <div className="px-4 py-4 border-b border-ink-200">
        <Link to="/devices" className="block" onClick={() => setNavOpen(false)}>
          <img src={LOGO} alt="SeaAir" className="h-8 w-auto" />
          <div className="text-xs text-ink-500 mt-1.5">Support Dashboard</div>
        </Link>
      </div>
      <nav className="flex-1 px-2 py-3 space-y-1">
        {[
          ['/devices', 'Live'],
          ['/history', 'History'],
          ['/beacons', 'Beacons'],
          ['/admin', 'Admin'],
        ].map(([to, label]) => (
          <NavLink key={to} to={to} className={navClass} onClick={() => setNavOpen(false)}>
            {label}
          </NavLink>
        ))}
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
    </>
  );

  return (
    <div className="h-full flex flex-col md:flex-row">
      {/* Mobile top bar with hamburger */}
      <header className="md:hidden flex items-center gap-3 border-b border-ink-200 bg-white px-3 py-2 shrink-0">
        <button
          type="button"
          onClick={() => setNavOpen(true)}
          aria-label="Open navigation menu"
          className="p-1.5 -ml-1 text-ink-700 hover:bg-ink-100 rounded"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <img src={LOGO} alt="SeaAir" className="h-6 w-auto" />
      </header>

      {/* Mobile drawer */}
      {navOpen && (
        <div className="md:hidden fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setNavOpen(false)}
            aria-hidden
          />
          <aside className="absolute left-0 top-0 h-full w-64 bg-white border-r border-ink-200 flex flex-col shadow-xl">
            {sidebar}
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-56 shrink-0 border-r border-ink-200 bg-white flex-col">
        {sidebar}
      </aside>

      <main className="flex-1 min-h-0 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
