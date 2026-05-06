import { useAuth as useOidcAuth } from 'react-oidc-context';

// Re-export for ergonomics; lets feature code import from one place.
export function useAuth() {
  return useOidcAuth();
}

export function useAccessToken(): string | undefined {
  const auth = useOidcAuth();
  return auth.user?.access_token;
}
