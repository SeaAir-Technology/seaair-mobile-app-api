import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from './useAuth';

interface Props {
  children: ReactNode;
}

// Renders the Cognito Hosted UI sign-in button until a session exists.
// Once authenticated, hands off to AccessGate to verify dashboard-admin
// group membership.
//
// Sessions outlive the 60-minute access token: the refresh token is valid
// for 30 days, but oidc-client-ts only renews on a timer while the tab is
// awake. When the app loads (or wakes) with an expired access token and a
// stored refresh token, we renew silently instead of dumping the admin back
// on the login page.
export function LoginGate({ children }: Props): JSX.Element {
  const auth = useAuth();
  const [resume, setResume] = useState<'idle' | 'trying' | 'failed'>('idle');

  const canResume = !!auth.user?.refresh_token && resume !== 'failed';

  useEffect(() => {
    if (auth.isAuthenticated) {
      if (resume !== 'idle') setResume('idle');
      return;
    }
    if (auth.isLoading || auth.activeNavigator || resume !== 'idle') return;
    if (!auth.user?.refresh_token) return;
    setResume('trying');
    auth
      .signinSilent()
      .then((user) => setResume(user ? 'idle' : 'failed'))
      .catch(() => setResume('failed'));
  }, [auth, resume]);

  if (
    auth.isLoading ||
    resume === 'trying' ||
    (!auth.isAuthenticated && !auth.error && canResume)
  ) {
    return (
      <div className="flex items-center justify-center h-screen text-ink-500">
        Loading…
      </div>
    );
  }

  if (auth.error) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <div className="text-red-600">
          Authentication error: {auth.error.message}
        </div>
        <button
          onClick={() => auth.signinRedirect()}
          className="px-4 py-2 bg-ink-800 text-white rounded"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!auth.isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-ink-900">
            SeaAir Support Dashboard
          </h1>
          <p className="text-ink-500 text-sm mt-1">
            Sign in with your SeaAir account.
          </p>
        </div>
        <button
          onClick={() => auth.signinRedirect()}
          className="px-6 py-2.5 bg-ink-800 text-white rounded font-medium hover:bg-ink-700"
        >
          Sign in
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
