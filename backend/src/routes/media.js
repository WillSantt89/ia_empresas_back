import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../config/logger.js';
import { redis } from '../config/redis.js';
import { getMediaAbsolutePath, getMediaStream } from '../services/media-storage.js';

const createLogger = logger.child({ module: 'media-routes' });

// MIME types that should be downloaded as attachment (not inline)
const ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'application/octet-stream',
]);

// Allowed extensions to prevent serving arbitrary files
const ALLOWED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif',
  '.ogg', '.mp3', '.m4a', '.amr',
  '.mp4', '.3gp',
  '.pdf', '.xls', '.xlsx', '.doc', '.docx', '.txt',
  '.bin',
]);

export default async function mediaRoutes(fastify) {
  /**
   * GET /api/media/:empresaId/:yearMonth/:filename
   * Serve stored media files with authentication
   *
   * Auth: JWT via Authorization header OR ?token= query param
   * (query param needed for <img>, <audio>, <video> tags that can't set headers)
   */
  fastify.get('/:empresaId/:yearMonth/:filename', {
    config: { rawBody: false },
  }, async (request, reply) => {
    try {
      const { empresaId, yearMonth, filename } = request.params;

      // Validate params format
      if (!empresaId || !yearMonth || !filename) {
        return reply.code(400).send({ error: 'Invalid path' });
      }

      // Validate filename extension
      const ext = path.extname(filename).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        return reply.code(400).send({ error: 'Invalid file type' });
      }

      // Validate yearMonth format (YYYY-MM)
      if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
        return reply.code(400).send({ error: 'Invalid path format' });
      }

      // --- Authentication ---
      // Try Authorization header first, then query param
      let token = null;
      const authHeader = request.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      } else if (request.query.token) {
        token = request.query.token;
      }

      if (!token) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      let decoded;
      try {
        decoded = fastify.jwt.verify(token);
      } catch (err) {
        return reply.code(401).send({ error: 'Invalid or expired token' });
      }

      // --- Tenant isolation ---
      // User can only access media from their own company (or master can access all)
      const userEmpresaId = decoded.empresa_id;
      const userRole = decoded.role;

      if (userRole !== 'master' && userEmpresaId !== empresaId) {
        return reply.code(403).send({ error: 'Access denied' });
      }

      // --- Serve file ---
      const relativePath = `${empresaId}/${yearMonth}/${filename}`;
      const absolutePath = getMediaAbsolutePath(relativePath);

      // Check file exists
      try {
        await fs.access(absolutePath);
      } catch {
        return reply.code(404).send({ error: 'File not found' });
      }

      const stat = await fs.stat(absolutePath);

      // Determine content type from extension
      const contentType = getContentType(ext);

      // Set headers
      reply.header('Content-Type', contentType);
      reply.header('Content-Length', stat.size);
      reply.header('Cache-Control', 'private, max-age=86400');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Access-Control-Allow-Origin', '*');

      // Documents: force download
      if (ATTACHMENT_TYPES.has(contentType)) {
        reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      } else {
        reply.header('Content-Disposition', 'inline');
      }

      // Stream the file
      const stream = getMediaStream(relativePath);
      return reply.send(stream);

    } catch (error) {
      createLogger.error('Error serving media', { error: error.message });
      return reply.code(500).send({ error: 'Internal error' });
    }
  });

  /**
   * GET /api/media/temp/:key
   * Serve media via temporary public key (no auth required).
   * Used for WhatsApp API link-based sending to avoid "forwarded" label.
   * Keys expire in 5 minutes via Redis TTL.
   */
  fastify.get('/temp/:key', {
    config: { rawBody: false },
  }, async (request, reply) => {
    try {
      const { key } = request.params;

      const data = await redis.get(`media_temp:${key}`);
      if (!data) {
        return reply.code(404).send({ error: 'Link expired or not found' });
      }

      const { relativePath, mimeType } = JSON.parse(data);
      const absolutePath = getMediaAbsolutePath(relativePath);

      try {
        await fs.access(absolutePath);
      } catch {
        return reply.code(404).send({ error: 'File not found' });
      }

      const stat = await fs.stat(absolutePath);

      reply.header('Content-Type', mimeType || 'application/octet-stream');
      reply.header('Content-Length', stat.size);
      reply.header('Cache-Control', 'no-store');
      reply.header('Access-Control-Allow-Origin', '*');

      const stream = getMediaStream(relativePath);
      return reply.send(stream);
    } catch (error) {
      createLogger.error('Error serving temp media', { error: error.message });
      return reply.code(500).send({ error: 'Internal error' });
    }
  });
}

/**
 * Create a temporary public URL for a media file.
 * Stores a Redis key with 5 min TTL. Returns the full URL.
 */
export async function createTempMediaUrl(relativePath, mimeType) {
  const key = randomUUID();
  await redis.setex(`media_temp:${key}`, 300, JSON.stringify({ relativePath, mimeType }));

  // Build public URL — EasyPanel exposes the service via HTTPS
  const baseUrl = process.env.PUBLIC_URL
    || 'https://wschat-ia-empresas-back.fldxjw.easypanel.host';
  return `${baseUrl}/api/media/temp/${key}`;
}

function getContentType(ext) {
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ogg': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.amr': 'audio/amr',
    '.mp4': 'video/mp4',
    '.3gp': 'video/3gpp',
    '.pdf': 'application/pdf',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt': 'text/plain',
    '.bin': 'application/octet-stream',
  };
  return map[ext] || 'application/octet-stream';
}
