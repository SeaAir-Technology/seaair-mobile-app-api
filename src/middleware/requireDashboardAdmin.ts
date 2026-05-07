/**
 * Dashboard auth middleware.
 *
 * Verifies the Cognito JWT (using the existing verifyJWT) AND requires that
 * the authenticated user is a member of the dashboard-admin group.
 *
 * Group membership is checked via Cognito's AdminListGroupsForUser. The
 * result is cached per-instance for 60 seconds to avoid hitting the Cognito
 * API on every request.
 */

import { Request, Response, NextFunction } from 'express';
import { verifyJWT } from '../auth';
import { isDashboardAdmin } from '../services/dashboardAdmin';

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map<string, { admin: boolean; expiresAt: number }>();

function cachedIsAdmin(username: string): boolean | null {
  const hit = cache.get(username);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(username);
    return null;
  }
  return hit.admin;
}

function setCache(username: string, admin: boolean): void {
  cache.set(username, { admin, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function requireDashboardAdmin(req: Request, res: Response, next: NextFunction): void {
  // Reuse the existing JWT verifier so the same auth.ts handles signing keys,
  // expiry, audience, etc. We then layer the group check on top.
  verifyJWT(req, res, async (err?: any) => {
    if (err) return next(err);
    if (!req.auth) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const username = req.auth.username || req.auth['cognito:username'] || req.auth.sub;
    if (!username) {
      res.status(403).json({ error: 'No username claim on token' });
      return;
    }

    // Fast path: groups claim included on the access token (Cognito does
    // populate cognito:groups when the user has any). Trust this if present.
    const groupsClaim = req.auth['cognito:groups'];
    if (Array.isArray(groupsClaim)) {
      const adminGroup = process.env.DASHBOARD_ADMIN_GROUP || 'dashboard-admin';
      const isAdmin = groupsClaim.includes(adminGroup);
      setCache(username, isAdmin);
      if (!isAdmin) {
        res.status(403).json({ error: 'Dashboard access required' });
        return;
      }
      return next();
    }

    // No groups claim: fall back to AdminListGroupsForUser, cached.
    const cached = cachedIsAdmin(username);
    if (cached !== null) {
      if (!cached) {
        res.status(403).json({ error: 'Dashboard access required' });
        return;
      }
      return next();
    }
    try {
      const admin = await isDashboardAdmin(username);
      setCache(username, admin);
      if (!admin) {
        res.status(403).json({ error: 'Dashboard access required' });
        return;
      }
      next();
    } catch (lookupErr: any) {
      console.error(`[DashboardAuth] Group lookup failed for ${username}: ${lookupErr.message}`);
      res.status(500).json({ error: 'Authorization check failed' });
    }
  });
}
