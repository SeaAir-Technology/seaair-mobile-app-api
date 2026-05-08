# Consent ledger schema (`seaair-consents`)

This table is the **legal source of truth** for user consents on the SeaAir mobile app and any future surfaces (web dashboard, controller-side flows, etc.). Every accept and every withdrawal writes a new row. Nothing is updated; nothing is deleted except by a documented legal-hold-driven manual event.

DynamoDB table: `seaair-consents` (us-east-2)
ARN: `arn:aws:dynamodb:us-east-2:120569623207:table/seaair-consents`
Billing: PAY_PER_REQUEST
PITR: enabled
Encryption: default (AWS-owned KMS)

## Why a ledger and not a flag

Consent records have to answer questions years from now in front of a regulator, an arbitrator, or a judge. Specifically: *as of date D, what version of which consent had user U accepted, and what was the disclosure they actually saw?* You cannot answer that with a last-write-wins record. Every accept and every withdrawal must persist forever (subject only to documented deletion events) so that a complete history is always reconstructible.

The fast-path "do we need to show the modal?" check happens against a Cognito custom attribute (`custom:wifi_consent_v` and friends). The Cognito attribute is a derivable cache of the latest accept; this table is the truth.

## Key schema

```
pk  userId  Cognito sub                     (string, e.g. "d1ab8520-20e1-7010-127f-09a59817fad9")
sk  sk      <consentType>#<recordedAt>#<version>#<recordId>
                                            (string, see "sort key construction" below)
```

### Sort key construction

```
sk = `${consentType}#${recordedAt}#${version}#${recordId}`
```

- `consentType` first so a single Query with `sk begins_with "<type>#"` returns just that consent type for the user
- `recordedAt` (ISO-8601 millisecond-precision UTC, e.g. `2026-05-08T18:09:00.123Z`) second so that within a consent type, items sort chronologically. Reverse-iteration with `Limit=1` returns the latest action.
- `version` third for human readability when scanning items in the console; doesn't affect query logic.
- `recordId` (UUIDv4) last as a uniqueness tiebreaker. Two writes in the same millisecond are extremely unlikely but the UUID makes the sk globally unique by construction.

ISO timestamps sort lexically the same as chronologically, so DynamoDB's range comparison Just Works on them.

## Item attributes

| Attribute | Type | Required | Notes |
|---|---|---|---|
| `userId` | S | yes | pk; Cognito sub |
| `sk` | S | yes | composite, see above |
| `consentType` | S | yes | see "Reserved consent types" below |
| `version` | S | yes | the disclosure version the user saw, e.g. `"1.0"` |
| `action` | S | yes | `"accepted"` or `"withdrawn"` |
| `recordedAt` | S | yes | ISO-8601 UTC; same value as in the sk |
| `recordedAtEpoch` | N | yes | epoch millis; convenience for math, charts, range filters |
| `recordId` | S | yes | UUIDv4; same value as in the sk |
| `disclosureUrl` | S | recommended | versioned URL of the disclosure shown, e.g. `https://seaair.com/wifi-data-disclosure/v1.0` |
| `disclosureHash` | S | recommended | SHA-256 hex of the disclosure HTML at consent time. This is the strongest single piece of evidence; if asked "what did the user see," you can produce the exact text and prove it hasn't been edited. |
| `ipAddress` | S | optional | best-effort, from the request (`X-Forwarded-For` first hop). Useful for fraud / dispute investigation. |
| `userAgent` | S | optional | mobile app UA string |
| `appVersion` | S | optional | mobile app version string, e.g. `"3.0.0 (1234)"` |
| `platform` | S | optional | `"ios"` or `"android"` |
| `controllerId` | N | optional | when consent is given in the context of a specific controller setup |
| `metadata` | M | optional | free-form map for future extension. Keep it small; don't dump huge payloads here. |

`PutItem` is called with `ConditionExpression: "attribute_not_exists(sk)"` to make absolutely sure we never overwrite an existing row.

## Global Secondary Index

```
GSI: byConsentType
  pk: consentType
  sk: recordedAt
  Projection: ALL
```

Use cases:
- "Show me all consents for type X newest first" — reporting, dashboards, regulator export
- "How many people accepted v1.0 of `wifi_data_use` in the last 30 days?" — Query with key condition on consentType and a range on recordedAt
- Future: re-consent campaigns when a new disclosure version publishes

The primary table answers "what did user U consent to" via the partition key. The GSI answers "across all users, what consents were recorded for type T."

## Common query patterns

### Latest action for a user + consent type (the modal-prompt check)

