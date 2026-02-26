import { logger } from '../config/logger.js';
import { USER_ROLES, ERROR_CODES } from '../config/constants.js';

/**
 * Multi-tenant isolation middleware
 * Ensures data isolation between companies
 */
export async function tenantMiddleware(request, reply) {
  try {
    // Skip for public routes
    const publicRoutes = ['/health', '/api/auth/login', '/api/auth/forgot-password', '/api/auth/reset-password'];
    if (publicRoutes.some(route => request.url.startsWith(route))) {
      return;
    }

    // For webhook routes, empresa_id will be determined by the phone_number_id
    if (request.url.startsWith('/api/chat') || request.url.startsWith('/api/webhook')) {
      return;
    }

    // User must be authenticated at this point
    if (!request.user) {
      const error = new Error('Usuário não autenticado');
      error.statusCode = 401;
      throw error;
    }

    const user = request.user;

    // Master users handling
    if (user.role === USER_ROLES.MASTER) {
      // Check for impersonation header
      const empresaIdHeader = request.headers['x-empresa-id'];

      if (empresaIdHeader) {
        // Master is impersonating a company
        request.empresaId = empresaIdHeader;
        request.isMaster = true;
        request.isImpersonating = true;

        logger.debug('Master impersonating company', {
          user_id: user.id,
          empresa_id: empresaIdHeader
        });
      } else {
        // Master in global context - use their own empresa_id if they have one
        request.empresaId = user.empresa_id || null;
        request.isMaster = true;
        request.isImpersonating = false;
      }
    } else {
      // Regular users - always scoped to their company
      if (!user.empresa_id) {
        const error = new Error('Usuário sem empresa associada');
        error.code = ERROR_CODES.TENANT_MISMATCH;
        error.statusCode = 403;
        throw error;
      }

      request.empresaId = user.empresa_id;
      request.isMaster = false;
      request.isImpersonating = false;
    }

    // Check if route requires empresa_id
    const requiresEmpresa = [
      '/api/agentes',
      '/api/tools',
      '/api/inboxes',
      '/api/whatsapp-numbers',
      '/api/api-keys',
      '/api/conversas',
      '/api/dashboard',
      '/api/logs',
      '/api/usuarios',
      '/api/configuracoes'
    ];

    if (requiresEmpresa.some(route => request.url.startsWith(route)) && !request.empresaId) {
      const error = new Error('Empresa não especificada. Use o header X-Empresa-Id para impersonate.');
      error.code = ERROR_CODES.TENANT_MISMATCH;
      error.statusCode = 400;
      throw error;
    }

  } catch (error) {
    logger.error('Tenant middleware error', {
      error: error.message,
      user_id: request.user?.id,
      url: request.url
    });

    reply.code(error.statusCode || 500).send({
      success: false,
      error: {
        code: error.code || ERROR_CODES.INTERNAL_ERROR,
        message: error.message
      }
    });
  }
}

/**
 * Helper function to add tenant filter to database queries
 * @param {string} query - SQL query
 * @param {Array} params - Query parameters
 * @param {string} empresaId - Company ID
 * @param {string} tableAlias - Table alias (optional)
 * @returns {object} Modified query and params
 */
export function addTenantFilter(query, params = [], empresaId, tableAlias = null) {
  if (!empresaId) {
    return { query, params };
  }

  const alias = tableAlias ? `${tableAlias}.` : '';
  let modifiedQuery = query;
  let modifiedParams = [...params];

  // Check if WHERE clause exists
  const whereIndex = query.toLowerCase().indexOf('where');

  if (whereIndex > -1) {
    // Add empresa_id condition after WHERE
    const beforeWhere = query.substring(0, whereIndex + 5);
    const afterWhere = query.substring(whereIndex + 5);
    modifiedQuery = `${beforeWhere} ${alias}empresa_id = $${params.length + 1} AND ${afterWhere}`;
  } else {
    // Add WHERE clause before ORDER BY, GROUP BY, or at the end
    const orderByIndex = query.toLowerCase().indexOf('order by');
    const groupByIndex = query.toLowerCase().indexOf('group by');
    const limitIndex = query.toLowerCase().indexOf('limit');

    let insertIndex = query.length;
    if (orderByIndex > -1) insertIndex = Math.min(insertIndex, orderByIndex);
    if (groupByIndex > -1) insertIndex = Math.min(insertIndex, groupByIndex);
    if (limitIndex > -1) insertIndex = Math.min(insertIndex, limitIndex);

    const beforeInsert = query.substring(0, insertIndex);
    const afterInsert = query.substring(insertIndex);
    modifiedQuery = `${beforeInsert} WHERE ${alias}empresa_id = $${params.length + 1} ${afterInsert}`;
  }

  modifiedParams.push(empresaId);

  return { query: modifiedQuery, params: modifiedParams };
}

/**
 * Validate that a resource belongs to the company
 * @param {string} resourceId - Resource ID to validate
 * @param {string} tableName - Table name
 * @param {string} empresaId - Company ID
 * @param {object} db - Database connection
 * @returns {boolean} True if resource belongs to company
 */
export async function validateResourceOwnership(resourceId, tableName, empresaId, db) {
  if (!empresaId) {
    return true; // Master user without impersonation
  }

  const { rows } = await db.query(
    `SELECT 1 FROM ${tableName} WHERE id = $1 AND empresa_id = $2 LIMIT 1`,
    [resourceId, empresaId]
  );

  return rows.length > 0;
}

/**
 * Middleware to validate resource ownership
 * @param {string} tableName - Table name to check
 * @param {string} paramName - Request parameter name containing the resource ID
 */
export function requireResourceOwnership(tableName, paramName = 'id') {
  return async (request, reply) => {
    const resourceId = request.params[paramName];
    const empresaId = request.empresaId;

    if (!resourceId) {
      return; // No resource ID to validate
    }

    const isOwner = await validateResourceOwnership(
      resourceId,
      tableName,
      empresaId,
      request.server.db
    );

    if (!isOwner) {
      logger.warn('Resource ownership validation failed', {
        table: tableName,
        resource_id: resourceId,
        empresa_id: empresaId,
        user_id: request.user?.id
      });

      reply.code(404).send({
        success: false,
        error: {
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: 'Recurso não encontrado'
        }
      });
    }
  };
}