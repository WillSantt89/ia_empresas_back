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

// Media token TTL: 5 minutes
const MEDIA_TOKEN_TTL = 300;

export default async function mediaRoutes(fastify) {

  /**
   * POST /api/media/token
   * Generate a short-lived media access token (5 min).
   * Used by frontend to avoid putting the main JWT in query strings.
   * Requires valid JWT authentication.
   */
  fastify.post('/token', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const mediaToken = randomUUID();
    const tokenData = {
      user_id: request.user.id,
      empresa_id: request.empresaId || request.user.empresa_id,
      role: request.user.role,
    };

    await redis.setex(`media_token:${mediaToken}`, MEDIA_TOKEN_TTL, JSON.stringify(tokenData));

    return reply.send({
      success: true,
      data: { token: mediaToken, expires_in: MEDIA_TOKEN_TTL },
    });
  });

  /**
   * GET /api/media/:empresaId/:yearMonth/:filename
   * Serve stored media files with authentication
   *
   * Auth: JWT via Authorization header, OR ?mt= short-lived media token, OR ?token= JWT (legacy)
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
      // Priority: 1) Authorization header (JWT), 2) ?mt= media token, 3) ?token= JWT (legacy)
      let userEmpresaId = null;
      let userRole = null;

      const authHeader = request.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        // Standard JWT auth
        try {
          const decoded = fastify.jwt.verify(authHeader.substring(7));
          userEmpresaId = decoded.empresa_id;
          userRole = decoded.role;
        } catch (err) {
          return reply.code(401).send({ error: 'Invalid or expired token' });
        }
      } else if (request.query.mt) {
        // Short-lived media token (preferred for <img>/<audio>/<video>)
        const tokenData = await redis.get(`media_token:${request.query.mt}`);
        if (!tokenData) {
          return reply.code(401).send({ error: 'Invalid or expired media token' });
        }
        const parsed = JSON.parse(tokenData);
        userEmpresaId = parsed.empresa_id;
        userRole = parsed.role;
      } else if (request.query.token) {
        // Legacy: JWT in query param (deprecated, kept for backward compatibility)
        try {
          const decoded = fastify.jwt.verify(request.query.token);
          userEmpresaId = decoded.empresa_id;
          userRole = decoded.role;
        } catch (err) {
          return reply.code(401).send({ error: 'Invalid or expired token' });
        }
      } else {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      // --- Tenant isolation ---
      // User can only access media from their own company (or master can access all)
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
      // CORS handled globally by @fastify/cors plugin

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
      // CORS handled globally by @fastify/cors plugin

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
