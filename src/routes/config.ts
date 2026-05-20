/**
 * Configuration Routes
 * Routes for managing user-device configurations
 * Requires JWT authentication
 */

import express, { Request, Response } from 'express';
import { verifyJWT } from '../auth';
import { storeUserDeviceAssociation, getUserDeviceAssociation, deleteUserDeviceAssociation } from '../services/dynamodb';

const router = express.Router();

/**
 * POST /config/device
 * Associate a controller device with a user
 * Requires JWT authentication
 * Body: {
 *   controllerId: number (required)
 * }
 */
router.post('/device', verifyJWT, async (req: Request, res: Response): Promise<void> => {
  const { controllerId } = req.body;
  const userId = req.auth?.sub; // Cognito user ID (sub)
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  console.log(`[Config] Device association request from user ${userId} at ${ip} for controller ${controllerId}`);

  // Validate required fields
  if (controllerId === undefined || controllerId === null) {
    console.log('[Config] Error: controllerId is required');
    res.status(400).json({ 
      error: 'controllerId is required',
      message: 'Please provide a controller ID to associate with your account'
    });
    return;
  }

  // Validate controllerId is a number
  if (typeof controllerId !== 'number' || !Number.isInteger(controllerId) || controllerId < 0 || !Number.isSafeInteger(controllerId)) {
    console.log('[Config] Error: controllerId must be a safe non-negative integer');
    res.status(400).json({ 
      error: 'controllerId must be a safe non-negative integer (within JavaScript safe integer range)',
      message: 'Controller ID must be a valid non-negative integer within JavaScript safe integer range'
    });
    return;
  }

  if (!userId) {
    console.log('[Config] Error: User ID not found in JWT token');
    res.status(401).json({ 
      error: 'Authentication failed',
      message: 'User ID not found in authentication token'
    });
    return;
  }

  // Rate limiting check - track per account and per IP
  const authRateLimitKey = `auth:${userId}`;
  if (!req.app.locals.rateLimiter.checkLimit(authRateLimitKey)) {
    console.log(`[Config] Rate limit exceeded for user ${userId}`);
    res.status(429).json({ 
      error: 'Rate limit exceeded',
      message: 'Too many requests from this account. Maximum 60 requests per 30 seconds.'
    });
    return;
  }

  // Also check rate limiting by IP
  const ipRateLimitKey = `ip:${ip}`;
  if (!req.app.locals.rateLimiter.checkLimit(ipRateLimitKey)) {
    console.log(`[Config] Rate limit exceeded for IP ${ip}`);
    res.status(429).json({ 
      error: 'Rate limit exceeded',
      message: 'Too many requests from this IP. Maximum 60 requests per 30 seconds.'
    });
    return;
  }

  // Record this request for both auth and IP rate limiting
  req.app.locals.rateLimiter.recordRequest(authRateLimitKey);
  req.app.locals.rateLimiter.recordRequest(ipRateLimitKey);

  try {
    // Store the user-device association in DynamoDB
    await storeUserDeviceAssociation(userId, controllerId);

    console.log(`[Config] Successfully associated controller ${controllerId} with user ${userId}`);
    
    res.status(200).json({ 
      success: true,
      message: 'Device associated successfully',
      userId: userId,
      controllerId: controllerId
    });
  } catch (error: any) {
    console.error(`[Config] Error associating device:`, error);
    
    res.status(500).json({ 
      error: 'Failed to associate device',
      message: error.message || 'An error occurred while storing the device association'
    });
  }
});

/**
 * GET /config/device/:controllerId
 * Get user-device association
 * Requires JWT authentication
 */
