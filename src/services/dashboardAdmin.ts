/**
 * Cognito admin wrapper for the dashboard.
 *
 * The seaair-apprunner-instance IAM role grants the actions used here
 * scoped to the dashboard pool only. All operations target the user pool
 * configured via COGNITO_USER_POOL_ID.
 */

import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { COGNITO_USER_POOL_ID, AWS_REGION } from '../auth';

const ADMIN_GROUP = process.env.DASHBOARD_ADMIN_GROUP || 'dashboard-admin';

let cognitoClient: CognitoIdentityProviderClient | null = null;

function client(): CognitoIdentityProviderClient {
  if (cognitoClient) return cognitoClient;
  cognitoClient = new CognitoIdentityProviderClient({ region: AWS_REGION });
  return cognitoClient;
}

export interface DashboardUser {
  sub: string;
  username: string;
  email?: string;
  enabled: boolean;
  status?: string;
  isDashboardAdmin: boolean;
  createdAt?: string;
}

function attrsToMap(attrs?: { Name?: string; Value?: string }[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const a of attrs || []) {
    if (a.Name && a.Value) m[a.Name] = a.Value;
  }
  return m;
}

/**
 * Check whether a user (by username/sub) is in the dashboard-admin group.
 * Used by the requireDashboardAdmin middleware on every request.
 */
export async function isDashboardAdmin(username: string): Promise<boolean> {
  const result = await client().send(new AdminListGroupsForUserCommand({
    UserPoolId: COGNITO_USER_POOL_ID,
    Username: username,
  }));
  return (result.Groups || []).some(g => g.GroupName === ADMIN_GROUP);
}

/**
 * List all users in the pool, with their dashboard-admin membership computed.
 * Used by the admin panel to render the toggle list.
 */
export async function listAllDashboardUsers(limit = 60): Promise<DashboardUser[]> {
  // Get the set of admin usernames first, then list all users and mark them.
  const adminResult = await client().send(new ListUsersInGroupCommand({
    UserPoolId: COGNITO_USER_POOL_ID,
    GroupName: ADMIN_GROUP,
    Limit: 60,
  }));
  const adminUsernames = new Set<string>(
    (adminResult.Users || []).map(u => u.Username || '').filter(Boolean)
  );

  const usersResult = await client().send(new ListUsersCommand({
    UserPoolId: COGNITO_USER_POOL_ID,
    Limit: limit,
  }));

  return (usersResult.Users || []).map(u => {
    const attrs = attrsToMap(u.Attributes);
    return {
      sub: attrs.sub,
      username: u.Username || '',
      email: attrs.email,
      enabled: u.Enabled ?? true,
      status: u.UserStatus,
      isDashboardAdmin: adminUsernames.has(u.Username || ''),
      createdAt: u.UserCreateDate?.toISOString(),
    };
  });
}

/**
 * Search users by email substring. Cognito's filter syntax only supports
 * exact prefix on indexed attrs, so we list and filter client-side for
 * substring matching. Limit is applied after filtering.
 */
export async function searchUsers(query: string, limit = 20): Promise<DashboardUser[]> {
  const all = await listAllDashboardUsers(60);
  const q = query.toLowerCase();
  return all
    .filter(u =>
      (u.email && u.email.toLowerCase().includes(q)) ||
      (u.username && u.username.toLowerCase().includes(q))
    )
    .slice(0, limit);
}

export async function grantDashboardAccess(username: string): Promise<void> {
  await client().send(new AdminAddUserToGroupCommand({
    UserPoolId: COGNITO_USER_POOL_ID,
    Username: username,
    GroupName: ADMIN_GROUP,
  }));
  console.log(`[DashboardAdmin] Granted dashboard access to ${username}`);
}

export async function revokeDashboardAccess(username: string): Promise<void> {
  await client().send(new AdminRemoveUserFromGroupCommand({
    UserPoolId: COGNITO_USER_POOL_ID,
    Username: username,
    GroupName: ADMIN_GROUP,
  }));
  console.log(`[DashboardAdmin] Revoked dashboard access from ${username}`);
}

/**
 * Look up a user by email (used for joining beacons -> Cognito user info).
 * Returns the Cognito sub, email, and enabled status.
 */
export async function getUserByEmail(email: string): Promise<DashboardUser | null> {
  const result = await client().send(new ListUsersCommand({
    UserPoolId: COGNITO_USER_POOL_ID,
    Filter: `email = "${email.replace(/"/g, '')}"`,
    Limit: 1,
  }));
  const u = result.Users?.[0];
  if (!u) return null;
  const attrs = attrsToMap(u.Attributes);
  // Don't run the expensive isDashboardAdmin check here; callers can ask if needed.
  return {
    sub: attrs.sub,
    username: u.Username || '',
    email: attrs.email,
    enabled: u.Enabled ?? true,
    status: u.UserStatus,
    isDashboardAdmin: false,
    createdAt: u.UserCreateDate?.toISOString(),
  };
}

export async function getUserBySub(sub: string): Promise<DashboardUser | null> {
  const result = await client().send(new AdminGetUserCommand({
    UserPoolId: COGNITO_USER_POOL_ID,
    Username: sub,
  }));
  if (!result) return null;
  const attrs = attrsToMap(result.UserAttributes);
  return {
    sub: attrs.sub || sub,
    username: result.Username || sub,
    email: attrs.email,
    enabled: result.Enabled ?? true,
    status: result.UserStatus,
    isDashboardAdmin: await isDashboardAdmin(result.Username || sub).catch(() => false),
    createdAt: result.UserCreateDate?.toISOString(),
  };
}
