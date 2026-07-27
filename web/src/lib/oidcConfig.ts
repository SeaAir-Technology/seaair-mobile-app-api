import { WebStorageStateStore } from 'oidc-client-ts';
import type { AuthProviderProps } from 'react-oidc-context';

const authority = import.meta.env.VITE_COGNITO_AUTHORITY;
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID;
const domain = import.meta.env.VITE_COGNITO_DOMAIN
  .replace(/^https?:\/\//, '')
  .replace(/\/$/, '');
const redirectUri = import.meta.env.VITE_COGNITO_REDIRECT_URI;
const logoutUri = import.meta.env.VITE_COGNITO_LOGOUT_URI;

// Cognito's OIDC discovery doc lists internal /authorize and /token endpoints,
// but those don't render the Hosted UI login page. We provide all endpoints
// explicitly so oidc-client-ts uses the Hosted UI domain instead of
// discovery. Token / userinfo / jwks endpoints continue to work fine.
export const oidcConfig: AuthProviderProps = {
  authority,
  client_id: clientId,
  redirect_uri: redirectUri,
  post_logout_redirect_uri: logoutUri,
  response_type: 'code',
  scope: 'openid email profile',
  loadUserInfo: false,
  metadata: {
    issuer: authority,
    authorization_endpoint: `https://${domain}/oauth2/authorize`,
    token_endpoint: `https://${domain}/oauth2/token`,
    userinfo_endpoint: `https://${domain}/oauth2/userInfo`,
    end_session_endpoint:
      `https://${domain}/logout?client_id=${encodeURIComponent(clientId)}` +
      `&logout_uri=${encodeURIComponent(logoutUri)}`,
    jwks_uri: `${authority}/.well-known/jwks.json`,
    revocation_endpoint: `https://${domain}/oauth2/revoke`,
  },
  userStore: new WebStorageStateStore({ store: window.localStorage }),
  // Renew via the refresh token before the 60-min access token lapses.
  // (This is the library default, but it's the load-bearing half of "don't
  // make admins log in hourly" — the other half is LoginGate's silent resume
  // for tabs that were closed or asleep past expiry.)
  automaticSilentRenew: true,
  // Strip the ?code=&state= from the URL after sign-in completes so the user
  // can refresh without re-triggering the auth-code exchange.
  onSigninCallback: () => {
    window.history.replaceState({}, document.title, window.location.pathname);
  },
};
