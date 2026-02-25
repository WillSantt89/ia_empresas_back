import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { pool } from '../src/config/database.js';
import { logger } from '../src/config/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsDir = join(__dirname, '..', 'migrations');

async function rollbackMigration(steps = 1) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verificar se tabela _migrations existe
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = '_migrations'
      );
    `);

    if (!tableExists.rows[0].exists) {
      logger.error('No migrations table found. Run migrations first.');
      return;
    }

    // Buscar últimas migrações executadas
    const executedMigrations = await client.query(`
      SELECT filename
      FROM _migrations
      ORDER BY executed_at DESC
      LIMIT $1
    `, [steps]);

    if (executedMigrations.rows.length === 0) {
      logger.info('No migrations to rollback');
      return;
    }

    logger.info(`Rolling back ${executedMigrations.rows.length} migration(s)...`);

    // Executar rollback em ordem reversa
    for (const migration of executedMigrations.rows) {
      const filename = migration.filename;
      const filepath = join(migrationsDir, filename);

      try {
        const content = await readFile(filepath, 'utf8');

        // Extrair seção DOWN do arquivo
        const downMatch = content.match(/-- DOWN\s*([\s\S]*?)(?:-- UP|$)/i);

        if (!downMatch || !downMatch[1].trim()) {
          logger.warn(`No DOWN section found in ${filename}, skipping rollback`);
          continue;
        }

        const downSql = downMatch[1].trim();

        logger.info(`Rolling back ${filename}...`);

        // Executar SQL de rollback
        await client.query(downSql);

        // Remover da tabela de migrações
        await client.query(`
          DELETE FROM _migrations
          WHERE filename = $1
        `, [filename]);

        logger.info(`✓ Rolled back ${filename}`);

      } catch (error) {
        logger.error(`Failed to rollback ${filename}:`, error);
        throw error;
      }
    }

    await client.query('COMMIT');
    logger.info('✅ Rollback completed successfully!');

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Rollback failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Parse argumentos da linha de comando
const args = process.argv.slice(2);
const steps = args[0] ? parseInt(args[0], 10) : 1;

if (isNaN(steps) || steps < 1) {
  logger.error('Invalid number of steps. Usage: npm run migrate:down [steps]');
  process.exit(1);
}

// Executar rollback
rollbackMigration(steps)
  .then(() => {
    logger.info(`Rollback of ${steps} migration(s) completed`);
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Rollback process failed:', error);
    process.exit(1);
  });