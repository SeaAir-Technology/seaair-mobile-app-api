/**
 * Consent ledger routes - mounted at /mobile/consent.
 *
 *   POST /mobile/consent                 - record an acceptance
 *   GET  /mobile/consent/:consentType    - return latest record for the user
 *
 * The user's identity comes from their Cognito JWT (req.auth.sub). We
 * never trust a client-supplied userId. The mobile app sends only the
 * consent payload (type, version, disclosure metadata, optional context).
 * Request metadata (ip, user agent) is captured server-side from the
 * HTTP request itself, not from the body.
 *
 * Reserved consent types here MUST stay in sync with docs/CONSENT_SCHEMA.md.
 * The Set lookup keeps the surface tight so an attacker can't pollute the
 * table with arbitrary type strings.
 */

import express, { Request, Response } from 'express';
import { verifyJWT } from '../auth';
import { recordConsent, getLatestConsent } from '../services/consents';

const router = express.Router();

const RESERVED_CONSENT_TYPES = new Set<string>([
  'wifi_data_use',
  'terms_of_service',
  'privacy_policy',
  'marketing_emails',
  'analytics_optin',
  'push_notifications',
  'beta_features',
  'location_services',
  'third_party_sharing',
  'age_verification',
]);

const VERSION_REGEX = /^\d+\.\d+$/;
const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/i;
const MAX_URL_LEN = 500;
const MAX_USER_AGENT_LEN = 512;
const MAX_APP_VERSION_LEN = 64;
const MAX_METADATA_BYTES = 4096;

function clientIp(req: Request): string | undefined {
  const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  if (fwd) return fwd;
  return req.ip;
}

// POST /mobile/consent
router.post('/', verifyJWT, async (req: Request, res: Response): Promise<void> => {
  if (!req.auth?.sub) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }
  const userId = req.auth.sub;
  const {
    consentType,
    version,
    disclosureUrl,
    disclosureHash,
    appVersion,
    platform,
    controllerId,
    metadata,
  } = req.body || {};

  if (!consentType || typeof consentType !== 'string') {
    res.status(400).json({ error: 'consentType is required and must be a string' });
    return;
  }
  if (!RESERVED_CONSENT_TYPES.has(consentType)) {
    res.status(400).json({ error: `Unknown consentType: ${consentType}` });
    return;
  }
  if (!version || typeof version !== 'string') {
    res.status(400).json({ error: 'version is required and must be a string' });
    return;
  }
  if (!VERSION_REGEX.test(version)) {
    res.status(400).json({ error: 'version must be in <major>.<minor> format (e.g. "1.0")' });
    return;
  }
  if (disclosureUrl !== undefined) {
    if (typeof disclosureUrl !== 'string' || disclosureUrl.length > MAX_URL_LEN) {
      res.status(400).json({ error: `disclosureUrl must be a string up to ${MAX_URL_LEN} chars` });
      return;
    }
  }
  if (disclosureHash !== undefined) {
    if (typeof disclosureHash !== 'string' || !SHA256_HEX_REGEX.test(disclosureHash)) {
      res.status(400).json({ error: 'disclosureHash must be a SHA-256 hex string (64 chars)' });
      return;
    }
  }
  if (appVersion !== undefined) {
    if (typeof appVersion !== 'string' || appVersion.length > MAX_APP_VERSION_LEN) {
      res.status(400).json({
        error: `appVersion must be a string up to ${MAX_APP_VERSION_LEN} chars`,
      });
      return;
    }
  }
  if (platform !== undefined && platform !== 'ios' && platform !== 'android') {
    res.status(400).json({ error: 'platform must be "ios" or "android"' });
    return;
  }
  if (controllerId !== undefined) {
    if (
      typeof controllerId !== 'number' ||
      !Number.isInteger(controllerId) ||
      controllerId <= 0 ||
      !Number.isSafeInteger(controllerId)
    ) {
      res.status(400).json({ error: 'controllerId must be a safe positive integer' });
      return;
    }
  }
  if (metadata !== undefined) {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      res.status(400).json({ error: 'metadata must be a plain object' });
      return;
    }
    if (JSON.stringify(metadata).length > MAX_METADATA_BYTES) {
      res.status(400).json({
        error: `metadata must be ${MAX_METADATA_BYTES} bytes or less when JSON-serialized`,
      });
      return;
    }
  }

  const userAgent = (req.headers['user-agent'] as string | undefined)?.slice(0, MAX_USER_AGENT_LEN);
  const ipAddress = clientIp(req);

  try {
    const record = await recordConsent({
      userId,
      consentType,
      version,
      disclosureUrl,
      disclosureHash,
      ipAddress,
      userAgent,
      appVersion,
      platform,
      controllerId,
      metadata,
    });
    res.status(201).json({ success: true, record });
  } catch (err: any) {
    console.error(`[Consent] Record failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to record consent', message: err.message });
  }
});

// GET /mobile/consent/:consentType
router.get('/:consentType', verifyJWT, async (req: Request, res: Response): Promise<void> => {
  if (!req.auth?.sub) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }
  const { consentType } = req.params;
  if (!RESERVED_CONSENT_TYPES.has(consentType)) {
    res.status(400).json({ error: `Unknown consentType: ${consentType}` });
    return;
  }
  try {
    const record = await getLatestConsent(req.auth.sub, consentType);
    if (!record) {
      res.json({ hasConsent: false, record: null });
      return;
    }
    res.json({ hasConsent: true, record });
  } catch (err: any) {
    console.error(`[Consent] Query failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to query consent', message: err.message });
  }
});

export default router;
