/**
 * Resolve a Cognito user's email and name from the sub claim on their JWT.
 *
 * The mobile API uses Cognito access tokens, which by default don't
 * include the email or name claims — but they always include sub. This
 * helper does a server-side lookup against the user pool and caches the
 * result in-memory so we don't pound Cognito on every authenticated
 * write. If a future Cognito change starts including these in the
 * access token, callers can read req.auth.email / req.auth.name directly
 * and skip the lookup entirely.
 *
 * Uses ListUsers with a sub filter rather than AdminGetUser because
 * AdminGetUser takes Username, and in this pool Username only matches
 * sub for native users. Federated identities (Google, Sign in with
 * Apple) have Usernames like "google_…" and "signinwithapple_…" with
 * a separate sub UUID, so AdminGetUser({Username: sub}) would 404 for
 * those users. The sub-filter ListUsers query is correct for both.
 *
 * email and name are fetched and cached together — both come off the
 * same ListUsers Attributes array, so there's no reason to pay for two
 * Cognito round-trips per user.
 *
 * Cache: 1h TTL on hits, 1min TTL on misses (so a transient Cognito
 * outage doesn't poison the negative cache for an hour), bounded to
 * 1000 entries with insertion-order FIFO eviction. Each App Runner
 * instance has its own copy; a user changing their email/name propagates
 * within an hour. The cache covers the steady-state fast path; the
 * call latency on a cache miss is one ListUsers round-trip (~50ms).
 */

import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { COGNITO_USER_POOL_ID, AWS_REGION } from '../auth';

const CACHE_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 1000;

export interface CognitoUserAttributes {
  email: string | null;
  name: string | null;
}

interface CacheEntry extends CognitoUserAttributes {
  expires: number;
}

const cache = new Map<string, CacheEntry>();

let cognitoClient: CognitoIdentityProviderClient | null = null;
function client(): CognitoIdentityProviderClient {
  if (!cognitoClient) {
    cognitoClient = new CognitoIdentityProviderClient({ region: AWS_REGION });
  }
  return cognitoClient;
}

/**
 * Returns the email + name attributes for the user identified by the
 * given sub, or nulls if Cognito returns no matching user / the user
 * has no such attribute / the lookup fails. Never throws.
 */
export async function getCognitoUserBySub(sub: string): Promise<CognitoUserAttributes> {
  if (!sub) return { email: null, name: null };

  const now = Date.now();
  const cached = cache.get(sub);
  if (cached && cached.expires > now) {
    return { email: cached.email, name: cached.name };
  }
  if (cached) cache.delete(sub);

  if (!COGNITO_USER_POOL_ID) {
    console.warn('[CognitoUser] COGNITO_USER_POOL_ID not configured');
    return { email: null, name: null };
  }

  try {
    const result = await client().send(new ListUsersCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      // Filter syntax: `sub = "<value>"`. Strip any double quotes from the
      // sub defensively even though Cognito-issued sub UUIDs never contain
      // them; this is just to make the query injection-safe by construction.
      Filter: `sub = "${sub.replace(/"/g, '')}"`,
      Limit: 1,
    }));

    const user = result.Users?.[0];
    const email =
      user?.Attributes?.find((a) => a.Name === 'email')?.Value ?? null;
    const name =
      user?.Attributes?.find((a) => a.Name === 'name')?.Value ?? null;

    // Bound cache size with FIFO eviction (Map iteration order = insertion).
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }
    cache.set(sub, {
      email,
      name,
      expires: now + (email ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS),
    });
    return { email, name };
  } catch (err: any) {
    console.error(`[CognitoUser] sub\u2192attributes lookup failed for ${sub}: ${err.message}`);
    return { email: null, name: null };
  }
}
