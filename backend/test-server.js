import Fastify from 'fastify';
import cors from '@fastify/cors';

const fastify = Fastify({ logger: true });

// Register CORS
await fastify.register(cors, {
  origin: true,
  credentials: true
});

// Test routes
fastify.get('/health', async () => {
  return { status: 'ok', time: new Date().toISOString() };
});

fastify.post('/api/auth/login', async (request) => {
  console.log('Login attempt:', request.body);

  // Mock response for testing
  if (request.body.email === 'admin@plataforma.com' && request.body.senha === 'admin123') {
    return {
      success: true,
      data: {
        token: 'test-jwt-token-123',
        user: {
          id: '1',
          email: 'admin@plataforma.com',
          nome: 'Admin',
          role: 'master'
        }
      }
    };
  }

  return {
    success: false,
    error: 'Invalid credentials'
  };
});

// Start server
const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Test server running on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();