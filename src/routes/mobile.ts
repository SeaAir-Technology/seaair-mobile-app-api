/**
 * Mobile App Routes
 * Routes used by the mobile application
 * Requires JWT authentication
 */

import express, { Request, Response } from 'express';
import { verifyJWT } from '../auth';
import { Message } from '../types';
import { validateControllerIdInProtobuf } from '../protobufValidator';

const router = express.Router();

/**
 * POST /mobile/message
 * Mobile app sends message to controller
 * Requires JWT authentication
 * Body: {
 *   controllerId: number (required),
 *   protobufPayload: string (base64 encoded protobuf)
 * }
 */
router.post('/message', verifyJWT, async (req: Request, res: Response): Promise<void> => {
  const { controllerId, protobufPayload } = req.body;
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const authId = req.auth?.sub || req.auth?.userId;

  console.log(`[Mobile] Message received from user ${authId} at ${ip} for controller ${controllerId}`);
  console.log(`[Mobile] Payload:`, JSON.stringify(req.body, null, 2));

  // Validate required fields
  if (controllerId === undefined || controllerId === null) {
    console.log('[Mobile] Error: controllerId is required');
    res.status(400).json({ 
      error: 'controllerId is required' 
    });
    return;
  }

  // Validate controllerId is a number
  if (typeof controllerId !== 'number' || !Number.isInteger(controllerId) || controllerId < 0 || !Number.isSafeInteger(controllerId)) {
    console.log('[Mobile] Error: controllerId must be a safe non-negative integer');
    res.status(400).json({ 
      error: 'controllerId must be a safe non-negative integer (within JavaScript safe integer range)' 
    });
    return;
  }

  if (!protobufPayload) {
    console.log('[Mobile] Error: protobufPayload is required');
    res.status(400).json({ 
      error: 'protobufPayload is required' 
    });
    return;
  }

  // Validate controller ID in protobuf payload
  const validation = await validateControllerIdInProtobuf(protobufPayload);
  if (!validation.valid) {
    console.log(`[Mobile] Error: Rejected message with controller_id = 0 in protobuf payload from user ${authId} for controller ${controllerId}`);
    res.status(400).json({ 
      error: 'Invalid protobuf message: controller_id cannot be 0' 
    });
    return;
  }

  // Rate limiting check - track per account and per IP to any controller
  const authRateLimitKey = `auth:${authId}`;
  if (!req.app.locals.rateLimiter.checkLimit(authRateLimitKey)) {
    console.log(`[Mobile] Rate limit exceeded for user ${authId}`);
    res.status(429).json({ 
      error: 'Rate limit exceeded',
      message: 'Too many requests from this account. Maximum 25 requests per 30 seconds.'
    });
    return;
  }

  // Also check rate limiting by IP
  const ipRateLimitKey = `ip:${ip}`;
  if (!req.app.locals.rateLimiter.checkLimit(ipRateLimitKey)) {
    console.log(`[Mobile] Rate limit exceeded for IP ${ip}`);
    res.status(429).json({ 
      error: 'Rate limit exceeded',
      message: 'Too many requests from this IP. Maximum 25 requests per 30 seconds.'
    });
    return;
  }

  // Record this request for both auth and IP rate limiting
  req.app.locals.rateLimiter.recordRequest(authRateLimitKey);
  req.app.locals.rateLimiter.recordRequest(ipRateLimitKey);

  // Create message object
  const message: Message = {
    timestamp: new Date().toISOString(),
    sender: {
      ip: ip,
      type: 'mobile',
      authId: authId
    },
    controllerId: controllerId,
    protobufPayload: protobufPayload
  };

  // Add to mobile app queue
  req.app.locals.messageQueue.addMobileAppMessage(controllerId, message);

  res.status(200).json({ 
    success: true,
    message: 'Message queued for controller',
    controllerId: controllerId
  });
});

/**
 * GET /mobile/status/:controllerId
 * Mobile app retrieves latest controller status
 * Requires JWT authentication
 */
router.get('/status/:controllerId', verifyJWT, (req: Request, res: Response): void => {
  const controllerIdParam = req.params.controllerId;
  const controllerId = parseInt(controllerIdParam, 10);
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const authId = req.auth?.sub || req.auth?.userId;

  console.log(`[Mobile] Status request from user ${authId} at ${ip} for controller ${controllerId}`);

  if (isNaN(controllerId) || controllerId < 0) {
    res.status(400).json({ 
      error: 'controllerId must be a valid non-negative integer' 
    });
    return;
  }

  // Rate limiting check - track per account and per IP
  const authRateLimitKey = `auth:${authId}`;
  if (!req.app.locals.rateLimiter.checkLimit(authRateLimitKey)) {
    console.log(`[Mobile] Rate limit exceeded for user ${authId}`);
    res.status(429).json({ 
      error: 'Rate limit exceeded',
      message: 'Too many requests from this account. Maximum 25 requests per 30 seconds.'
    });
    return;
  }

  // Also check IP rate limiting
  const ipRateLimitKey = `ip:${ip}`;
  if (!req.app.locals.rateLimiter.checkLimit(ipRateLimitKey)) {
    console.log(`[Mobile] Rate limit exceeded for IP ${ip}`);
    res.status(429).json({ 
      error: 'Rate limit exceeded',
      message: 'Too many requests from this IP. Maximum 25 requests per 30 seconds.'
    });
    return;
  }

  // Record this request for both auth and IP rate limiting
  req.app.locals.rateLimiter.recordRequest(authRateLimitKey);
  req.app.locals.rateLimiter.recordRequest(ipRateLimitKey);

  // Retrieve controller status message
  const message = req.app.locals.messageQueue.getControllerMessage(controllerId);

  if (!message) {
    console.log(`[Mobile] No status available for controller ${controllerId}`);
    res.status(200).json({ 
      success: true,
      status: null
    });
    return;
  }

  console.log(`[Mobile] Returning status for controller ${controllerId}`);
  
  res.status(200).json({
    success: true,
    status: message
  });
});

export default router;
