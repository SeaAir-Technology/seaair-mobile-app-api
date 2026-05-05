/**
 * Mobile App Routes
 * Routes used by the mobile application. Requires JWT authentication.
 */

import express, { Request, Response } from 'express';
import { verifyJWT } from '../auth';
import { Message } from '../types';

const router = express.Router();

/**
 * POST /mobile/message
 * Append a command to stream:mobile2fw:{controllerId}.
 */
router.post('/message', verifyJWT, async (req: Request, res: Response): Promise<void> => {
  const { controllerId, protobufPayload } = req.body;
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const authId = req.auth?.sub || req.auth?.userId;

  console.log(`[Mobile] Message received from user ${authId} at ${ip} for controller ${controllerId}`);

  if (controllerId === undefined || controllerId === null) {
    res.status(400).json({ error: 'controllerId is required' });
    return;
  }
  if (typeof controllerId !== 'number' || !Number.isInteger(controllerId) || controllerId <= 0 || !Number.isSafeInteger(controllerId)) {
    res.status(400).json({ error: 'controllerId must be a safe positive integer (cannot be 0)' });
    return;
  }
  if (!protobufPayload) {
    res.status(400).json({ error: 'protobufPayload is required' });
    return;
  }

  const authRateLimitKey = `auth:${authId}`;
  if (!req.app.locals.rateLimiter.checkLimit(authRateLimitKey)) {
    res.status(429).json({ error: 'Rate limit exceeded', message: 'Too many requests from this account. Maximum 25 requests per 30 seconds.' });
    return;
  }
  const ipRateLimitKey = `ip:${ip}`;
  if (!req.app.locals.rateLimiter.checkLimit(ipRateLimitKey)) {
    res.status(429).json({ error: 'Rate limit exceeded', message: 'Too many requests from this IP. Maximum 25 requests per 30 seconds.' });
    return;
  }
  req.app.locals.rateLimiter.recordRequest(authRateLimitKey);
  req.app.locals.rateLimiter.recordRequest(ipRateLimitKey);

  const message: Message = {
    timestamp: new Date().toISOString(),
    sender: { ip, type: 'mobile', authId },
    controllerId,
    protobufPayload
  };

  try {
    await req.app.locals.messageBroker.addMobileAppMessage(controllerId, message);
    res.status(200).json({ success: true, message: 'Message queued for controller', controllerId });
  } catch (err: any) {
    console.error(`[Mobile] Failed to queue message: ${err.message}`);
    res.status(500).json({ error: 'Broker write failed', message: err.message });
  }
});

/**
 * GET /mobile/status/:controllerId
 * Mobile reads latest controller heartbeat (XREVRANGE COUNT 1 with 11-min freshness window).
 */
router.get('/status/:controllerId', verifyJWT, async (req: Request, res: Response): Promise<void> => {
  const controllerId = parseInt(req.params.controllerId, 10);
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const authId = req.auth?.sub || req.auth?.userId;

  if (isNaN(controllerId) || controllerId < 0) {
    res.status(400).json({ error: 'controllerId must be a valid non-negative integer' });
    return;
  }

  const authRateLimitKey = `auth:${authId}`;
  if (!req.app.locals.rateLimiter.checkLimit(authRateLimitKey)) {
    res.status(429).json({ error: 'Rate limit exceeded', message: 'Too many requests from this account.' });
    return;
  }
  const ipRateLimitKey = `ip:${ip}`;
  if (!req.app.locals.rateLimiter.checkLimit(ipRateLimitKey)) {
    res.status(429).json({ error: 'Rate limit exceeded', message: 'Too many requests from this IP.' });
    return;
  }
  req.app.locals.rateLimiter.recordRequest(authRateLimitKey);
  req.app.locals.rateLimiter.recordRequest(ipRateLimitKey);

  try {
    const message = await req.app.locals.messageBroker.getControllerMessage(controllerId);
    if (!message) {
      res.status(200).json({ success: true, status: null });
      return;
    }
    res.status(200).json({ success: true, status: message });
  } catch (err: any) {
    console.error(`[Mobile] Failed to read status: ${err.message}`);
    res.status(500).json({ error: 'Broker read failed', message: err.message });
  }
});

export default router;
