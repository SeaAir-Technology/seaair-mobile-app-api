/**
 * AWS Cognito JWT Authentication Middleware
 * Validates JWT tokens issued by AWS Cognito for mobile app and dashboard routes.
 *
 * COGNITO_CLIENT_ID accepts a single client id OR a comma-separated list,
 * which lets one verifier accept tokens from multiple app clients in the
 * same user pool (e.g. the mobile app client AND the dashboard SPA client).
 */

import { Request, Response, NextFunction } from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { cognitoConfig, isCognitoConfigured as checkCognitoConfig } from './config/cognito';
import { AuthInfo } from './types';

// Extend Express Request type to include auth property
declare global {
  namespace Express {
    interface Request {
      auth?: AuthInfo;
    }
  }
}

// Create Cognito JWT verifier instance
let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function parseClientIds(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Initialize the Cognito JWT verifier
 * This is called lazily on first use to allow configuration at runtime
 */
function initializeVerifier(): ReturnType<typeof CognitoJwtVerifier.create> {
  if (!cognitoConfig.userPoolId || !cognitoConfig.clientId) {
    throw new Error(
      'AWS Cognito configuration missing. Please set COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID in the configuration.'
    );
  }

  if (!verifier) {
    const ids = parseClientIds(cognitoConfig.clientId);
    if (ids.length === 0) {
      throw new Error('COGNITO_CLIENT_ID parsed to an empty client list');
    }
    // aws-jwt-verify accepts a string OR string[]; for the array form it
    // accepts a token if its client_id claim matches any of the ids.
    verifier = CognitoJwtVerifier.create({
      userPoolId: cognitoConfig.userPoolId,
      tokenUse: 'access',
      clientId: ids.length === 1 ? ids[0] : ids,
    });

    console.log(
      `[Auth] Cognito JWT verifier initialized for User Pool: ${cognitoConfig.userPoolId}, ` +
        `Region: ${cognitoConfig.region}, Clients: [${ids.join(', ')}]`
    );
  }

  return verifier;
}

/**
 * Middleware to verify AWS Cognito JWT token
 */
export async function verifyJWT(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    console.log('[Auth] No authorization header provided');
    res.status(401).json({ 
      error: 'No authorization header provided',
      message: 'Authorization header with Bearer token is required'
    });
    return;
  }

  // Expected format: "Bearer <token>"
  const parts = authHeader.split(' ');
  
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    console.log('[Auth] Invalid authorization header format');
    res.status(401).json({ 
      error: 'Invalid authorization header format',
      message: 'Expected format: Bearer <token>'
    });
    return;
  }

  const token = parts[1];

  try {
    // Initialize verifier if needed
    const cognitoVerifier = initializeVerifier();
    
    // Verify the token against AWS Cognito
    const payload = await cognitoVerifier.verify(token);
    
    // Attach decoded token to request for use in routes
    // Cognito tokens have 'sub' as the unique user identifier
    req.auth = {
      username: (payload as any).username || (payload as any)['cognito:username'],
      email: (payload as any).email,
      ...payload
    };
    
    console.log(`[Auth] Cognito JWT verified for user: ${payload.sub} (${(payload as any).username || (payload as any)['cognito:username'] || 'unknown'})`);
    
    next();
  } catch (error: any) {
    console.log(`[Auth] Cognito JWT verification failed: ${error.message}`);
    
    // Handle specific error cases
    if (error.message.includes('Token expired')) {
      res.status(401).json({ 
        error: 'Token expired',
        message: 'JWT token has expired. Please refresh your token.'
      });
      return;
    }
    
    if (error.message.includes('Token use invalid')) {
      res.status(401).json({ 
        error: 'Invalid token type',
        message: 'Expected an access token from AWS Cognito'
      });
      return;
    }
    
    if (error.message.includes('configuration missing')) {
      console.error('[Auth] AWS Cognito not configured. Check configuration.');
      res.status(500).json({ 
        error: 'Authentication service not configured',
        message: 'Server authentication configuration is incomplete'
      });
      return;
    }
    
    res.status(401).json({ 
      error: 'Authentication failed',
      message: 'Invalid or malformed JWT token'
    });
  }
}

/**
 * Check if AWS Cognito is properly configured
 */
export function isCognitoConfigured(): boolean {
  return checkCognitoConfig();
}

/**
 * Export Cognito configuration values
 */
export const COGNITO_USER_POOL_ID = cognitoConfig.userPoolId;
export const COGNITO_CLIENT_ID = cognitoConfig.clientId;
export const AWS_REGION = cognitoConfig.region;
