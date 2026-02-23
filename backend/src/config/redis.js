import Redis from 'ioredis';
import { config } from './env.js';
import { logger } from './logger.js';

// Redis client configuration
const redisConfig = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  showFriendlyErrorStack: config.NODE_ENV === 'development',
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      // Only reconnect when the error contains "READONLY"
      return true;
    }
    return false;
  }
};

// Parse Redis URL
const parseRedisUrl = (url) => {
  try {
    const redisUrl = new URL(url);
    return {
      host: redisUrl.hostname,
      port: redisUrl.port || 6379,
      password: redisUrl.password,
      username: redisUrl.username || 'default',
      ...redisConfig
    };
  } catch (error) {
    logger.error('Invalid Redis URL:', error);
    throw error;
  }
};

// Create Redis client
export const redis = new Redis(parseRedisUrl(config.REDIS_URL));

// Handle Redis events
redis.on('connect', () => {
  logger.info('Redis client connected');
});

redis.on('ready', () => {
  logger.info('Redis client ready');
});

redis.on('error', (err) => {
  logger.error('Redis client error:', err);
});

redis.on('close', () => {
  logger.warn('Redis connection closed');
});

redis.on('reconnecting', (delay) => {
  logger.info(`Redis reconnecting in ${delay}ms`);
});

// Test Redis connection
export async function testRedisConnection() {
  try {
    const pong = await redis.ping();
    logger.info('Redis connected successfully:', pong);
    return true;
  } catch (error) {
    logger.error('Redis connection failed:', error);
    return false;
  }
}

// Helper functions for common operations

// Set with expiration
export async function setWithExpiry(key, value, ttlSeconds) {
  const serialized = JSON.stringify(value);
  return redis.setex(key, ttlSeconds, serialized);
}

// Get and parse JSON
export async function getJSON(key) {
  const value = await redis.get(key);
  return value ? JSON.parse(value) : null;
}

// Increment with expiry
export async function incrementWithExpiry(key, ttlSeconds) {
  const multi = redis.multi();
  multi.incr(key);
  multi.expire(key, ttlSeconds);
  const results = await multi.exec();
  return results[0][1]; // Return the incremented value
}

// Check if key exists
export async function exists(key) {
  return redis.exists(key);
}

// Delete keys by pattern
export async function deleteByPattern(pattern) {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    return redis.del(...keys);
  }
  return 0;
}

// Get all keys by pattern
export async function getKeysByPattern(pattern) {
  return redis.keys(pattern);
}

// Pub/Sub helpers
export const publisher = redis.duplicate();
export const subscriber = redis.duplicate();

// Subscribe to a channel
export function subscribe(channel, callback) {
  subscriber.subscribe(channel);
  subscriber.on('message', (receivedChannel, message) => {
    if (receivedChannel === channel) {
      try {
        const parsed = JSON.parse(message);
        callback(parsed);
      } catch {
        callback(message);
      }
    }
  });
}

// Publish to a channel
export async function publish(channel, message) {
  const serialized = typeof message === 'string' ? message : JSON.stringify(message);
  return publisher.publish(channel, serialized);
}

// Graceful shutdown
export async function closeRedis() {
  await redis.quit();
  await publisher.quit();
  await subscriber.quit();
  logger.info('Redis connections closed');
}