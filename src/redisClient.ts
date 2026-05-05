/**
 * Redis client connection manager.
 * Resolves AUTH token from REDIS_AUTH_TOKEN env var (preferred — App Runner
 * secret injection populates this from Secrets Manager) or falls back to
 * REDIS_AUTH_TOKEN_SECRET_ARN for local development.
 */

import { Redis, RedisOptions } from 'ioredis';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

let client: Redis | null = null;

async function resolveAuthToken(): Promise<string | undefined> {
  if (process.env.REDIS_AUTH_TOKEN && process.env.REDIS_AUTH_TOKEN.length > 0) {
    return process.env.REDIS_AUTH_TOKEN;
  }
  const secretArn = process.env.REDIS_AUTH_TOKEN_SECRET_ARN;
  if (!secretArn) {
    console.warn('[RedisClient] No REDIS_AUTH_TOKEN or REDIS_AUTH_TOKEN_SECRET_ARN configured. Connecting without AUTH.');
    return undefined;
  }
  const region = process.env.AWS_REGION || 'us-east-2';
  console.log(`[RedisClient] Loading Redis AUTH token from Secrets Manager: ${secretArn}`);
  const sm = new SecretsManagerClient({ region });
  const result = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) {
    throw new Error(`Secrets Manager returned empty SecretString for ${secretArn}`);
  }
  return result.SecretString;
}

export async function getRedisClient(): Promise<Redis> {
  if (client) return client;

  const host = process.env.REDIS_HOST;
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);
  if (!host) {
    throw new Error('REDIS_HOST environment variable is required when MESSAGE_BROKER=redis');
  }
  const useTLS = (process.env.REDIS_TLS || 'true').toLowerCase() === 'true';
  const password = await resolveAuthToken();

  const options: RedisOptions = {
    host,
    port,
    password,
    tls: useTLS ? {} : undefined,
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
    reconnectOnError: (err: Error) => {
      const targets = ['READONLY', 'ETIMEDOUT', 'ECONNRESET'];
      return targets.some(t => err.message.includes(t));
    }
  };

  client = new Redis(options);

  client.on('connect', () => console.log(`[RedisClient] Connected to ${host}:${port} (TLS=${useTLS})`));
  client.on('ready', () => console.log('[RedisClient] Ready'));
  client.on('error', (err: Error) => console.error(`[RedisClient] Error: ${err.message}`));
  client.on('close', () => console.warn('[RedisClient] Connection closed'));
  client.on('reconnecting', (delay: number) => console.warn(`[RedisClient] Reconnecting in ${delay}ms`));

  await new Promise<void>((resolve, reject) => {
    if (client!.status === 'ready') return resolve();
    const onReady = () => { cleanup(); resolve(); };
    const onError = (err: Error) => { cleanup(); reject(err); };
    const cleanup = () => {
      client!.off('ready', onReady);
      client!.off('error', onError);
    };
    client!.once('ready', onReady);
    client!.once('error', onError);
    setTimeout(() => { cleanup(); reject(new Error('Redis connection timeout (10s)')); }, 10000);
  });

  return client;
}

export async function closeRedisClient(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
