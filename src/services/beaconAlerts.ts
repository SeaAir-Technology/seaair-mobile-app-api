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
 * The publish is bounded by a hard timeout so it can't hang for the
 * SDK's full retry budget when SNS is unreachable from this network
 * (e.g. App Runner subnets with no SNS VPC endpoint or NAT). Callers
 * are expected to NOT await this function for the same reason — see
 * the comment in beacons.createBeacon.
 */

import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { Beacon } from './beacons';
import { AWS_REGION } from '../auth';

const TOPIC_ARN = process.env.SNS_BEACON_TOPIC_ARN || '';
const DASHBOARD_URL =
  process.env.DASHBOARD_URL || 'https://mobile-app-api.seaair.com';

// Hard ceiling on a single publish attempt. 5s is well above SNS's
// median latency from inside AWS, but short enough that hung calls
// don't pile up if the network path is broken. The SDK's default
// retry budget can otherwise run 30+ seconds before giving up.
const PUBLISH_TIMEOUT_MS = 5000;

let snsClient: SNSClient | null = null;
function client(): SNSClient {
  if (!snsClient) {
    snsClient = new SNSClient({ region: AWS_REGION });
  }
  return snsClient;
}

/**
 * Race a promise against a timeout. The timeout cleanup ensures the
 * timer is unregistered as soon as the original promise settles, so
 * we don't keep the event loop alive longer than necessary.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
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
    `Name:       ${beacon.userName || '(not set)'}`,
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
    const result = await withTimeout(
      client().send(
        new PublishCommand({
          TopicArn: TOPIC_ARN,
          Subject: subject,
          Message: body,
        })
      ),
      PUBLISH_TIMEOUT_MS,
      'SNS publish'
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
