/**
 * Cognito client wrapper.
 *
 * Uses amazon-cognito-identity-js (USER_SRP_AUTH) so we never have a client
 * secret in the browser. The dashboard targets the existing user pool and
 * app client; access is gated server-side by membership in the
 * dashboard-admin Cognito group.
 *
 * Tokens persist via amazon-cognito-identity-js's built-in localStorage
 * adapter, keyed by `CognitoIdentityServiceProvider.{clientId}.{username}.*`.
 */

import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';

// Hard-coded for the SeaAir support dashboard. If you ever rotate to a new
// pool / client, change these and rebuild.
const USER_POOL_ID = 'us-east-2_Z6wNcT7sN';
const CLIENT_ID = '40b923fpk6c5v1lvatbcqbdakq';

const userPool = new CognitoUserPool({
  UserPoolId: USER_POOL_ID,
  ClientId: CLIENT_ID,
});

export interface SignInResult {
  accessToken: string;
  idToken: string;
  username: string;
  email?: string;
  groups: string[];
}

export interface NewPasswordRequired {
  type: 'NEW_PASSWORD_REQUIRED';
  user: CognitoUser;
  userAttributes: Record<string, string>;
}

export type SignInOutcome = SignInResult | NewPasswordRequired;

function readSession(session: CognitoUserSession, fallbackUsername: string): SignInResult {
  const idPayload = session.getIdToken().decodePayload() as Record<string, unknown>;
  const accessPayload = session.getAccessToken().decodePayload() as Record<string, unknown>;
  const groupsRaw = (accessPayload['cognito:groups'] || idPayload['cognito:groups']) as
    | string[]
    | undefined;
  return {
    accessToken: session.getAccessToken().getJwtToken(),
    idToken: session.getIdToken().getJwtToken(),
    username:
      (accessPayload.username as string) ||
      (idPayload['cognito:username'] as string) ||
      fallbackUsername,
    email: idPayload.email as string | undefined,
    groups: Array.isArray(groupsRaw) ? groupsRaw : [],
  };
}

export function signIn(username: string, password: string): Promise<SignInOutcome> {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: username, Pool: userPool });
    const auth = new AuthenticationDetails({ Username: username, Password: password });
    user.authenticateUser(auth, {
      onSuccess(session) {
        resolve(readSession(session, username));
      },
      onFailure(err) {
        reject(err);
      },
      newPasswordRequired(userAttributes) {
        // Cognito's required attribute set; remove email_verified to satisfy
        // completeNewPasswordChallenge expectations.
        delete userAttributes.email_verified;
        delete userAttributes.phone_number_verified;
        resolve({ type: 'NEW_PASSWORD_REQUIRED', user, userAttributes });
      },
    });
  });
}

export function completeNewPassword(
  user: CognitoUser,
  newPassword: string,
  attrs: Record<string, string>
): Promise<SignInResult> {
  return new Promise((resolve, reject) => {
    user.completeNewPasswordChallenge(newPassword, attrs, {
      onSuccess(session) {
        resolve(readSession(session, user.getUsername()));
      },
      onFailure(err) {
        reject(err);
      },
    });
  });
}

/**
 * Returns a current valid access token, refreshing transparently if needed.
 * Resolves to null if no user is signed in or refresh fails.
 */
export function getAccessToken(): Promise<string | null> {
  const user = userPool.getCurrentUser();
  if (!user) return Promise.resolve(null);
  return new Promise((resolve) => {
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session || !session.isValid()) {
        resolve(null);
        return;
      }
      resolve(session.getAccessToken().getJwtToken());
    });
  });
}

export function getCurrentUserSnapshot(): SignInResult | null {
  const user = userPool.getCurrentUser();
  if (!user) return null;
  let snapshot: SignInResult | null = null;
  user.getSession((err: Error | null, session: CognitoUserSession | null) => {
    if (err || !session || !session.isValid()) return;
    snapshot = readSession(session, user.getUsername());
  });
  return snapshot;
}

export function signOut(): void {
  const user = userPool.getCurrentUser();
  if (user) user.signOut();
}
