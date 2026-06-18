/**
 * Analytics history routes (Tier-2 archive).
 *
 * Mounted at /dashboard/api/analytics behind requireDashboardAdmin, so these
 * inherit the same Cognito JWT + dashboard-admin authorization as every other
 * dashboard read. (A per-user mobile surface may be added later; out of scope
 * for now.)
 *
 * Unlike /dashboard/api/devices/:id/analytics — which samples the short Redis
 * live window in RAM — this endpoint reads the durable DynamoDB archive, so it
 * can serve days of history and downsample server-side via change-point
 * bucketing. See src/services/archiveStore.ts.
 */

import express, { Request, Response } from 'express';
import {
  ArchiveStore,
  getArchiveStore,
  archiveEnabled,
  retentionDays,
  Resolution,
} from '../services/archiveStore';

const router = express.Router();

const VALID_RESOLUTIONS: Resolution[] = ['raw', '1m', '5m', '1h'];

function getStore(req: Request): ArchiveStore {
  return (req.app.locals.archiveStore as ArchiveStore | undefined) ?? getArchiveStore();
}

/**
 * GET /dashboard/api/analytics/controller/:controllerId
 *   ?from=<epoch ms, required>&to=<epoch ms, default now>
 *   &resolution=raw|1m|5m|1h (default raw)&measures=a,b,c
 */
router.get('/controller/:controllerId', async (req: Request, res: Response): Promise<void> => {
  if (!archiveEnabled()) {
    res.status(503).json({
      error: 'Archive disabled',
      message: 'Set ARCHIVE_ENABLED=true to serve analytics history',
    });
    return;
  }

  const controllerId = parseInt(req.params.controllerId, 10);
  if (isNaN(controllerId) || controllerId <= 0) {
    res.status(400).json({ error: 'controllerId must be a positive integer' });
    return;
  }

  const from = Number(req.query.from);
  if (!req.query.from || !Number.isFinite(from)) {
    res.status(400).json({ error: 'from (epoch ms) is required' });
    return;
  }

  const now = Date.now();
  const to = req.query.to !== undefined ? Number(req.query.to) : now;
  if (!Number.isFinite(to) || to < from) {
    res.status(400).json({ error: 'to must be a number >= from' });
    return;
  }

  // `from` must fall inside the retention window — older data is purged and
  // not queryable (FR-4 / AC: 400 on out-of-window).
  const retentionFloor = now - retentionDays() * 86_400_000;
  if (from < retentionFloor) {
    res.status(400).json({
      error: 'from is outside the retention window',
      retentionDays: retentionDays(),
      earliest: retentionFloor,
    });
    return;
  }

  let resolution: Resolution = 'raw';
  if (req.query.resolution !== undefined) {
    const r = String(req.query.resolution) as Resolution;
    if (!VALID_RESOLUTIONS.includes(r)) {
      res.status(400).json({ error: `resolution must be one of ${VALID_RESOLUTIONS.join(', ')}` });
      return;
    }
    resolution = r;
  }

  const measures =
    typeof req.query.measures === 'string' && req.query.measures.length > 0
      ? req.query.measures.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

  const started = Date.now();
  try {
    const result = await getStore(req).query(controllerId, from, to, resolution, measures);
    // NFR-4: meter query latency.
    console.log(
      `[Analytics] controller=${controllerId} range=${to - from}ms resolution=${result.resolution} ` +
        `points=${result.points.length} latencyMs=${Date.now() - started}`,
    );
    res.json(result);
  } catch (err: any) {
    console.error(`[Analytics] query failed for controller ${controllerId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
