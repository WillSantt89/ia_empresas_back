import chatwootWebhookRoutes from './chatwoot.js';
import n8nWebhookRoutes from './n8n.js';

/**
 * Webhook Routes Index
 * Registers all webhook endpoints
 */

const webhookRoutes = async (fastify) => {
  // Register Chatwoot webhooks
  await fastify.register(chatwootWebhookRoutes, { prefix: '/chatwoot' });

  // Register n8n webhooks (gateway for WhatsApp via n8n)
  await fastify.register(n8nWebhookRoutes, { prefix: '/n8n' });
};

export default webhookRoutes;