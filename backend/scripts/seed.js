import bcrypt from 'bcrypt';
import { pool } from '../src/config/database.js';
import { logger } from '../src/config/logger.js';

async function seed() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    logger.info('Seeding database...');

    // 1. Insert default plans
    const { rows: plans } = await client.query(`
      INSERT INTO planos (nome, descricao, preco_base_mensal, max_usuarios, max_tools, max_mensagens_mes, permite_modelo_pro)
      VALUES
        ('Starter', 'Plano inicial para pequenas empresas', 197.00, 3, 5, 5000, false),
        ('Pro', 'Plano profissional com mais recursos', 497.00, 10, 15, 20000, true),
        ('Enterprise', 'Plano empresarial completo', 997.00, 50, 50, 100000, true)
      ON CONFLICT DO NOTHING
      RETURNING id, nome
    `);

    logger.info(`✓ Created ${plans.length} plans`);

    // 2. Insert chargeable items
    const { rows: items } = await client.query(`
      INSERT INTO itens_cobraveis (slug, nome, descricao, tipo_cobranca, preco_fixo)
      VALUES
        ('agente_ia', 'Agente de IA', 'Agente inteligente para atendimento', 'por_faixa', NULL),
        ('numero_whatsapp', 'Número WhatsApp', 'Número oficial do WhatsApp Business', 'preco_fixo', 50.00)
      ON CONFLICT (slug) DO NOTHING
      RETURNING id, slug
    `);

    logger.info(`✓ Created ${items.length} chargeable items`);

    // 3. Insert price ranges for AI agents
    const agenteItem = items.find(i => i.slug === 'agente_ia');
    if (agenteItem) {
      const { rows: ranges } = await client.query(`
        INSERT INTO faixas_item (item_cobravel_id, nome, limite_diario, preco_mensal)
        VALUES
          ($1, 'Starter', 500, 197.00),
          ($1, 'Profissional', 1500, 500.00),
          ($1, 'Enterprise', 5000, 997.00),
          ($1, 'Ilimitado', 999999, 1997.00)
        ON CONFLICT DO NOTHING
        RETURNING nome
      `, [agenteItem.id]);

      logger.info(`✓ Created ${ranges.length} price ranges for AI agents`);
    }

    // 4. Create master user
    const hashedPassword = await bcrypt.hash('admin123', 12);
    const { rows: users } = await client.query(`
      INSERT INTO usuarios (nome, email, senha_hash, role, ativo)
      VALUES
        ('William', 'admin@plataforma.com', $1, 'master', true)
      ON CONFLICT (email) DO NOTHING
      RETURNING email
    `, [hashedPassword]);

    logger.info(`✓ Created ${users.length} master user(s)`);

    // 5. Create global alert configurations
    const { rows: alerts } = await client.query(`
      INSERT INTO alertas_config (empresa_id, tipo, percentual, notificar_master, notificar_admin, mensagem_custom)
      VALUES
        (NULL, 'limite_diario_80', 80, true, true, 'Atenção: Agente atingiu 80% do limite diário'),
        (NULL, 'limite_diario_100', 100, true, true, 'Crítico: Agente atingiu 100% do limite diário')
      ON CONFLICT DO NOTHING
      RETURNING tipo
    `);

    logger.info(`✓ Created ${alerts.length} alert configurations`);

    await client.query('COMMIT');
    logger.info('✅ Database seeded successfully!');

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Seed failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run seed
seed()
  .then(() => {
    logger.info('Seed process completed');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Seed process failed:', error);
    process.exit(1);
  });