import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

/**
 * Encrypt sensitive data
 * @param {string} text - Text to encrypt
 * @param {string} key - Encryption key (must be 32 characters)
 * @returns {object} Encrypted data with iv and authTag
 */
export function encrypt(text, key) {
  if (!key || key.length !== 32) {
    throw new Error('Encryption key must be exactly 32 characters');
  }

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(key), iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex')
  };
}

/**
 * Decrypt sensitive data
 * @param {object} encryptedData - Object with encrypted, iv, and authTag
 * @param {string} key - Encryption key (must be 32 characters)
 * @returns {string} Decrypted text
 */
export function decrypt(encryptedData, key) {
  if (!key || key.length !== 32) {
    throw new Error('Encryption key must be exactly 32 characters');
  }

  const { encrypted, iv, authTag } = encryptedData;

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    Buffer.from(key),
    Buffer.from(iv, 'hex')
  );

  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Hash a value using SHA256
 * @param {string} value - Value to hash
 * @returns {string} Hashed value
 */
export function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Generate a random token
 * @param {number} length - Token length in bytes
 * @returns {string} Random token
 */
export function generateToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}