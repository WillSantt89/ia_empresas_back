import rateLimit from '@fastify/rate-limit';

// Configuração global de rate limiting
export const globalRateLimit = {
  global: true,
  max: 1000, // 1000 requests por minuto
  timeWindow: '1 minute',
  skipSuccessfulRequests: false,
  skipFailedRequests: true,
  errorResponseBuilder: function (request, context) {
    return {
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please try again later.',
        statusCode: 429,
        after: context.after,
        limit: context.max
      }
    };
  }
};

// Rate limit específico para endpoint de chat
export const chatRateLimit = {
  max: async (request, key) => {
    // 200 requests por minuto por empresa_id
    return 200;
  },
  timeWindow: '1 minute',
  keyGenerator: (request) => {
    // Use empresa_id como chave quando disponível
    if (request.body?.empresa_id) {
      return `chat:empresa:${request.body.empresa_id}`;
    }
    // Fallback para IP
    return `chat:ip:${request.ip}`;
  },
  errorResponseBuilder: function (request, context) {
    return {
      success: false,
      error: {
        code: 'CHAT_RATE_LIMITED',
        message: 'Chat rate limit exceeded. Please wait before sending more messages.',
        statusCode: 429,
        after: context.after,
        limit: context.max
      }
    };
  }
};

// Rate limit específico para login
export const loginRateLimit = {
  max: 10, // 10 tentativas por minuto
  timeWindow: '1 minute',
  keyGenerator: (request) => {
    // Rate limit por IP + email para prevenir brute force
    const email = request.body?.email || 'unknown';
    return `login:${request.ip}:${email}`;
  },
  errorResponseBuilder: function (request, context) {
    return {
      success: false,
      error: {
        code: 'LOGIN_RATE_LIMITED',
        message: 'Too many login attempts. Please try again later.',
        statusCode: 429,
        after: context.after,
        limit: context.max
      }
    };
  }
};

// Rate limit para criação de recursos
export const createResourceRateLimit = {
  max: 100, // 100 criações por hora
  timeWindow: '1 hour',
  keyGenerator: (request) => {
    // Use empresa_id do usuário autenticado
    const empresaId = request.user?.empresa_id || request.empresaId;
    if (empresaId) {
      return `create:empresa:${empresaId}`;
    }
    return `create:ip:${request.ip}`;
  }
};

// Rate limit para API keys testing
export const apiKeyTestRateLimit = {
  max: 20, // 20 testes por hora
  timeWindow: '1 hour',
  keyGenerator: (request) => {
    const empresaId = request.user?.empresa_id || request.empresaId;
    return `apitest:${empresaId || request.ip}`;
  }
};

// Função para configurar rate limiting em rotas específicas
export function setupRouteRateLimits(fastify) {
  // Chat endpoint
  fastify.register(rateLimit, {
    ...chatRateLimit,
    routeOptions: {
      config: {
        rateLimit: chatRateLimit
      }
    }
  });

  // Login endpoint
  fastify.addHook('onRoute', (routeOptions) => {
    if (routeOptions.url === '/api/auth/login' && routeOptions.method === 'POST') {
      routeOptions.config = routeOptions.config || {};
      routeOptions.config.rateLimit = loginRateLimit;
    }
  });

  // Create resource endpoints
  fastify.addHook('onRoute', (routeOptions) => {
    const createEndpoints = [
      '/api/agentes',
      '/api/tools',
      '/api/usuarios',
      '/api/api-keys',
      '/api/whatsapp-numbers'
    ];

    if (createEndpoints.includes(routeOptions.url) && routeOptions.method === 'POST') {
      routeOptions.config = routeOptions.config || {};
      routeOptions.config.rateLimit = createResourceRateLimit;
    }
  });

  // API key test endpoint
  fastify.addHook('onRoute', (routeOptions) => {
    if (routeOptions.url?.includes('/testar') && routeOptions.method === 'POST') {
      routeOptions.config = routeOptions.config || {};
      routeOptions.config.rateLimit = apiKeyTestRateLimit;
    }
  });
}

export default {
  globalRateLimit,
  chatRateLimit,
  loginRateLimit,
  createResourceRateLimit,
  apiKeyTestRateLimit,
  setupRouteRateLimits
};