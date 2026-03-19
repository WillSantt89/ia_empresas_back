import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { redis, publisher } from '../config/redis.js';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { pool } from '../config/database.js';
import jwt from 'jsonwebtoken';

let io = null;
let emitter = null; // For worker processes (no HTTP server)

/**
 * Inicializa o Socket.IO no servidor Fastify
 */
export function initializeWebSocket(server) {
  // CORS: se origin='*', Socket.IO com credentials=true rejeita. Transformar em callback.
  const corsOrigin = config.CORS_ORIGIN === '*'
    ? (origin, callback) => callback(null, true)
    : config.CORS_ORIGIN.includes(',')
      ? config.CORS_ORIGIN.split(',').map(s => s.trim())
      : config.CORS_ORIGIN;

  io = new Server(server, {
    cors: {
      origin: corsOrigin,
      credentials: true,
      methods: ['GET', 'POST'],
    },
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    pingTimeout: 30000,
    pingInterval: 25000,
  });

  // Adapter Redis para suportar clustering
  try {
    const pubClient = publisher.duplicate();
    const subClient = redis.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
    logger.info('Socket.IO Redis adapter configured');
  } catch (error) {
    logger.warn('Socket.IO Redis adapter failed, using default memory adapter:', error.message);
  }

  // Middleware de autenticacao JWT
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) {
        return next(new Error('Token nao fornecido'));
      }

      const decoded = jwt.verify(token, config.JWT_SECRET);

      // Buscar usuario com cache Redis (5min)
      const cacheKey = `user_ws:${decoded.id}`;
      let user;
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          user = JSON.parse(cached);
        }
      } catch (_) { /* cache miss, segue pro banco */ }

      if (!user) {
        const userResult = await pool.query(
          `SELECT u.id, u.nome, u.email, u.role, u.empresa_id, e.nome as empresa_nome
           FROM usuarios u
           JOIN empresas e ON u.empresa_id = e.id
           WHERE u.id = $1 AND u.ativo = true AND e.ativo = true`,
          [decoded.id]
        );

        if (userResult.rows.length === 0) {
          return next(new Error('Usuario nao encontrado'));
        }

        user = userResult.rows[0];
        try {
          await redis.set(cacheKey, JSON.stringify(user), 'EX', 300);
        } catch (_) { /* falha no cache não bloqueia */ }
      }

      socket.user = user;
      next();
    } catch (error) {
      logger.warn('Socket.IO auth failed:', error.message);
      next(new Error('Token invalido'));
    }
  });

  // Conexao estabelecida
  io.on('connection', async (socket) => {
    const user = socket.user;

    // Limitar a 3 conexões simultâneas por usuário
    const userSockets = await io.in(`usuario:${user.id}`).fetchSockets();
    if (userSockets.length >= 3) {
      logger.warn(`Socket rejected: ${user.nome} already has ${userSockets.length} connections`);
      socket.emit('error', { message: 'Maximo de conexoes atingido (3)' });
      socket.disconnect(true);
      return;
    }

    logger.info(`Socket connected: ${user.nome} (${user.role}) [${socket.id}]`);

    // Auto-join rooms baseado no usuario
    socket.join(`usuario:${user.id}`);
    socket.join(`empresa:${user.empresa_id}`);

    // Auto-join nas filas do usuario (com cache Redis 5min)
    try {
      let filas;
      const filasCacheKey = `user_filas:${user.id}`;
      try {
        const cachedFilas = await redis.get(filasCacheKey);
        if (cachedFilas) filas = JSON.parse(cachedFilas);
      } catch (_) { /* cache miss */ }

      if (!filas) {
        const filasResult = await pool.query(
          `SELECT fm.fila_id FROM fila_membros fm
           JOIN filas_atendimento fa ON fm.fila_id = fa.id
           WHERE fm.usuario_id = $1 AND fa.ativo = true`,
          [user.id]
        );
        filas = filasResult.rows;
        try {
          await redis.set(filasCacheKey, JSON.stringify(filas), 'EX', 300);
        } catch (_) { /* falha no cache não bloqueia */ }
      }

      for (const row of filas) {
        socket.join(`fila:${row.fila_id}`);
      }

      // Atualizar disponibilidade
      await pool.query(
        `UPDATE usuarios SET disponibilidade = 'disponivel', ultima_atividade = NOW() WHERE id = $1`,
        [user.id]
      );

      // Notificar empresa que operador ficou online
      socket.to(`empresa:${user.empresa_id}`).emit('operador:status', {
        usuario_id: user.id,
        nome: user.nome,
        disponibilidade: 'disponivel',
      });
    } catch (error) {
      logger.error('Error on socket connection setup:', error.message);
    }

    // === EVENTOS CLIENT → SERVER ===

    // Entrar no room de uma conversa
    socket.on('join:conversa', ({ conversa_id }) => {
      if (conversa_id) {
        socket.join(`conversa:${conversa_id}`);
        logger.debug(`${user.nome} joined conversa:${conversa_id}`);
      }
    });

    // Sair do room de uma conversa
    socket.on('leave:conversa', ({ conversa_id }) => {
      if (conversa_id) {
        socket.leave(`conversa:${conversa_id}`);
        logger.debug(`${user.nome} left conversa:${conversa_id}`);
      }
    });

    // Entrar no room de uma fila
    socket.on('join:fila', ({ fila_id }) => {
      if (fila_id) {
        socket.join(`fila:${fila_id}`);
      }
    });

    // Sair do room de uma fila
    socket.on('leave:fila', ({ fila_id }) => {
      if (fila_id) {
        socket.leave(`fila:${fila_id}`);
      }
    });

    // Indicador digitando (operador)
    socket.on('typing:operador', ({ conversa_id, typing }) => {
      if (conversa_id) {
        socket.to(`conversa:${conversa_id}`).emit('typing:operador', {
          conversa_id,
          usuario_id: user.id,
          nome: user.nome,
          typing: !!typing,
        });
      }
    });

    // Alterar disponibilidade
    socket.on('disponibilidade', async ({ status }) => {
      const validStatus = ['disponivel', 'ocupado', 'offline'];
      if (!validStatus.includes(status)) return;

      try {
        await pool.query(
          `UPDATE usuarios SET disponibilidade = $1, ultima_atividade = NOW() WHERE id = $2`,
          [status, user.id]
        );

        socket.to(`empresa:${user.empresa_id}`).emit('operador:status', {
          usuario_id: user.id,
          nome: user.nome,
          disponibilidade: status,
        });
      } catch (error) {
        logger.error('Error updating disponibilidade:', error.message);
      }
    });

    // Desconexao
    socket.on('disconnect', async (reason) => {
      logger.info(`Socket disconnected: ${user.nome} (${reason}) [${socket.id}]`);

      try {
        // Verificar se usuario tem outras conexoes ativas
        const rooms = io.sockets.adapter.rooms.get(`usuario:${user.id}`);
        if (!rooms || rooms.size === 0) {
          // Nenhuma outra conexao, marcar offline se auto_offline
          const userCheck = await pool.query(
            `SELECT auto_offline FROM usuarios WHERE id = $1`,
            [user.id]
          );
          if (userCheck.rows[0]?.auto_offline) {
            await pool.query(
              `UPDATE usuarios SET disponibilidade = 'offline', ultima_atividade = NOW() WHERE id = $1`,
              [user.id]
            );

            io.to(`empresa:${user.empresa_id}`).emit('operador:status', {
              usuario_id: user.id,
              nome: user.nome,
              disponibilidade: 'offline',
            });
          }
        }
      } catch (error) {
        logger.error('Error on socket disconnect:', error.message);
      }
    });
  });

  logger.info('Socket.IO initialized');
  return io;
}

