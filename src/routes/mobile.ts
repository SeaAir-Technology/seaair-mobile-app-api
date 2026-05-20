/**
 * Mobile App Routes
 * Routes used by the mobile application. Requires JWT authentication.
 */

import express, { Request, Response } from 'express';
import { verifyJWT } from '../auth';
import { Message } from '../types';
import { decodePayload } from '../services/protoDecoder';

const router = express.Router();

/**
 * Server-side filter: drop legacy `BLE.Msg{deviceInfoRequest{}}` status
 * polls on ingress so they don't clog the mobile->firmware command FIFO.
 *
 * Why this exists: old mobile clients send a `deviceInfoRequest` periodically
 * to ask "what's the controller doing right now?". That message goes through
 * the same Redis Streams channel as real commands like `deviceConfigRequest`.
 * Drain rate is one message per firmware poll (~10s), so a chatty status
 * poll buries real commands behind dozens of queued no-ops, sometimes
 * pushing user-initiated commands minutes-to-hours behind by the time the
 * firmware sees them.
 *
 * The right fix is to point status polls at the synchronous read endpoint
 * (`GET /mobile/status/:controllerId`, which reads the latest fw2mobile
 * heartbeat without queueing anything). New mobile clients do that. This
 * filter buys legacy clients (still in the field, not yet upgraded) the
 * same outcome by silently absorbing their polls server-side.
 *
 * Behavior:
 *   - Decode the wrapper protobuf. If it's `BLE.Msg` with the
 *     `deviceInfoRequest` variant of its `oneof data` set, drop it.
 *   - Respond 200 OK with the same shape as a successful queue write so
 *     legacy clients see no difference and don't trigger retry storms.
 *   - Anything we can't decode, or any non-deviceInfoRequest message,
 *     passes through to the broker untouched.
 *   - Server-side log every drop so you can see when it's safe to remove
 *     this once all clients have upgraded.
 *
 * Kill switch: set DROP_LEGACY_DEVICE_INFO_REQUEST=false on App Runner to
 * disable in place without a redeploy. Default is enabled.
 */
function shouldDropLegacyStatusPoll(payload: string): boolean {
  if (process.env.DROP_LEGACY_DEVICE_INFO_REQUEST === 'false') return false;
  const decoded = decodePayload(payload);
  if (!decoded) return false;
  if (decoded.typeName !== 'BLE.Msg') return false;
  return decoded.data.deviceInfoRequest !== undefined;
}

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
    res.status(429).json({ error: 'Rate limit exceeded', message: 'Too many requests from this account. Maximum 60 requests per 30 seconds.' });
    return;
  }
  const ipRateLimitKey = `ip:${ip}`;
  if (!req.app.locals.rateLimiter.checkLimit(ipRateLimitKey)) {
    res.status(429).json({ error: 'Rate limit exceeded', message: 'Too many requests from this IP. Maximum 60 requests per 30 seconds.' });
    return;
  }
  req.app.locals.rateLimiter.recordRequest(authRateLimitKey);
  req.app.locals.rateLimiter.recordRequest(ipRateLimitKey);

  // Filter out legacy status polls before they hit the broker. See the
  // shouldDropLegacyStatusPoll docstring above for full rationale.
  if (shouldDropLegacyStatusPoll(protobufPayload)) {
    console.log(`[Mobile] Dropped legacy BLE.Msg{deviceInfoRequest} from user ${authId} for controller ${controllerId}; new clients should use GET /mobile/status/:controllerId instead`);
    res.status(200).json({ success: true, message: 'Message queued for controller', controllerId });
    return;
  }

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
 * Per-request cap on the number of fw2mobile entries returned in the
 * `?since=<streamId>` mode. Large enough that a mobile client polling every
 * 5s won't fall behind under normal traffic (firmware heartbeat cadence is
 * ~5s, plus occasional response messages); small enough that a misbehaving
 * client with a very old checkpoint can't drag the route into multi-second
 * payloads. When the cap is hit, the response carries `hasMore: true` so
 * the client knows to re-poll immediately with the advanced checkpoint.
 */
const SINCE_MAX_COUNT = 50;

/**
 * GET /mobile/status/:controllerId
 *
 * Two modes, selected by the presence of the `since` query param:
 *
 *   1. Legacy single-latest (no `since`)
 *      Returns `{ success, status: <single latest message or null> }`. Used
 *      by clients that don't track stream-id checkpoints — including every
 *      build released before this endpoint gained `?since` support. Reads
 *      via the broker's `getControllerMessage` (XREVRANGE COUNT 1 on Redis;
 *      single-slot lookup on the in-memory broker).
 *
 *   2. Since-checkpoint (`?since=<streamId>`)
 *      Returns `{ success, statuses: [...], highWaterMark, hasMore }`
 *      containing every fw2mobile entry with id strictly greater than the
 *      caller's `since`, capped at SINCE_MAX_COUNT. Mobile uses this to
 *      pick up command responses (admin-pin, wifi-config, …) that would
 *      otherwise be buried under a newer heartbeat by the time the next
 *      single-latest poll fires. The client persists `highWaterMark` in
 *      memory and passes it back on the next poll; first-time/bootstrap
 *      clients fall back to mode 1 to obtain an initial id.
 *
 * Backward compatibility: pre-`?since` clients never send the param and
 * never see the new response shape — they continue to get the same
 * single-latest payload they've always received.
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

  const sinceParam = req.query.since;
  const since = typeof sinceParam === 'string' && sinceParam.length > 0 ? sinceParam : null;

  try {
    if (since !== null) {
      const result = await req.app.locals.messageBroker.getControllerMessagesSince(
        controllerId,
        since,
        SINCE_MAX_COUNT,
      );
      res.status(200).json({
        success: true,
        statuses: result.messages,
        highWaterMark: result.highWaterMark,
        hasMore: result.hasMore,
      });
      return;
    }

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
