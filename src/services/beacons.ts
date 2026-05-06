/**
 * Beacons service - DynamoDB wrapper for help beacons.
 *
 * Schema (table seaair-beacons):
 *   pk = "BEACON"                          (single partition: all beacons)
 *   sk = "{createdAt}#{beaconId}"          (sort: chronological + uniqueness)
 *   GSI byController: controllerId + createdAt
 *
 * TTL on `expiresAt` field auto-deletes after 1 year.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'crypto';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { getAWSConfig } from '../config/cognito';

const TABLE_NAME = process.env.BEACONS_TABLE_NAME || 'seaair-beacons';
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

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

export interface Beacon {
  beaconId: string;
  controllerId: number;
  userId: string;          // Cognito sub
  userEmail: string;
  message?: string;        // free-text from the user
  createdAt: string;       // ISO 8601
  expiresAt: number;       // epoch seconds, used by DynamoDB TTL
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
  const expiresAt = Math.floor(Date.now() / 1000) + ONE_YEAR_SECONDS;

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

  console.log(`[Beacons] Created beacon ${beaconId} for controller ${input.controllerId} from ${input.userEmail}`);
  return beacon;
}

/**
 * List recent beacons newest-first. `before` accepts a sk value
 * ("{createdAt}#{beaconId}") for keyset pagination.
 */
export async function listBeacons(limit: number, before?: string): Promise<{
  beacons: Beacon[];
  nextCursor?: string;
}> {
  const result = await client().send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: {
      ':pk': 'BEACON',
      ...(before ? { ':before': before } : {}),
    },
    ...(before ? { FilterExpression: 'sk < :before' } : {}),
    ScanIndexForward: false,
    Limit: limit,
  }));

  const beacons = (result.Items || []).map(itemToBeacon);
  const last = result.LastEvaluatedKey?.sk as string | undefined;
  return { beacons, nextCursor: last };
}

export async function listBeaconsForController(
  controllerId: number,
  limit: number
): Promise<Beacon[]> {
  const result = await client().send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'byController',
    KeyConditionExpression: 'controllerId = :cid',
    ExpressionAttributeValues: { ':cid': controllerId },
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
