import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../src/config/database.js';
import { logger } from '../src/config/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigrations() {
  const client = await pool.connect();

  try {
    // Start transaction
    await client.query('BEGIN');

    // Create migrations table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Get all migration files
    const migrationsDir = join(__dirname, '../migrations');
    const files = await readdir(migrationsDir);
    const sqlFiles = files
      .filter(f => f.endsWith('.sql'))
      .sort(); // Sort to ensure order

    // Get executed migrations
    const { rows: executedMigrations } = await client.query(
      'SELECT name FROM _migrations'
    );
    const executed = new Set(executedMigrations.map(m => m.name));

    // Run pending migrations
    let migrationsRun = 0;
    for (const file of sqlFiles) {
      if (!executed.has(file)) {
        logger.info(`Running migration: ${file}`);

        const sqlPath = join(migrationsDir, file);
        const sql = await readFile(sqlPath, 'utf-8');

        // Extract UP migration
        const upMatch = sql.match(/-- UP([\s\S]*?)(?:-- DOWN|$)/i);
        if (!upMatch) {
          throw new Error(`No UP migration found in ${file}`);
        }

        const upSql = upMatch[1].trim();

        // Execute migration
        await client.query(upSql);

        // Record migration
        await client.query(
          'INSERT INTO _migrations (name) VALUES ($1)',
          [file]
        );

        logger.info(`✓ Migration ${file} completed`);
        migrationsRun++;
      }
    }

    // Commit transaction
    await client.query('COMMIT');

    if (migrationsRun === 0) {
      logger.info('All migrations are up to date');
    } else {
      logger.info(`Successfully ran ${migrationsRun} migration(s)`);
    }
  } catch (error) {
    // Rollback on error
    await client.query('ROLLBACK');
    logger.error('Migration failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run migrations
runMigrations()
  .then(() => {
    logger.info('Migration process completed');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Migration process failed:', error);
    process.exit(1);
  });