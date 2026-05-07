/**
 * Beacons service - DynamoDB wrapper for help beacons.
 *
 * Schema (table seaair-beacons):
 *   pk = "BEACON"                          (single partition: all beacons)
 *   sk = "{createdAt}#{beaconId}"          (sort: chronological + uniqueness)
 *   GSI byController: controllerId + createdAt
 *
 * Lifecycle:
 *   - createBeacon sets expiresAt = createdAt + 24h. DynamoDB TTL eventually
 *     deletes the row, but reads filter on `expiresAt > now` so cleared
 *     beacons disappear from the dashboard immediately.
 *   - resolveBeacon sets expiresAt = now (epoch seconds), which fails the
 *     same read filter on the next call. Idempotent: re-resolving an
 *     already-resolved beacon is a no-op semantically (it lowers expiresAt
 *     further, still <now).
 *
 * TTL on `expiresAt` field auto-deletes after the deadline.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'crypto';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { getAWSConfig } from '../config/cognito';

const TABLE_NAME = process.env.BEACONS_TABLE_NAME || 'seaair-beacons';
const ONE_DAY_SECONDS = 24 * 60 * 60;

let docClient: DynamoDBDocumentClient | null = null;

function client(): DynamoDBDocumentClient {
  if (docClient) return docClient;
  const awsConfig = getAWSConfig();
  const hasCreds = !!(awsConfig.accessKeyId && awsConfig.secretAccessKey);
  const base = new DynamoDBClient({
    region: awsConfig.region,
    ...(hasCreds && {
      credentials: {
        accessKeyId: awsConfig.accessKeyId!,
        secretAccessKey: awsConfig.secretAccessKey!,
      },
    }),
  });
  docClient = DynamoDBDocumentClient.from(base);
  return docClient;
}

function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export interface Beacon {
  beaconId: string;
  controllerId: number;
  userId: string;          // Cognito sub
  userEmail: string;
  message?: string;        // free-text from the user
  createdAt: string;       // ISO 8601
  expiresAt: number;       // epoch seconds, used by DynamoDB TTL + read filter
}

export interface CreateBeaconInput {
  controllerId: number;
  userId: string;
  userEmail: string;
  message?: string;
}

export async function createBeacon(input: CreateBeaconInput): Promise<Beacon> {
  const beaconId = randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = nowEpochSeconds() + ONE_DAY_SECONDS;

  const beacon: Beacon = {
    beaconId,
    controllerId: input.controllerId,
    userId: input.userId,
    userEmail: input.userEmail,
    message: input.message,
    createdAt,
    expiresAt,
  };

  await client().send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      pk: 'BEACON',
      sk: `${createdAt}#${beaconId}`,
      ...beacon,
    },
  }));

  console.log(`[Beacons] Created beacon ${beaconId} for controller ${input.controllerId} from ${input.userEmail}, expires in 24h`);
  return beacon;
}

/**
 * Resolve (clear) a beacon by setting its expiresAt to now. The next read
 * filter (`expiresAt > now`) drops it from the active list immediately.
 * DynamoDB TTL will eventually delete the row from storage.
 *
 * Throws if the beacon doesn't exist (ConditionalCheckFailed) so callers
 * can surface a 404 rather than silently creating something.
 */
export async function resolveBeacon(
  createdAt: string,
  beaconId: string
): Promise<void> {
  const sk = `${createdAt}#${beaconId}`;
  await client().send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { pk: 'BEACON', sk },
    UpdateExpression: 'SET expiresAt = :now',
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: {
      ':now': nowEpochSeconds(),
    },
  }));
  console.log(`[Beacons] Resolved beacon ${beaconId} (sk=${sk})`);
}

/**
 * List recent ACTIVE beacons newest-first. Active = expiresAt > now.
 * `before` accepts a sk value ("{createdAt}#{beaconId}") for keyset
 * pagination. The expiresAt filter is applied AFTER the page is read, so a
 * page may contain fewer than `limit` items if many in that page have been
 * cleared/expired; the cursor still advances correctly.
 */
export async function listBeacons(limit: number, before?: string): Promise<{
  beacons: Beacon[];
  nextCursor?: string;
}> {
  const filterParts: string[] = ['expiresAt > :now'];
  const exprValues: Record<string, any> = {
    ':pk': 'BEACON',
    ':now': nowEpochSeconds(),
  };
  if (before) {
    filterParts.push('sk < :before');
    exprValues[':before'] = before;
  }

  const result = await client().send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'pk = :pk',
    FilterExpression: filterParts.join(' AND '),
    ExpressionAttributeValues: exprValues,
    ScanIndexForward: false,
    Limit: limit,
  }));

  const beacons = (result.Items || []).map(itemToBeacon);
  const last = result.LastEvaluatedKey?.sk as string | undefined;
  return { beacons, nextCursor: last };
}

/**
 * List ACTIVE beacons for one controller, newest-first.
 */
export async function listBeaconsForController(
  controllerId: number,
  limit: number
): Promise<Beacon[]> {
  const result = await client().send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'byController',
    KeyConditionExpression: 'controllerId = :cid',
    FilterExpression: 'expiresAt > :now',
    ExpressionAttributeValues: {
      ':cid': controllerId,
      ':now': nowEpochSeconds(),
    },
    ScanIndexForward: false,
    Limit: limit,
  }));
  return (result.Items || []).map(itemToBeacon);
}

export async function getBeacon(createdAt: string, beaconId: string): Promise<Beacon | null> {
  const result = await client().send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { pk: 'BEACON', sk: `${createdAt}#${beaconId}` },
  }));
  return result.Item ? itemToBeacon(result.Item) : null;
}

function itemToBeacon(item: Record<string, any>): Beacon {
  return {
    beaconId: item.beaconId,
    controllerId: typeof item.controllerId === 'number'
      ? item.controllerId
      : parseInt(item.controllerId, 10),
    userId: item.userId,
    userEmail: item.userEmail,
    message: item.message,
    createdAt: item.createdAt,
    expiresAt: typeof item.expiresAt === 'number'
      ? item.expiresAt
      : parseInt(item.expiresAt, 10),
  };
}
