import chatwootWebhookRoutes from './chatwoot.js';

/**
 * Webhook Routes Index
 * Registers all webhook endpoints
 */

const webhookRoutes = async (fastify) => {
  // Register Chatwoot webhooks
  await fastify.register(chatwootWebhookRoutes, { prefix: '/chatwoot' });

  // Future webhook endpoints can be added here
  // await fastify.register(otherWebhookRoutes, { prefix: '/other' });
};

export default webhookRoutes;