import { config } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import pg from 'pg';
import Redis from 'ioredis';

console.log('🔍 Diagnóstico do Sistema - Backend IA Empresas\n');

// Check environment variables
console.log('1️⃣ Verificando variáveis de ambiente:');
const requiredEnvVars = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'WEBHOOK_API_KEY'
];

let envErrors = 0;
for (const varName of requiredEnvVars) {
  if (!process.env[varName]) {
    console.log(`❌ ${varName}: NÃO DEFINIDA`);
    envErrors++;
  } else {
    const value = process.env[varName];
    const masked = varName.includes('SECRET') || varName.includes('KEY')
      ? value.substring(0, 4) + '****'
      : value.substring(0, 20) + '...';
    console.log(`✅ ${varName}: ${masked}`);
  }
}

if (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length !== 32) {
  console.log('❌ ENCRYPTION_KEY deve ter exatamente 32 caracteres!');
  envErrors++;
}

console.log(`\nTotal de erros de variáveis: ${envErrors}\n`);

// Test database connection
console.log('2️⃣ Testando conexão com PostgreSQL:');
try {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000
  });

  const result = await pool.query('SELECT NOW()');
  console.log('✅ PostgreSQL conectado:', result.rows[0].now);

  // Check if tables exist
  const tablesResult = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);

  console.log(`\n📊 Tabelas encontradas: ${tablesResult.rows.length}`);
  if (tablesResult.rows.length === 0) {
    console.log('❌ Nenhuma tabela encontrada! Execute: npm run migrate');
  } else if (tablesResult.rows.length < 20) {
    console.log('⚠️  Poucas tabelas encontradas. Verifique se as migrações foram executadas corretamente.');
  }

  // Check for master user
  const userResult = await pool.query(`
    SELECT email, role FROM usuarios WHERE role = 'master' LIMIT 1
  `);

  if (userResult.rows.length === 0) {
    console.log('❌ Usuário master não encontrado! Execute: npm run seed');
  } else {
    console.log('✅ Usuário master encontrado:', userResult.rows[0].email);
  }

  await pool.end();
} catch (error) {
  console.log('❌ Erro ao conectar com PostgreSQL:', error.message);
}

// Test Redis connection
console.log('\n3️⃣ Testando conexão com Redis:');
try {
  const redis = new Redis(process.env.REDIS_URL, {
    connectTimeout: 5000,
    maxRetriesPerRequest: 1
  });

  await redis.ping();
  console.log('✅ Redis conectado');

  const info = await redis.info('server');
  const version = info.match(/redis_version:([^\r\n]+)/);
  if (version) {
    console.log(`   Versão: ${version[1]}`);
  }

  await redis.quit();
} catch (error) {
  console.log('❌ Erro ao conectar com Redis:', error.message);
}

// Check port availability
console.log('\n4️⃣ Verificando porta do servidor:');
const port = process.env.PORT || 3000;
console.log(`📍 Porta configurada: ${port}`);

// Summary
console.log('\n📋 RESUMO:');
console.log('===========');
if (envErrors > 0) {
  console.log(`❌ ${envErrors} variáveis de ambiente faltando`);
}
console.log('\n💡 Próximos passos:');
console.log('1. Configure todas as variáveis de ambiente');
console.log('2. Execute: npm run migrate');
console.log('3. Execute: npm run seed');
console.log('4. Inicie o servidor: npm start');

process.exit(0);