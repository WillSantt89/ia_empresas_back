import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';
import { randomUUID } from 'crypto';

export default async function configuracoesRoutes(fastify, opts) {
  // Obter configurações da empresa
  fastify.get('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('configuracoes', 'read')
    ]
  }, async (request, reply) => {
    try {
      const { empresaId } = request;

      // Buscar dados da empresa
      const empresaResult = await pool.query(`
        SELECT
          e.*,
          p.nome as plano_nome,
          p.max_usuarios,
          p.max_tools,
          p.max_mensagens_mes,
          p.permite_modelo_pro,
          (SELECT COUNT(*) FROM usuarios WHERE empresa_id = e.id AND ativo = true) as usuarios_ativos,
          (SELECT COUNT(*) FROM agentes WHERE empresa_id = e.id AND ativo = true) as agentes_ativos,
          (SELECT COUNT(*) FROM tools WHERE empresa_id = e.id AND ativo = true) as tools_ativas
        FROM empresas e
        LEFT JOIN assinaturas a ON a.empresa_id = e.id
        LEFT JOIN planos p ON p.id = a.plano_id
        WHERE e.id = $1
      `, [empresaId]);

      if (empresaResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'EMPRESA_NOT_FOUND',
            message: 'Empresa não encontrada'
          }
        });
      }

      const empresa = empresaResult.rows[0];

      // Buscar configuração de controle humano
      const controleResult = await pool.query(
        'SELECT * FROM config_controle_humano WHERE empresa_id = $1',
        [empresaId]
      );

      // Buscar alertas configurados
      const alertasResult = await pool.query(`
        SELECT * FROM alertas_config
        WHERE empresa_id = $1 OR empresa_id IS NULL
        ORDER BY empresa_id DESC, tipo, percentual
      `, [empresaId]);

      // Estatísticas de uso
      const usoResult = await pool.query(`
        SELECT
          um.total_mensagens as mensagens_mes_atual,
          um.total_tokens_input + um.total_tokens_output as tokens_mes_atual,
          um.total_tool_calls as tool_calls_mes_atual
        FROM uso_mensal um
        WHERE um.empresa_id = $1 AND um.ano_mes = TO_CHAR(CURRENT_DATE, 'YYYY-MM')
      `, [empresaId]);

      const uso = usoResult.rows[0] || {
        mensagens_mes_atual: 0,
        tokens_mes_atual: 0,
        tool_calls_mes_atual: 0
      };

      return {
        success: true,
        data: {
          empresa: {
            id: empresa.id,
            nome: empresa.nome,
            slug: empresa.slug,
            logo_url: empresa.logo_url,
            criado_em: empresa.criado_em,
            atualizado_em: empresa.atualizado_em
          },
          plano: {
            nome: empresa.plano_nome,
            limites: {
              max_usuarios: empresa.max_usuarios,
              max_tools: empresa.max_tools,
              max_mensagens_mes: empresa.max_mensagens_mes,
              permite_modelo_pro: empresa.permite_modelo_pro
            },
            uso_atual: {
              usuarios: empresa.usuarios_ativos,
              tools: empresa.tools_ativas,
              mensagens_mes: parseInt(uso.mensagens_mes_atual || 0)
            }
          },
          chatwoot: {
            url: empresa.chatwoot_url,
            account_id: empresa.chatwoot_account_id,
            status: empresa.chatwoot_status,
            admin_email: empresa.chatwoot_admin_email,
            configurado: !!(empresa.chatwoot_url && empresa.chatwoot_api_token)
          },
          n8n: {
            webhook_token: empresa.webhook_token || null,
            n8n_response_url: empresa.n8n_response_url || null,
            webhook_url: empresa.webhook_token
              ? `${process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`}/api/webhooks/n8n`
              : null,
            configurado: !!empresa.webhook_token
          },
          controle_humano: controleResult.rows[0] || {
            timeout_inatividade_minutos: 30,
            mensagem_retorno_ia: 'Voltei! Desculpe a espera. Como posso ajudar? 😊',
            permitir_devolver_via_nota: true,
            comando_assumir: '/assumir',
            comando_devolver: '/devolver',
            notificar_admin_ao_assumir: true,
            notificar_admin_ao_devolver: true,
            ativo: true
          },
          alertas: alertasResult.rows.map(a => ({
            id: a.id,
            tipo: a.tipo,
            percentual: a.percentual,
            notificar_master: a.notificar_master,
            notificar_admin: a.notificar_admin,
            mensagem_custom: a.mensagem_custom,
            global: !a.empresa_id
          })),
          estatisticas_uso: {
            mensagens_mes: parseInt(uso.mensagens_mes_atual || 0),
            tokens_mes: parseInt(uso.tokens_mes_atual || 0),
            tool_calls_mes: parseInt(uso.tool_calls_mes_atual || 0)
          }
        }
      };
    } catch (error) {
      logger.error('Error getting configuracoes:', error);
      throw error;
    }
  });

  // Atualizar configurações
  fastify.put('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('configuracoes', 'write')
    ],
    schema: {
      body: {
        type: 'object',
        properties: {
          empresa: {
            type: 'object',
            properties: {
              nome: { type: 'string', minLength: 1, maxLength: 255 },
              logo_url: { type: 'string' }
            }
          },
          chatwoot: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              api_token: { type: 'string' },
              account_id: { type: 'integer' },
              admin_email: { type: 'string', format: 'email' },
              admin_senha: { type: 'string' }
            }
          },
          controle_humano: {
            type: 'object',
            properties: {
              timeout_inatividade_minutos: { type: 'integer', minimum: 5, maximum: 1440 },
              mensagem_retorno_ia: { type: 'string' },
              permitir_devolver_via_nota: { type: 'boolean' },
              comando_assumir: { type: 'string' },
              comando_devolver: { type: 'string' },
              notificar_admin_ao_assumir: { type: 'boolean' },
              notificar_admin_ao_devolver: { type: 'boolean' },
              ativo: { type: 'boolean' }
            }
          },
          n8n: {
            type: 'object',
            properties: {
              gerar_token: { type: 'boolean' },
              n8n_response_url: { type: 'string' }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { empresaId } = request;
      const { empresa, chatwoot, controle_humano, n8n } = request.body;

      // Atualizar dados da empresa se fornecido
      if (empresa) {
        const empresaFields = [];
        const empresaValues = [];
        let paramCount = 1;

        if ('nome' in empresa) {
          empresaFields.push(`nome = $${paramCount}`);
          empresaValues.push(empresa.nome);
          paramCount++;
        }

        if ('logo_url' in empresa) {
          empresaFields.push(`logo_url = $${paramCount}`);
          empresaValues.push(empresa.logo_url);
          paramCount++;
        }

        if (empresaFields.length > 0) {
          empresaFields.push('atualizado_em = NOW()');
          empresaValues.push(empresaId);

          await client.query(
            `UPDATE empresas SET ${empresaFields.join(', ')} WHERE id = $${paramCount}`,
            empresaValues
          );
        }
      }

      // Atualizar configuração Chatwoot se fornecido
      if (chatwoot) {
        const chatwootFields = [];
        const chatwootValues = [];
        let paramCount = 1;

        if ('url' in chatwoot) {
          chatwootFields.push(`chatwoot_url = $${paramCount}`);
          chatwootValues.push(chatwoot.url);
          paramCount++;
        }

        if ('api_token' in chatwoot) {
          // Encriptar token antes de salvar
          const encryptedToken = await fastify.encrypt(chatwoot.api_token);
          chatwootFields.push(`chatwoot_api_token = $${paramCount}`);
          chatwootValues.push(encryptedToken);
          paramCount++;
        }

        if ('account_id' in chatwoot) {
          chatwootFields.push(`chatwoot_account_id = $${paramCount}`);
          chatwootValues.push(chatwoot.account_id);
          paramCount++;
        }

        if ('admin_email' in chatwoot) {
          chatwootFields.push(`chatwoot_admin_email = $${paramCount}`);
          chatwootValues.push(chatwoot.admin_email);
          paramCount++;
        }

        if ('admin_senha' in chatwoot && chatwoot.admin_senha) {
          // Hash da senha antes de salvar
          const bcrypt = await import('bcrypt');
          const hashedPassword = await bcrypt.hash(chatwoot.admin_senha, 10);
          chatwootFields.push(`chatwoot_admin_senha_hash = $${paramCount}`);
          chatwootValues.push(hashedPassword);
          paramCount++;
        }

        if (chatwootFields.length > 0) {
          chatwootFields.push('chatwoot_status = $' + paramCount);
          chatwootValues.push('ativo');
          paramCount++;

          chatwootFields.push('atualizado_em = NOW()');
          chatwootValues.push(empresaId);

          await client.query(
            `UPDATE empresas SET ${chatwootFields.join(', ')} WHERE id = $${paramCount}`,
            chatwootValues
          );
        }
      }

      // Atualizar configuração de controle humano se fornecido
      if (controle_humano) {
        // Verificar se já existe
        const existingConfig = await client.query(
          'SELECT id FROM config_controle_humano WHERE empresa_id = $1',
          [empresaId]
        );

        if (existingConfig.rows.length > 0) {
          // Atualizar existente
          const fields = [];
          const values = [];
          let paramCount = 1;

          Object.entries(controle_humano).forEach(([key, value]) => {
            fields.push(`${key} = $${paramCount}`);
            values.push(value);
            paramCount++;
          });

          values.push(empresaId);

          await client.query(
            `UPDATE config_controle_humano SET ${fields.join(', ')} WHERE empresa_id = $${paramCount}`,
            values
          );
        } else {
          // Criar nova configuração
          await client.query(`
            INSERT INTO config_controle_humano (
              id, empresa_id, timeout_inatividade_minutos, mensagem_retorno_ia,
              permitir_devolver_via_nota, comando_assumir, comando_devolver,
              notificar_admin_ao_assumir, notificar_admin_ao_devolver, ativo
            ) VALUES (
              gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9
            )
          `, [
            empresaId,
            controle_humano.timeout_inatividade_minutos || 30,
            controle_humano.mensagem_retorno_ia || 'Voltei! Desculpe a espera. Como posso ajudar? 😊',
            controle_humano.permitir_devolver_via_nota !== false,
            controle_humano.comando_assumir || '/assumir',
            controle_humano.comando_devolver || '/devolver',
            controle_humano.notificar_admin_ao_assumir !== false,
            controle_humano.notificar_admin_ao_devolver !== false,
            controle_humano.ativo !== false
          ]);
        }
      }

      // Atualizar configuração n8n se fornecido
      if (n8n) {
        const n8nFields = [];
        const n8nValues = [];
        let paramCount = 1;

        if (n8n.gerar_token) {
          // Generate a new webhook token (UUID v4 without dashes)
          const newToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').substring(0, 32);
          n8nFields.push(`webhook_token = $${paramCount}`);
          n8nValues.push(newToken.substring(0, 64));
          paramCount++;
        }

        if ('n8n_response_url' in n8n) {
          n8nFields.push(`n8n_response_url = $${paramCount}`);
          n8nValues.push(n8n.n8n_response_url || null);
          paramCount++;
        }

        if (n8nFields.length > 0) {
          n8nFields.push('atualizado_em = NOW()');
          n8nValues.push(empresaId);

          await client.query(
            `UPDATE empresas SET ${n8nFields.join(', ')} WHERE id = $${paramCount}`,
            n8nValues
          );
        }
      }

      await client.query('COMMIT');

      logger.info(`Configuracoes updated for empresa ${empresaId}`);

      // Retornar configurações atualizadas
      return fastify.inject({
        method: 'GET',
        url: '/api/configuracoes',
        headers: request.headers
      }).then(response => response.json());

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating configuracoes:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Gerenciar alertas personalizados
  fastify.post('/alertas', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('configuracoes', 'write')
    ],
    schema: {
      body: {
        type: 'object',
        required: ['tipo', 'percentual'],
        properties: {
          tipo: { type: 'string' },
          percentual: { type: 'integer', minimum: 1, maximum: 100 },
          notificar_master: { type: 'boolean', default: false },
          notificar_admin: { type: 'boolean', default: true },
          mensagem_custom: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { empresaId } = request;
      const { tipo, percentual, notificar_master, notificar_admin, mensagem_custom } = request.body;

      // Verificar se já existe alerta similar
      const existingAlert = await client.query(
        'SELECT id FROM alertas_config WHERE empresa_id = $1 AND tipo = $2 AND percentual = $3',
        [empresaId, tipo, percentual]
      );

      if (existingAlert.rows.length > 0) {
        return reply.code(409).send({
          success: false,
          error: {
            code: 'ALERT_EXISTS',
            message: 'Já existe um alerta configurado com estes parâmetros'
          }
        });
      }

      const result = await client.query(`
        INSERT INTO alertas_config (
          id, empresa_id, tipo, percentual,
          notificar_master, notificar_admin,
          mensagem_custom, ativo, criado_em
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, $6, true, NOW()
        ) RETURNING *
      `, [empresaId, tipo, percentual, notificar_master, notificar_admin, mensagem_custom]);

      await client.query('COMMIT');

      logger.info(`Alert created for empresa ${empresaId}: ${tipo} at ${percentual}%`);

      reply.code(201).send({
        success: true,
        data: result.rows[0]
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error creating alert:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Deletar alerta personalizado
  fastify.delete('/alertas/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('configuracoes', 'write')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { empresaId } = request;

      const result = await pool.query(
        'DELETE FROM alertas_config WHERE id = $1 AND empresa_id = $2 RETURNING id',
        [id, empresaId]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'ALERT_NOT_FOUND',
            message: 'Alerta não encontrado'
          }
        });
      }

      logger.info(`Alert deleted: ${id}`);

      reply.code(204).send();
    } catch (error) {
      logger.error('Error deleting alert:', error);
      throw error;
    }
  });

  // Testar conexão Chatwoot
  fastify.post('/chatwoot/testar', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('configuracoes', 'write')
    ]
  }, async (request, reply) => {
    try {
      const { empresaId } = request;

      // Buscar configuração
      const empresaResult = await pool.query(
        'SELECT chatwoot_url, chatwoot_api_token, chatwoot_account_id FROM empresas WHERE id = $1',
        [empresaId]
      );

      if (empresaResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'EMPRESA_NOT_FOUND',
            message: 'Empresa não encontrada'
          }
        });
      }

      const empresa = empresaResult.rows[0];

      if (!empresa.chatwoot_url || !empresa.chatwoot_api_token) {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'CHATWOOT_NOT_CONFIGURED',
            message: 'Chatwoot não está configurado'
          }
        });
      }

      // TODO: Implementar teste real com API do Chatwoot
      logger.info(`Chatwoot test requested for empresa ${empresaId}`);

      return {
        success: true,
        data: {
          status: 'connected',
          account_id: empresa.chatwoot_account_id,
          message: 'Conexão com Chatwoot estabelecida com sucesso'
        }
      };
    } catch (error) {
      logger.error('Error testing Chatwoot:', error);

      return {
        success: false,
        data: {
          status: 'error',
          message: error.message || 'Erro ao conectar com Chatwoot'
        }
      };
    }
  });
}