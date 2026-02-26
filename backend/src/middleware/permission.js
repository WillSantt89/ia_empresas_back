import { logger } from '../config/logger.js';
import { USER_ROLES, ROLE_HIERARCHY, ERROR_CODES } from '../config/constants.js';

/**
 * Permission matrix defining access rules
 * Structure: { resource: { action: [allowed_roles] } }
 */
const PERMISSION_MATRIX = {
  // Master-only resources
  empresas: {
    read: [USER_ROLES.MASTER],
    write: [USER_ROLES.MASTER],
    delete: [USER_ROLES.MASTER]
  },
  planos: {
    read: [USER_ROLES.MASTER],
    write: [USER_ROLES.MASTER],
    delete: [USER_ROLES.MASTER]
  },
  'itens-cobraveis': {
    read: [USER_ROLES.MASTER],
    write: [USER_ROLES.MASTER],
    delete: [USER_ROLES.MASTER]
  },
  assinaturas: {
    read: [USER_ROLES.MASTER],
    write: [USER_ROLES.MASTER],
    delete: [USER_ROLES.MASTER]
  },
  'dashboard-global': {
    read: [USER_ROLES.MASTER]
  },

  // Company resources
  agentes: {
    read: [USER_ROLES.MASTER, USER_ROLES.ADMIN, USER_ROLES.OPERADOR, USER_ROLES.VIEWER],
    write: [USER_ROLES.MASTER, USER_ROLES.ADMIN],
    delete: [USER_ROLES.MASTER, USER_ROLES.ADMIN],
    test: [USER_ROLES.MASTER, USER_ROLES.ADMIN, USER_ROLES.OPERADOR]
  },
  prompts: {
    read: [USER_ROLES.MASTER, USER_ROLES.ADMIN, USER_ROLES.OPERADOR, USER_ROLES.VIEWER],
    write: [USER_ROLES.MASTER, USER_ROLES.ADMIN],
    activate: [USER_ROLES.MASTER, USER_ROLES.ADMIN]
  },
  tools: {
    read: [USER_ROLES.MASTER, USER_ROLES.ADMIN, USER_ROLES.OPERADOR, USER_ROLES.VIEWER],
    write: [USER_ROLES.MASTER, USER_ROLES.ADMIN],
    delete: [USER_ROLES.MASTER, USER_ROLES.ADMIN],
    test: [USER_ROLES.MASTER, USER_ROLES.ADMIN]
  },
  inboxes: {
    read: [USER_ROLES.MASTER, USER_ROLES.ADMIN, USER_ROLES.OPERADOR, USER_ROLES.VIEWER],
    write: [USER_ROLES.MASTER, USER_ROLES.ADMIN],
    delete: [USER_ROLES.MASTER, USER_ROLES.ADMIN]
  },
  'whatsapp-numbers': {
    read: [USER_ROLES.MASTER, USER_ROLES.ADMIN, USER_ROLES.OPERADOR, USER_ROLES.VIEWER],
    write: [USER_ROLES.MASTER, USER_ROLES.ADMIN],
    delete: [USER_ROLES.MASTER, USER_ROLES.ADMIN]
  },
  'api-keys': {
    read: [USER_ROLES.MASTER, USER_ROLES.ADMIN],
    write: [USER_ROLES.MASTER, USER_ROLES.ADMIN],
    delete: [USER_ROLES.MASTER, USER_ROLES.ADMIN],
    activate: [USER_ROLES.MASTER, USER_ROLES.ADMIN],
    test: [USER_ROLES.MASTER, USER_ROLES.ADMIN]
  },
  usuarios: {
    read: [USER_ROLES.MASTER, USER_ROLES.ADMIN, USER_ROLES.OPERADOR, USER_ROLES.VIEWER],
    write: [USER_ROLES.MASTER, USER_ROLES.ADMIN],
    delete: [USER_ROLES.MASTER, USER_ROLES.ADMIN]
  },
  conversas: {
    read: [USER_ROLES.MASTER, USER_ROLES.ADMIN, USER_ROLES.OPERADOR, USER_ROLES.VIEWER],
    control: [USER_ROLES.MASTER, USER_ROLES.ADMIN, USER_ROLES.OPERADOR]
  },
  logs: {
    read: [USER_ROLES.MASTER, USER_ROLES.ADMIN, USER_ROLES.OPERADOR, USER_ROLES.VIEWER]
  },
  dashboard: {
    read: [USER_ROLES.MASTER, USER_ROLES.ADMIN, USER_ROLES.OPERADOR, USER_ROLES.VIEWER]
  },
  configuracoes: {
    read: [USER_ROLES.MASTER, USER_ROLES.ADMIN, USER_ROLES.OPERADOR, USER_ROLES.VIEWER],
    write: [USER_ROLES.MASTER, USER_ROLES.ADMIN]
  }
};

