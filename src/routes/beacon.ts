/**
 * Beacon submission route - mounted at /mobile/beacon.
 *
 * The mobile app POSTs here when a user requests support. The user's email
 * comes from their Cognito JWT (we do not trust a client-provided email).
 *
 * Body: { controllerId: number, message?: string }
 */

import express, { Request, Response } from 'express';
import { verifyJWT } from '../auth';
import { createBeacon } from '../services/beacons';

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
  const userEmail = req.auth.email;
  if (!userEmail) {
    res.status(400).json({
      error: 'JWT missing email claim',
      message: 'Configure Cognito to include email on the access token',
    });
    return;
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
