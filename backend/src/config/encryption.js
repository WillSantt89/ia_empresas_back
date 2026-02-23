import crypto from 'crypto';
import { config } from './env.js';

/**
 * Encryption utilities for sensitive data
 * Uses AES-256-GCM for authenticated encryption
 */

const algorithm = 'aes-256-gcm';
const keyBuffer = Buffer.from(config.ENCRYPTION_KEY, 'utf8');

/**
 * Encrypt sensitive data
 * @param {string} text - Plain text to encrypt
 * @returns {string} Encrypted text in format: iv:authTag:encrypted
 */
export function encrypt(text) {
  if (!text) {
    return null;
  }

  try {
    // Generate random IV (Initialization Vector)
    const iv = crypto.randomBytes(16);

    // Create cipher
    const cipher = crypto.createCipheriv(algorithm, keyBuffer, iv);

    // Encrypt the text
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // Get auth tag for authenticated encryption
    const authTag = cipher.getAuthTag();

    // Combine IV, auth tag, and encrypted data
    // Format: base64(iv):base64(authTag):hex(encrypted)
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
  } catch (error) {
    throw new Error(`Encryption failed: ${error.message}`);
  }
}

/**
 * Decrypt sensitive data
 * @param {string} encryptedData - Encrypted text in format: iv:authTag:encrypted
 * @returns {string} Decrypted plain text
 */
export function decrypt(encryptedData) {
  if (!encryptedData) {
    return null;
  }

  try {
    // Split the encrypted data
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }

    const [ivBase64, authTagBase64, encrypted] = parts;

    // Convert from base64
    const iv = Buffer.from(ivBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');

    // Create decipher
    const decipher = crypto.createDecipheriv(algorithm, keyBuffer, iv);
    decipher.setAuthTag(authTag);

    // Decrypt
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    throw new Error(`Decryption failed: ${error.message}`);
  }
}

/**
 * Hash a string using SHA-256
 * @param {string} text - Text to hash
 * @returns {string} Hex-encoded hash
 */
export function hash(text) {
  if (!text) {
    return null;
  }

  return crypto
    .createHash('sha256')
    .update(text)
    .digest('hex');
}

/**
 * Generate a secure random token
 * @param {number} length - Token length in bytes (default: 32)
 * @returns {string} Hex-encoded token
 */
export function generateSecureToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Generate a secure API key
 * @returns {string} API key in format: prefix_randomToken
 */
export function generateApiKey(prefix = 'sk') {
  const randomPart = crypto.randomBytes(24).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return `${prefix}_${randomPart}`;
}

/**
 * Mask sensitive data for display
 * @param {string} text - Text to mask
 * @param {number} showChars - Number of characters to show at the end
 * @returns {string} Masked text
 */
export function maskSensitiveData(text, showChars = 4) {
  if (!text || text.length <= showChars) {
    return text;
  }

  const masked = '*'.repeat(text.length - showChars);
  const visible = text.slice(-showChars);

  return `${masked}${visible}`;
}

/**
 * Validate encryption key on startup
 */
export function validateEncryptionKey() {
  if (!config.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is not set in environment variables');
  }

  if (config.ENCRYPTION_KEY.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be exactly 32 characters for AES-256');
  }

  // Test encryption/decryption
  try {
    const testText = 'test_encryption';
    const encrypted = encrypt(testText);
    const decrypted = decrypt(encrypted);

    if (decrypted !== testText) {
      throw new Error('Encryption/decryption test failed');
    }
  } catch (error) {
    throw new Error(`Encryption validation failed: ${error.message}`);
  }
}

/**
 * Encrypt an object as JSON
 * @param {object} obj - Object to encrypt
 * @returns {string} Encrypted JSON
 */
export function encryptObject(obj) {
  if (!obj) {
    return null;
  }

  const json = JSON.stringify(obj);
  return encrypt(json);
}

/**
 * Decrypt JSON to object
 * @param {string} encryptedData - Encrypted JSON data
 * @returns {object} Decrypted object
 */
export function decryptObject(encryptedData) {
  if (!encryptedData) {
    return null;
  }

  const json = decrypt(encryptedData);
  return JSON.parse(json);
}

// Validate on module load
validateEncryptionKey();