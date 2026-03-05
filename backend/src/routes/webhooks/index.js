import n8nWebhookRoutes from './n8n.js';
import whatsappWebhookRoutes from './whatsapp.js';

/**
 * Webhook Routes Index
 * Registers all webhook endpoints
 */

const webhookRoutes = async (fastify) => {
  // Register n8n webhooks (gateway for WhatsApp via n8n)
  await fastify.register(n8nWebhookRoutes, { prefix: '/n8n' });

  // Register direct WhatsApp webhooks (Meta Cloud API)
  await fastify.register(whatsappWebhookRoutes, { prefix: '/whatsapp' });
};

export default webhookRoutes;