import pg from 'pg';
import { config } from './env.js';
import { logger } from './logger.js';

const { Pool } = pg;

// Configure PostgreSQL connection pool
const poolConfig = {
  connectionString: config.DATABASE_URL,
  max: 50, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 5000, // Return an error after 5 seconds if connection could not be established
  allowExitOnIdle: true, // Allows the process to exit if the pool is idle
};

// Create the pool
export const pool = new Pool(poolConfig);

// Handle pool errors
pool.on('error', (err) => {
  logger.error('Unexpected database pool error:', err);
});

// Test database connection
export async function testConnection() {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    logger.info('Database connected successfully', {
      time: result.rows[0].now
    });
    return true;
  } catch (error) {
    logger.error('Database connection failed:', error);
    return false;
  }
}

// Helper function to execute queries
export async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;

    // Log slow queries
    if (duration > 100) {
      logger.warn('Slow query detected', {
        query: text,
        duration,
        rows: res.rowCount
      });
    }

    return res;
  } catch (error) {
    logger.error('Database query error', {
      query: text,
      error: error.message
    });
    throw error;
  }
}

// Transaction helper
export async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Multi-tenant query helper - always filters by empresa_id
export async function tenantQuery(text, params, empresaId) {
  if (!empresaId && !text.includes('empresas')) {
    throw new Error('empresa_id is required for tenant queries');
  }

  // Add empresa_id filter to WHERE clause if not already present
  let modifiedQuery = text;
  let modifiedParams = [...params];

  if (empresaId && !text.includes('empresa_id')) {
    if (text.toLowerCase().includes('where')) {
      modifiedQuery = text.replace(/where/i, `WHERE empresa_id = $${params.length + 1} AND`);
    } else {
      // Add WHERE clause if it doesn't exist
      const selectMatch = text.match(/from\s+(\w+)/i);
      if (selectMatch) {
        modifiedQuery = text.replace(
          new RegExp(`from\\s+${selectMatch[1]}`, 'i'),
          `FROM ${selectMatch[1]} WHERE empresa_id = $${params.length + 1}`
        );
      }
    }
    modifiedParams.push(empresaId);
  }

  return query(modifiedQuery, modifiedParams);
}

// Graceful shutdown
export async function closePool() {
  await pool.end();
  logger.info('Database pool closed');
}