router.get('/device/:controllerId', verifyJWT, async (req: Request, res: Response): Promise<void> => {
  const controllerIdParam = req.params.controllerId;
  const controllerId = parseInt(controllerIdParam, 10);
  const userId = req.auth?.sub; // Cognito user ID (sub)
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  console.log(`[Config] Device association query from user ${userId} at ${ip} for controller ${controllerId}`);

  if (isNaN(controllerId) || controllerId < 0) {
    res.status(400).json({ 
      error: 'controllerId must be a valid non-negative integer' 
    });
    return;
  }

  if (!userId) {
    res.status(401).json({ 
      error: 'Authentication failed',
      message: 'User ID not found in authentication token'
    });
    return;
  }

  // Rate limiting check - track per account and per IP
  const authRateLimitKey = `auth:${userId}`;
  if (!req.app.locals.rateLimiter.checkLimit(authRateLimitKey)) {
    console.log(`[Config] Rate limit exceeded for user ${userId}`);
    res.status(429).json({ 
      error: 'Rate limit exceeded',
      message: 'Too many requests from this account. Maximum 60 requests per 30 seconds.'
    });
    return;
  }

  // Also check rate limiting by IP
  const ipRateLimitKey = `ip:${ip}`;
  if (!req.app.locals.rateLimiter.checkLimit(ipRateLimitKey)) {
    console.log(`[Config] Rate limit exceeded for IP ${ip}`);
    res.status(429).json({ 
      error: 'Rate limit exceeded',
      message: 'Too many requests from this IP. Maximum 60 requests per 30 seconds.'
    });
    return;
  }

  // Record this request for both auth and IP rate limiting
  req.app.locals.rateLimiter.recordRequest(authRateLimitKey);
  req.app.locals.rateLimiter.recordRequest(ipRateLimitKey);

  try {
    // Retrieve the user-device association from DynamoDB
    const association = await getUserDeviceAssociation(userId, controllerId);

    if (!association) {
      console.log(`[Config] No association found for controller ${controllerId} and user ${userId}`);
      res.status(200).json({ 
        success: true,
        association: null
      });
      return;
    }

    console.log(`[Config] Found association for controller ${controllerId} and user ${userId}`);
    
    res.status(200).json({ 
      success: true,
      association: {
        userId: association.userId,
        controllerId: association.controllerId,
        createdAt: association.createdAt,
        updatedAt: association.updatedAt
      }
    });
  } catch (error: any) {
    console.error(`[Config] Error retrieving device association:`, error);
    
    res.status(500).json({ 
      error: 'Failed to retrieve device association',
      message: error.message || 'An error occurred while retrieving the device association'
    });
  }
});

/**
 * DELETE /config/device/:controllerId
 * Delete user-device association
 * Requires JWT authentication
 */
router.delete('/device/:controllerId', verifyJWT, async (req: Request, res: Response): Promise<void> => {
  const controllerIdParam = req.params.controllerId;
  const controllerId = parseInt(controllerIdParam, 10);
  const userId = req.auth?.sub; // Cognito user ID (sub)
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  console.log(`[Config] Device dissociation request from user ${userId} at ${ip} for controller ${controllerId}`);

  if (isNaN(controllerId) || controllerId < 0) {
    res.status(400).json({ 
      error: 'controllerId must be a valid non-negative integer' 
    });
    return;
  }

  if (!userId) {
    res.status(401).json({ 
      error: 'Authentication failed',
      message: 'User ID not found in authentication token'
    });
    return;
  }

  // Rate limiting check - track per account and per IP
  const authRateLimitKey = `auth:${userId}`;
  if (!req.app.locals.rateLimiter.checkLimit(authRateLimitKey)) {
    console.log(`[Config] Rate limit exceeded for user ${userId}`);
    res.status(429).json({ 
      error: 'Rate limit exceeded',
      message: 'Too many requests from this account. Maximum 60 requests per 30 seconds.'
    });
    return;
  }

  // Also check rate limiting by IP
  const ipRateLimitKey = `ip:${ip}`;
  if (!req.app.locals.rateLimiter.checkLimit(ipRateLimitKey)) {
    console.log(`[Config] Rate limit exceeded for IP ${ip}`);
    res.status(429).json({ 
      error: 'Rate limit exceeded',
      message: 'Too many requests from this IP. Maximum 60 requests per 30 seconds.'
    });
    return;
  }

  // Record this request for both auth and IP rate limiting
  req.app.locals.rateLimiter.recordRequest(authRateLimitKey);
  req.app.locals.rateLimiter.recordRequest(ipRateLimitKey);

  try {
    // Delete the user-device association from DynamoDB
    await deleteUserDeviceAssociation(userId, controllerId);

    console.log(`[Config] Successfully dissociated controller ${controllerId} from user ${userId}`);
    
    res.status(200).json({ 
      success: true,
      message: 'Device dissociated successfully',
      userId: userId,
      controllerId: controllerId
    });
  } catch (error: any) {
    console.error(`[Config] Error dissociating device:`, error);
    
    res.status(500).json({ 
      error: 'Failed to dissociate device',
      message: error.message || 'An error occurred while deleting the device association'
    });
  }
});

export default router;
