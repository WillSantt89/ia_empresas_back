const http = require('http');

console.log('🚀 Simple Debug Server Starting...');
console.log('PORT:', process.env.PORT || 3001);
console.log('NODE_ENV:', process.env.NODE_ENV);

// Mock data
const mockUser = {
  id: '1',
  email: 'admin@plataforma.com',
  nome: 'Admin Debug',
  role: 'master',
  empresa_id: '1',
  permissions: ['all']
};

const mockAnalyticsOverview = {
  totalEmpresas: 10,
  totalAgentes: 25,
  totalConversas: 1500,
  totalMensagens: 45000,
  growth: {
    empresas: 15.5,
    agentes: 22.3,
    conversas: 35.2,
    mensagens: 42.1
  }
};

const mockAnalyticsUsage = {
  periodo: '30d',
  usage: [
    { date: '2024-01-01', mensagens: 1200, conversas: 45 },
    { date: '2024-01-02', mensagens: 1350, conversas: 52 },
    { date: '2024-01-03', mensagens: 1100, conversas: 41 },
  ],
  topAgentes: [
    { id: '1', nome: 'Vendas Bot', mensagens: 5200 },
    { id: '2', nome: 'Suporte Bot', mensagens: 4800 },
  ]
};

const server = http.createServer((req, res) => {
  console.log(`📥 ${new Date().toISOString()} ${req.method} ${req.url}`);

  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Helper function to send JSON response
  const sendJson = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // Routes
  if (req.url === '/health') {
    sendJson(200, {
      status: 'ok',
      server: 'simple-debug',
      time: new Date().toISOString(),
      port: process.env.PORT || 3001
    });
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Backend API is running on port ' + (process.env.PORT || 3001));
  } else if (req.url === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      console.log('Login attempt body:', body);
      sendJson(200, {
        success: true,
        data: {
          token: 'debug-token-123',
          user: mockUser
        }
      });
    });
  } else if (req.url === '/api/auth/me') {
    // Check for Authorization header (mock validation)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      sendJson(401, { error: 'Unauthorized' });
      return;
    }
    sendJson(200, {
      success: true,
      data: mockUser
    });
  } else if (req.url === '/analytics/overview') {
    sendJson(200, {
      success: true,
      data: mockAnalyticsOverview
    });
  } else if (req.url === '/analytics/usage') {
    sendJson(200, {
      success: true,
      data: mockAnalyticsUsage
    });
  } else if (req.url.startsWith('/api/')) {
    // Generic handler for other API routes
    sendJson(200, {
      success: true,
      data: [],
      message: `Mock response for ${req.url}`
    });
  } else {
    sendJson(404, { error: 'Not found', url: req.url });
  }
});

const port = parseInt(process.env.PORT || '3001');
server.listen(port, '0.0.0.0', () => {
  console.log(`✅ Server listening on 0.0.0.0:${port}`);
  console.log(`📍 Health check: http://localhost:${port}/health`);
  console.log('\n📌 Available endpoints:');
  console.log('  GET  /health');
  console.log('  POST /api/auth/login');
  console.log('  GET  /api/auth/me');
  console.log('  GET  /analytics/overview');
  console.log('  GET  /analytics/usage');
});

// Handle errors
server.on('error', (err) => {
  console.error('❌ Server error:', err);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});