```typescript
const result = await ddb.send(new QueryCommand({
  TableName: 'seaair-consents',
  KeyConditionExpression: 'userId = :u AND begins_with(sk, :t)',
  ExpressionAttributeValues: {
    ':u': userId,
    ':t': `${consentType}#`,
  },
  ScanIndexForward: false,  // newest first
  Limit: 1,
}));
const latest = result.Items?.[0];
// If latest is undefined or latest.action === 'withdrawn' or latest.version < currentPublishedVersion: show modal.
```

### Full consent history for a user

```typescript
const result = await ddb.send(new QueryCommand({
  TableName: 'seaair-consents',
  KeyConditionExpression: 'userId = :u',
  ExpressionAttributeValues: { ':u': userId },
  ScanIndexForward: false,
}));
```

### All recent consents of a given type (analytics)

```typescript
const result = await ddb.send(new QueryCommand({
  TableName: 'seaair-consents',
  IndexName: 'byConsentType',
  KeyConditionExpression: 'consentType = :t AND recordedAt > :since',
  ExpressionAttributeValues: {
    ':t': 'wifi_data_use',
    ':since': new Date(Date.now() - 30 * 86400_000).toISOString(),
  },
  ScanIndexForward: false,
}));
```

## Reserved consent types

Live as of v1 of this design:

| consentType | Status | What it covers |
|---|---|---|
| `wifi_data_use` | shipping v1.0 | The WiFi connectivity & data use disclosure (cloud comms, support, analytics, product improvement). The first consent we ask for. |
| `terms_of_service` | reserved | The mobile app's Terms of Service; bumped when the TOS materially changes |
| `privacy_policy` | reserved | The Privacy Policy; bumped when the policy materially changes |

Future-reserved (don't repurpose these names for unrelated things):

| consentType | What it would cover |
|---|---|
| `marketing_emails` | opt-in to non-transactional marketing email |
| `analytics_optin` | opt-in to optional analytics SDKs beyond what's strictly necessary |
| `push_notifications` | opt-in to non-essential push notifications |
| `beta_features` | opt-in to beta / experimental features and the data collection that comes with them |
| `location_services` | opt-in to processing precise device location |
| `third_party_sharing` | explicit consent for sharing data with named third-party integrations |
| `age_verification` | confirmation user is over the applicable minimum age |

Adding a new consent type is a doc edit; no schema change required.

## Versioning conventions

`version` is a string of the form `"<major>.<minor>"`. Bump major when re-consent is required (new collection categories, new purposes, new recipient categories). Bump minor for clarifying edits that don't materially expand processing.

The mobile app compares against the currently-published major version. If the user's last-accepted major is older than the current published major, prompt for re-consent. Minor-version changes do not trigger a prompt.

## Cognito custom attributes (companion fast-path)

For each consent type that the mobile app needs to check on launch, define a Cognito custom attribute:

```
custom:wifi_consent_v        string, mutable    e.g. "1.0"  (or unset = needs prompt)
custom:tos_consent_v         string, mutable
custom:privacy_consent_v     string, mutable
```

Update the attribute right after a successful `PutItem` to the ledger. The attribute is a cache; the ledger is the truth. If they ever drift (e.g. ledger write succeeds, attribute update fails), the ledger wins — so make sure the API endpoint writes the ledger first, then the attribute.

NOTE: Cognito custom attributes are forever. Once you create `custom:wifi_consent_v` you can never remove that attribute name from the user pool. Pick names you can live with.

## Append-only enforcement

Three layers:

1. **API code**: only ever calls `PutItem` and `Query`. Never `UpdateItem`. Never `DeleteItem`.
2. **PutItem condition**: `attribute_not_exists(sk)` so we never silently overwrite. The composite sk's UUID component makes this practically guaranteed to succeed on every legitimate call.
3. **IAM policy** (`seaair-apprunner-instance` → `dashboard-access` → `ConsentsTableAppendOnly` statement): grants `dynamodb:PutItem`, `dynamodb:GetItem`, `dynamodb:Query`, `dynamodb:BatchGetItem` and nothing else. No `UpdateItem`, no `DeleteItem`, no `BatchWriteItem` (which can do deletes).

Manual deletions for documented legal-hold or right-to-be-forgotten events would be done by an operator with separately-elevated credentials, recorded in a deletion log, and reflected in our compliance documentation. The App Runner instance role can never delete consent records.

## Retention

Indefinite. No TTL is configured. Storage is cheap; legal evidence is not. If a user invokes a deletion right and we determine (with counsel) that their consent records can be expunged, we do it as a documented event using out-of-band credentials, not as routine cleanup.

## Cost notes

PAY_PER_REQUEST. At reasonable volumes (a few accepts and an occasional withdrawal per user per year), monthly cost is dominated by the storage of items and PITR continuous backup, which together come to a few cents per thousand items. Expected cost: trivial.

## Future considerations

- **Customer-managed KMS key**: if compliance requirements push us to it, switch from AWS-owned to a customer-managed CMK. Done via `update-table` with SSESpecification.
- **Streams**: we may want to enable DynamoDB Streams later if we want to react to consent events (e.g., kick off a data-purge workflow when an `action: "withdrawn"` row arrives). Not enabled now to avoid unnecessary moving parts.
- **Counsel review of retention**: have counsel confirm "indefinite retention of consent records" is the right posture for our markets. It is the conservative answer; the alternative is some legitimate-interest-based retention period but the bar to defend it is higher.
