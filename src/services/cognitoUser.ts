/**
 * Resolve a Cognito user's email from the sub claim on their JWT.
 *
 * The mobile API uses Cognito access tokens, which by default don't
 * include the email claim — but they always include sub. This helper
 * does a server-side lookup against the user pool and caches the
 * result in-memory so we don't pound Cognito on every authenticated
 * write. If a future Cognito change starts including email in the
 * access token, callers can read req.auth.email directly and skip the
 * lookup entirely.
 *
 * Uses ListUsers with a sub filter rather than AdminGetUser because
 * AdminGetUser takes Username, and in this pool Username only matches
 * sub for native users. Federated identities (Google, Sign in with
 * Apple) have Usernames like "google_…" and "signinwithapple_…" with
 * a separate sub UUID, so AdminGetUser({Username: sub}) would 404 for
 * those users. The sub-filter ListUsers query is correct for both.
 *
 * Cache: 1h TTL on hits, 1min TTL on misses (so a transient Cognito
 * outage doesn't poison the negative cache for an hour), bounded to
 * 1000 entries with insertion-order FIFO eviction. Each App Runner
 * instance has its own copy; a user changing their email propagates
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

interface CacheEntry {
  email: string | null;
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
 * Returns the email attribute for the user identified by the given sub,
 * or null if Cognito returns no matching user / the user has no email
 * attribute / the lookup fails. Never throws.
 */
export async function getUserEmailBySub(sub: string): Promise<string | null> {
  if (!sub) return null;

  const now = Date.now();
  const cached = cache.get(sub);
  if (cached && cached.expires > now) {
    return cached.email;
  }
  if (cached) cache.delete(sub);

  if (!COGNITO_USER_POOL_ID) {
    console.warn('[CognitoUser] COGNITO_USER_POOL_ID not configured');
    return null;
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

    // Bound cache size with FIFO eviction (Map iteration order = insertion).
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }
    cache.set(sub, {
      email,
      expires: now + (email ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS),
    });
    return email;
  } catch (err: any) {
    console.error(`[CognitoUser] sub\u2192email lookup failed for ${sub}: ${err.message}`);
    return null;
  }
}
