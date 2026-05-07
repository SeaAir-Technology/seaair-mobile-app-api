/**
 * Out-of-band notification when a help beacon is raised.
 *
 * Publishes an email-friendly message to an SNS topic that has
 * info@seaair.com (and optionally other recipients) subscribed by
 * email. Configured via env:
 *
 *   SNS_BEACON_TOPIC_ARN  - the topic ARN to publish to. If unset,
 *                           the call is a logged no-op so dev/local
 *                           runs don't fail.
 *   DASHBOARD_URL         - public URL prefix for the dashboard SPA,
 *                           used to build deep links in the email body.
 *                           Defaults to https://mobile-app-api.seaair.com.
 *
 * Uses await + try/catch so that if SNS is unhappy, beacon creation
 * still succeeds — the customer raised a request, and we'd rather
 * have it stored and visible in the dashboard than fail the request
 * because the alerting fan-out had a hiccup. Failures are logged so
 * we notice in CloudWatch.
 */

import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { Beacon } from './beacons';
import { AWS_REGION } from '../auth';

const TOPIC_ARN = process.env.SNS_BEACON_TOPIC_ARN || '';
const DASHBOARD_URL =
  process.env.DASHBOARD_URL || 'https://mobile-app-api.seaair.com';

let snsClient: SNSClient | null = null;
function client(): SNSClient {
  if (!snsClient) {
    snsClient = new SNSClient({ region: AWS_REGION });
  }
  return snsClient;
}

export async function notifyBeaconRaised(beacon: Beacon): Promise<void> {
  if (!TOPIC_ARN) {
    console.log(
      '[BeaconAlerts] SNS_BEACON_TOPIC_ARN not set; skipping email notification'
    );
    return;
  }

  // SNS Subject hard cap is 100 chars; keep it short and informative.
  const subject = `SeaAir Help Beacon \u2014 Controller ${beacon.controllerId}`.slice(
    0,
    100
  );

  const body = [
    'A SeaAir customer raised a help beacon.',
    '',
    `Customer:   ${beacon.userEmail}`,
    `User ID:    ${beacon.userId}`,
    `Controller: ${beacon.controllerId}`,
    `Time:       ${beacon.createdAt}`,
    `Message:    ${beacon.message || '(none)'}`,
    '',
    `Open beacon list:    ${DASHBOARD_URL}/beacons`,
    `Open controller:     ${DASHBOARD_URL}/devices/${beacon.controllerId}`,
  ].join('\n');

  try {
    const result = await client().send(
      new PublishCommand({
        TopicArn: TOPIC_ARN,
        Subject: subject,
        Message: body,
      })
    );
    console.log(
      `[BeaconAlerts] Sent notification for beacon ${beacon.beaconId} (MessageId=${result.MessageId})`
    );
  } catch (err: any) {
    // Don't rethrow — a failed alert must not fail beacon creation.
    console.error(
      `[BeaconAlerts] Failed to publish notification for beacon ${beacon.beaconId}: ${err.message}`
    );
  }
}