/**
 * Check if user has permission for a resource and action
 * @param {string} userRole - User's role
 * @param {string} resource - Resource name
 * @param {string} action - Action name
 * @returns {boolean} True if user has permission
 */
export function hasPermission(userRole, resource, action) {
  if (!PERMISSION_MATRIX[resource] || !PERMISSION_MATRIX[resource][action]) {
    // If permission not defined, deny by default
    return false;
  }

  const allowedRoles = PERMISSION_MATRIX[resource][action];
  return allowedRoles.includes(userRole);
}

/**
 * Check if user role has higher or equal hierarchy than target role
 * @param {string} userRole - User's role
 * @param {string} targetRole - Target role to compare
 * @returns {boolean} True if user has higher or equal hierarchy
 */
export function hasRoleHierarchy(userRole, targetRole) {
  const userLevel = ROLE_HIERARCHY[userRole] || 0;
  const targetLevel = ROLE_HIERARCHY[targetRole] || 0;
  return userLevel >= targetLevel;
}

/**
 * Permission middleware factory
 * @param {string} resource - Resource name
 * @param {string} action - Action name
 * @returns {Function} Middleware function
 */
export function requirePermission(resource, action) {
  return async (request, reply) => {
    try {
      // User must be authenticated
      if (!request.user) {
        const error = new Error('Usuário não autenticado');
        error.code = ERROR_CODES.AUTH_INVALID_CREDENTIALS;
        error.statusCode = 401;
        throw error;
      }

      const userRole = request.user.role;

      // Check permission
      if (!hasPermission(userRole, resource, action)) {
        const error = new Error('Sem permissão para acessar este recurso');
        error.code = ERROR_CODES.PERMISSION_DENIED;
        error.statusCode = 403;
        throw error;
      }

      // Additional checks for specific resources
      if (resource === 'usuarios' && action === 'write') {
        // Users cannot edit their own role
        if (request.params.id === request.user.id && request.body?.role) {
          const error = new Error('Usuário não pode alterar o próprio role');
          error.code = ERROR_CODES.PERMISSION_DENIED;
          error.statusCode = 403;
          throw error;
        }

        // Check role hierarchy when creating/editing users
        if (request.body?.role && !hasRoleHierarchy(userRole, request.body.role)) {
          const error = new Error('Sem permissão para criar/editar usuário com este role');
          error.code = ERROR_CODES.PERMISSION_DENIED;
          error.statusCode = 403;
          throw error;
        }
      }

      logger.debug('Permission granted', {
        user_id: request.user.id,
        role: userRole,
        resource,
        action
      });

    } catch (error) {
      logger.warn('Permission denied', {
        error: error.message,
        user_id: request.user?.id,
        role: request.user?.role,
        resource,
        action,
        url: request.url
      });

      reply.code(error.statusCode || 403).send({
        success: false,
        error: {
          code: error.code || ERROR_CODES.PERMISSION_DENIED,
          message: error.message
        }
      });
    }
  };
}

/**
 * Combined role requirement middleware
 * @param {string[]} allowedRoles - Array of allowed roles
 * @returns {Function} Middleware function
 */
export function requireRole(allowedRoles) {
  return async (request, reply) => {
    try {
      // User must be authenticated
      if (!request.user) {
        const error = new Error('Usuário não autenticado');
        error.code = ERROR_CODES.AUTH_INVALID_CREDENTIALS;
        error.statusCode = 401;
        throw error;
      }

      // Check if user role is allowed
      if (!allowedRoles.includes(request.user.role)) {
        const error = new Error('Role não autorizado para este recurso');
        error.code = ERROR_CODES.PERMISSION_DENIED;
        error.statusCode = 403;
        throw error;
      }

    } catch (error) {
      logger.warn('Role requirement not met', {
        error: error.message,
        user_id: request.user?.id,
        role: request.user?.role,
        required_roles: allowedRoles,
        url: request.url
      });

      reply.code(error.statusCode || 403).send({
        success: false,
        error: {
          code: error.code || ERROR_CODES.PERMISSION_DENIED,
          message: error.message
        }
      });
    }
  };
}

/**
 * Check if user can access another user's data
 * @param {object} request - Fastify request
 * @param {string} targetUserId - Target user ID
 * @returns {boolean} True if access is allowed
 */
export function canAccessUser(request, targetUserId) {
  const user = request.user;

  // Master can access anyone
  if (user.role === USER_ROLES.MASTER) {
    return true;
  }

  // Admin can access users in their company
  if (user.role === USER_ROLES.ADMIN) {
    // Would need to query DB to check if target user is in same company
    return true; // Simplified for now
  }

  // Others can only access themselves
  return user.id === targetUserId;
}

/**
 * Role-based permission check (takes array of allowed roles)
 * Used in routes like: checkPermission(['master', 'admin'])
 * @param {string[]} allowedRoles - Array of allowed roles
 * @returns {Function} Middleware function
 */
export const checkPermission = requireRole;