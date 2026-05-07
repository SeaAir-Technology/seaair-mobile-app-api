import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccessToken, useAuth } from './useAuth';
import { apiFetch, ApiError } from '../lib/api';
import type { MeResponse } from '../lib/types';

interface Props {
  children: ReactNode;
}

// Verifies the signed-in user actually has dashboard-admin access by
// hitting /me. Renders an access-denied screen on 403 with a sign-out
// affordance, since reauthing as the same user won't fix it -- another
// admin needs to grant.
export function AccessGate({ children }: Props): JSX.Element {
  const auth = useAuth();
  const token = useAccessToken();

  const { data, error, isLoading } = useQuery<MeResponse>({
    queryKey: ['me'],
    queryFn: () => apiFetch<MeResponse>(token!, '/me'),
    enabled: !!token,
    retry: false,
    staleTime: 60_000,
  });

  if (isLoading) {
    return <div className="p-8 text-ink-500">Checking access…</div>;
  }

  const apiErr = error as ApiError | undefined;
  if (apiErr?.status === 403) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4 p-8 text-center">
        <h1 className="text-xl font-semibold text-ink-900">Access denied</h1>
        <p className="text-ink-500 max-w-md">
          Your account is signed in but isn’t in the dashboard-admin group.
          Ask another dashboard admin to grant access, then refresh.
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 border border-ink-300 rounded"
          >
            Refresh
          </button>
          <button
            onClick={() => auth.signoutRedirect()}
            className="px-4 py-2 bg-ink-800 text-white rounded"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-red-600">
        Failed to verify access: {String((error as Error).message)}
      </div>
    );
  }

  if (!data?.isDashboardAdmin) {
    return <div className="p-8 text-ink-500">Access check inconclusive.</div>;
  }

  return <>{children}</>;
}
