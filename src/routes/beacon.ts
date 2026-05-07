/**
 * Beacon submission route - mounted at /mobile/beacon.
 *
 * The mobile app POSTs here when a user requests support. The user's
 * identity comes from their Cognito JWT (we don't trust client-supplied
 * identity). Body: { controllerId: number, message?: string }.
 *
 * Email resolution: Cognito access tokens don't include the email claim
 * by default, so we don't depend on req.auth.email being populated. We
 * resolve it server-side from req.auth.sub via the cognitoUser cache.
 * If a future Cognito access-token customization adds email to the JWT,
 * the lookup short-circuits and we use the claim directly.
 *
 * Fallback when both the claim and the lookup return nothing:
 *   - Federated users (Google, Sign in with Apple) get their
 *     cognito:username, which is in the form "google_<id>" or
 *     "signinwithapple_<id>" — enough for support to identify the user
 *     by provider.
 *   - Native users get a sub-prefix placeholder, since their
 *     cognito:username is the same UUID as sub and adds no info.
 *   - The userId field on the beacon record always carries the full sub
 *     so support can cross-reference exactly even when userEmail is a
 *     placeholder.
 */

import express, { Request, Response } from 'express';
import { verifyJWT } from '../auth';
import { createBeacon } from '../services/beacons';
import { getUserEmailBySub } from '../services/cognitoUser';

const router = express.Router();

router.post('/', verifyJWT, async (req: Request, res: Response): Promise<void> => {
  if (!req.auth) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }
  const { controllerId, message } = req.body || {};

  if (controllerId === undefined || controllerId === null) {
    res.status(400).json({ error: 'controllerId is required' });
    return;
  }
  if (
    typeof controllerId !== 'number' ||
    !Number.isInteger(controllerId) ||
    controllerId <= 0 ||
    !Number.isSafeInteger(controllerId)
  ) {
    res.status(400).json({ error: 'controllerId must be a safe positive integer' });
    return;
  }
  if (message !== undefined && typeof message !== 'string') {
    res.status(400).json({ error: 'message must be a string' });
    return;
  }
  if (typeof message === 'string' && message.length > 2000) {
    res.status(400).json({ error: 'message must be 2000 characters or less' });
    return;
  }

  const userId = req.auth.sub;
  if (!userId) {
    res.status(401).json({ error: 'JWT missing sub claim' });
    return;
  }

  // 1. Trust the JWT email claim if present (free, future-proof if Cognito
  //    is configured to emit it later).
  // 2. Look up via Cognito ListUsers by sub. Cached in-memory.
  // 3. Fall back to the cognito:username for federated users so support
  //    sees "google_..." or "signinwithapple_..." instead of an opaque
  //    sub prefix; the userId field still has the full sub.
  let userEmail = (req.auth as any).email as string | undefined;
  if (!userEmail) {
    const looked = await getUserEmailBySub(userId);
    if (looked) userEmail = looked;
  }
  if (!userEmail) {
    const cognitoUsername =
      ((req.auth as any)['cognito:username'] as string | undefined) ||
      ((req.auth as any).username as string | undefined);
    if (
      cognitoUsername &&
      // Native-user usernames are the same UUID as sub; surfacing them
      // would be no more useful than the sub prefix. Federated usernames
      // start with the provider name ("google_", "signinwithapple_"),
      // which is what we want to expose.
      cognitoUsername !== userId &&
      !/^[0-9a-f-]{36}$/i.test(cognitoUsername)
    ) {
      userEmail = `(${cognitoUsername})`;
    } else {
      userEmail = `(no-email:${userId.slice(0, 8)})`;
    }
    console.warn(
      `[Beacon] Could not resolve email for sub ${userId}; storing fallback ${userEmail}`
    );
  }

  try {
    const beacon = await createBeacon({
      controllerId,
      userId,
      userEmail,
      message: message?.trim() || undefined,
    });
    res.status(201).json({ success: true, beacon });
  } catch (err: any) {
    console.error(`[Beacon] Create failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to create beacon', message: err.message });
  }
});

export default router;