/**
 * Retorna a instancia do Socket.IO
 */
export function getIO() {
  if (!io) {
    logger.warn('Socket.IO not initialized yet');
  }
  return io;
}

/**
 * Configura o emitter para processos worker (sem servidor HTTP).
 * Usa @socket.io/redis-emitter para emitir eventos via Redis pub/sub.
 */
export function setEmitter(emitterInstance) {
  emitter = emitterInstance;
  logger.info('Socket.IO Redis emitter configured (worker mode)');
}

/**
 * Retorna io (server) ou emitter (worker) — o que estiver disponivel
 */
function getBroadcaster() {
  return io || emitter;
}

// === HELPERS DE EMISSAO ===

/**
 * Emite evento para uma conversa especifica
 */
export function emitToConversa(conversaId, evento, dados) {
  const bc = getBroadcaster();
  if (bc) {
    bc.to(`conversa:${conversaId}`).emit(evento, dados);
  }
}

/**
 * Emite evento para uma fila
 */
export function emitToFila(filaId, evento, dados) {
  const bc = getBroadcaster();
  if (bc) {
    bc.to(`fila:${filaId}`).emit(evento, dados);
  }
}

/**
 * Emite evento para um usuario especifico
 */
export function emitToUser(userId, evento, dados) {
  const bc = getBroadcaster();
  if (bc) {
    bc.to(`usuario:${userId}`).emit(evento, dados);
  }
}

/**
 * Emite evento para toda a empresa
 */
export function emitToEmpresa(empresaId, evento, dados) {
  const bc = getBroadcaster();
  if (bc) {
    bc.to(`empresa:${empresaId}`).emit(evento, dados);
  }
}

/**
 * Emite nova mensagem para conversa + atualiza stats da fila
 */
export function emitNovaMensagem(conversaId, filaId, mensagem) {
  emitToConversa(conversaId, 'mensagem:nova', mensagem);
  if (filaId) {
    emitToFila(filaId, 'fila:nova-mensagem', {
      conversa_id: conversaId,
      preview: mensagem.conteudo?.substring(0, 100),
      criado_em: mensagem.criado_em,
    });
  }
}

/**
 * Emite atualizacao de status de entrega
 */
export function emitStatusEntrega(conversaId, dados) {
  emitToConversa(conversaId, 'mensagem:status', dados);
}

/**
 * Emite que conversa foi atribuida a operador
 */
export function emitConversaAtribuida(conversaId, filaId, operadorId, dados) {
  emitToConversa(conversaId, 'conversa:atribuida', dados);
  emitToUser(operadorId, 'conversa:atribuida', dados);
  if (filaId) {
    emitToFila(filaId, 'conversa:atualizada', dados);
  }
}

/**
 * Emite atualizacao geral de conversa
 */
export function emitConversaAtualizada(conversaId, filaId, dados) {
  emitToConversa(conversaId, 'conversa:atualizada', dados);
  if (filaId) {
    emitToFila(filaId, 'conversa:atualizada', dados);
  }
}

/**
 * Emite nova conversa na fila
 */
export function emitNovaConversaNaFila(filaId, conversa) {
  emitToFila(filaId, 'conversa:nova', conversa);
}

/**
 * Emite stats atualizadas de fila (debounced 500ms para evitar emissões excessivas)
 */
const statsTimers = new Map();

export function emitFilaStats(filaId, stats) {
  if (statsTimers.has(filaId)) clearTimeout(statsTimers.get(filaId));
  statsTimers.set(filaId, setTimeout(() => {
    emitToFila(filaId, 'fila:stats', { ...stats, fila_id: filaId });
    statsTimers.delete(filaId);
  }, 500));
}
