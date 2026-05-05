/**
 * Controller Routes
 * Routes used by the physical controller device. No JWT authentication required.
 */

import express, { Request, Response } from 'express';
import { Message } from '../types';

const router = express.Router();

/**
 * POST /controller/heartbeat
 * Controller appends a heartbeat to stream:fw2mobile:{controllerId}.
 */
router.post('/heartbeat', async (req: Request, res: Response): Promise<void> => {
  const { controllerId, protobufPayload } = req.body;
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';

  console.log(`[Controller] Heartbeat received from controller ${controllerId} at ${ip}`);

  if (controllerId === undefined || controllerId === null) {
    res.status(400).json({ error: 'controllerId is required' });
    return;
  }
  if (typeof controllerId !== 'number' || !Number.isInteger(controllerId) || controllerId <= 0 || !Number.isSafeInteger(controllerId)) {
    res.status(400).json({ error: 'controllerId must be a safe positive integer (cannot be 0)' });
    return;
  }
  if (!protobufPayload) {
    res.status(400).json({ error: 'protobufPayload is required' });
    return;
  }

  const message: Message = {
    timestamp: new Date().toISOString(),
    sender: { ip, type: 'controller' },
    controllerId,
    protobufPayload
  };

  try {
    await req.app.locals.messageBroker.addControllerMessage(controllerId, message);
    res.status(200).json({ success: true, message: 'Heartbeat received', controllerId });
  } catch (err: any) {
    console.error(`[Controller] Failed to add heartbeat: ${err.message}`);
    res.status(500).json({ error: 'Broker write failed', message: err.message });
  }
});

/**
 * GET /controller/messages/:controllerId
 * Controller pulls the next undelivered command from stream:mobile2fw:{controllerId}
 * via the "fw" consumer group. Stream history is retained on read (XACK only).
 */
router.get('/messages/:controllerId', async (req: Request, res: Response): Promise<void> => {
  const controllerId = parseInt(req.params.controllerId, 10);
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';

  console.log(`[Controller] Message retrieval request from ${ip} for controller ${controllerId}`);

  if (isNaN(controllerId) || controllerId < 0) {
    res.status(400).json({ error: 'controllerId must be a valid non-negative integer' });
    return;
  }

  try {
    const message = await req.app.locals.messageBroker.getMobileAppMessage(controllerId);
    if (!message) {
      res.status(200).json({ success: true, message: null });
      return;
    }
    res.status(200).json({ success: true, message });
  } catch (err: any) {
    console.error(`[Controller] Failed to read message: ${err.message}`);
    res.status(500).json({ error: 'Broker read failed', message: err.message });
  }
});

export default router;
