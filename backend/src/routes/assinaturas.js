import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';

export default async function assinaturasRoutes(fastify, opts) {
  // Obter assinatura de uma empresa
  fastify.get('/:empresaId', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('assinaturas', 'read')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['empresaId'],
        properties: {
          empresaId: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request.params;

      // Buscar assinatura com plano
      const assinaturaResult = await pool.query(`
        SELECT
          a.*,
          p.nome as plano_nome,
          p.descricao as plano_descricao,
          p.preco_base_mensal,
          p.max_usuarios,
          p.max_tools,
          p.max_mensagens_mes,
          p.permite_modelo_pro,
          e.nome as empresa_nome,
          e.slug as empresa_slug
        FROM assinaturas a
        JOIN planos p ON p.id = a.plano_id
        JOIN empresas e ON e.id = a.empresa_id
        WHERE a.empresa_id = $1
      `, [empresaId]);

      if (assinaturaResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'ASSINATURA_NOT_FOUND',
            message: 'Assinatura não encontrada para esta empresa'
          }
        });
      }

      const assinatura = assinaturaResult.rows[0];

      // Buscar itens da assinatura
      const itensResult = await pool.query(`
        SELECT
          ai.*,
          ic.slug as item_slug,
          ic.nome as item_nome,
          ic.tipo_cobranca,
          fi.nome as faixa_nome,
          fi.limite_diario as faixa_limite_diario
        FROM assinatura_itens ai
        JOIN itens_cobraveis ic ON ic.id = ai.item_cobravel_id
        LEFT JOIN faixas_item fi ON fi.id = ai.faixa_id
        WHERE ai.assinatura_id = $1 AND ai.ativo = true
        ORDER BY ic.nome
      `, [assinatura.id]);

      assinatura.itens = itensResult.rows;

      // Calcular resumo de cobrança
      const resumo = {
        valor_plano_base: parseFloat(assinatura.preco_base_mensal),
        valor_itens: 0,
        valor_total: 0,
        detalhes: []
      };

      // Adicionar plano base
      resumo.detalhes.push({
        tipo: 'plano_base',
        descricao: `Plano ${assinatura.plano_nome}`,
        quantidade: 1,
        valor_unitario: parseFloat(assinatura.preco_base_mensal),
        valor_total: parseFloat(assinatura.preco_base_mensal)
      });

      // Adicionar itens
      for (const item of assinatura.itens) {
        const valorItem = parseFloat(item.preco_unitario) * item.quantidade;
        resumo.valor_itens += valorItem;

        resumo.detalhes.push({
          tipo: 'item_adicional',
          descricao: item.item_nome,
          faixa: item.faixa_nome,
          quantidade: item.quantidade,
          valor_unitario: parseFloat(item.preco_unitario),
          valor_total: valorItem
        });
      }

      resumo.valor_total = resumo.valor_plano_base + resumo.valor_itens;
      assinatura.resumo_cobranca = resumo;

      // Buscar uso atual
      const usoResult = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM agentes WHERE empresa_id = $1 AND ativo = true) as agentes_ativos,
          (SELECT COUNT(*) FROM whatsapp_numbers WHERE empresa_id = $1 AND ativo = true) as numeros_ativos,
          (SELECT COUNT(*) FROM usuarios WHERE empresa_id = $1 AND ativo = true) as usuarios_ativos,
          (SELECT total_mensagens FROM uso_mensal WHERE empresa_id = $1 AND ano_mes = TO_CHAR(CURRENT_DATE, 'YYYY-MM')) as mensagens_mes_atual
      `, [empresaId]);

      assinatura.uso_atual = usoResult.rows[0];

      return {
        success: true,
        data: assinatura
      };
    } catch (error) {
      logger.error('Error getting assinatura:', error);
      throw error;
    }
  });

  // Atualizar assinatura (adicionar/remover itens, mudar plano)
  fastify.put('/:empresaId', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('assinaturas', 'write')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['empresaId'],
        properties: {
          empresaId: { type: 'string', format: 'uuid' }
        }
      },
      body: {
        type: 'object',
        properties: {
          plano_id: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['ativa', 'suspensa', 'cancelada'] },
          itens: {
            type: 'array',
            items: {
              type: 'object',
              required: ['item_cobravel_id', 'quantidade'],
              properties: {
                item_cobravel_id: { type: 'string', format: 'uuid' },
                faixa_id: { type: 'string', format: 'uuid' },
                quantidade: { type: 'integer', minimum: 1 }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { empresaId } = request.params;
      const { plano_id, status, itens } = request.body;

      // Verificar se assinatura existe — se não, criar (upsert)
      const assinaturaResult = await client.query(
        'SELECT * FROM assinaturas WHERE empresa_id = $1',
        [empresaId]
      );

      let assinatura;

      if (assinaturaResult.rows.length === 0) {
        // Upsert: criar assinatura se não existe
        if (!plano_id) {
          await client.query('ROLLBACK');
          return reply.code(400).send({
            success: false,
            error: {
              code: 'PLANO_REQUIRED',
              message: 'plano_id é obrigatório para criar assinatura'
            }
          });
        }

        // Verificar se plano existe
        const planoExists = await client.query(
          'SELECT * FROM planos WHERE id = $1 AND ativo = true',
          [plano_id]
        );

        if (planoExists.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(400).send({
            success: false,
            error: {
              code: 'PLANO_NOT_FOUND',
              message: 'Plano não encontrado ou inativo'
            }
          });
        }

        const newResult = await client.query(
          `INSERT INTO assinaturas (empresa_id, plano_id, status, data_inicio)
           VALUES ($1, $2, 'ativa', CURRENT_DATE) RETURNING *`,
          [empresaId, plano_id]
        );
        assinatura = newResult.rows[0];

        // Atualizar plano_id na empresa
        await client.query(
          'UPDATE empresas SET plano_id = $1, atualizado_em = NOW() WHERE id = $2',
          [plano_id, empresaId]
        );

        // Registrar histórico (usar 'mudou_plano' — CHECK constraint não tem 'criou_assinatura')
        await client.query(`
          INSERT INTO assinatura_historico (
            id, assinatura_id, empresa_id, acao,
            executado_por, criado_em
          ) VALUES (
            gen_random_uuid(), $1, $2, 'mudou_plano', $3, NOW()
          )
        `, [assinatura.id, empresaId, request.user.id]);
      } else {
        assinatura = assinaturaResult.rows[0];
      }
      const userId = request.user.id;

      // Atualizar plano se fornecido
      if (plano_id && plano_id !== assinatura.plano_id) {
        // Verificar se plano existe
        const planoExists = await client.query(
          'SELECT * FROM planos WHERE id = $1 AND ativo = true',
          [plano_id]
        );

        if (planoExists.rows.length === 0) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'PLANO_NOT_FOUND',
              message: 'Plano não encontrado ou inativo'
            }
          });
        }

        await client.query(
          'UPDATE assinaturas SET plano_id = $1, atualizado_em = NOW() WHERE id = $2',
          [plano_id, assinatura.id]
        );

        // Registrar histórico
        await client.query(`
          INSERT INTO assinatura_historico (
            id, assinatura_id, empresa_id, acao,
            executado_por, criado_em
          ) VALUES (
            gen_random_uuid(), $1, $2, 'mudou_plano', $3, NOW()
          )
        `, [assinatura.id, empresaId, userId]);
      }

      // Atualizar status se fornecido
      if (status && status !== assinatura.status) {
        await client.query(
          'UPDATE assinaturas SET status = $1, atualizado_em = NOW() WHERE id = $2',
          [status, assinatura.id]
        );
      }

      // Atualizar itens se fornecido
      if (itens && Array.isArray(itens)) {
        // Buscar itens atuais
        const itensAtuais = await client.query(
          'SELECT * FROM assinatura_itens WHERE assinatura_id = $1 AND ativo = true',
          [assinatura.id]
        );

        // Processar cada item novo/atualizado
        for (const itemNovo of itens) {
          // Verificar se item cobrável existe
          const itemCobravel = await client.query(
            'SELECT * FROM itens_cobraveis WHERE id = $1 AND ativo = true',
            [itemNovo.item_cobravel_id]
          );

          if (itemCobravel.rows.length === 0) {
            throw new Error(`Item cobrável ${itemNovo.item_cobravel_id} não encontrado`);
          }

          const itemCobravelData = itemCobravel.rows[0];

          // Determinar preço
          let precoUnitario = 0;
          let limiteDialio = null;

          if (itemCobravelData.tipo_cobranca === 'preco_fixo') {
            precoUnitario = itemCobravelData.preco_fixo;
          } else {
            // Verificar faixa
            if (!itemNovo.faixa_id) {
              throw new Error(`Faixa é obrigatória para item ${itemCobravelData.nome}`);
            }

            const faixa = await client.query(
              'SELECT * FROM faixas_item WHERE id = $1 AND item_cobravel_id = $2 AND ativo = true',
              [itemNovo.faixa_id, itemNovo.item_cobravel_id]
            );

            if (faixa.rows.length === 0) {
              throw new Error(`Faixa ${itemNovo.faixa_id} não encontrada para o item`);
            }

            precoUnitario = faixa.rows[0].preco_mensal;
            limiteDialio = faixa.rows[0].limite_diario;
          }

          // Normalizar faixa_id: undefined → null (node-postgres não aceita undefined)
          const faixaId = itemNovo.faixa_id || null;

          // Verificar se já existe
          const itemExistente = itensAtuais.rows.find(
            i => i.item_cobravel_id === itemNovo.item_cobravel_id
          );

          if (itemExistente) {
            // Atualizar existente
            if (itemExistente.quantidade !== itemNovo.quantidade ||
                (itemExistente.faixa_id || null) !== faixaId) {

              await client.query(`
                UPDATE assinatura_itens
                SET
                  faixa_id = $1,
                  quantidade = $2,
                  preco_unitario = $3,
                  limite_diario = $4
                WHERE id = $5
              `, [faixaId, itemNovo.quantidade, precoUnitario, limiteDialio, itemExistente.id]);

              // Registrar histórico
              await client.query(`
                INSERT INTO assinatura_historico (
                  id, assinatura_id, empresa_id, acao,
                  item_cobravel_id, quantidade_anterior, quantidade_nova,
                  preco_anterior, preco_novo, executado_por, criado_em
                ) VALUES (
                  gen_random_uuid(), $1, $2,
                  $3, $4,
                  $5, $6, $7,
                  $8, $9, NOW()
                )
              `, [
                assinatura.id, empresaId,
                (itemExistente.faixa_id || null) !== faixaId ? 'mudou_faixa' : 'alterou_quantidade',
                itemNovo.item_cobravel_id,
                itemExistente.quantidade, itemNovo.quantidade,
                itemExistente.preco_unitario, precoUnitario,
                userId
              ]);
            }
          } else {
            // Adicionar novo
            await client.query(`
              INSERT INTO assinatura_itens (
                id, assinatura_id, empresa_id, item_cobravel_id,
                faixa_id, quantidade, preco_unitario, limite_diario,
                ativo, adicionado_em
              ) VALUES (
                gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, true, NOW()
              )
            `, [
              assinatura.id, empresaId, itemNovo.item_cobravel_id,
              faixaId, itemNovo.quantidade, precoUnitario, limiteDialio
            ]);

            // Registrar histórico
            await client.query(`
              INSERT INTO assinatura_historico (
                id, assinatura_id, empresa_id, acao,
                item_cobravel_id, quantidade_nova, preco_novo,
                executado_por, criado_em
              ) VALUES (
                gen_random_uuid(), $1, $2, 'adicionou_item',
                $3, $4, $5, $6, NOW()
              )
            `, [assinatura.id, empresaId, itemNovo.item_cobravel_id, itemNovo.quantidade, precoUnitario, userId]);
          }
        }

        // Desativar itens removidos
        const itensParaManter = itens.map(i => i.item_cobravel_id);
        for (const itemAtual of itensAtuais.rows) {
          if (!itensParaManter.includes(itemAtual.item_cobravel_id)) {
            await client.query(
              'UPDATE assinatura_itens SET ativo = false, removido_em = NOW() WHERE id = $1',
              [itemAtual.id]
            );

            // Registrar histórico
            await client.query(`
              INSERT INTO assinatura_historico (
                id, assinatura_id, empresa_id, acao,
                item_cobravel_id, quantidade_anterior, preco_anterior,
                executado_por, criado_em
              ) VALUES (
                gen_random_uuid(), $1, $2, 'removeu_item',
                $3, $4, $5, $6, NOW()
              )
            `, [assinatura.id, empresaId, itemAtual.item_cobravel_id, itemAtual.quantidade, itemAtual.preco_unitario, userId]);
          }
        }
      }

      await client.query('COMMIT');

      // Buscar assinatura atualizada
      return fastify.inject({
        method: 'GET',
        url: `/api/assinaturas/${empresaId}`,
        headers: request.headers
      }).then(response => response.json());

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating assinatura:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Obter histórico de mudanças
  fastify.get('/:empresaId/historico', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('assinaturas', 'read')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['empresaId'],
        properties: {
          empresaId: { type: 'string', format: 'uuid' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          per_page: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request.params;
      const { page, per_page } = request.query;
      const offset = (page - 1) * per_page;

      // Verificar se empresa existe
      const empresaExists = await pool.query(
        'SELECT id FROM empresas WHERE id = $1',
        [empresaId]
      );

      if (empresaExists.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'EMPRESA_NOT_FOUND',
            message: 'Empresa não encontrada'
          }
        });
      }

      // Buscar histórico
      const historicoResult = await pool.query(`
        SELECT
          ah.*,
          ic.nome as item_nome,
          u.nome as executado_por_nome
        FROM assinatura_historico ah
        LEFT JOIN itens_cobraveis ic ON ic.id = ah.item_cobravel_id
        LEFT JOIN usuarios u ON u.id = ah.executado_por
        WHERE ah.empresa_id = $1
        ORDER BY ah.criado_em DESC
        LIMIT $2 OFFSET $3
      `, [empresaId, per_page, offset]);

      // Contar total
      const totalResult = await pool.query(
        'SELECT COUNT(*) FROM assinatura_historico WHERE empresa_id = $1',
        [empresaId]
      );

      const total = parseInt(totalResult.rows[0].count);

      return {
        success: true,
        data: historicoResult.rows,
        total,
        page,
        per_page,
        total_pages: Math.ceil(total / per_page)
      };
    } catch (error) {
      logger.error('Error getting assinatura historico:', error);
      throw error;
    }
  });

  // Obter faturas
  fastify.get('/:empresaId/faturas', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('faturas', 'read')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['empresaId'],
        properties: {
          empresaId: { type: 'string', format: 'uuid' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pendente', 'paga', 'atrasada', 'cancelada'] },
          ano: { type: 'integer', minimum: 2024 },
          page: { type: 'integer', minimum: 1, default: 1 },
          per_page: { type: 'integer', minimum: 1, maximum: 100, default: 12 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request.params;
      const { status, ano, page, per_page } = request.query;
      const offset = (page - 1) * per_page;

      let query = `
        SELECT
          f.*,
          a.status as assinatura_status,
          p.nome as plano_nome
        FROM faturas f
        JOIN assinaturas a ON a.id = f.assinatura_id
        JOIN planos p ON p.id = a.plano_id
        WHERE f.empresa_id = $1
      `;

      const params = [empresaId];
      const conditions = [];

      if (status) {
        params.push(status);
        conditions.push(`f.status = $${params.length}`);
      }

      if (ano) {
        params.push(`${ano}-%`);
        conditions.push(`f.ano_mes LIKE $${params.length}`);
      }

      if (conditions.length > 0) {
        query += ` AND ${conditions.join(' AND ')}`;
      }

      query += ` ORDER BY f.ano_mes DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(per_page, offset);

      const result = await pool.query(query, params);

      // Contar total
      let countQuery = `
        SELECT COUNT(*) FROM faturas f
        WHERE f.empresa_id = $1
      `;

      const countParams = [empresaId];
      if (conditions.length > 0) {
        countQuery += ` AND ${conditions.join(' AND ')}`;
        countParams.push(...params.slice(1, -2));
      }

      const totalResult = await pool.query(countQuery, countParams);
      const total = parseInt(totalResult.rows[0].count);

      return {
        success: true,
        data: result.rows,
        total,
        page,
        per_page,
        total_pages: Math.ceil(total / per_page)
      };
    } catch (error) {
      logger.error('Error getting faturas:', error);
      throw error;
    }
  });
}