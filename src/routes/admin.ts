/**
 * Admin Routes -- inspect Redis Streams for testing and the future dashboard.
 * Protected by a shared X-Admin-Token header (env: ADMIN_TOKEN).
 * Will be replaced/augmented later with Cognito-group-based auth + WAF IP allow-list.
 */

import express, { Request, Response, NextFunction } from 'express';

const router = express.Router();

function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    res.status(503).json({ error: 'Admin endpoints disabled', message: 'ADMIN_TOKEN is not configured' });
    return;
  }
  const provided = (req.headers['x-admin-token'] as string) || '';
  if (provided.length !== expected.length || provided !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

router.use(requireAdminToken);

// GET /admin/streams -- list all stream keys with their lengths
router.get('/streams', async (req: Request, res: Response): Promise<void> => {
  const broker = req.app.locals.messageBroker;
  if (!broker.listStreamKeys || !broker.getStreamLength) {
    res.status(501).json({ error: 'Stream inspection not supported by current broker', brokerType: process.env.MESSAGE_BROKER || 'memory' });
    return;
  }
  try {
    const keys: string[] = await broker.listStreamKeys();
    const items = await Promise.all(keys.map(async (key) => {
      const parts = key.split(':');
      const direction = parts[1] as 'fw2mobile' | 'mobile2fw';
      const controllerId = parseInt(parts[2], 10);
      const length = await broker.getStreamLength(controllerId, direction);
      return { key, direction, controllerId, length };
    }));
    res.status(200).json({ success: true, streams: items, count: items.length });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list streams', message: err.message });
  }
});

// GET /admin/streams/:controllerId/:direction?count=50
router.get('/streams/:controllerId/:direction', async (req: Request, res: Response): Promise<void> => {
  const broker = req.app.locals.messageBroker;
  if (!broker.getStreamHistory) {
    res.status(501).json({ error: 'Stream inspection not supported by current broker' });
    return;
  }
  const controllerId = parseInt(req.params.controllerId, 10);
  const direction = req.params.direction;
  const count = Math.min(parseInt((req.query.count as string) || '50', 10), 500);

  if (isNaN(controllerId) || controllerId <= 0) {
    res.status(400).json({ error: 'controllerId must be a positive integer' });
    return;
  }
  if (direction !== 'fw2mobile' && direction !== 'mobile2fw') {
    res.status(400).json({ error: 'direction must be fw2mobile or mobile2fw' });
    return;
  }
  try {
    const messages = await broker.getStreamHistory(controllerId, direction, count);
    const length = await broker.getStreamLength(controllerId, direction);
    res.status(200).json({ success: true, controllerId, direction, count: messages.length, totalInStream: length, messages });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read stream', message: err.message });
  }
});

export default router;
