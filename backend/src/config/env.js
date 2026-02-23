import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env') });

// Validation helper
function validateEnv(key, defaultValue = undefined, required = true) {
  const value = process.env[key] || defaultValue;

  if (required && !value) {
    throw new Error(`Environment variable ${key} is required but not set`);
  }

  return value;
}

// Validate and export configuration
export const config = {
  // Node Environment
  NODE_ENV: validateEnv('NODE_ENV', 'development', false),

  // Server Configuration
  PORT: parseInt(validateEnv('PORT', '3000', false), 10),

  // Database Configuration
  DATABASE_URL: validateEnv('DATABASE_URL'),

  // Redis Configuration
  REDIS_URL: validateEnv('REDIS_URL'),

  // JWT Configuration
  JWT_SECRET: validateEnv('JWT_SECRET'),
  JWT_EXPIRES_IN: validateEnv('JWT_EXPIRES_IN', '24h', false),
  JWT_REFRESH_EXPIRES_IN: validateEnv('JWT_REFRESH_EXPIRES_IN', '7d', false),

  // Encryption Key (must be exactly 32 characters for AES-256)
  ENCRYPTION_KEY: (() => {
    const key = validateEnv('ENCRYPTION_KEY');
    if (key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be exactly 32 characters for AES-256');
    }
    return key;
  })(),

  // Webhook Security
  WEBHOOK_API_KEY: validateEnv('WEBHOOK_API_KEY'),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: parseInt(validateEnv('RATE_LIMIT_WINDOW_MS', '60000', false), 10), // 1 minute
  RATE_LIMIT_MAX_REQUESTS: parseInt(validateEnv('RATE_LIMIT_MAX_REQUESTS', '1000', false), 10),
  RATE_LIMIT_CHAT_MAX: parseInt(validateEnv('RATE_LIMIT_CHAT_MAX', '200', false), 10),
  RATE_LIMIT_LOGIN_MAX: parseInt(validateEnv('RATE_LIMIT_LOGIN_MAX', '10', false), 10),

  // Logging
  LOG_LEVEL: validateEnv('LOG_LEVEL', 'info', false),

  // Gemini API (not required at startup, each company provides their own)
  GEMINI_API_ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models',

  // Security Headers
  CORS_ORIGIN: validateEnv('CORS_ORIGIN', '*', false),
  CORS_CREDENTIALS: validateEnv('CORS_CREDENTIALS', 'true', false) === 'true',

  // Session Configuration
  SESSION_TTL_HOURS: parseInt(validateEnv('SESSION_TTL_HOURS', '24', false), 10),

  // Development/Production specific
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production',
  isTesting: process.env.NODE_ENV === 'test',
};

// Validate critical configurations
if (config.isProduction) {
  // Additional production validations
  if (config.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET should be at least 32 characters in production');
  }

  if (config.CORS_ORIGIN === '*') {
    console.warn('WARNING: CORS_ORIGIN is set to "*" in production. Consider restricting it.');
  }
}

// Export validated config
export default config;