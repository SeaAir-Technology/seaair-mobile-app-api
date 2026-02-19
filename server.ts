/**
 * SeaAir Mobile App API
 * Transport layer for mobile app and controller communication
 */

import express, { Request, Response, NextFunction, Application } from 'express';
import morgan from 'morgan';
import { MessageQueue } from './src/messageQueue';
import { RateLimiter } from './src/rateLimiter';
import controllerRoutes from './src/routes/controller';
import mobileRoutes from './src/routes/mobile';
import configRoutes from './src/routes/config';
import { isCognitoConfigured, COGNITO_USER_POOL_ID, AWS_REGION } from './src/auth';
import { HealthDetailResponse, QueueContents, Message } from './src/types';

const app: Application = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(morgan('combined')); // Log all HTTP requests

// Initialize message queue and rate limiter
app.locals.messageQueue = new MessageQueue();
app.locals.rateLimiter = new RateLimiter();

console.log('[Server] Message queue and rate limiter initialized');

// Check AWS Cognito configuration
if (isCognitoConfigured()) {
  console.log(`[Server] AWS Cognito configured - User Pool: ${COGNITO_USER_POOL_ID}, Region: ${AWS_REGION}`);
} else {
  console.warn('[Server] WARNING: AWS Cognito not configured. Set COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID in the configuration.');
  console.warn('[Server] Mobile app authentication will fail until Cognito is configured.');
}

// Routes
app.use('/controller', controllerRoutes);
app.use('/mobile', mobileRoutes);
app.use('/config', configRoutes);

// Health check endpoint
app.get('/health', (_req: Request, res: Response): void => {
  res.status(200).json({ status: 'healthy' });
});

// Detailed health check endpoint with queue contents
app.get('/health-detail', (_req: Request, res: Response): void => {
  const stats = app.locals.messageQueue.getStats();
  const rateLimiterStats = app.locals.rateLimiter.getStats();
  const queueData = app.locals.messageQueue.getAllQueueContents();
  
  // Convert Maps to plain objects for JSON serialization
  const queueContents: QueueContents = {
    mobileAppQueue: {},
    controllerQueue: {}
  };

  // Convert mobile app queue Map to object
  for (const [controllerId, messages] of queueData.mobileAppQueue.entries()) {
    queueContents.mobileAppQueue[controllerId.toString()] = messages;
  }

  // Convert controller queue Map to object
  for (const [controllerId, message] of queueData.controllerQueue.entries()) {
    queueContents.controllerQueue[controllerId.toString()] = message;
  }

  // Log queue contents to console
  console.log('[Server] /health-detail - Dumping queue contents:');
  console.log('='.repeat(80));
  console.log('Mobile App Queue (messages from mobile apps to controllers):');
  console.log('-'.repeat(80));
  for (const [controllerId, messages] of queueData.mobileAppQueue.entries()) {
    console.log(`  Controller ID ${controllerId}: ${messages.length} message(s)`);
    messages.forEach((msg: Message, idx: number) => {
      console.log(`    Message ${idx + 1}:`);
      console.log(`      Timestamp: ${msg.timestamp}`);
      console.log(`      Sender: ${msg.sender.type} from ${msg.sender.ip}${msg.sender.authId ? ` (Auth: ${msg.sender.authId})` : ''}`);
      console.log(`      Payload: ${msg.protobufPayload.substring(0, 50)}${msg.protobufPayload.length > 50 ? '...' : ''}`);
      console.log(`      Expires At: ${msg.expiresAt ? new Date(msg.expiresAt).toISOString() : 'N/A'}`);
    });
  }
  
  console.log('='.repeat(80));
  console.log('Controller Queue (latest heartbeat from controllers):');
  console.log('-'.repeat(80));
  for (const [controllerId, message] of queueData.controllerQueue.entries()) {
    console.log(`  Controller ID ${controllerId}:`);
    console.log(`    Timestamp: ${message.timestamp}`);
    console.log(`    Sender: ${message.sender.type} from ${message.sender.ip}`);
    console.log(`    Payload: ${message.protobufPayload.substring(0, 50)}${message.protobufPayload.length > 50 ? '...' : ''}`);
    console.log(`    Expires At: ${message.expiresAt ? new Date(message.expiresAt).toISOString() : 'N/A'}`);
  }
  console.log('='.repeat(80));

  const response: HealthDetailResponse = {
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    queues: stats,
    queueContents: queueContents,
    rateLimiter: rateLimiterStats,
    cognito: {
      configured: isCognitoConfigured(),
      userPoolId: COGNITO_USER_POOL_ID || 'not-set',
      region: AWS_REGION
    }
  };

  res.status(200).json(response);
});

// 404 handler
app.use((req: Request, res: Response): void => {
  console.log(`[Server] 404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({ 
    error: 'Route not found' 
  });
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction): void => {
  console.error('[Server] Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message
  });
});

// Function to log health data
function logHealthData(): void {
  const stats = app.locals.messageQueue.getStats();
  const rateLimiterStats = app.locals.rateLimiter.getStats();
  
  console.log('\n' + '='.repeat(80));
  console.log('[Health Monitor] System Health Status');
  console.log('='.repeat(80));
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Uptime: ${Math.floor(process.uptime())} seconds`);
  console.log('-'.repeat(80));
  console.log('Queue Statistics:');
  console.log(`  Mobile App Controllers: ${stats.mobileAppControllers}`);
  console.log(`  Mobile App Messages: ${stats.mobileAppMessages}`);
  console.log(`  Controller Messages: ${stats.controllerMessages}`);
  console.log('-'.repeat(80));
  console.log('Rate Limiter Statistics:');
  console.log(`  Tracked Keys: ${rateLimiterStats.trackedKeys}`);
  console.log('-'.repeat(80));
  console.log('Cognito Configuration:');
  console.log(`  Configured: ${isCognitoConfigured()}`);
  console.log(`  User Pool ID: ${COGNITO_USER_POOL_ID || 'not-set'}`);
  console.log(`  Region: ${AWS_REGION}`);
  console.log('='.repeat(80) + '\n');
}

// Start server
app.listen(PORT, () => {
  console.log(`[Server] SeaAir Mobile App API running on port ${PORT}`);
  console.log(`[Server] Controller routes available at /controller`);
  console.log(`[Server] Mobile app routes available at /mobile`);
  console.log(`[Server] Configuration routes available at /config`);
  console.log(`[Server] Health check available at /health`);
  console.log(`[Server] Detailed health check available at /health-detail`);
  
  // Start periodic health monitoring (every 60 seconds)
  setInterval(logHealthData, 60000);
  console.log('[Server] Health monitoring started - logging every 60 seconds');
});

export default app;
