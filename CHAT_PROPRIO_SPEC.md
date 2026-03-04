# ESPECIFICACAO COMPLETA — CHAT PROPRIO + FILAS DE ATENDIMENTO
## Substituicao do Chatwoot por Sistema Interno

**Data:** 2026-03-04
**Status:** Planejamento
**Versao:** 1.0

---

## INDICE

1. [Visao Geral](#1-visao-geral)
2. [Arquitetura Nova vs Antiga](#2-arquitetura-nova-vs-antiga)
3. [Banco de Dados — Novas Tabelas e Alteracoes](#3-banco-de-dados)
4. [Backend — Novos Endpoints](#4-backend-endpoints)
5. [Backend — WebSocket (Real-Time)](#5-websocket)
6. [Backend — Servicos Novos e Alterados](#6-servicos)
7. [Frontend — Nova Interface do Chat](#7-frontend)
8. [Permissoes por Role](#8-permissoes)
9. [Fluxos Detalhados](#9-fluxos)
10. [O Que Remover (Chatwoot)](#10-remocao-chatwoot)
11. [Performance e Escala](#11-performance)
12. [Fases de Implementacao](#12-fases)
13. [Checklist Geral](#13-checklist)

---

## 1. VISAO GERAL

### O que estamos fazendo
Construir um sistema de chat e atendimento COMPLETO dentro da nossa plataforma, eliminando a dependencia do Chatwoot. Operadores humanos vao atender clientes WhatsApp diretamente pelo nosso painel.

### O que NAO muda
- Agentes IA (Gemini) continuam funcionando normalmente
- Fluxo WhatsApp -> Meta -> n8n -> Backend continua igual
- n8n Flow 2 (enviar resposta pro WhatsApp) continua igual
- Multi-tenancy, API keys, tools, transferencia entre agentes IA
- Numeros WhatsApp (cadastro, verificacao Meta) — ja funciona

### O que muda
- Operador responde pelo NOSSO painel (nao mais pelo Chatwoot)
- Mensagens do operador passam pelo nosso backend -> n8n Flow 2 -> WhatsApp
- Real-time via WebSocket (operador recebe msgs instantaneamente)
- Filas de atendimento com round-robin e atribuicao
- Todo historico unificado no nosso BD (sem sync Chatwoot)

### Diagrama de arquitetura final

```
                    ┌──────────────┐
                    │   WhatsApp   │
                    │   (Cliente)  │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   Meta API   │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │     n8n      │
                    │   Flow 1    │
                    └──────┬───────┘
                           │
              POST /api/webhooks/n8n
                           │
                    ┌──────▼───────────────────────────────┐
                    │            BACKEND (Fastify)          │
                    │                                       │
                    │  ┌─────────────────────────────────┐  │
                    │  │ Roteamento:                      │  │
                    │  │  controlado_por = 'ia'           │  │
                    │  │    → Gemini processa             │  │
                    │  │    → Resposta via n8n Flow 2     │  │
                    │  │                                   │  │
                    │  │  controlado_por = 'humano'       │  │
                    │  │    → Salva BD + Redis            │  │
                    │  │    → WebSocket → Operador        │  │
                    │  │                                   │  │
                    │  │  controlado_por = 'fila'         │  │
                    │  │    → Salva BD + Redis            │  │
                    │  │    → Entra na fila               │  │
                    │  │    → WebSocket → Painel          │  │
                    │  └─────────────────────────────────┘  │
                    │                                       │
                    │  ┌──────┐  ┌──────┐  ┌────────────┐  │
                    │  │Redis │  │ PG   │  │ WebSocket  │  │
                    │  │Cache │  │ BD   │  │ Server     │  │
                    │  └──────┘  └──────┘  └─────┬──────┘  │
                    └────────────────────────────┬┘─────────┘
                                                 │
                              ┌───────────────────▼──────────────────┐
                              │         NOSSO PAINEL (Frontend)      │
                              │                                      │
                              │  ┌────────┬───────────┬───────────┐  │
                              │  │Sidebar │  Lista    │  Chat     │  │
                              │  │ Filas  │ Conversas │  Ativo    │  │
                              │  │        │           │           │  │
                              │  │Minhas  │ Card 1    │ Mensagens │  │
                              │  │Nao Atr │ Card 2    │ Input     │  │
                              │  │        │ Card 3    │ Acoes     │  │
                              │  └────────┴───────────┴───────────┘  │
                              └──────────────────────────────────────┘
```

---

## 2. ARQUITETURA NOVA VS ANTIGA

### Fluxo ANTIGO (com Chatwoot)

```
Msg chega → Backend decide IA/Humano
  Se Humano:
    → Salva Redis
    → Operador abre CHATWOOT pra responder
    → Chatwoot envia via inbox WhatsApp proprio
    → Ao devolver: Backend busca msgs no Chatwoot → sync Redis (FRAGIL)
```

### Fluxo NOVO (chat proprio)

```
Msg chega → Backend decide IA/Humano/Fila
  Se IA:
    → Gemini processa → n8n Flow 2 → WhatsApp (igual hoje)
  Se Fila (aguardando atendimento):
    → Salva BD + Redis → WebSocket notifica painel
    → Round-robin ou operador pega manualmente
  Se Humano (operador atendendo):
    → Salva BD + Redis → WebSocket envia msg pro operador
    → Operador responde pelo painel → POST /api/chat/enviar
    → Backend salva BD + Redis → n8n Flow 2 → WhatsApp
    → Ao devolver: historico JA ESTA no Redis (sem sync!)
```

### Ganhos

| Aspecto | Antes | Depois |
|---------|-------|--------|
| Onde operador responde | Chatwoot (externo) | Nosso painel |
| Armazenamento msgs | Duplicado (Chatwoot + Redis) | Unificado (BD + Redis) |
| Sync ao devolver pra IA | Buscar msgs Chatwoot → Redis | Desnecessario |
| Dependencia externa | Chatwoot + n8n monitorando | Nenhuma |
| Ponto de falha | Chatwoot caiu = sem atendimento | Autonomo |
| Filas de atendimento | Nao existia | Round-robin + manual |
| Real-time | Via Chatwoot | WebSocket proprio |

---

## 3. BANCO DE DADOS

### 3.1 Novas Tabelas

#### `filas_atendimento`
Filas/departamentos para organizar o atendimento humano.

```sql
CREATE TABLE filas_atendimento (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome VARCHAR(100) NOT NULL,
  descricao TEXT,
  cor VARCHAR(7) DEFAULT '#3B82F6',
  icone VARCHAR(50) DEFAULT 'headset',

  -- Configuracao de atribuicao
  auto_assignment BOOLEAN DEFAULT true,
  metodo_distribuicao VARCHAR(20) DEFAULT 'round_robin',
  max_conversas_por_operador INTEGER DEFAULT 10,

  -- Horario de funcionamento
  horario_funcionamento_ativo BOOLEAN DEFAULT false,
  horario_funcionamento JSONB DEFAULT '{}',
  mensagem_fora_horario TEXT DEFAULT 'Estamos fora do horario de atendimento. Retornaremos em breve.',

  -- Prioridade padrao
  prioridade_padrao VARCHAR(10) DEFAULT 'none',

  -- SLA (tempo maximo de espera em minutos)
  sla_primeira_resposta_min INTEGER,
  sla_resolucao_min INTEGER,

  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(empresa_id, nome)
);

CREATE INDEX idx_filas_empresa ON filas_atendimento(empresa_id) WHERE ativo = true;
```

#### `fila_membros`
Quais operadores/admins pertencem a cada fila.

```sql
CREATE TABLE fila_membros (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fila_id UUID NOT NULL REFERENCES filas_atendimento(id) ON DELETE CASCADE,
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  papel VARCHAR(20) DEFAULT 'membro',
  criado_em TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(fila_id, usuario_id)
);

CREATE INDEX idx_fila_membros_usuario ON fila_membros(usuario_id);
CREATE INDEX idx_fila_membros_fila ON fila_membros(fila_id);
```

#### `labels`
Tags globais por empresa para categorizar conversas.

```sql
CREATE TABLE labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome VARCHAR(50) NOT NULL,
  cor VARCHAR(7) DEFAULT '#6B7280',
  descricao TEXT,
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(empresa_id, nome)
);
```

#### `conversa_labels`
Relacao N:N entre conversas e labels.

```sql
CREATE TABLE conversa_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversa_id UUID NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  label_id UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  criado_em TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(conversa_id, label_id)
);

CREATE INDEX idx_conversa_labels_conversa ON conversa_labels(conversa_id);
CREATE INDEX idx_conversa_labels_label ON conversa_labels(label_id);
```

#### `notas_internas`
Notas visiveis apenas para operadores/admins.

```sql
CREATE TABLE notas_internas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversa_id UUID NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  usuario_id UUID NOT NULL REFERENCES usuarios(id),
  usuario_nome VARCHAR(255),
  conteudo TEXT NOT NULL,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notas_conversa ON notas_internas(conversa_id);
```

### 3.2 Alteracoes em Tabelas Existentes

#### `conversas` — Novos campos

```sql
-- Fila de atendimento
ALTER TABLE conversas ADD COLUMN fila_id UUID REFERENCES filas_atendimento(id);
ALTER TABLE conversas ADD COLUMN fila_entrada_em TIMESTAMPTZ;

-- Operador atribuido (especifico, diferente de humano_id generico)
ALTER TABLE conversas ADD COLUMN operador_id UUID REFERENCES usuarios(id);
ALTER TABLE conversas ADD COLUMN operador_nome VARCHAR(255);
ALTER TABLE conversas ADD COLUMN operador_atribuido_em TIMESTAMPTZ;

-- Prioridade
ALTER TABLE conversas ADD COLUMN prioridade VARCHAR(10) DEFAULT 'none';

-- Snooze
ALTER TABLE conversas ADD COLUMN snoozed_ate TIMESTAMPTZ;

-- Contato expandido
ALTER TABLE conversas ADD COLUMN contato_nome VARCHAR(255);

-- Indices
CREATE INDEX idx_conversas_fila ON conversas(fila_id, status) WHERE fila_id IS NOT NULL;
CREATE INDEX idx_conversas_operador ON conversas(operador_id, status) WHERE operador_id IS NOT NULL;
CREATE INDEX idx_conversas_prioridade ON conversas(prioridade, status);
```

**Novo valor para `controlado_por`:**
- `'ia'` — Agente IA atendendo (igual hoje)
- `'humano'` — Operador humano atendendo (igual hoje)
- `'fila'` — Aguardando na fila (NOVO)

**Novos valores para `status`:**
- `'ativo'` — Conversa em andamento (igual hoje)
- `'pendente'` — Na fila aguardando atendimento (NOVO)
- `'snoozed'` — Adiada ate data/hora (NOVO)
- `'finalizado'` — Concluida (igual hoje)
- `'timeout'` — Timeout por inatividade (igual hoje)

#### `usuarios` — Disponibilidade

```sql
ALTER TABLE usuarios ADD COLUMN disponibilidade VARCHAR(20) DEFAULT 'offline';
ALTER TABLE usuarios ADD COLUMN auto_offline BOOLEAN DEFAULT true;
ALTER TABLE usuarios ADD COLUMN max_conversas_simultaneas INTEGER DEFAULT 10;
ALTER TABLE usuarios ADD COLUMN ultima_atividade TIMESTAMPTZ;
```

**Valores de `disponibilidade`:**
- `'disponivel'` — Online e aceitando conversas
- `'ocupado'` — Online mas nao recebe auto-assignment
- `'offline'` — Offline

#### `mensagens_log` — Novos campos

```sql
-- Status de entrega WhatsApp
ALTER TABLE mensagens_log ADD COLUMN status_entrega VARCHAR(20) DEFAULT 'sent';
-- Valores: 'sent', 'delivered', 'read', 'failed'

-- Tipo de remetente (para distinguir IA vs operador)
ALTER TABLE mensagens_log ADD COLUMN remetente_tipo VARCHAR(20);
-- Valores: 'ia', 'operador', 'cliente', 'sistema'

ALTER TABLE mensagens_log ADD COLUMN remetente_id UUID;
ALTER TABLE mensagens_log ADD COLUMN remetente_nome VARCHAR(255);
```

### 3.3 Diagrama de Relacionamentos (Novos)

```
empresas
  ├── filas_atendimento
  │     └── fila_membros → usuarios
  ├── labels
  │     └── conversa_labels → conversas
  ├── conversas (campos novos: fila_id, operador_id, prioridade, snoozed_ate)
  │     ├── mensagens_log (campos novos: status_entrega, remetente_tipo)
  │     ├── notas_internas → usuarios
  │     └── controle_historico (existente, sem alteracao)
  └── usuarios (campos novos: disponibilidade, max_conversas_simultaneas)
```

---

## 4. BACKEND — ENDPOINTS

### 4.1 Filas de Atendimento

| Metodo | Rota | Descricao | Permissao |
|--------|------|-----------|-----------|
| `GET` | `/api/filas` | Listar filas (operador ve so as dele) | master, admin, operador |
| `POST` | `/api/filas` | Criar fila | master, admin |
| `GET` | `/api/filas/:id` | Detalhes da fila + stats | master, admin, operador (se membro) |
| `PUT` | `/api/filas/:id` | Atualizar fila | master, admin |
| `DELETE` | `/api/filas/:id` | Desativar fila (soft delete) | master, admin |
| `GET` | `/api/filas/:id/membros` | Listar membros da fila | master, admin, operador (se membro) |
| `POST` | `/api/filas/:id/membros` | Adicionar membros | master, admin |
| `DELETE` | `/api/filas/:id/membros/:userId` | Remover membro | master, admin |
| `GET` | `/api/filas/:id/conversas` | Conversas da fila | master, admin, operador (se membro) |
| `GET` | `/api/filas/stats` | Contadores de todas as filas | master, admin |

**GET /api/filas — Resposta:**
```json
{
  "data": [
    {
      "id": "uuid",
      "nome": "Suporte N1",
      "cor": "#3B82F6",
      "icone": "headset",
      "auto_assignment": true,
      "ativo": true,
      "stats": {
        "aguardando": 5,
        "em_atendimento": 3,
        "membros_online": 2,
        "membros_total": 4,
        "tempo_medio_espera_min": 3.5
      }
    }
  ]
}
```

**POST /api/filas — Body:**
```json
{
  "nome": "Suporte N1",
  "descricao": "Atendimento geral",
  "cor": "#3B82F6",
  "icone": "headset",
  "auto_assignment": true,
  "metodo_distribuicao": "round_robin",
  "max_conversas_por_operador": 10,
  "prioridade_padrao": "none",
  "horario_funcionamento_ativo": false,
  "horario_funcionamento": {
    "seg": { "inicio": "08:00", "fim": "18:00" },
    "ter": { "inicio": "08:00", "fim": "18:00" },
    "qua": { "inicio": "08:00", "fim": "18:00" },
    "qui": { "inicio": "08:00", "fim": "18:00" },
    "sex": { "inicio": "08:00", "fim": "18:00" },
    "sab": null,
    "dom": null
  },
  "mensagem_fora_horario": "Estamos fora do horario.",
  "sla_primeira_resposta_min": 5,
  "sla_resolucao_min": 60,
  "membros": ["usuario-uuid-1", "usuario-uuid-2"]
}
```

### 4.2 Conversas (Endpoints Novos)

| Metodo | Rota | Descricao | Permissao |
|--------|------|-----------|-----------|
| `POST` | `/api/conversas/:id/atribuir` | Atribuir a operador especifico | master, admin, operador |
| `POST` | `/api/conversas/:id/desatribuir` | Remover atribuicao (volta pra fila) | master, admin, operador |
| `POST` | `/api/conversas/:id/transferir-fila` | Mover para outra fila | master, admin, operador |
| `POST` | `/api/conversas/:id/prioridade` | Alterar prioridade | master, admin, operador |
| `POST` | `/api/conversas/:id/snooze` | Adiar conversa | master, admin, operador |
| `POST` | `/api/conversas/:id/unsnooze` | Reativar conversa adiada | master, admin, operador |
| `GET` | `/api/conversas/:id/labels` | Listar labels da conversa | master, admin, operador |
| `POST` | `/api/conversas/:id/labels` | Definir labels | master, admin, operador |
| `GET` | `/api/conversas/:id/notas` | Listar notas internas | master, admin, operador |
| `POST` | `/api/conversas/:id/notas` | Criar nota interna | master, admin, operador |
| `POST` | `/api/conversas/filtro` | Filtro avancado | master, admin, operador |

**POST /api/conversas/:id/atribuir:**
```json
{
  "operador_id": "uuid"
}
```

**POST /api/conversas/:id/transferir-fila:**
```json
{
  "fila_id": "uuid",
  "motivo": "Cliente precisa de suporte tecnico"
}
```

**POST /api/conversas/:id/prioridade:**
```json
{
  "prioridade": "high"
}
```

**POST /api/conversas/:id/snooze:**
```json
{
  "ate": "2026-03-05T10:00:00Z",
  "motivo": "Cliente vai retornar amanha"
}
```

**POST /api/conversas/filtro:**
```json
{
  "filtros": [
    { "campo": "status", "operador": "igual", "valor": "ativo" },
    { "campo": "prioridade", "operador": "igual", "valor": "high" },
    { "campo": "fila_id", "operador": "igual", "valor": "uuid" },
    { "campo": "operador_id", "operador": "igual", "valor": "uuid" },
    { "campo": "labels", "operador": "contem", "valor": "vip" },
    { "campo": "criado_em", "operador": "maior_que", "valor": "2026-03-01" }
  ],
  "ordenar_por": "prioridade",
  "ordem": "desc",
  "pagina": 1,
  "por_pagina": 50
}
```

### 4.3 Chat (Enviar Mensagem — NOVO)

| Metodo | Rota | Descricao | Permissao |
|--------|------|-----------|-----------|
| `POST` | `/api/chat/enviar` | Operador envia msg pro cliente via WhatsApp | master, admin, operador |
| `POST` | `/api/chat/typing` | Indicador digitando (envia pro cliente) | master, admin, operador |

**POST /api/chat/enviar:**
```json
{
  "conversa_id": "uuid",
  "conteudo": "Ola! Como posso ajudar?",
  "tipo": "text"
}
```

**Fluxo interno:**
1. Valida que operador tem acesso a conversa (membro da fila)
2. Salva em `mensagens_log` com `remetente_tipo = 'operador'`
3. Adiciona ao historico Redis
4. Faz POST para n8n Flow 2 (mesmo endpoint que IA usa)
5. Emite WebSocket `message:sent` para confirmar ao operador
6. Aguarda callback `confirmar-envio` com wamid

### 4.4 Labels

| Metodo | Rota | Descricao | Permissao |
|--------|------|-----------|-----------|
| `GET` | `/api/labels` | Listar labels da empresa | master, admin, operador |
| `POST` | `/api/labels` | Criar label | master, admin |
| `PUT` | `/api/labels/:id` | Atualizar label | master, admin |
| `DELETE` | `/api/labels/:id` | Remover label | master, admin |

### 4.5 Disponibilidade do Operador

| Metodo | Rota | Descricao | Permissao |
|--------|------|-----------|-----------|
| `PATCH` | `/api/usuarios/disponibilidade` | Alterar minha disponibilidade | qualquer autenticado |
| `GET` | `/api/usuarios/online` | Listar operadores online | master, admin |

**PATCH /api/usuarios/disponibilidade:**
```json
{
  "disponibilidade": "disponivel"
}
```

### 4.6 Status de Entrega WhatsApp (NOVO)

| Metodo | Rota | Descricao | Permissao |
|--------|------|-----------|-----------|
| `POST` | `/api/webhooks/n8n/status-entrega` | n8n envia status de entrega Meta | webhook auth |

**POST /api/webhooks/n8n/status-entrega:**
```json
{
  "whatsapp_message_id": "wamid.xxx",
  "status": "delivered",
  "timestamp": "1709567890",
  "phone": "5511999999999"
}
```

**Fluxo:**
1. n8n recebe webhook da Meta com status changes
2. Chama nosso endpoint com wamid + status
3. Backend atualiza `mensagens_log.status_entrega`
4. Emite WebSocket `message:status` para atualizar UI (checkmarks)

---

## 5. WEBSOCKET (REAL-TIME)

### 5.1 Tecnologia
- **Socket.IO** (sobre WebSocket, com fallback para polling)
- Integrado ao Fastify via `@fastify/websocket` ou `fastify-socket.io`
- Autenticacao via JWT no handshake

### 5.2 Namespaces e Rooms

```
Namespace: /chat

Rooms:
  empresa:{empresa_id}              — Todos da empresa (admin/master)
  fila:{fila_id}                    — Membros de uma fila
  conversa:{conversa_id}            — Quem esta visualizando uma conversa
  usuario:{usuario_id}              — Canal privado do usuario
```

### 5.3 Eventos Server → Client

| Evento | Room | Payload | Quando |
|--------|------|---------|--------|
| `conversa:nova` | `fila:{fila_id}` | Conversa completa | Nova conversa entra na fila |
| `conversa:atualizada` | `fila:{fila_id}` | Campos alterados | Status, prioridade, etc. mudou |
| `conversa:atribuida` | `usuario:{operador_id}` | Conversa + operador | Conversa atribuida ao operador |
| `mensagem:nova` | `conversa:{conversa_id}` | Mensagem completa | Msg do cliente chega |
| `mensagem:status` | `conversa:{conversa_id}` | wamid + status | Status entrega WhatsApp |
| `mensagem:enviada` | `conversa:{conversa_id}` | Mensagem salva | Confirmacao de envio do operador |
| `fila:stats` | `fila:{fila_id}` | Contadores | Mudanca em stats da fila |
| `operador:status` | `empresa:{empresa_id}` | usuario_id + status | Operador ficou online/offline |
| `notificacao` | `usuario:{usuario_id}` | Notificacao | Qualquer notificacao |
| `typing:cliente` | `conversa:{conversa_id}` | { typing: true } | Cliente digitando (se Meta enviar) |

### 5.4 Eventos Client → Server

| Evento | Payload | Acao |
|--------|---------|------|
| `join:fila` | { fila_id } | Entra no room da fila |
| `leave:fila` | { fila_id } | Sai do room da fila |
| `join:conversa` | { conversa_id } | Entra no room da conversa |
| `leave:conversa` | { conversa_id } | Sai do room da conversa |
| `typing:operador` | { conversa_id, typing: bool } | Operador digitando |

### 5.5 Autenticacao WebSocket

```javascript
// Client
const socket = io('/chat', {
  auth: { token: 'jwt-token-aqui' }
});

// Server
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  const user = await verifyJWT(token);
  if (!user) return next(new Error('Nao autorizado'));
  socket.user = user;
  socket.join(`usuario:${user.id}`);
  socket.join(`empresa:${user.empresa_id}`);
  // Auto-join nas filas do usuario
  const filas = await getFilasDoUsuario(user.id);
  filas.forEach(f => socket.join(`fila:${f.id}`));
  next();
});
```

### 5.6 Integracao com Webhook n8n

Quando mensagem chega no webhook n8n e `controlado_por` = `'humano'` ou `'fila'`:

```javascript
// No webhook handler (apos salvar msg no BD)
fastify.io.to(`conversa:${conversa_id}`).emit('mensagem:nova', {
  id: mensagem.id,
  conversa_id,
  conteudo: message,
  direcao: 'entrada',
  remetente_tipo: 'cliente',
  criado_em: new Date()
});

// Se na fila, notificar membros
if (controlado_por === 'fila') {
  fastify.io.to(`fila:${fila_id}`).emit('fila:stats', statsAtualizadas);
}
```

---

## 6. SERVICOS (Backend)

### 6.1 Novos Servicos

#### `services/fila-manager.js`
```
Funcoes:
- getFilasDoUsuario(usuario_id) — retorna filas que o usuario pertence
- atribuirConversaAutomatica(conversa_id, fila_id) — round-robin
- getProximoOperadorDisponivel(fila_id) — logica round-robin
- calcularStatsFilas(empresa_id) — contadores por fila
- verificarHorarioFuncionamento(fila_id) — checa se dentro do horario
- verificarCapacidadeOperador(usuario_id) — se pode receber mais conversas
```

**Logica Round-Robin:**
```
1. Buscar membros da fila com disponibilidade = 'disponivel'
2. Para cada membro, contar conversas ativas atribuidas
3. Filtrar membros que nao atingiram max_conversas_simultaneas
4. Ordenar por menor numero de conversas ativas (balanceamento)
5. Atribuir ao primeiro da lista
6. Se ninguem disponivel: conversa fica na fila como 'nao atribuida'
```

#### `services/chat-sender.js`
```
Funcoes:
- enviarMensagemWhatsApp(conversa_id, conteudo, operador) — fluxo completo de envio
  1. Buscar conversa + empresa + whatsapp_number
  2. Salvar em mensagens_log (remetente_tipo = 'operador')
  3. Adicionar ao Redis
  4. POST n8n Flow 2 (phone, message, phone_number_id, token)
  5. Emitir WebSocket
  6. Retornar mensagem salva
```

#### `services/websocket.js`
```
Funcoes:
- initializeSocket(fastify) — configura Socket.IO
- emitToConversation(conversa_id, evento, dados) — emite para room da conversa
- emitToFila(fila_id, evento, dados) — emite para room da fila
- emitToUser(usuario_id, evento, dados) — emite para room do usuario
- emitToEmpresa(empresa_id, evento, dados) — emite para toda empresa
```

### 6.2 Servicos Alterados

#### `services/memory.js` (Redis)
**Adicionar:**
- Ao salvar mensagem do operador, incluir `remetente_tipo: 'operador'` e `remetente_nome`
- Formato Redis atualizado: `{ role: 'model', parts: [{text}], timestamp, remetente_tipo, remetente_nome }`

**Remover (gradual):**
- `syncChatwootHistory()` — nao sera mais necessario

#### `routes/webhooks/n8n.js`
**Alterar:**
- Quando `controlado_por = 'humano'`:
  - MANTER: salva msg no Redis + BD
  - ADICIONAR: emitir WebSocket `mensagem:nova` para o operador
- Quando `controlado_por = 'fila'`:
  - MANTER: salva msg no Redis + BD
  - ADICIONAR: emitir WebSocket `mensagem:nova` + `fila:stats`
- REMOVER: qualquer referencia a Chatwoot

#### `routes/conversas.js`
**Alterar:**
- `POST /assumir` → agora tambem atribui fila + operador_id, emite WebSocket
- `POST /devolver` → REMOVER syncChatwootHistory, apenas marca controlado_por='ia'
- `POST /finalizar` → emitir WebSocket `conversa:atualizada`

---

## 7. FRONTEND

### 7.1 Estrutura de Arquivos (Novos)

```
src/app/(dashboard)/dashboard/chat/
  page.tsx                          ← Pagina principal (REESCREVER)

src/components/chat/
  chat-layout.tsx                   ← Layout 3 colunas
  chat-sidebar.tsx                  ← Sidebar esquerda (filas + filtros)
  chat-conversation-list.tsx        ← Lista de conversas (coluna meio)
  chat-conversation-card.tsx        ← Card de conversa na lista
  chat-window.tsx                   ← Janela de chat (coluna direita)
  chat-message.tsx                  ← Componente de mensagem individual
  chat-input.tsx                    ← Input de envio de mensagem
  chat-info-panel.tsx               ← Painel info direito (contato, labels, etc)
  chat-empty-state.tsx              ← Estado vazio
  chat-header.tsx                   ← Header da conversa aberta

src/components/filas/
  fila-create-dialog.tsx            ← Dialog criar/editar fila
  fila-members-dialog.tsx           ← Dialog gerenciar membros
  fila-settings.tsx                 ← Configuracoes da fila

src/components/chat/actions/
  assign-operator-dialog.tsx        ← Dialog atribuir operador
  transfer-queue-dialog.tsx         ← Dialog transferir fila
  snooze-dialog.tsx                 ← Dialog adiar conversa
  labels-popover.tsx                ← Popover para labels
  priority-select.tsx               ← Select de prioridade
  note-dialog.tsx                   ← Dialog criar nota interna

src/hooks/
  use-socket.ts                     ← Hook WebSocket
  use-chat.ts                       ← Hook logica de chat
  use-filas.ts                      ← Hook logica de filas

src/contexts/
  socket-context.tsx                ← Provider WebSocket global
```

### 7.2 Layout do Chat (3 colunas)

```
┌─────────────┬────────────────────┬──────────────────────────────────┐
│  SIDEBAR     │   LISTA CONVERSAS  │        CHAT ATIVO                │
│  (280px)     │   (350px)          │        (flex-1)                  │
│              │                    │                                   │
│ ┌──────────┐│ ┌────────────────┐ │ ┌───────────────────────────────┐│
│ │Disponib. ││ │ [Buscar...]    │ │ │ Header: Nome + Status + Acoes ││
│ │🟢 Online ││ ├────────────────┤ │ ├───────────────────────────────┤│
│ └──────────┘│ │                │ │ │                               ││
│              │ │  Card Conversa │ │ │     Area de Mensagens         ││
│ ── ABAS ── │ │  🟢 Joao      │ │ │     (scroll)                  ││
│ [Minhas][!] │ │  Ola preciso.. │ │ │                               ││
│              │ │  ⚡Alta  2min │ │ │  💬 Cliente (14:30)           ││
│ ── FILAS ── │ │                │ │ │  Ola, preciso de ajuda        ││
│              │ ├────────────────┤ │ │                               ││
│ Suporte   5 │ │                │ │ │       Operador (14:31) 💬     ││
│ Vendas    2 │ │  Card Conversa │ │ │  Claro! Em que posso ajudar?  ││
│ Financ.   0 │ │  🟡 Maria     │ │ │                     ✓✓ 14:31  ││
│              │ │  Quero cancel. │ │ │                               ││
│ ── LABELS ──│ │  🔴Urgente 5m │ │ │  💬 Cliente (14:32)           ││
│              │ │                │ │ │  Meu pedido nao chegou        ││
│ #vip      3 │ ├────────────────┤ │ │                               ││
│ #bug      1 │ │                │ │ ├───────────────────────────────┤│
│ #urgente  2 │ │  Card Conversa │ │ │ [Notas internas]              ││
│              │ │  ...           │ │ │ "Cliente VIP, cuidado"        ││
│              │ │                │ │ ├───────────────────────────────┤│
│              │ │                │ │ │ [Input mensagem]        [▶]  ││
│              │ │                │ │ │ [📎 Anexo] [😊 Emoji]        ││
│              │ └────────────────┘ │ └───────────────────────────────┘│
│              │                    │                                   │
│ ── STATUS ──│ │ Mostrando 12    │ │ ┌───────────────────────────────┐│
│ 🟢 Ativo  8│ │ conversas       │ │ │ PAINEL INFO (toggle)          ││
│ ⏸ Fila   5│ │                  │ │ │ Contato: +55 11 99999-9999   ││
│ ✅ Resolv 12│                    │ │ Nome: Joao Silva              ││
│              │                    │ │ Fila: Suporte N1              ││
│              │                    │ │ Operador: Maria               ││
│              │                    │ │ Prioridade: [Alta ▼]          ││
│              │                    │ │ Labels: [vip][novo]           ││
│              │                    │ │                               ││
│              │                    │ │ [Transferir Fila]             ││
│              │                    │ │ [Devolver p/ IA]              ││
│              │                    │ │ [Finalizar]                   ││
│              │                    │ │ [Adiar (Snooze)]              ││
│              │                    │ └───────────────────────────────┘│
└──────────────┴────────────────────┴──────────────────────────────────┘
```

### 7.3 Componentes shadcn/ui Necessarios

```
Ja existentes no projeto:
  ✅ Button, Input, Label

Adicionar via npx shadcn-ui@latest add:
  ☐ Dialog          — Criar/editar filas, atribuir operador
  ☐ Sheet           — Painel info lateral (mobile)
  ☐ Select          — Prioridade, fila, operador
  ☐ Badge           — Labels, status, contadores
  ☐ DropdownMenu    — Acoes rapidas
  ☐ Command         — Busca avancada (cmdk)
  ☐ Popover         — Labels, snooze datepicker
  ☐ Tabs            — Minhas / Nao atribuidas
  ☐ Tooltip         — Status operador, timestamps
  ☐ ScrollArea      — Listas com scroll
  ☐ Separator       — Divisoes visuais
  ☐ Avatar          — Avatar do contato/operador
  ☐ Textarea        — Input de mensagem
  ☐ Calendar        — Date picker para snooze
  ☐ Skeleton        — Loading states
  ☐ Switch          — Toggles configuracao
  ☐ Checkbox        — Multi-select membros
```

### 7.4 WebSocket no Frontend

```typescript
// src/contexts/socket-context.tsx

'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from './auth-context';

interface SocketContextType {
  socket: Socket | null;
  connected: boolean;
}

// Hook de uso:
// const { socket, connected } = useSocket();
//
// useEffect(() => {
//   socket?.on('mensagem:nova', (msg) => {
//     queryClient.setQueryData(['conversa', msg.conversa_id], old => ({
//       ...old,
//       mensagens: [...old.mensagens, msg]
//     }));
//   });
// }, [socket]);
```

### 7.5 Comportamento por Tela

#### Sidebar (Esquerda)
- **Toggle disponibilidade** no topo (online/ocupado/offline)
- **Aba "Minhas"** — conversas atribuidas ao operador logado (com badge contador)
- **Aba "Nao atribuidas"** — conversas na fila sem operador (com badge)
- **Lista de Filas** — cada fila com contador de aguardando
- **Lista de Labels** — cada label com contador
- **Filtros de Status** — ativo, na fila, resolvido

#### Lista de Conversas (Centro)
- Cards de conversa com: nome contato, preview ultima msg, fila, prioridade, labels, tempo de espera
- Cores de prioridade: none=cinza, low=azul, medium=amarelo, high=laranja, urgent=vermelho
- Indicador visual de "nao lida" (mensagens novas)
- Ordenacao: prioridade (desc) → tempo de espera (desc)
- Busca textual por nome/telefone/conteudo
- Atualizacao real-time via WebSocket

#### Chat Ativo (Direita)
- Header: nome contato + telefone + status + botoes de acao
- Mensagens: baloes esquerda (cliente) / direita (operador/IA)
- Indicador de quem enviou: icone IA vs avatar operador
- Status de entrega: ✓ enviado, ✓✓ entregue, ✓✓ azul lido
- Indicador "digitando..."
- Input de mensagem com envio por Enter (Shift+Enter = nova linha)
- Notas internas (aba separada ou toggle)
- Painel info (toggle) com acoes

### 7.6 Responsividade (Mobile)

```
Desktop (lg+): 3 colunas lado a lado
Tablet (md):   Sidebar oculta (toggle), 2 colunas
Mobile (sm):   1 coluna de cada vez (lista OU chat)
  - Lista → click → Chat (com botao voltar)
  - Sidebar via drawer/sheet
```

---

## 8. PERMISSOES POR ROLE

### 8.1 Tabela de Permissoes — Chat

| Funcionalidade | master | admin | operador | viewer |
|---|---|---|---|---|
| Ver TODAS as conversas | ✅ | ✅ | ❌ | ❌ |
| Ver conversas das SUAS filas | ✅ | ✅ | ✅ | ❌ |
| Ver conversas nao atribuidas (da fila) | ✅ | ✅ | ✅ | ❌ |
| Ver "Minhas" conversas | ✅ | ✅ | ✅ | ❌ |
| Pegar conversa da fila | ✅ | ✅ | ✅ | ❌ |
| Enviar mensagem | ✅ | ✅ | ✅ | ❌ |
| Atribuir a outro operador | ✅ | ✅ | ❌ | ❌ |
| Transferir entre filas | ✅ | ✅ | ✅ (filas permitidas) | ❌ |
| Alterar prioridade | ✅ | ✅ | ✅ | ❌ |
| Adicionar labels | ✅ | ✅ | ✅ | ❌ |
| Criar notas internas | ✅ | ✅ | ✅ | ❌ |
| Devolver pra IA | ✅ | ✅ | ✅ | ❌ |
| Finalizar conversa | ✅ | ✅ | ✅ | ❌ |
| Snooze conversa | ✅ | ✅ | ✅ | ❌ |
| Acessar painel Chat | ✅ | ✅ | ✅ | ❌ |

### 8.2 Tabela de Permissoes — Filas

| Funcionalidade | master | admin | operador | viewer |
|---|---|---|---|---|
| CRUD filas | ✅ | ✅ | ❌ | ❌ |
| Gerenciar membros | ✅ | ✅ | ❌ | ❌ |
| Ver stats de TODAS filas | ✅ | ✅ | ❌ | ❌ |
| Ver stats das SUAS filas | ✅ | ✅ | ✅ | ❌ |
| Configurar horario/SLA | ✅ | ✅ | ❌ | ❌ |

### 8.3 Tabela de Permissoes — Labels

| Funcionalidade | master | admin | operador | viewer |
|---|---|---|---|---|
| CRUD labels | ✅ | ✅ | ❌ | ❌ |
| Aplicar labels em conversas | ✅ | ✅ | ✅ | ❌ |

### 8.4 Regras Especiais do Operador

```
1. Operador NUNCA ve aba "Todas" (so master/admin)
2. Operador NUNCA ve conversas de filas que nao pertence
3. Operador so pode transferir para filas que ELE pertence
4. Operador ve:
   - "Minhas" → conversas onde operador_id = seu id
   - "Nao atribuidas" → conversas onde fila_id IN (suas filas) AND operador_id IS NULL
5. Ao "pegar" conversa nao atribuida:
   - operador_id = seu id
   - controlado_por = 'humano'
   - conversa sai da lista "nao atribuidas" dos outros operadores da mesma fila
```

---

## 9. FLUXOS DETALHADOS

### 9.1 Nova Mensagem WhatsApp (IA atendendo)

```
1. WhatsApp → Meta → n8n → POST /api/webhooks/n8n
2. Backend identifica conversa (ou cria nova)
3. controlado_por = 'ia'
4. Gemini processa mensagem
5. Resposta salva BD + Redis
6. POST n8n Flow 2 → Meta → WhatsApp
7. WebSocket: emite 'mensagem:nova' + 'mensagem:enviada' (para quem estiver vendo)
```

### 9.2 Nova Mensagem WhatsApp (Humano atendendo)

```
1. WhatsApp → Meta → n8n → POST /api/webhooks/n8n
2. Backend identifica conversa
3. controlado_por = 'humano'
4. Salva msg em BD (mensagens_log) + Redis
5. NAO processa com Gemini
6. WebSocket: emite 'mensagem:nova' para room conversa:{id}
7. Operador ve msg aparecer na tela instantaneamente
```

### 9.3 Nova Mensagem WhatsApp (Na fila, sem operador)

```
1. WhatsApp → Meta → n8n → POST /api/webhooks/n8n
2. Backend identifica conversa
3. controlado_por = 'fila' (aguardando atendimento)
4. Salva msg em BD + Redis
5. NAO processa com Gemini
6. Tenta auto-assignment (round-robin):
   a. Se encontrou operador → atribui, muda para 'humano'
      WebSocket: 'conversa:atribuida' para operador
   b. Se nao encontrou → permanece na fila
      WebSocket: 'fila:stats' atualiza contadores
7. WebSocket: 'mensagem:nova' para room conversa:{id}
```

### 9.4 Operador Envia Mensagem

```
1. Operador digita msg no chat → POST /api/chat/enviar
2. Backend valida permissao (operador membro da fila)
3. Salva em mensagens_log (remetente_tipo='operador', remetente_id, remetente_nome)
4. Adiciona ao Redis (role='model', com metadados do operador)
5. POST n8n Flow 2 com: phone, message, phone_number_id, token
6. WebSocket: 'mensagem:enviada' para room conversa:{id}
7. n8n Flow 2 → Meta → WhatsApp → cliente recebe
8. n8n chama POST /confirmar-envio com wamid
9. Backend atualiza whatsapp_message_id em mensagens_log
10. WebSocket: 'mensagem:status' {status: 'sent'} → operador ve ✓
```

### 9.5 Operador Pega Conversa da Fila

```
1. Operador clica em conversa nao atribuida → POST /api/conversas/:id/atribuir
2. Backend:
   - Valida: operador pertence a fila da conversa
   - UPDATE conversas SET operador_id = ?, operador_nome = ?,
     operador_atribuido_em = NOW(), controlado_por = 'humano'
   - INSERT controle_historico (acao='operador_assumiu')
3. WebSocket:
   - 'conversa:atribuida' para usuario:{operador_id}
   - 'conversa:atualizada' para fila:{fila_id} (sai da lista nao atribuidas)
   - 'fila:stats' com contadores atualizados
```

### 9.6 Transferir Conversa para Outra Fila

```
1. Operador clica "Transferir" → POST /api/conversas/:id/transferir-fila
2. Backend:
   - Valida: operador pertence a fila destino
   - UPDATE conversas SET fila_id = nova_fila, operador_id = NULL,
     controlado_por = 'fila'
   - INSERT controle_historico (acao='transferencia_fila')
   - Tenta auto-assignment na nova fila
3. WebSocket:
   - 'conversa:atualizada' para fila:{fila_antiga} (sai)
   - 'conversa:nova' para fila:{fila_nova} (entra)
   - Se auto-assigned: 'conversa:atribuida' para novo operador
```

### 9.7 Devolver para IA

```
1. Operador clica "Devolver p/ IA" → POST /api/conversas/:id/devolver
2. Backend:
   - UPDATE conversas SET controlado_por = 'ia', operador_id = NULL
   - INSERT controle_historico (acao='devolvido_ia')
   - Historico JA ESTA no Redis (sem sync necessario!)
3. WebSocket:
   - 'conversa:atualizada' para fila:{fila_id}
4. Proxima msg do cliente → Gemini processa normalmente
```

### 9.8 Finalizar Conversa

```
1. Operador clica "Finalizar" → POST /api/conversas/:id/finalizar
2. Backend:
   - UPDATE conversas SET status = 'finalizado', controlado_por = 'ia'
   - Arquiva Redis (30 dias TTL)
   - INSERT controle_historico (acao='finalizada')
3. WebSocket:
   - 'conversa:atualizada' para fila:{fila_id}
   - 'fila:stats' com contadores atualizados
4. Proxima msg do mesmo contato → cria conversa NOVA
```

### 9.9 Roteamento Inicial de Conversa Nova

```
Nova conversa criada pelo webhook n8n:

1. Agente IA esta ativo para empresa?
   SIM → controlado_por = 'ia', Gemini processa

2. Nao tem agente IA OU agente configurado como "encaminhar pra fila"?
   → Verificar: empresa tem fila padrao configurada?
     SIM → controlado_por = 'fila', fila_id = fila_padrao
           → Tenta round-robin
     NAO → controlado_por = 'fila', fila_id = primeira fila ativa
           → Tenta round-robin

3. Agente IA processa e detecta que precisa de humano?
   (via regra de transferencia com trigger_tipo = 'keyword' ou 'menu_opcao')
   → controlado_por = 'fila', fila_id = fila configurada na regra
   → WebSocket notifica fila
```

---

## 10. REMOCAO DO CHATWOOT

### 10.1 O que remover (apos chat proprio funcionar)

```
ARQUIVOS PARA REMOVER:
  ☐ src/services/chatwoot.js                    — Servico completo
  ☐ src/routes/webhooks/chatwoot.js              — Webhook Chatwoot

FUNCOES PARA REMOVER:
  ☐ memory.js → syncChatwootHistory()            — Sync Chatwoot→Redis
  ☐ conversas.js → logica de Chatwoot            — Refs ao Chatwoot

CAMPOS QUE SE TORNAM OBSOLETOS (manter por historico, nao usar):
  ☐ conversas.conversation_id_chatwoot
  ☐ conversas.inbox_id (se inboxes eram do Chatwoot)
  ☐ config_controle_humano (comandos Chatwoot) → substituido por UI

ENDPOINTS QUE MUDAM:
  ☐ POST /api/webhooks/n8n/controle-humano → manter mas simplificar
    (sem logica Chatwoot, sem sync, sem chatwoot_account_id)

CONFIGURACOES FRONTEND PARA REMOVER:
  ☐ Dashboard > Configuracoes > Chatwoot (aba inteira)
  ☐ Campos chatwoot_* em configuracoes de empresa

DEPENDENCIAS NPM PARA REMOVER:
  ☐ Qualquer pacote relacionado ao Chatwoot (verificar package.json)
```

### 10.2 Estrategia de Migracao

```
Fase 1: Construir chat proprio (Chatwoot continua funcionando em paralelo)
Fase 2: Migrar operadores para o nosso chat (testar)
Fase 3: Desativar Chatwoot (manter codigo por precaucao)
Fase 4: Remover codigo Chatwoot (limpeza final)
```

---

## 11. PERFORMANCE E ESCALA

### 11.1 Ajustes Imediatos (fazer junto com chat)

```
☐ Aumentar pool PostgreSQL: 20 → 50 conexoes
    Arquivo: src/config/database.js

☐ Adicionar clustering Node.js (fork por CPU)
    Arquivo: src/server.js ou novo src/cluster.js
    Impacto: ~4x throughput

☐ Ajustar rate limit por tipo de endpoint
    Arquivo: src/middleware/rate-limit.js
    - Webhook n8n: 500 req/min (precisa ser rapido)
    - WebSocket: sem rate limit (gerenciado por Socket.IO)
    - Chat enviar: 300 req/min por empresa
    - CRUD filas: 100 req/min

☐ Socket.IO com adapter Redis (para clustering)
    Pacote: @socket.io/redis-adapter
    Permite: multiplas instancias compartilhem rooms
```

### 11.2 Estimativa de Capacidade (apos ajustes)

```
Com clustering (4 CPUs) + pool 50:
  - Throughput: ~30-50 req/seg
  - Empresas simultaneas: ~30-50
  - Operadores simultaneos (WebSocket): ~200
  - Msgs WhatsApp/min: ~1000 (incluindo IA + humano)
```

### 11.3 Escala Futura (roadmap)

```
☐ BullMQ para processamento assincrono do Gemini
☐ PgBouncer para connection pooling externo
☐ Read replicas PostgreSQL para queries de leitura
☐ Redis Sentinel para alta disponibilidade
☐ Multiplas instancias Docker com load balancer
```

---

## 12. FASES DE IMPLEMENTACAO

### FASE 1 — Backend: Infraestrutura (1-2 dias)
```
☐ Migration: novas tabelas (filas, fila_membros, labels, conversa_labels, notas_internas)
☐ Migration: novos campos em conversas (fila_id, operador_id, prioridade, snoozed_ate)
☐ Migration: novos campos em usuarios (disponibilidade, max_conversas_simultaneas)
☐ Migration: novos campos em mensagens_log (status_entrega, remetente_tipo)
☐ Ajustar pool PostgreSQL (20 → 50)
☐ Instalar Socket.IO + configurar WebSocket server
☐ Servico websocket.js (init, emit helpers)
```

### FASE 2 — Backend: Filas e Atribuicao (1-2 dias)
```
☐ Rotas CRUD filas_atendimento (/api/filas)
☐ Rotas CRUD fila_membros
☐ Servico fila-manager.js (round-robin, stats, capacidade)
☐ Rotas novas conversas (atribuir, desatribuir, transferir-fila)
☐ Rota prioridade, snooze/unsnooze
☐ Integrar filas no webhook n8n (roteamento inicial)
☐ Permissoes: operador ve apenas filas dele
```

### FASE 3 — Backend: Chat + Envio de Mensagem (1-2 dias)
```
☐ Rota POST /api/chat/enviar (operador → WhatsApp)
☐ Servico chat-sender.js
☐ Integrar WebSocket no webhook n8n (push msgs)
☐ Integrar WebSocket nas acoes de conversa
☐ Rota status-entrega (webhook Meta via n8n)
☐ Rotas labels (CRUD + aplicar em conversas)
☐ Rotas notas internas
☐ Rota disponibilidade operador
☐ Rota filtro avancado
```

### FASE 4 — Frontend: Componentes Base (1-2 dias)
```
☐ Instalar componentes shadcn/ui necessarios
☐ Instalar socket.io-client
☐ Criar SocketContext + useSocket hook
☐ Componente chat-layout.tsx (3 colunas responsivo)
☐ Componente chat-sidebar.tsx (filas + filtros)
☐ Componente chat-conversation-list.tsx
☐ Componente chat-conversation-card.tsx
☐ Componente chat-empty-state.tsx
```

### FASE 5 — Frontend: Chat Ativo (1-2 dias)
```
☐ Componente chat-window.tsx (area de mensagens)
☐ Componente chat-message.tsx (balao individual)
☐ Componente chat-input.tsx (envio de msg)
☐ Componente chat-header.tsx
☐ Componente chat-info-panel.tsx (painel lateral)
☐ Integrar WebSocket (mensagens real-time)
☐ Status de entrega (checkmarks)
☐ Indicador digitando
☐ Auto-scroll para ultima mensagem
```

### FASE 6 — Frontend: Acoes e Dialogs (1 dia)
```
☐ Dialog atribuir operador
☐ Dialog transferir fila
☐ Dialog snooze (com date picker)
☐ Popover labels
☐ Select prioridade
☐ Dialog nota interna
☐ Dialog criar/editar fila (admin)
☐ Dialog gerenciar membros fila (admin)
```

### FASE 7 — Integracao e Testes (1-2 dias)
```
☐ Testar fluxo completo: msg WhatsApp → fila → operador pega → responde → cliente recebe
☐ Testar round-robin com multiplos operadores
☐ Testar transferencia entre filas
☐ Testar devolver pra IA (historico preservado)
☐ Testar finalizar conversa
☐ Testar prioridade + labels + notas
☐ Testar permissoes operador (ve so filas dele)
☐ Testar responsividade mobile
☐ Testar com multiplas empresas (multi-tenant)
☐ Testar status de entrega WhatsApp
☐ Load test basico (multiplas msgs simultaneas)
```

### FASE 8 — Remocao Chatwoot (apos validacao)
```
☐ Remover services/chatwoot.js
☐ Remover routes/webhooks/chatwoot.js
☐ Remover syncChatwootHistory de memory.js
☐ Simplificar endpoint controle-humano
☐ Remover aba Chatwoot das configuracoes frontend
☐ Atualizar CLAUDE.md com nova arquitetura
☐ Atualizar MEMORY.md
```

---

## 13. CHECKLIST GERAL

### Banco de Dados
- [ ] Migration 034: filas_atendimento
- [ ] Migration 034: fila_membros
- [ ] Migration 034: labels
- [ ] Migration 034: conversa_labels
- [ ] Migration 034: notas_internas
- [ ] Migration 034: ALTER conversas (fila_id, operador_id, prioridade, snoozed_ate, contato_nome)
- [ ] Migration 034: ALTER usuarios (disponibilidade, max_conversas_simultaneas, ultima_atividade)
- [ ] Migration 034: ALTER mensagens_log (status_entrega, remetente_tipo, remetente_id, remetente_nome)
- [ ] Seed: fila padrao para empresa demo

### Backend — Rotas
- [ ] GET /api/filas
- [ ] POST /api/filas
- [ ] GET /api/filas/:id
- [ ] PUT /api/filas/:id
- [ ] DELETE /api/filas/:id
- [ ] GET /api/filas/:id/membros
- [ ] POST /api/filas/:id/membros
- [ ] DELETE /api/filas/:id/membros/:userId
- [ ] GET /api/filas/:id/conversas
- [ ] GET /api/filas/stats
- [ ] POST /api/conversas/:id/atribuir
- [ ] POST /api/conversas/:id/desatribuir
- [ ] POST /api/conversas/:id/transferir-fila
- [ ] POST /api/conversas/:id/prioridade
- [ ] POST /api/conversas/:id/snooze
- [ ] POST /api/conversas/:id/unsnooze
- [ ] GET /api/conversas/:id/labels
- [ ] POST /api/conversas/:id/labels
- [ ] GET /api/conversas/:id/notas
- [ ] POST /api/conversas/:id/notas
- [ ] POST /api/conversas/filtro
- [ ] POST /api/chat/enviar
- [ ] POST /api/chat/typing
- [ ] GET /api/labels
- [ ] POST /api/labels
- [ ] PUT /api/labels/:id
- [ ] DELETE /api/labels/:id
- [ ] PATCH /api/usuarios/disponibilidade
- [ ] GET /api/usuarios/online
- [ ] POST /api/webhooks/n8n/status-entrega

### Backend — Servicos
- [ ] services/websocket.js
- [ ] services/fila-manager.js
- [ ] services/chat-sender.js
- [ ] Alterar services/memory.js (remetente_tipo)
- [ ] Alterar routes/webhooks/n8n.js (WebSocket + fila routing)
- [ ] Alterar routes/conversas.js (novos endpoints + WebSocket)
- [ ] Alterar src/config/database.js (pool 50)

### Frontend — Componentes
- [ ] Instalar shadcn/ui (Dialog, Sheet, Select, Badge, etc)
- [ ] Instalar socket.io-client
- [ ] contexts/socket-context.tsx
- [ ] hooks/use-socket.ts
- [ ] hooks/use-chat.ts
- [ ] hooks/use-filas.ts
- [ ] components/chat/chat-layout.tsx
- [ ] components/chat/chat-sidebar.tsx
- [ ] components/chat/chat-conversation-list.tsx
- [ ] components/chat/chat-conversation-card.tsx
- [ ] components/chat/chat-window.tsx
- [ ] components/chat/chat-message.tsx
- [ ] components/chat/chat-input.tsx
- [ ] components/chat/chat-header.tsx
- [ ] components/chat/chat-info-panel.tsx
- [ ] components/chat/chat-empty-state.tsx
- [ ] components/filas/fila-create-dialog.tsx
- [ ] components/filas/fila-members-dialog.tsx
- [ ] components/chat/actions/assign-operator-dialog.tsx
- [ ] components/chat/actions/transfer-queue-dialog.tsx
- [ ] components/chat/actions/snooze-dialog.tsx
- [ ] components/chat/actions/labels-popover.tsx
- [ ] components/chat/actions/priority-select.tsx
- [ ] components/chat/actions/note-dialog.tsx
- [ ] Reescrever app/(dashboard)/dashboard/chat/page.tsx

### Frontend — Funcionalidades
- [ ] Layout 3 colunas responsivo
- [ ] Sidebar com filas + contadores
- [ ] Lista de conversas com filtros
- [ ] Chat com mensagens real-time (WebSocket)
- [ ] Input de envio de mensagem
- [ ] Status de entrega (checkmarks)
- [ ] Indicador digitando
- [ ] Pegar conversa da fila
- [ ] Transferir entre filas
- [ ] Atribuir operador (admin)
- [ ] Devolver pra IA
- [ ] Finalizar conversa
- [ ] Alterar prioridade
- [ ] Labels (aplicar/remover)
- [ ] Notas internas
- [ ] Snooze/unsnooze
- [ ] Toggle disponibilidade
- [ ] Busca textual
- [ ] Permissoes operador (ve so filas dele)
- [ ] Dark mode
- [ ] Responsive mobile
- [ ] Sons/notificacoes

### Testes e Validacao
- [ ] Fluxo msg WhatsApp → fila → operador → resposta
- [ ] Round-robin com multiplos operadores
- [ ] Transferencia entre filas
- [ ] Devolver pra IA com historico preservado
- [ ] Permissoes operador
- [ ] Multi-tenant (empresas isoladas)
- [ ] Status de entrega WhatsApp
- [ ] Responsividade mobile
- [ ] Load test basico

### Remocao Chatwoot
- [ ] Remover services/chatwoot.js
- [ ] Remover routes/webhooks/chatwoot.js
- [ ] Remover syncChatwootHistory
- [ ] Simplificar controle-humano
- [ ] Remover aba Chatwoot do frontend
- [ ] Atualizar documentacao

---

## NOTAS FINAIS

### Dependencias NPM Novas (Backend)
```json
{
  "socket.io": "^4.7.x",
  "@socket.io/redis-adapter": "^8.x"
}
```

### Dependencias NPM Novas (Frontend)
```json
{
  "socket.io-client": "^4.7.x"
}
```

### Variaveis de Ambiente Novas
```
Nenhuma obrigatoria — WebSocket usa mesma porta do Fastify
Opcional: SOCKET_IO_PATH=/socket.io (default)
```

### Compatibilidade
- Manter endpoints existentes funcionando durante transicao
- Chat proprio e Chatwoot podem coexistir (Fase 1-2)
- Chatwoot so e removido apos validacao completa (Fase 8)
