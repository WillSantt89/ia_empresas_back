console.log('🔍 Debug Server Starting...');
console.log('Environment:', process.env.NODE_ENV);
console.log('Port:', process.env.PORT || 3000);

// Test environment variables
const requiredEnvs = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'WEBHOOK_API_KEY'
];

console.log('\n📋 Environment Variables Check:');
let missingEnvs = 0;
for (const env of requiredEnvs) {
  if (process.env[env]) {
    console.log(`✅ ${env}: ${process.env[env].substring(0, 20)}...`);
  } else {
    console.log(`❌ ${env}: MISSING`);
    missingEnvs++;
  }
}

if (missingEnvs > 0) {
  console.log(`\n❌ ${missingEnvs} environment variables are missing!`);
}

// Simple HTTP server for testing
import http from 'http';

const server = http.createServer((req, res) => {
  console.log(`📥 ${req.method} ${req.url}`);

  // Enable CORS for all origins
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      time: new Date().toISOString(),
      env: missingEnvs === 0 ? 'configured' : 'missing_vars'
    }));
  } else if (req.url === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      console.log('Login attempt:', body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: {
          token: 'debug-jwt-token',
          user: {
            id: '1',
            email: 'admin@plataforma.com',
            nome: 'Debug Admin',
            role: 'master'
          }
        }
      }));
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`\n✅ Debug server running on port ${port}`);
  console.log(`📍 Health check: http://localhost:${port}/health`);
});