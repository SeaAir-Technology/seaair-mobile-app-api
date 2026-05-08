/**
 * Consents service - DynamoDB wrapper for the consent ledger.
 *
 * Schema (table seaair-consents):
 *   pk = userId          (Cognito sub)
 *   sk = <consentType>#<recordedAt>#<version>#<recordId>
 *
 * APPEND-ONLY by design and by IAM. We only ever PutItem (with
 * attribute_not_exists(sk) to refuse silent overwrites) and Query. The
 * App Runner instance role grants no UpdateItem, no DeleteItem, no
 * BatchWriteItem on this table; manual deletions for legal-hold or
 * RTBF events are out-of-band operator actions, not routine code.
 *
 * "Withdrawal" is not modeled here. The user model is: opt in by
 * accepting a consent; opt out by disabling the underlying feature
 * (e.g. WiFi). The historical accept record stays. The absence of
 * further data flow when the feature is off is the technical proof of
 * withdrawal. See docs/CONSENT_SCHEMA.md for the full design rationale.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'crypto';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { getAWSConfig } from '../config/cognito';

const TABLE_NAME = process.env.CONSENTS_TABLE_NAME || 'seaair-consents';

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

export interface ConsentRecord {
  userId: string;
  consentType: string;
  version: string;
  action: 'accepted';
  recordedAt: string;
  recordedAtEpoch: number;
  recordId: string;
  disclosureUrl?: string;
  disclosureHash?: string;
  ipAddress?: string;
  userAgent?: string;
  appVersion?: string;
  platform?: 'ios' | 'android';
  controllerId?: number;
  metadata?: Record<string, unknown>;
}

export interface RecordConsentInput {
  userId: string;
  consentType: string;
  version: string;
  disclosureUrl?: string;
  disclosureHash?: string;
  ipAddress?: string;
  userAgent?: string;
  appVersion?: string;
  platform?: 'ios' | 'android';
  controllerId?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Write a new consent acceptance to the ledger. The composite sk is unique
 * by construction (UUIDv4 component); attribute_not_exists(sk) is just a
 * paranoid guard against the astronomical chance of a collision. Throws on
 * DDB failure so the caller's HTTP handler can surface the error.
 */
export async function recordConsent(input: RecordConsentInput): Promise<ConsentRecord> {
  const recordId = randomUUID();
  const recordedAt = new Date().toISOString();
  const recordedAtEpoch = Date.now();
  const sk = `${input.consentType}#${recordedAt}#${input.version}#${recordId}`;

  const record: ConsentRecord = {
    userId: input.userId,
    consentType: input.consentType,
    version: input.version,
    action: 'accepted',
    recordedAt,
    recordedAtEpoch,
    recordId,
    ...(input.disclosureUrl && { disclosureUrl: input.disclosureUrl }),
    ...(input.disclosureHash && { disclosureHash: input.disclosureHash }),
    ...(input.ipAddress && { ipAddress: input.ipAddress }),
    ...(input.userAgent && { userAgent: input.userAgent }),
    ...(input.appVersion && { appVersion: input.appVersion }),
    ...(input.platform && { platform: input.platform }),
    ...(input.controllerId !== undefined && { controllerId: input.controllerId }),
    ...(input.metadata && { metadata: input.metadata }),
  };

  await client().send(new PutCommand({
    TableName: TABLE_NAME,
    Item: { sk, ...record },
    ConditionExpression: 'attribute_not_exists(sk)',
  }));

  console.log(
    `[Consents] Recorded ${input.consentType} v${input.version} for user ${input.userId} ` +
    `(recordId=${recordId})`
  );
  return record;
}

/**
 * Return the user's most recent consent record for the given consentType,
 * or null if they have never consented to that type.
 *
 * Comparison of the returned version against the currently-required version
 * is the caller's responsibility. The convention is that a major-version
 * mismatch should trigger a re-consent prompt; minor-version differences
 * do not.
 */
export async function getLatestConsent(
  userId: string,
  consentType: string,
): Promise<ConsentRecord | null> {
  const result = await client().send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'userId = :u AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':u': userId,
      ':prefix': `${consentType}#`,
    },
    ScanIndexForward: false,  // newest first
    Limit: 1,
  }));

  if (!result.Items || result.Items.length === 0) return null;
  return itemToRecord(result.Items[0]);
}

function itemToRecord(item: Record<string, any>): ConsentRecord {
  return {
    userId: item.userId,
    consentType: item.consentType,
    version: item.version,
    action: item.action,
    recordedAt: item.recordedAt,
    recordedAtEpoch: typeof item.recordedAtEpoch === 'number'
      ? item.recordedAtEpoch
      : parseInt(item.recordedAtEpoch, 10),
    recordId: item.recordId,
    disclosureUrl: item.disclosureUrl,
    disclosureHash: item.disclosureHash,
    ipAddress: item.ipAddress,
    userAgent: item.userAgent,
    appVersion: item.appVersion,
    platform: item.platform,
    controllerId: typeof item.controllerId === 'number'
      ? item.controllerId
      : (item.controllerId !== undefined ? parseInt(item.controllerId, 10) : undefined),
    metadata: item.metadata,
  };
}
