# Tiered Retention & Analytics History

Implements the *Tiered Retention & Analytics History* spec. Two tiers:

- **Tier 1 — Redis Streams (live transport).** Per-controller streams trimmed
  to a small live window (`STREAM_LIVE_MAXLEN`, default 5000 ≈ 7h @ 5s). Memory
  is bounded by `controllers × live-window`, never by total history, so the
  broker can't OOM regardless of device count or a runaway writer. Trimming is
  `MAXLEN ~ <n>` on every per-controller `XADD` — the backstop, not eviction.
- **Tier 2 — DynamoDB archive (durable history).** Every `fw2mobile` heartbeat
  is archived best-effort, off the hot path. Self-purges via a TTL. Backs the
  analytics API and the reconnect fallback.

Everything is behind feature flags (see [`.env.example`](../.env.example)) and
**off by default**. Production is unchanged until you create the table and set
`ARCHIVE_ENABLED=true`.

## Change-based compression (FR-6)

Heartbeats arrive ~every 5s and are mostly identical. Instead of storing ~17k
points/controller/day, we store only **change-points**: a new item is written
when decoded telemetry changes (or comms resume after a gap). An unchanged
heartbeat just bumps the prior item's `repeated` counter and extends `lastTs`,
proving the machine kept communicating without growing the table. The query
layer expands these sparse points back into time buckets (`raw|1m|5m|1h`,
avg/min/max). A 4-day mostly-constant series collapses from ~69k points to a
handful. There is intentionally **no separate rollup table** — change-point
storage already does that job, and aggregation happens app-side at query time.

> Consequence: the reconnect fallback (FR-7) replays distinct *state changes*
> in the gap, not every redundant 5s heartbeat — less data, same information.

## Manual infrastructure setup (not yet IaC)

Delivered as CLI for a human to apply. Run from an admin profile in
`us-east-2`. Nothing here is created automatically.

### 1. DynamoDB history table

PK `controllerId` (S), SK `ts` (N, epoch ms), on-demand billing, TTL on `ttl`.

```bash
aws dynamodb create-table \
  --region us-east-2 \
  --table-name controller-history \
  --attribute-definitions \
      AttributeName=controllerId,AttributeType=S \
      AttributeName=ts,AttributeType=N \
  --key-schema \
      AttributeName=controllerId,KeyType=HASH \
      AttributeName=ts,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST

# Enable TTL (purges items past ARCHIVE_RETENTION_DAYS automatically)
aws dynamodb update-time-to-live \
  --region us-east-2 \
  --table-name controller-history \
  --time-to-live-specification "Enabled=true, AttributeName=ttl"
```

`ttl` is written as `floor(ts/1000) + ARCHIVE_RETENTION_DAYS*86400`. Physical
delete can lag up to ~48h; queries already filter `ttl > now` for an exact
logical cutoff.

### 2. IAM — least privilege on the App Runner instance role

Attach to the existing instance role (`seaair-apprunner-*`). No wildcards;
scoped to this table ARN only.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "ControllerHistoryArchive",
    "Effect": "Allow",
    "Action": ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
    "Resource": "arn:aws:dynamodb:us-east-2:120569623207:table/controller-history"
  }]
}
```

### 3. CloudWatch memory alarm (FR-9)

Backstop alert before the broker fills, routed to the existing beacon SNS topic
(the one emailing info@seaair.com).

```bash
aws cloudwatch put-metric-alarm \
  --region us-east-2 \
  --alarm-name seaair-msgbroker-memory-high \
  --namespace AWS/ElastiCache \
  --metric-name DatabaseMemoryUsagePercentage \
  --dimensions Name=CacheClusterId,Value=seaair-msgbroker-001 \
  --statistic Average --period 300 --evaluation-periods 2 \
  --threshold 80 --comparison-operator GreaterThanThreshold \
  --alarm-actions arn:aws:sns:us-east-2:120569623207:seaair-beacon-alerts
```

**Runbook:** if `seaair-msgbroker-memory-high` fires, check per-stream sizes and
trim before OOM — `GET /admin/streams`, then lower `STREAM_LIVE_MAXLEN` (or flush
oversized streams) via `apprunner update-service`.

## Rollout & rollback

App Runner env is updated with `apprunner update-service` — resupply the full
`SourceConfiguration` (preserve all existing vars + secret ARNs).

1. Deploy this code (archive inert: `ARCHIVE_ENABLED=false`).
2. Create the table + IAM + alarm (above).
3. Set `STREAM_LIVE_MAXLEN=5000` and `ARCHIVE_ENABLED=true`.
4. Confirm via `GET /health-detail` → `archive.enabled: true`, and that
   `GET /dashboard/api/analytics/controller/<id>?from=<ms>` returns points.

**Rollback:** set `ARCHIVE_ENABLED=false` and revert `STREAM_LIVE_MAXLEN`. No
data migration. The table and alarm are additive and safe to leave in place.

## Analytics API

`GET /dashboard/api/analytics/controller/:controllerId` (dashboard-admin auth).

| Param | | |
|---|---|---|
| `from` | epoch ms, **required** | must be within retention window (else 400) |
| `to` | epoch ms, optional | default now |
| `resolution` | `raw\|1m\|5m\|1h` | default `raw`; auto-escalates past `ANALYTICS_MAX_RAW_POINTS` |
| `measures` | comma-separated, optional | subset of measures |

`raw` returns measure values directly; a time resolution returns
`{ avg, min, max }` per numeric measure per bucket.

## Config

All new env vars are documented in [`.env.example`](../.env.example):
`STREAM_LIVE_MAXLEN`, `ARCHIVE_ENABLED`, `ARCHIVE_STORE`,
`ARCHIVE_RETENTION_DAYS`, `DDB_HISTORY_TABLE`, `ARCHIVE_GAP_SECONDS`,
`ANALYTICS_MAX_RAW_POINTS`.
