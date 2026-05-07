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

  // Email resolution. Try the JWT claim first (works free if Cognito ever
  // starts emitting it), then fall back to a sub\u2192email lookup against
  // the user pool. The lookup is cached in-memory so steady-state cost is
  // about one Cognito ListUsers call per user per hour per instance.
  let userEmail = (req.auth as any).email as string | undefined;
  if (!userEmail) {
    const looked = await getUserEmailBySub(userId);
    if (looked) userEmail = looked;
  }
  if (!userEmail) {
    // Don't fail the beacon over a missing email \u2014 the user is authenticated
    // and the controller still needs help. Store a placeholder that includes
    // the first 8 chars of sub so support staff can still tell which user it
    // was via the userId field on the beacon record.
    console.warn(`[Beacon] Could not resolve email for sub ${userId}; storing placeholder`);
    userEmail = `(no-email:${userId.slice(0, 8)})`;
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
