import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../config/logger.js';

const createLogger = logger.child({ module: 'media-storage' });

export const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB (WhatsApp Business limit)

const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'audio/ogg': '.ogg',
  'audio/ogg; codecs=opus': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/amr': '.amr',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'application/pdf': '.pdf',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'text/plain': '.txt',
};

function getExtension(mimeType) {
  // Clean MIME type (remove parameters like "; codecs=opus")
  const baseMime = mimeType.split(';')[0].trim();
  return MIME_TO_EXT[mimeType] || MIME_TO_EXT[baseMime] || '.bin';
}

/**
 * Save media buffer to disk
 * @param {Buffer} buffer - File binary data
 * @param {string} empresaId - Company UUID for directory isolation
 * @param {string} mimeType - MIME type of the file
 * @param {string} [fileName] - Optional original filename (for documents)
 * @returns {Promise<{relativePath: string, sizeBytes: number}>}
 */
export async function saveMedia(buffer, empresaId, mimeType, fileName) {
  if (!buffer || buffer.length === 0) {
    throw new Error('Empty buffer');
  }

  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${buffer.length} bytes (max ${MAX_FILE_SIZE})`);
  }

  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const ext = getExtension(mimeType);
  const uuid = crypto.randomUUID();
  const storedFileName = `${uuid}${ext}`;

  const dirPath = path.join(UPLOAD_DIR, empresaId, yearMonth);
  await fs.mkdir(dirPath, { recursive: true });

  const filePath = path.join(dirPath, storedFileName);
  await fs.writeFile(filePath, buffer);

  const relativePath = `${empresaId}/${yearMonth}/${storedFileName}`;

  createLogger.debug('Media saved', {
    relativePath,
    sizeBytes: buffer.length,
    mimeType,
    originalName: fileName || null,
  });

  return {
    relativePath,
    sizeBytes: buffer.length,
  };
}

/**
 * Get absolute path for a stored media file
 * @param {string} relativePath - Relative path as stored in DB
 * @returns {string} Absolute file path
 */
export function getMediaAbsolutePath(relativePath) {
  // Prevent path traversal
  const normalized = path.normalize(relativePath);
  if (normalized.includes('..')) {
    throw new Error('Invalid path');
  }
  return path.join(UPLOAD_DIR, normalized);
}

/**
 * Create a read stream for a stored media file
 * @param {string} relativePath - Relative path as stored in DB
 * @returns {fs.ReadStream}
 */
export function getMediaStream(relativePath) {
  const absolutePath = getMediaAbsolutePath(relativePath);
  return createReadStream(absolutePath);
}

/**
 * Check if a media file exists
 * @param {string} relativePath - Relative path
 * @returns {Promise<boolean>}
 */
export async function mediaExists(relativePath) {
  try {
    const absolutePath = getMediaAbsolutePath(relativePath);
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}
