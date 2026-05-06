import type { ReactNode } from 'react';
import { useAuth } from './useAuth';

interface Props {
  children: ReactNode;
}

// Renders the Cognito Hosted UI sign-in button until a session exists.
// Once authenticated, hands off to AccessGate to verify dashboard-admin
// group membership.
export function LoginGate({ children }: Props): JSX.Element {
  const auth = useAuth();

  if (auth.isLoading) {
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
