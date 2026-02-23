# MAPA MESTRE DE DESENVOLVIMENTO
## Plataforma Multi-Tenant de Agentes IA com WhatsApp
### Guia Técnico de Prompts por Subfase

---

## COMO USAR ESTE DOCUMENTO

Cada subfase abaixo é um **prompt autocontido** que você deve copiar e colar em uma nova conversa do Claude. 

**Regras:**
1. Execute na ordem (Fase 1A → 1B → 1C → ...)
2. Antes de colar o prompt da próxima subfase, confirme que a anterior está funcionando
3. No início de cada prompt, anexe os arquivos relevantes já criados (quando indicado)
4. Cada prompt tem uma seção "ENTREGÁVEIS" — confira que TODOS foram gerados antes de prosseguir

**Estrutura de cada prompt:**
- CONTEXTO: O que já foi feito antes
- OBJETIVO: O que construir agora
- ESPECIFICAÇÃO TÉCNICA: Detalhes completos
- ENTREGÁVEIS: Lista exata de arquivos que devem ser gerados
- CRITÉRIOS DE VALIDAÇÃO: Como verificar que está correto

---

## INVENTÁRIO COMPLETO DO SISTEMA

Antes dos prompts, aqui está o inventário completo de TUDO que precisa existir no sistema final. Use como checklist.

### Tabelas do Banco de Dados (23 tabelas)

```
PLATAFORMA:
  [  ] 01. planos
  [  ] 02. itens_cobraveis
  [  ] 03. faixas_item
  [  ] 04. alertas_config

EMPRESAS:
  [  ] 05. empresas
  [  ] 06. usuarios
  [  ] 07. api_keys
  [  ] 08. assinaturas
  [  ] 09. assinatura_itens
  [  ] 10. assinatura_historico
  [  ] 11. faturas
  [  ] 12. notificacoes

INFRAESTRUTURA:
  [  ] 13. inboxes
  [  ] 14. whatsapp_numbers

INTELIGÊNCIA:
  [  ] 15. agentes
  [  ] 16. prompts
  [  ] 17. tools
  [  ] 18. agente_tools
  [  ] 19. agente_transferencias

OPERAÇÃO:
  [  ] 20. conversas
  [  ] 21. atendimentos
  [  ] 22. mensagens_log
  [  ] 23. uso_diario_agente
  [  ] 24. uso_mensal
  [  ] 25. controle_historico
  [  ] 26. config_controle_humano
```

### Middlewares do Backend (5)

```
  [  ] 01. auth.js — Validação JWT, identificação de usuário
  [  ] 02. tenant.js — Injeção de empresa_id em toda query
  [  ] 03. permission.js — Verificação de role vs recurso
  [  ] 04. limit.js — Verificação de limites do plano/assinatura
  [  ] 05. rate-limit.js — Rate limiting por empresa e endpoint
```

### Serviços do Backend (7)

```
  [  ] 01. gemini.js — Chamada Gemini API com function calling
  [  ] 02. tool-runner.js — Executa HTTP requests das tools
  [  ] 03. memory.js — Redis para histórico de conversa
  [  ] 04. chatwoot.js — Espelhamento de mensagens no Chatwoot
  [  ] 05. api-key-manager.js — Pool de keys com failover
  [  ] 06. billing.js — Cálculos de cobrança e limites
  [  ] 07. notification.js — Sistema de notificações e alertas
```

### Endpoints da API (37+)

```
CORE:
  [  ] POST /api/chat
  [  ] POST /api/webhook/chatwoot

AUTH:
  [  ] POST /api/auth/login
  [  ] POST /api/auth/refresh
  [  ] POST /api/auth/forgot-password
  [  ] POST /api/auth/reset-password
  [  ] GET  /api/auth/me

EMPRESAS (Master):
  [  ] GET    /api/empresas
  [  ] POST   /api/empresas
  [  ] GET    /api/empresas/:id
  [  ] PUT    /api/empresas/:id
  [  ] DELETE /api/empresas/:id
  [  ] POST   /api/empresas/:id/impersonate

PLANOS (Master):
  [  ] GET    /api/planos
  [  ] POST   /api/planos
  [  ] PUT    /api/planos/:id

ITENS COBRÁVEIS (Master):
  [  ] GET    /api/itens-cobraveis
  [  ] POST   /api/itens-cobraveis
  [  ] PUT    /api/itens-cobraveis/:id
  [  ] GET    /api/faixas/:itemId
  [  ] POST   /api/faixas/:itemId
  [  ] PUT    /api/faixas/:id

ASSINATURAS (Master):
  [  ] GET    /api/assinaturas/:empresaId
  [  ] PUT    /api/assinaturas/:empresaId
  [  ] GET    /api/assinaturas/:empresaId/historico
  [  ] GET    /api/assinaturas/:empresaId/faturas

AGENTES:
  [  ] GET    /api/agentes
  [  ] POST   /api/agentes
  [  ] GET    /api/agentes/:id
  [  ] PUT    /api/agentes/:id
  [  ] DELETE /api/agentes/:id

PROMPTS:
  [  ] GET    /api/agentes/:id/prompts
  [  ] POST   /api/agentes/:id/prompts
  [  ] PUT    /api/agentes/:agenteId/prompts/:promptId/ativar

TRANSFERÊNCIAS:
  [  ] GET    /api/agentes/:id/transferencias
  [  ] POST   /api/agentes/:id/transferencias
  [  ] PUT    /api/transferencias/:id
  [  ] DELETE /api/transferencias/:id

TOOLS:
  [  ] GET    /api/tools
  [  ] POST   /api/tools
  [  ] GET    /api/tools/:id
  [  ] PUT    /api/tools/:id
  [  ] DELETE /api/tools/:id
  [  ] POST   /api/tools/:id/testar

AGENTE-TOOLS:
  [  ] GET    /api/agentes/:id/tools
  [  ] PUT    /api/agentes/:id/tools (atualiza vínculos)

INBOXES:
  [  ] GET    /api/inboxes
  [  ] POST   /api/inboxes
  [  ] PUT    /api/inboxes/:id
  [  ] DELETE /api/inboxes/:id

WHATSAPP NUMBERS:
  [  ] GET    /api/whatsapp-numbers
  [  ] POST   /api/whatsapp-numbers
  [  ] PUT    /api/whatsapp-numbers/:id
  [  ] DELETE /api/whatsapp-numbers/:id

API KEYS:
  [  ] GET    /api/api-keys
  [  ] POST   /api/api-keys
  [  ] PUT    /api/api-keys/:id
  [  ] DELETE /api/api-keys/:id
  [  ] PUT    /api/api-keys/:id/ativar
  [  ] POST   /api/api-keys/:id/testar

USUÁRIOS:
  [  ] GET    /api/usuarios
  [  ] POST   /api/usuarios
  [  ] PUT    /api/usuarios/:id
  [  ] DELETE /api/usuarios/:id

CONVERSAS:
  [  ] GET    /api/conversas
  [  ] GET    /api/conversas/:id
  [  ] POST   /api/conversas/:id/assumir
  [  ] POST   /api/conversas/:id/devolver
  [  ] GET    /api/conversas/:id/historico-controle

DASHBOARD:
  [  ] GET    /api/dashboard
  [  ] GET    /api/dashboard/global (Master)

LOGS:
  [  ] GET    /api/logs
  [  ] GET    /api/logs/:id

CONFIGURAÇÕES:
  [  ] GET    /api/configuracoes
  [  ] PUT    /api/configuracoes
```

### Telas do Frontend (24)

```
LOGIN:
  [  ] 00. Login

MASTER:
  [  ] M1.   Dashboard Global
  [  ] M2.   Empresas (lista)
  [  ] M2.1  Criar/Editar Empresa
  [  ] M2.2  Assinatura da Empresa
  [  ] M2.3  Impersonate (banner + contexto)
  [  ] M3.   Planos
  [  ] M4.   Itens Cobráveis e Faixas

ADMIN:
  [  ] A1.   Dashboard da Empresa
  [  ] A2.   Agentes IA (lista)
  [  ] A2.1  Editar Agente
  [  ] A2.2  Editor de Prompt (versionado)
  [  ] A2.3  Tools do Agente (vincular)
  [  ] A2.4  Transferências entre Agentes
  [  ] A2.5  Testar Agente (chat de teste)
  [  ] A3.   Tools (lista)
  [  ] A3.1  Editar/Criar Tool
  [  ] A4.   Números WhatsApp
  [  ] A5.   Chatwoot (config + controle humano)
  [  ] A6.   API Keys (pool + failover)
  [  ] A7.   Conversas Ativas (IA vs humano)
  [  ] A8.   Logs
  [  ] A9.   Usuários
  [  ] A10.  Configurações
```

---

## FASE 1: BACKEND CORE

### Subfase 1A — Setup do Projeto + Banco de Dados Completo

**O que fazer:** Criar a estrutura do projeto, instalar dependências, e gerar TODAS as migrations SQL.

**Prompt para colar no Claude:**

```
Estou construindo uma plataforma SaaS multi-tenant de agentes IA para atendimento via WhatsApp. Preciso que você crie a estrutura inicial do projeto backend e TODAS as migrations do banco de dados PostgreSQL.

## STACK
- Node.js 20+ com Fastify
- PostgreSQL 15+
- Redis 7+
- Docker + docker-compose

## ESTRUTURA DE PASTAS

/agent-platform
├── /backend
│   ├── /src
│   │   ├── /config
│   │   │   ├── database.js     (pool PostgreSQL com pg)
│   │   │   ├── redis.js        (conexão Redis com ioredis)
│   │   │   ├── env.js          (validação de variáveis de ambiente)
│   │   │   └── constants.js    (enums, valores padrão)
│   │   ├── /middleware
│   │   ├── /routes
│   │   ├── /services
│   │   ├── /models
│   │   └── server.js
│   ├── /migrations
│   ├── /scripts
│   │   └── seed.js             (dados iniciais)
│   ├── .env.example
│   ├── package.json
│   └── Dockerfile
├── docker-compose.yml
└── README.md

## VARIÁVEIS DE AMBIENTE (.env.example)

DATABASE_URL=postgresql://user:pass@localhost:5432/agent_platform
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-secret-key-min-32-chars
JWT_EXPIRES_IN=24h
JWT_REFRESH_EXPIRES_IN=7d
ENCRYPTION_KEY=your-aes-256-key-exactly-32-chars
PORT=3000
NODE_ENV=development

## MIGRATIONS SQL

Crie arquivos SQL numerados sequencialmente. Cada arquivo deve ter UP e DOWN (criar e destruir).

IMPORTANTE: 
- Todos os IDs são UUID (gen_random_uuid())
- Toda tabela que pertence a uma empresa TEM empresa_id NOT NULL com FK
- Toda tabela tem criado_em TIMESTAMPTZ DEFAULT NOW()
- Use JSONB para campos flexíveis
- Crie indexes em todas as colunas de busca frequente
- Crie indexes compostos (empresa_id, campo) para queries multi-tenant

### Tabelas na ordem de dependência:

**001_create_planos.sql**
- id UUID PK
- nome VARCHAR(100) NOT NULL
- descricao TEXT
- preco_base_mensal DECIMAL(10,2) DEFAULT 0
- max_usuarios INTEGER DEFAULT 3
- max_tools INTEGER DEFAULT 10
- max_mensagens_mes INTEGER DEFAULT 5000
- permite_modelo_pro BOOLEAN DEFAULT false
- ativo BOOLEAN DEFAULT true
- criado_em TIMESTAMPTZ DEFAULT NOW()
- atualizado_em TIMESTAMPTZ DEFAULT NOW()

**002_create_itens_cobraveis.sql**
- id UUID PK
- slug VARCHAR(50) UNIQUE NOT NULL (valores: 'agente_ia', 'numero_whatsapp')
- nome VARCHAR(100) NOT NULL
- descricao TEXT
- tipo_cobranca VARCHAR(20) NOT NULL CHECK (tipo_cobranca IN ('por_faixa', 'preco_fixo'))
- preco_fixo DECIMAL(10,2) (só se tipo = preco_fixo)
- ativo BOOLEAN DEFAULT true
- criado_em TIMESTAMPTZ DEFAULT NOW()

**003_create_faixas_item.sql**
- id UUID PK
- item_cobravel_id UUID FK → itens_cobraveis ON DELETE CASCADE
- nome VARCHAR(100) NOT NULL
- limite_diario INTEGER NOT NULL
- preco_mensal DECIMAL(10,2) NOT NULL
- ativo BOOLEAN DEFAULT true
- criado_em TIMESTAMPTZ DEFAULT NOW()
- INDEX (item_cobravel_id)

**004_create_empresas.sql**
- id UUID PK
- nome VARCHAR(255) NOT NULL
- slug VARCHAR(100) UNIQUE NOT NULL
- logo_url VARCHAR(500)
- plano_id UUID FK → planos
- chatwoot_url VARCHAR(500)
- chatwoot_api_token VARCHAR(500)
- chatwoot_account_id INTEGER
- chatwoot_status VARCHAR(20) DEFAULT 'ativo' CHECK IN ('ativo','provisionando','erro')
- chatwoot_admin_email VARCHAR(255)
- chatwoot_admin_senha_hash VARCHAR(255)
- ativo BOOLEAN DEFAULT true
- criado_em TIMESTAMPTZ DEFAULT NOW()
- atualizado_em TIMESTAMPTZ DEFAULT NOW()

**005_create_usuarios.sql**
- id UUID PK
- empresa_id UUID FK → empresas ON DELETE CASCADE (NULL para master)
- nome VARCHAR(255) NOT NULL
- email VARCHAR(255) UNIQUE NOT NULL
- senha_hash VARCHAR(255) NOT NULL
- role VARCHAR(20) NOT NULL CHECK IN ('master','admin','operador','viewer')
- ativo BOOLEAN DEFAULT true
- ultimo_login TIMESTAMPTZ
- criado_em TIMESTAMPTZ DEFAULT NOW()
- INDEX (empresa_id)
- INDEX (email)

**006_create_api_keys.sql**
- id UUID PK
- empresa_id UUID FK → empresas ON DELETE CASCADE
- provedor VARCHAR(50) NOT NULL DEFAULT 'gemini' CHECK IN ('gemini','openai','anthropic')
- nome_exibicao VARCHAR(100) NOT NULL
- api_key_encrypted TEXT NOT NULL
- status VARCHAR(20) DEFAULT 'standby' CHECK IN ('ativa','standby','rate_limited','erro','desativada')
- prioridade INTEGER NOT NULL DEFAULT 1
- total_requests_hoje INTEGER DEFAULT 0
- total_tokens_hoje BIGINT DEFAULT 0
- ultimo_uso TIMESTAMPTZ
- ultimo_erro TIMESTAMPTZ
- ultimo_erro_msg TEXT
- retry_apos TIMESTAMPTZ
- tentativas_erro INTEGER DEFAULT 0
- criado_por UUID FK → usuarios
- criado_em TIMESTAMPTZ DEFAULT NOW()
- atualizado_em TIMESTAMPTZ DEFAULT NOW()
- INDEX (empresa_id, status, prioridade)
- INDEX (empresa_id)

**007_create_assinaturas.sql**
- id UUID PK
- empresa_id UUID UNIQUE FK → empresas ON DELETE CASCADE
- plano_id UUID FK → planos
- status VARCHAR(20) DEFAULT 'ativa' CHECK IN ('ativa','suspensa','cancelada')
- data_inicio DATE NOT NULL DEFAULT CURRENT_DATE
- data_proximo_cobro DATE
- criado_em TIMESTAMPTZ DEFAULT NOW()
- atualizado_em TIMESTAMPTZ DEFAULT NOW()
- INDEX (empresa_id)

**008_create_assinatura_itens.sql**
- id UUID PK
- assinatura_id UUID FK → assinaturas ON DELETE CASCADE
- empresa_id UUID FK → empresas ON DELETE CASCADE
- item_cobravel_id UUID FK → itens_cobraveis
- faixa_id UUID FK → faixas_item (NULL se preco_fixo)
- quantidade INTEGER NOT NULL DEFAULT 1
- preco_unitario DECIMAL(10,2) NOT NULL
- limite_diario INTEGER (copiado da faixa, NULL se preco_fixo)
- preco_total DECIMAL(10,2) GENERATED ALWAYS AS (quantidade * preco_unitario) STORED
- ativo BOOLEAN DEFAULT true
- adicionado_em TIMESTAMPTZ DEFAULT NOW()
- removido_em TIMESTAMPTZ
- INDEX (empresa_id)
- INDEX (assinatura_id)

**009_create_assinatura_historico.sql**
- id UUID PK
- assinatura_id UUID FK → assinaturas ON DELETE CASCADE
- empresa_id UUID FK → empresas ON DELETE CASCADE
- acao VARCHAR(50) NOT NULL CHECK IN ('adicionou_item','removeu_item','alterou_quantidade','mudou_plano','mudou_faixa','desconto_aplicado')
- item_cobravel_id UUID FK → itens_cobraveis
- quantidade_anterior INTEGER
- quantidade_nova INTEGER
- preco_anterior DECIMAL(10,2)
- preco_novo DECIMAL(10,2)
- motivo TEXT
- executado_por UUID FK → usuarios
- criado_em TIMESTAMPTZ DEFAULT NOW()
- INDEX (empresa_id)

**010_create_faturas.sql**
- id UUID PK
- empresa_id UUID FK → empresas ON DELETE CASCADE
- assinatura_id UUID FK → assinaturas
- ano_mes VARCHAR(7) NOT NULL (formato: '2026-02')
- valor_plano_base DECIMAL(10,2) DEFAULT 0
- valor_itens DECIMAL(10,2) DEFAULT 0
- valor_total DECIMAL(10,2) DEFAULT 0
- desconto DECIMAL(10,2) DEFAULT 0
- valor_final DECIMAL(10,2) DEFAULT 0
- status VARCHAR(20) DEFAULT 'pendente' CHECK IN ('pendente','paga','atrasada','cancelada')
- data_vencimento DATE
- data_pagamento DATE
- detalhes_json JSONB
- criado_em TIMESTAMPTZ DEFAULT NOW()
- INDEX (empresa_id, ano_mes)
- UNIQUE (empresa_id, ano_mes)

**011_create_notificacoes.sql**
- id UUID PK
- empresa_id UUID FK → empresas ON DELETE CASCADE
- tipo VARCHAR(50) NOT NULL
- titulo VARCHAR(255) NOT NULL
- mensagem TEXT NOT NULL
- severidade VARCHAR(20) DEFAULT 'info' CHECK IN ('info','warning','critical')
- lida BOOLEAN DEFAULT false
- criado_em TIMESTAMPTZ DEFAULT NOW()
- INDEX (empresa_id, lida)

**012_create_inboxes.sql**
- id UUID PK
- empresa_id UUID FK → empresas ON DELETE CASCADE
- inbox_id_chatwoot INTEGER NOT NULL
- nome VARCHAR(100)
- agente_id UUID (FK → agentes, adicionado depois)
- ativo BOOLEAN DEFAULT true
- criado_em TIMESTAMPTZ DEFAULT NOW()
- INDEX (empresa_id)
- UNIQUE (empresa_id, inbox_id_chatwoot)

**013_create_whatsapp_numbers.sql**
- id UUID PK
- empresa_id UUID FK → empresas ON DELETE CASCADE
- inbox_id UUID FK → inboxes ON DELETE SET NULL
- nome_exibicao VARCHAR(100)
- phone_number_id VARCHAR(100) NOT NULL
- waba_id VARCHAR(100)
- token_graph_api TEXT NOT NULL
- numero_formatado VARCHAR(20)
- ativo BOOLEAN DEFAULT true
- criado_em TIMESTAMPTZ DEFAULT NOW()
- INDEX (empresa_id)
- INDEX (phone_number_id)

**014_create_agentes.sql**
- id UUID PK
- empresa_id UUID FK → empresas ON DELETE CASCADE
- nome VARCHAR(100) NOT NULL
- descricao TEXT
- tipo VARCHAR(20) NOT NULL DEFAULT 'especialista' CHECK IN ('triagem','especialista')
- modelo_llm VARCHAR(50) DEFAULT 'gemini-2.0-flash'
- temperatura DECIMAL(2,1) DEFAULT 0.3 CHECK (temperatura >= 0 AND temperatura <= 1)
- max_tokens INTEGER DEFAULT 2048
- mensagem_limite_atingido TEXT DEFAULT 'Olá! No momento estamos com alto volume de atendimentos. Tente novamente mais tarde! 🙏'
- conta_atendimento BOOLEAN DEFAULT true
- ativo BOOLEAN DEFAULT true
- criado_em TIMESTAMPTZ DEFAULT NOW()
- atualizado_em TIMESTAMPTZ DEFAULT NOW()
- INDEX (empresa_id)

-- Agora adicionar FK na tabela inboxes:
ALTER TABLE inboxes ADD CONSTRAINT fk_inboxes_agente FOREIGN KEY (agente_id) REFERENCES agentes(id) ON DELETE SET NULL;

**015_create_prompts.sql**
- id UUID PK
- agente_id UUID FK → agentes ON DELETE CASCADE
- empresa_id UUID FK → empresas ON DELETE CASCADE
- versao INTEGER NOT NULL DEFAULT 1
- conteudo TEXT NOT NULL
- ativo BOOLEAN DEFAULT false
- criado_por UUID FK → usuarios
- criado_em TIMESTAMPTZ DEFAULT NOW()
- INDEX (agente_id, ativo)
- UNIQUE (agente_id, versao)

**016_create_tools.sql**
- id UUID PK
- empresa_id UUID FK → empresas ON DELETE CASCADE
- nome VARCHAR(100) NOT NULL
- descricao_para_llm TEXT NOT NULL
- url VARCHAR(500) NOT NULL
- metodo VARCHAR(10) NOT NULL DEFAULT 'POST' CHECK IN ('GET','POST','PUT','PATCH','DELETE')
- headers_json JSONB DEFAULT '{}'
- body_template_json JSONB DEFAULT '{}'
- parametros_schema_json JSONB NOT NULL (JSON Schema dos parâmetros que o LLM deve preencher)
- timeout_ms INTEGER DEFAULT 30000
- ativo BOOLEAN DEFAULT true
- criado_em TIMESTAMPTZ DEFAULT NOW()
- atualizado_em TIMESTAMPTZ DEFAULT NOW()
- INDEX (empresa_id)

**017_create_agente_tools.sql**
- id UUID PK
- agente_id UUID FK → agentes ON DELETE CASCADE
- tool_id UUID FK → tools ON DELETE CASCADE
- ordem_prioridade INTEGER DEFAULT 0
- ativo BOOLEAN DEFAULT true
- criado_em TIMESTAMPTZ DEFAULT NOW()
- UNIQUE (agente_id, tool_id)
- INDEX (agente_id)

**018_create_agente_transferencias.sql**
- id UUID PK
- empresa_id UUID FK → empresas ON DELETE CASCADE
- agente_origem_id UUID FK → agentes ON DELETE CASCADE
- agente_destino_id UUID FK → agentes ON DELETE CASCADE
- trigger_tipo VARCHAR(30) NOT NULL CHECK IN ('tool_result','keyword','menu_opcao')
- trigger_valor VARCHAR(255) NOT NULL (ex: '1,fgts,saque' — separado por vírgula)
- transferir_historico BOOLEAN DEFAULT true
- ativo BOOLEAN DEFAULT true
- criado_em TIMESTAMPTZ DEFAULT NOW()
- INDEX (empresa_id, agente_origem_id)

**019_create_conversas.sql**
- id UUID PK
- empresa_id UUID FK → empresas ON DELETE CASCADE
- inbox_id UUID FK → inboxes
- conversation_id_chatwoot INTEGER
- contato_whatsapp VARCHAR(20)
- agente_id UUID FK → agentes
- agente_inicial_id UUID FK → agentes
- historico_agentes_json JSONB DEFAULT '[]'
- controlado_por VARCHAR(10) DEFAULT 'ia' CHECK IN ('ia','humano')
- humano_id UUID FK → usuarios
- humano_nome VARCHAR(255)
- humano_assumiu_em TIMESTAMPTZ
- humano_devolveu_em TIMESTAMPTZ
- humano_ultima_msg_em TIMESTAMPTZ
- status VARCHAR(20) DEFAULT 'ativo' CHECK IN ('ativo','finalizado','timeout')
- dados_json JSONB DEFAULT '{}'
- criado_em TIMESTAMPTZ DEFAULT NOW()
- atualizado_em TIMESTAMPTZ DEFAULT NOW()
- INDEX (empresa_id, status)
- INDEX (conversation_id_chatwoot)
- INDEX (empresa_id, controlado_por)

**020_create_atendimentos.sql**
- id UUID PK
- empresa_id UUID FK → empresas ON DELETE CASCADE
- agente_id UUID FK → agentes ON DELETE CASCADE
- conversa_id UUID FK → conversas ON DELETE CASCADE
- conversation_id_chatwoot INTEGER
- status VARCHAR(20) DEFAULT 'ativo' CHECK IN ('ativo','finalizado','timeout')
- iniciado_em TIMESTAMPTZ DEFAULT NOW()
- finalizado_em TIMESTAMPTZ
- total_mensagens INTEGER DEFAULT 0
- protocolo VARCHAR(50)
- criado_em TIMESTAMPTZ DEFAULT NOW()
- INDEX (empresa_id, agente_id)
- INDEX (empresa_id, status)

**021_create_mensagens_log.sql**
- id UUID PK
- conversa_id UUID FK → conversas ON DELETE CASCADE
- empresa_id UUID FK → empresas ON DELETE CASCADE
- direcao VARCHAR(10) NOT NULL CHECK IN ('entrada','saida')
- conteudo TEXT
- tokens_input INTEGER DEFAULT 0
- tokens_output INTEGER DEFAULT 0
- tools_invocadas_json JSONB
- modelo_usado VARCHAR(50)
- api_key_usada_id UUID FK → api_keys
- latencia_ms INTEGER
- erro TEXT
- criado_em TIMESTAMPTZ DEFAULT NOW()
- INDEX (empresa_id, criado_em DESC)
- INDEX (conversa_id)

**022_create_uso_diario_agente.sql**
- id UUID PK
- empresa_id UUID FK → empresas ON DELETE CASCADE
- agente_id UUID FK → agentes ON DELETE CASCADE
- data DATE NOT NULL DEFAULT CURRENT_DATE
- total_atendimentos INTEGER DEFAULT 0
- limite_diario INTEGER NOT NULL
- limite_atingido BOOLEAN DEFAULT false
- criado_em TIMESTAMPTZ DEFAULT NOW()
- atualizado_em TIMESTAMPTZ DEFAULT NOW()
- UNIQUE (empresa_id, agente_id, data)
- INDEX (empresa_id, data)

**023_create_uso_mensal.sql**
- id UUID PK
- empresa_id UUID FK → empresas ON DELETE CASCADE
- ano_mes VARCHAR(7) NOT NULL
- total_mensagens INTEGER DEFAULT 0
- total_tokens_input BIGINT DEFAULT 0
- total_tokens_output BIGINT DEFAULT 0
- total_tool_calls INTEGER DEFAULT 0
- atualizado_em TIMESTAMPTZ DEFAULT NOW()
- UNIQUE (empresa_id, ano_mes)

**024_create_controle_historico.sql**
- id UUID PK
- conversa_id UUID FK → conversas ON DELETE CASCADE
- empresa_id UUID FK → empresas ON DELETE CASCADE
- acao VARCHAR(50) NOT NULL CHECK IN ('humano_assumiu','humano_devolveu','timeout_ia_reassumiu','admin_forcou')
- de_controlador VARCHAR(10) NOT NULL
- para_controlador VARCHAR(10) NOT NULL
- humano_id UUID FK → usuarios
- humano_nome VARCHAR(255)
- motivo VARCHAR(100)
- criado_em TIMESTAMPTZ DEFAULT NOW()
- INDEX (conversa_id)
- INDEX (empresa_id)

**025_create_config_controle_humano.sql**
- id UUID PK
- empresa_id UUID UNIQUE FK → empresas ON DELETE CASCADE
- timeout_inatividade_minutos INTEGER DEFAULT 30
- mensagem_retorno_ia TEXT DEFAULT 'Voltei! Desculpe a espera. Como posso ajudar? 😊'
- permitir_devolver_via_nota BOOLEAN DEFAULT true
- comando_assumir VARCHAR(50) DEFAULT '/assumir'
- comando_devolver VARCHAR(50) DEFAULT '/devolver'
- notificar_admin_ao_assumir BOOLEAN DEFAULT true
- notificar_admin_ao_devolver BOOLEAN DEFAULT true
- ativo BOOLEAN DEFAULT true
- criado_em TIMESTAMPTZ DEFAULT NOW()

**026_create_alertas_config.sql**
- id UUID PK
- empresa_id UUID FK → empresas ON DELETE CASCADE (NULL = global)
- tipo VARCHAR(50) NOT NULL
- percentual INTEGER NOT NULL
- notificar_master BOOLEAN DEFAULT true
- notificar_admin BOOLEAN DEFAULT true
- mensagem_custom TEXT
- ativo BOOLEAN DEFAULT true
- criado_em TIMESTAMPTZ DEFAULT NOW()

## SCRIPT DE SEED (seed.js)

Deve inserir dados iniciais:

1. Planos: Starter (R$ 197), Pro (R$ 497), Enterprise (R$ 997)
2. Itens cobráveis: agente_ia (por_faixa), numero_whatsapp (preco_fixo R$ 50)
3. Faixas de agente_ia: Starter (500/dia, R$ 197), Profissional (1500/dia, R$ 500), Enterprise (5000/dia, R$ 997), Ilimitado (999999/dia, R$ 1997)
4. Usuário master: nome="William", email="admin@plataforma.com", role="master", senha bcrypt
5. Alertas padrão globais: 80% e 100% do limite diário

## DOCKER-COMPOSE

Deve subir: PostgreSQL 15, Redis 7, e o backend Node.js. 
Volumes persistentes para PostgreSQL.
Variáveis de ambiente via .env.

## PACKAGE.JSON

Dependências:
- fastify, @fastify/cors, @fastify/jwt, @fastify/rate-limit
- pg (PostgreSQL driver)
- ioredis
- bcrypt
- dotenv
- uuid
- crypto (nativo, para AES-256)
- node-fetch (ou fetch nativo)

Scripts:
- "start": "node src/server.js"
- "dev": "node --watch src/server.js"
- "migrate": "node scripts/migrate.js"
- "migrate:down": "node scripts/migrate-down.js"
- "seed": "node scripts/seed.js"

## SCRIPT DE MIGRATE (scripts/migrate.js)

Lê todos os arquivos de /migrations em ordem numérica, executa os que ainda não foram executados. Usa uma tabela _migrations para controlar quais já rodaram.

## ENTREGÁVEIS

1. docker-compose.yml
2. backend/.env.example
3. backend/package.json
4. backend/Dockerfile
5. backend/src/config/database.js
6. backend/src/config/redis.js
7. backend/src/config/env.js
8. backend/src/config/constants.js
9. backend/src/server.js (Fastify básico, apenas health check por enquanto)
10. backend/migrations/001_create_planos.sql até 026_create_alertas_config.sql
11. backend/scripts/migrate.js
12. backend/scripts/migrate-down.js
13. backend/scripts/seed.js
14. README.md com instruções de setup

## CRITÉRIOS DE VALIDAÇÃO

- docker-compose up sobe sem erros
- npm run migrate executa todas as migrations
- npm run seed insere dados iniciais
- Todas as tabelas existem no banco com tipos corretos
- Todas as FKs e constraints funcionam
- Indexes criados corretamente
- GET /health retorna { status: 'ok' }
```

---

### Subfase 1B — Middlewares + Autenticação

**Pré-requisito:** Subfase 1A concluída e funcionando.

**Prompt para colar no Claude:**

```
Estou construindo uma plataforma SaaS multi-tenant de agentes IA. A Fase 1A (banco de dados + setup) já está concluída. Agora preciso de todos os middlewares e o sistema de autenticação.

[ANEXE: todo o código da Fase 1A que foi gerado]

## OBJETIVO

Criar todos os 5 middlewares do sistema e as rotas de autenticação completas.

## MIDDLEWARE 1: auth.js

Localização: /backend/src/middleware/auth.js

Função: Valida JWT em toda request autenticada.

Lógica:
1. Extrai token do header Authorization: Bearer <token>
2. Se não tem token → 401 "Token não fornecido"
3. Verifica JWT com a secret
4. Se inválido/expirado → 401 "Token inválido ou expirado"
5. Busca usuário no banco pelo id do payload
6. Se não encontrou ou inativo → 401 "Usuário não encontrado"
7. Injeta request.user = { id, empresa_id, role, nome, email }
8. Se role é master, empresa_id pode ser null

## MIDDLEWARE 2: tenant.js

Localização: /backend/src/middleware/tenant.js

Função: Garante isolamento multi-tenant injetando empresa_id.

Lógica:
1. Se user.role === 'master':
   - Se header X-Empresa-Id presente → usa esse (impersonate)
   - Se não → request.empresaId = null (contexto master)
   - request.isMaster = true
   - request.isImpersonating = !!header X-Empresa-Id
2. Se user.role !== 'master':
   - request.empresaId = user.empresa_id
   - request.isMaster = false
   - request.isImpersonating = false
3. Se rota requer empresa_id e é null → 400 "Empresa não especificada"

Exporta helper: addTenantFilter(query, empresaId) que adiciona WHERE empresa_id = $N

## MIDDLEWARE 3: permission.js

Localização: /backend/src/middleware/permission.js

Função: Verifica se o role do usuário pode acessar o recurso.

Mapa de permissões:
- master: tudo
- admin: tudo na sua empresa (agentes, tools, inboxes, numeros, api-keys, usuarios, conversas, logs, dashboard, config)
- operador: dashboard (leitura), logs (leitura), testar agente, conversas (leitura)
- viewer: dashboard (leitura), logs (leitura)

Exporta função: requirePermission(recurso, acao) retorna middleware
Exemplo: requirePermission('agentes', 'write')

## MIDDLEWARE 4: limit.js

Localização: /backend/src/middleware/limit.js

Função: Verifica se a empresa não excedeu limites da assinatura.

Exporta: checkLimit(tipoRecurso) retorna middleware
Exemplo: checkLimit('agente_ia') → antes de criar agente, verifica se quantidade atual < quantidade contratada em assinatura_itens

Lógica para agente_ia:
1. Busca assinatura_itens WHERE empresa_id AND item_cobravel.slug = 'agente_ia' AND ativo
2. Se não encontrou → 403 "Sem item contratado para agentes IA"
3. quantidade_contratada = item.quantidade
4. quantidade_atual = COUNT agentes WHERE empresa_id AND ativo
5. Se atual >= contratada → 403 "Limite de {X} agentes atingido"

Lógica para numero_whatsapp:
1. Mesma lógica com slug = 'numero_whatsapp'
2. Conta whatsapp_numbers ativos

## MIDDLEWARE 5: rate-limit.js

Localização: /backend/src/middleware/rate-limit.js

Usa @fastify/rate-limit configurado:
- Global: 1000 requests/minuto por IP
- /api/chat: 200 requests/minuto por empresa_id
- /api/auth/login: 10 requests/minuto por IP

## ROTAS DE AUTENTICAÇÃO

Localização: /backend/src/routes/auth.js

### POST /api/auth/login
Body: { email, senha }
1. Busca usuário por email (ativo = true)
2. Compara senha com bcrypt
3. Se ok → gera JWT com { id, empresa_id, role }
4. Atualiza ultimo_login
5. Retorna { token, refreshToken, usuario: { id, nome, email, role, empresa_id } }

### POST /api/auth/refresh
Body: { refreshToken }
1. Valida refresh token
2. Gera novo JWT + novo refreshToken
3. Retorna { token, refreshToken }

### GET /api/auth/me
Header: Authorization Bearer
1. Retorna dados do usuário logado
2. Se admin: inclui dados da empresa
3. Se master: inclui flag isMaster

### POST /api/auth/forgot-password
Body: { email }
1. Gera token de reset (UUID)
2. Salva hash do token no banco (campo reset_token_hash, reset_token_expires)
3. Por enquanto apenas retorna { message: "Se o email existir, enviamos instruções" } (sem envio de email ainda)
4. Token expira em 1h

### POST /api/auth/reset-password
Body: { token, novaSenha }
1. Busca usuário com reset_token_hash válido e não expirado
2. Atualiza senha (bcrypt)
3. Limpa reset_token
4. Retorna { message: "Senha alterada" }

## MIGRATION ADICIONAL

026_add_reset_token_to_usuarios.sql
- Adiciona: reset_token_hash VARCHAR(255), reset_token_expires TIMESTAMPTZ

## REGISTRAR MIDDLEWARES NO SERVER.JS

server.js deve:
1. Registrar @fastify/cors (origin: *, credentials: true)
2. Registrar @fastify/jwt
3. Registrar @fastify/rate-limit
4. Registrar rotas de auth (sem middleware de auth)
5. Middleware de auth aplicado em todas EXCETO /api/auth/*

## ENTREGÁVEIS

1. backend/src/middleware/auth.js
2. backend/src/middleware/tenant.js
3. backend/src/middleware/permission.js
4. backend/src/middleware/limit.js
5. backend/src/middleware/rate-limit.js
6. backend/src/routes/auth.js
7. backend/src/config/encryption.js (funções encrypt/decrypt AES-256 para API keys)
8. backend/migrations/027_add_reset_token_to_usuarios.sql
9. Atualização do backend/src/server.js com registro de todos os middlewares e rotas

## CRITÉRIOS DE VALIDAÇÃO

- POST /api/auth/login com credenciais corretas retorna JWT
- POST /api/auth/login com credenciais erradas retorna 401
- GET /api/auth/me com token válido retorna dados do usuário
- GET /api/auth/me sem token retorna 401
- Middleware tenant injeta empresa_id corretamente
- Middleware permission bloqueia viewer de acessar /api/agentes POST
- Middleware limit bloqueia criação quando excede quantidade contratada
- Encrypt/decrypt de API keys funciona corretamente
```

---

### Subfase 1C — Serviço Gemini + Tool Runner + Memória Redis

**Pré-requisito:** Subfase 1B concluída.

**Prompt para colar no Claude:**

```
Estou construindo uma plataforma SaaS multi-tenant de agentes IA. As Fases 1A (banco) e 1B (auth + middlewares) estão concluídas. Agora preciso dos serviços core: Gemini API com function calling, tool runner, e memória Redis.

[ANEXE: código relevante das fases anteriores]

## OBJETIVO

Criar os 3 serviços que formam o cérebro do sistema:
1. gemini.js — Chama a API Gemini com function calling
2. tool-runner.js — Executa tools via HTTP
3. memory.js — Gerencia histórico de conversa no Redis

## SERVIÇO 1: gemini.js

Localização: /backend/src/services/gemini.js

### Função principal: processMessage(options)

Parâmetros:
```js
{
  apiKey: string,          // API key decriptada
  model: string,           // "gemini-2.0-flash-001"
  systemPrompt: string,    // Prompt do agente
  tools: [{                // Tools do agente (formato Gemini)
    name: string,
    description: string,
    parameters: object     // JSON Schema
  }],
  history: [{              // Histórico do Redis
    role: 'user' | 'model',
    parts: [{ text: string }]
  }],
  message: string,         // Mensagem atual do cliente
  temperature: number,     // 0.0-1.0
  maxTokens: number        // max output tokens
}
```

### Lógica com Function Calling Loop:

1. Montar request body para Gemini API:
   ```
   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}
   ```
2. Enviar com:
   - systemInstruction: { parts: [{ text: systemPrompt }] }
   - contents: [...history, { role: 'user', parts: [{ text: message }] }]
   - tools: [{ functionDeclarations: tools }]
   - generationConfig: { temperature, maxOutputTokens: maxTokens }

3. LOOP DE FUNCTION CALLING:
   - Receber resposta
   - Se resposta contém functionCall:
     a. Retornar { type: 'tool_call', toolName, toolArgs } para o caller
     b. Caller executa a tool e devolve o resultado
     c. Adicionar ao contents: { role: 'model', parts: [{ functionCall }] } e { role: 'function', parts: [{ functionResponse }] }
     d. Fazer nova chamada ao Gemini com o resultado da tool
     e. Repetir até MAX 5 iterações (evitar loop infinito)
   - Se resposta contém text (sem functionCall):
     a. Retornar { type: 'text', text, tokensInput, tokensOutput }

4. Contabilizar tokens do usageMetadata

5. Tratamento de erros:
   - 429 → throw com código 'RATE_LIMITED'
   - 401/403 → throw com código 'INVALID_KEY'
   - 500 → throw com código 'API_ERROR'
   - Timeout (30s) → throw com código 'TIMEOUT'

### Retorno final:
```js
{
  text: string,            // Resposta final do agente
  toolsCalled: [{          // Tools que foram chamadas
    name: string,
    args: object,
    result: object
  }],
  tokensInput: number,
  tokensOutput: number,
  model: string,
  iteracoes: number        // Quantas chamadas ao Gemini foram feitas
}
```

## SERVIÇO 2: tool-runner.js

Localização: /backend/src/services/tool-runner.js

### Função: executeTool(tool, args)

Parâmetros:
- tool: { url, metodo, headers_json, body_template_json, timeout_ms }
- args: object (argumentos preenchidos pelo LLM)

Lógica:
1. Mesclar args no body_template_json (substituir {{variavel}} pelos valores)
2. Se body_template_json está vazio, enviar args direto como body
3. Fazer HTTP request:
   - URL: tool.url
   - Método: tool.metodo
   - Headers: { 'Content-Type': 'application/json', ...tool.headers_json }
   - Body: JSON resultante
   - Timeout: tool.timeout_ms
4. Se resposta ok → retornar body da resposta
5. Se erro → retornar { error: 'Tool falhou', status: response.status, message: body }
6. Se timeout → retornar { error: 'Tool timeout', timeout: tool.timeout_ms }

### Função: buildToolDeclarations(tools)

Converte array de tools do banco para formato Gemini function declarations:
```js
tools.map(t => ({
  name: t.nome,
  description: t.descricao_para_llm,
  parameters: t.parametros_schema_json
}))
```

## SERVIÇO 3: memory.js

Localização: /backend/src/services/memory.js

### Chave Redis: `conv:{empresaId}:{conversationIdChatwoot}`

### Função: getHistory(empresaId, conversationId)
1. Busca no Redis a chave
2. Se não existe → retorna []
3. Retorna array de mensagens no formato Gemini contents

### Função: addToHistory(empresaId, conversationId, role, text)
1. Busca histórico atual
2. Adiciona { role, parts: [{ text }] }
3. Se histórico > 50 mensagens, remove as mais antigas (manter as 50 mais recentes)
4. Salva no Redis com TTL de 24h
5. Retorna novo histórico

### Função: addToolCallToHistory(empresaId, conversationId, functionCall, functionResponse)
1. Adiciona { role: 'model', parts: [{ functionCall }] }
2. Adiciona { role: 'function', parts: [{ functionResponse: { name, response: functionResponse } }] }
3. Salva com TTL 24h

### Função: clearHistory(empresaId, conversationId)
1. Deleta a chave do Redis

### Função: getSessionData(empresaId, conversationId)
1. Chave: `session:{empresaId}:{conversationId}`
2. Retorna dados extras (CPF salvo, produto escolhido, etc.)

### Função: setSessionData(empresaId, conversationId, data)
1. Salva/merge dados na session
2. TTL 24h

## SERVIÇO 4: api-key-manager.js

Localização: /backend/src/services/api-key-manager.js

### Função: getActiveKey(empresaId)

Lógica de seleção com failover:
1. Buscar api_keys WHERE empresa_id AND status IN ('ativa', 'rate_limited') AND (retry_apos IS NULL OR retry_apos <= NOW()) ORDER BY prioridade ASC
2. Filtrar: pegar primeira com status = 'ativa'
3. Se não tem ativa → pegar primeira rate_limited com retry_apos <= NOW()
4. Se nenhuma disponível → throw 'NO_KEYS_AVAILABLE'
5. Decriptar api_key_encrypted
6. Retornar { id, apiKey (decriptada), provedor }

### Função: reportSuccess(keyId)
1. UPDATE api_keys SET total_requests_hoje = total_requests_hoje + 1, ultimo_uso = NOW(), tentativas_erro = 0, status = 'ativa' WHERE id = keyId

### Função: reportError(keyId, errorCode, errorMsg)
Se errorCode = 'RATE_LIMITED':
1. UPDATE status = 'rate_limited', retry_apos = NOW() + 60s, ultimo_erro = NOW(), ultimo_erro_msg
Se errorCode = 'INVALID_KEY':
1. UPDATE status = 'erro', ultimo_erro = NOW(), ultimo_erro_msg, tentativas_erro = tentativas_erro + 1
Se errorCode = 'API_ERROR' ou 'TIMEOUT':
1. UPDATE retry_apos = NOW() + 30s, ultimo_erro = NOW(), ultimo_erro_msg

### Função: reportTokens(keyId, tokensInput, tokensOutput)
1. UPDATE total_tokens_hoje = total_tokens_hoje + tokensInput + tokensOutput

### Função: resetDailyCounters()
1. UPDATE api_keys SET total_requests_hoje = 0, total_tokens_hoje = 0 WHERE total_requests_hoje > 0

## ENTREGÁVEIS

1. backend/src/services/gemini.js
2. backend/src/services/tool-runner.js
3. backend/src/services/memory.js
4. backend/src/services/api-key-manager.js
5. backend/src/config/encryption.js (se não feito na 1B)

## CRITÉRIOS DE VALIDAÇÃO

- gemini.js faz chamada real ao Gemini e recebe resposta
- gemini.js executa loop de function calling (tool → resultado → nova chamada)
- gemini.js para após 5 iterações máximo
- tool-runner.js faz HTTP request e retorna resultado
- tool-runner.js respeita timeout
- memory.js salva e recupera histórico do Redis
- memory.js limita a 50 mensagens
- memory.js TTL de 24h funciona
- api-key-manager.js seleciona key ativa correta
- api-key-manager.js faz failover quando key dá rate limit
- api-key-manager.js marca key como erro quando inválida
```

---

### Subfase 1D — Endpoint /api/chat (O Coração do Sistema)

**Pré-requisito:** Subfase 1C concluída.

**Prompt para colar no Claude:**

```
Estou construindo uma plataforma SaaS multi-tenant de agentes IA. As Fases 1A (banco), 1B (auth + middlewares) e 1C (gemini + tools + memória) estão concluídas. Agora preciso do endpoint principal: POST /api/chat — o coração de todo o sistema.

[ANEXE: código relevante das fases anteriores]

## OBJETIVO

Criar o endpoint POST /api/chat que:
1. Recebe mensagem do n8n (webhook WhatsApp)
2. Identifica empresa e agente pelo phone_number_id
3. Verifica controle (IA vs humano)
4. Processa com o agente IA correto
5. Executa transferências entre agentes quando necessário
6. Contabiliza atendimentos
7. Verifica limites diários
8. Retorna resposta para o n8n disparar no WhatsApp
9. Espelha mensagem no Chatwoot

## ROTA: POST /api/chat

Localização: /backend/src/routes/chat.js

### Este endpoint NÃO usa auth JWT (é chamado pelo n8n via webhook)
### Usar uma API_KEY fixa configurável em env (WEBHOOK_API_KEY) para autenticar

### Request Body (vindo do n8n):
```json
{
  "message": "Oi, quero consultar meu FGTS",
  "phone_number_id": "710785522115859",
  "from": "5534991234567",
  "conversation_id_chatwoot": 123,
  "inbox_id_chatwoot": 4,
  "message_type": "incoming",
  "content_type": "text",
  "timestamp": "2026-02-10T08:00:00Z"
}
```

### Fluxo Completo (step by step):

**PASSO 1: Autenticação do webhook**
- Verificar header X-Webhook-Key === process.env.WEBHOOK_API_KEY
- Se inválido → 401

**PASSO 2: Identificar empresa pelo phone_number_id**
```sql
SELECT wn.*, i.*, e.id as empresa_id, e.nome as empresa_nome, e.chatwoot_url, e.chatwoot_api_token, e.chatwoot_account_id
FROM whatsapp_numbers wn
JOIN inboxes i ON i.id = wn.inbox_id
JOIN empresas e ON e.id = wn.empresa_id
WHERE wn.phone_number_id = $1 AND wn.ativo = true AND e.ativo = true
```
- Se não encontrou → 404 "Número não cadastrado"

**PASSO 3: Buscar ou criar conversa**
```sql
SELECT * FROM conversas 
WHERE empresa_id = $1 AND conversation_id_chatwoot = $2 AND status = 'ativo'
```
- Se não existe → criar nova conversa com agente_id = inbox.agente_id (triagem)
- Se existe → usar conversa existente

**PASSO 4: Verificar controle**
- Se conversa.controlado_por === 'humano':
  - Registrar mensagem no log (apenas para rastreio)
  - Retornar { action: 'skip', reason: 'Humano atendendo' }
  - NÃO processar com IA

**PASSO 5: Carregar agente atual**
```sql
SELECT a.*, 
  (SELECT conteudo FROM prompts WHERE agente_id = a.id AND ativo = true LIMIT 1) as prompt_ativo
FROM agentes a WHERE a.id = $1 AND a.ativo = true
```
- Se agente inativo → fallback para agente de triagem da empresa

**PASSO 6: Verificar limite diário do agente (se conta_atendimento = true)**
- Buscar/criar uso_diario_agente para hoje
- Verificar se é conversa NOVA com este agente (não continuação)
  - Nova = primeira mensagem deste agente nesta conversa
  - Verificar em historico_agentes_json se agente_id já aparece
- Se é nova E agente.conta_atendimento = true:
  - Verificar total_atendimentos < limite_diario
  - Se atingiu limite:
    - Retornar { action: 'limit_reached', response: agente.mensagem_limite_atingido }
    - Marcar limite_atingido = true
    - Criar notificação
  - Se ok: incrementar total_atendimentos
  - Criar registro em atendimentos

**PASSO 7: Carregar tools do agente**
```sql
SELECT t.* FROM tools t
JOIN agente_tools at ON at.tool_id = t.id
WHERE at.agente_id = $1 AND at.ativo = true AND t.ativo = true
ORDER BY at.ordem_prioridade
```

**PASSO 8: Obter API key**
- Chamar apiKeyManager.getActiveKey(empresa_id)
- Se sem key → retornar erro

**PASSO 9: Carregar histórico do Redis**
- memory.getHistory(empresa_id, conversation_id_chatwoot)

**PASSO 10: Chamar Gemini**
```js
const result = await gemini.processMessage({
  apiKey: key.apiKey,
  model: agente.modelo_llm,
  systemPrompt: prompt_ativo,
  tools: toolRunner.buildToolDeclarations(tools),
  history: history,
  message: message,
  temperature: agente.temperatura,
  maxTokens: agente.max_tokens
})
```

DURANTE o loop de function calling:
- Quando Gemini retorna tool_call:
  a. Encontrar tool pelo nome no array de tools
  b. Executar: toolRunner.executeTool(tool, args)
  c. Adicionar ao histórico: memory.addToolCallToHistory(...)
  d. Se tool.nome === 'TRANSFERIR_AGENTE':
     - Processar transferência (ver PASSO 11)
  e. Devolver resultado ao Gemini para continuar

**PASSO 11: Processar transferência entre agentes (se houver)**
Quando o agente invoca uma tool especial TRANSFERIR_AGENTE ou quando o resultado indica transferência:
1. Buscar regra em agente_transferencias pelo agente_origem e trigger
2. Se encontrou:
   - Atualizar conversa: agente_id = agente_destino_id
   - Adicionar ao historico_agentes_json
   - Se transferir_historico = false: memory.clearHistory(...)
   - NÃO interromper a resposta atual — a mensagem de transição vem do agente de triagem

**PASSO 12: Salvar no histórico Redis**
- memory.addToHistory(empresa_id, conv_id, 'user', message)
- memory.addToHistory(empresa_id, conv_id, 'model', result.text)

**PASSO 13: Reportar uso da API key**
- apiKeyManager.reportSuccess(key.id)
- apiKeyManager.reportTokens(key.id, result.tokensInput, result.tokensOutput)

**PASSO 14: Registrar log**
```sql
INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, tokens_input, tokens_output, tools_invocadas_json, modelo_usado, api_key_usada_id, latencia_ms)
```
- Registrar também mensagem de entrada (direcao = 'entrada')
- Registrar mensagem de saída (direcao = 'saida')

**PASSO 15: Atualizar contadores mensais**
```sql
INSERT INTO uso_mensal (empresa_id, ano_mes, total_mensagens, total_tokens_input, total_tokens_output, total_tool_calls)
VALUES ($1, $2, 1, $3, $4, $5)
ON CONFLICT (empresa_id, ano_mes) DO UPDATE SET
  total_mensagens = uso_mensal.total_mensagens + 1,
  total_tokens_input = uso_mensal.total_tokens_input + $3,
  total_tokens_output = uso_mensal.total_tokens_output + $4,
  total_tool_calls = uso_mensal.total_tool_calls + $5,
  atualizado_em = NOW()
```

**PASSO 16: Espelhar no Chatwoot**
- Chamar chatwoot.sendMessage(empresa, conversation_id_chatwoot, result.text)
- Se falhar → logar erro mas NÃO falhar a resposta

**PASSO 17: Retornar resposta**
```json
{
  "action": "reply",
  "response": "Olá! Sou a Mary da Santana Cred 😊...",
  "conversation_id": 123,
  "agente": "Mary Triagem",
  "tools_used": ["SALVA_CPF"],
  "latency_ms": 1842
}
```

## SERVIÇO AUXILIAR: chatwoot.js

Localização: /backend/src/services/chatwoot.js

### Função: sendMessage(empresa, conversationId, content)
POST {empresa.chatwoot_url}/api/v1/accounts/{empresa.chatwoot_account_id}/conversations/{conversationId}/messages
Headers: { api_access_token: empresa.chatwoot_api_token }
Body: { content, message_type: 'outgoing', content_type: 'text' }

### Função: sendPrivateNote(empresa, conversationId, content)
Mesmo endpoint mas com content_type: 'private_note' (para debug/logs)

## TRATAMENTO DE ERROS

Todo o fluxo deve estar em try/catch com tratamento específico:
- Se API key rate limited → tentar próxima key (retry automático)
- Se todas as keys falharam → retornar mensagem padrão de indisponibilidade
- Se tool falhou → informar ao Gemini que a tool falhou e deixar ele decidir
- Se Redis falhou → continuar sem histórico (log warning)
- Se Chatwoot falhou → continuar normalmente (log warning)
- NUNCA deixar o endpoint crashar — sempre retornar algo pro n8n

## ENTREGÁVEIS

1. backend/src/routes/chat.js
2. backend/src/services/chatwoot.js
3. Atualização do server.js para registrar a rota /api/chat
4. Atualização do .env.example com WEBHOOK_API_KEY

## CRITÉRIOS DE VALIDAÇÃO

Testar com curl/Postman:
- POST /api/chat com mensagem simples → retorna resposta do Gemini
- POST /api/chat com mensagem que invoca tool → tool é executada e resultado volta
- POST /api/chat com conversa controlada por humano → retorna skip
- POST /api/chat quando limite atingido → retorna mensagem de limite
- POST /api/chat com API key inválida → failover para próxima key
- Histórico no Redis persiste entre mensagens
- Logs são registrados no banco
- Contadores mensais são atualizados
- Mensagem é espelhada no Chatwoot
```

---

### Subfase 1E — Webhook Chatwoot + Controle IA/Humano + Job de Timeout

**Pré-requisito:** Subfase 1D concluída.

**Prompt para colar no Claude:**

```
Estou construindo uma plataforma SaaS multi-tenant de agentes IA. As Fases 1A-1D estão concluídas (banco, auth, Gemini, /api/chat). Agora preciso do webhook que recebe eventos do Chatwoot para controle IA/humano e o job de timeout.

[ANEXE: código relevante das fases anteriores]

## OBJETIVO

1. Endpoint que recebe webhooks do Chatwoot (assign/unassign/notas privadas)
2. Lógica de troca de controle IA ↔ humano
3. Job agendado que devolve conversas pra IA quando humano fica inativo

## ROTA: POST /api/webhook/chatwoot

Localização: /backend/src/routes/webhook-chatwoot.js

### Autenticação: Header X-Chatwoot-Webhook-Secret (configurável por empresa)

### Eventos que precisamos processar:

**1. conversation_updated (assign/unassign)**
```json
{
  "event": "conversation_updated",
  "data": {
    "id": 123,
    "inbox_id": 4,
    "account_id": 1,
    "assignee": { "id": 45, "name": "João Silva" }  // null se desatribuiu
  }
}
```

Lógica:
a. Identificar empresa pelo account_id
b. Buscar conversa pelo conversation_id_chatwoot
c. Se assignee != null (humano atribuiu):
   - UPDATE conversas SET controlado_por='humano', humano_id, humano_nome, humano_assumiu_em=NOW()
   - INSERT controle_historico (acao='humano_assumiu')
   - Criar notificação se config permitir
d. Se assignee == null (humano desatribuiu):
   - UPDATE conversas SET controlado_por='ia', humano_devolveu_em=NOW()
   - INSERT controle_historico (acao='humano_devolveu')
   - Buscar config_controle_humano da empresa
   - Se mensagem_retorno_ia configurada:
     - Chamar /api/chat internamente com mensagem especial para IA reassumir
     - Ou enviar mensagem direta via Chatwoot: "Voltei! Desculpe a espera 😊"

**2. message_created (notas privadas com comandos)**
```json
{
  "event": "message_created",
  "data": {
    "content": "/devolver",
    "content_type": "text",
    "message_type": "outgoing",
    "private": true,
    "conversation": { "id": 123, "account_id": 1 }
  }
}
```

Lógica:
a. Se private == true E content começa com '/' (comando):
   - Buscar config_controle_humano da empresa
   - Se content === config.comando_assumir → executar lógica de humano assume
   - Se content === config.comando_devolver → executar lógica de devolver pra IA
b. Se message_type == "outgoing" E private == false E conversa.controlado_por == 'humano':
   - UPDATE conversas SET humano_ultima_msg_em = NOW()
   - (Para tracking de inatividade do humano)

## JOB DE TIMEOUT

Localização: /backend/src/jobs/timeout-checker.js

### Executa a cada 5 minutos via setInterval

Lógica:
1. Buscar todas as conversas:
```sql
SELECT c.*, cch.timeout_inatividade_minutos, cch.mensagem_retorno_ia, e.chatwoot_url, e.chatwoot_api_token, e.chatwoot_account_id
FROM conversas c
JOIN empresas e ON e.id = c.empresa_id
LEFT JOIN config_controle_humano cch ON cch.empresa_id = c.empresa_id
WHERE c.controlado_por = 'humano' 
  AND c.status = 'ativo'
  AND c.humano_ultima_msg_em < NOW() - INTERVAL '1 minute' * COALESCE(cch.timeout_inatividade_minutos, 30)
```

2. Para cada conversa encontrada:
   - UPDATE conversas SET controlado_por='ia', humano_devolveu_em=NOW()
   - INSERT controle_historico (acao='timeout_ia_reassumiu', motivo='Timeout X min')
   - Se mensagem_retorno_ia configurada:
     - Enviar mensagem via Chatwoot API para o cliente
   - Criar notificação (warning)
   - Logar evento

### Registrar job no server.js:
```js
// Iniciar job após server ready
const timeoutChecker = require('./jobs/timeout-checker');
fastify.ready().then(() => {
  timeoutChecker.start(); // setInterval a cada 5 min
});
```

## JOB DE RESET DIÁRIO DE API KEYS

Localização: /backend/src/jobs/daily-reset.js

Executa uma vez por dia à meia-noite:
1. Chamar apiKeyManager.resetDailyCounters()
2. Reativar keys rate_limited que já passaram retry_apos
3. Logar execução

## ENTREGÁVEIS

1. backend/src/routes/webhook-chatwoot.js
2. backend/src/jobs/timeout-checker.js
3. backend/src/jobs/daily-reset.js
4. Atualização do server.js para registrar rota e jobs
5. Atualização do .env.example

## CRITÉRIOS DE VALIDAÇÃO

- Webhook recebe evento de assign → conversa muda para humano
- Webhook recebe evento de unassign → conversa volta para IA
- Nota privada com /devolver → conversa volta para IA
- Job de timeout detecta conversas com humano inativo → devolve pra IA
- Job de reset diário zera contadores das API keys
- Mensagem de retorno é enviada quando IA reassume
- Tudo é registrado no controle_historico
- Notificações são criadas
```

---

### Subfase 1F — CRUDs Completos (Todas as rotas de gestão)

**Pré-requisito:** Subfase 1E concluída.

**Prompt para colar no Claude:**

```
Estou construindo uma plataforma SaaS multi-tenant de agentes IA. As Fases 1A-1E estão concluídas (banco, auth, Gemini, chat, webhooks). Agora preciso de TODAS as rotas CRUD do sistema.

[ANEXE: código relevante das fases anteriores]

## OBJETIVO

Criar TODAS as rotas CRUD restantes. Cada rota deve:
- Usar middleware auth (JWT)
- Usar middleware tenant (isolamento por empresa_id)
- Usar middleware permission (verificar role)
- Usar middleware limit (quando aplicável, ex: criar agente)
- Validar input (Fastify schema validation)
- Retornar respostas padronizadas
- Tratar erros

## FORMATO DE RESPOSTA PADRÃO

Sucesso:
```json
{ "success": true, "data": { ... } }
```

Sucesso com lista:
```json
{ "success": true, "data": [...], "total": 42, "page": 1, "perPage": 20 }
```

Erro:
```json
{ "success": false, "error": { "code": "LIMIT_REACHED", "message": "Limite de 5 agentes atingido" } }
```

## ROTAS A CRIAR

### 1. /backend/src/routes/empresas.js (Master only)
- GET /api/empresas — Listar empresas (com busca por nome, filtro por status)
- POST /api/empresas — Criar empresa (validar slug único, criar assinatura inicial)
- GET /api/empresas/:id — Detalhes da empresa (incluir contadores: agentes, números, msgs/mês)
- PUT /api/empresas/:id — Editar empresa
- DELETE /api/empresas/:id — Soft delete (ativo = false)
- POST /api/empresas/:id/impersonate — Gerar novo JWT com empresa_id injetada

### 2. /backend/src/routes/planos.js (Master only)
- GET /api/planos
- POST /api/planos
- PUT /api/planos/:id

### 3. /backend/src/routes/itens-cobraveis.js (Master only)
- GET /api/itens-cobraveis (incluir faixas)
- POST /api/itens-cobraveis
- PUT /api/itens-cobraveis/:id
- GET /api/faixas/:itemId
- POST /api/faixas/:itemId
- PUT /api/faixas/:id

### 4. /backend/src/routes/assinaturas.js (Master only)
- GET /api/assinaturas/:empresaId (com itens, faixas, resumo de cobrança)
- PUT /api/assinaturas/:empresaId (atualizar itens, quantidade, faixa)
  - Ao alterar: registrar em assinatura_historico
  - Recalcular preco_total
- GET /api/assinaturas/:empresaId/historico
- GET /api/assinaturas/:empresaId/faturas

### 5. /backend/src/routes/agentes.js
- GET /api/agentes — Listar agentes da empresa (incluir contadores: tools vinculadas, atend. hoje)
- POST /api/agentes — Criar agente (verificar limite via middleware limit)
- GET /api/agentes/:id — Detalhes (incluir prompt ativo, tools, transferências)
- PUT /api/agentes/:id — Editar
- DELETE /api/agentes/:id — Soft delete

### 6. /backend/src/routes/prompts.js
- GET /api/agentes/:id/prompts — Listar versões do prompt
- POST /api/agentes/:id/prompts — Criar nova versão (auto-incrementar versão)
- PUT /api/agentes/:agenteId/prompts/:promptId/ativar — Ativar versão (desativar a anterior)

### 7. /backend/src/routes/transferencias.js
- GET /api/agentes/:id/transferencias — Listar regras
- POST /api/agentes/:id/transferencias — Criar regra
- PUT /api/transferencias/:id — Editar regra
- DELETE /api/transferencias/:id — Deletar regra

### 8. /backend/src/routes/tools.js
- GET /api/tools — Listar tools da empresa (incluir agentes vinculados)
- POST /api/tools — Criar tool
- GET /api/tools/:id — Detalhes
- PUT /api/tools/:id — Editar
- DELETE /api/tools/:id — Soft delete
- POST /api/tools/:id/testar — Executa tool com args de teste e retorna resultado

### 9. /backend/src/routes/agente-tools.js
- GET /api/agentes/:id/tools — Listar tools vinculadas
- PUT /api/agentes/:id/tools — Atualizar vínculos (recebe array de {tool_id, ordem_prioridade})
  Body: { tools: [{ tool_id: "uuid", ordem_prioridade: 1 }, ...] }
  Lógica: deletar vínculos antigos, criar novos (transação)

### 10. /backend/src/routes/inboxes.js
- GET /api/inboxes — Listar inboxes (incluir agente vinculado e número)
- POST /api/inboxes — Criar inbox
- PUT /api/inboxes/:id — Editar (mudar agente vinculado)
- DELETE /api/inboxes/:id — Deletar

### 11. /backend/src/routes/whatsapp-numbers.js
- GET /api/whatsapp-numbers — Listar números (verificar limite)
- POST /api/whatsapp-numbers — Criar (verificar limite via middleware)
- PUT /api/whatsapp-numbers/:id — Editar
- DELETE /api/whatsapp-numbers/:id — Soft delete

### 12. /backend/src/routes/api-keys.js
- GET /api/api-keys — Listar (mascarar key: mostrar só últimos 4 chars)
- POST /api/api-keys — Criar (encriptar key)
- PUT /api/api-keys/:id — Editar (nome, prioridade, status)
- DELETE /api/api-keys/:id — Deletar
- PUT /api/api-keys/:id/ativar — Trocar key ativa (efeito imediato)
- POST /api/api-keys/:id/testar — Fazer chamada de teste ao Gemini

### 13. /backend/src/routes/usuarios.js
- GET /api/usuarios — Listar da empresa
- POST /api/usuarios — Criar (bcrypt senha, verificar limite)
- PUT /api/usuarios/:id — Editar (não pode editar master, não pode mudar próprio role)
- DELETE /api/usuarios/:id — Soft delete

### 14. /backend/src/routes/conversas.js
- GET /api/conversas — Listar ativas (com filtros: status, agente, controlado_por)
- GET /api/conversas/:id — Detalhes (incluir mensagens recentes)
- POST /api/conversas/:id/assumir — Admin força humano assumir
- POST /api/conversas/:id/devolver — Admin força IA reassumir
- GET /api/conversas/:id/historico-controle — Log de trocas IA/humano

### 15. /backend/src/routes/dashboard.js
- GET /api/dashboard — Métricas da empresa:
  - Atendimentos hoje (por agente)
  - Uso de limites (agentes, números, msgs)
  - Latência média hoje
  - Conversas ativas agora
  - Total mensagens mês
- GET /api/dashboard/global (Master only) — Métricas globais:
  - Total empresas ativas
  - Total agentes, números
  - Atendimentos hoje (todas empresas)
  - Receita mensal estimada
  - Empresas próximas do limite
  - Alertas

### 16. /backend/src/routes/logs.js
- GET /api/logs — Listar mensagens_log com filtros:
  - data_inicio, data_fim
  - agente_id
  - conversa_id
  - com_erro (boolean)
  - Paginação (page, perPage)
  - Ordenação (criado_em DESC)
- GET /api/logs/:id — Detalhes de uma mensagem (prompt completo, tools, resposta)

### 17. /backend/src/routes/configuracoes.js
- GET /api/configuracoes — Retorna config da empresa (config_controle_humano + dados empresa)
- PUT /api/configuracoes — Atualiza configurações

## REGISTRAR NO SERVER.JS

Todas as rotas devem ser registradas no server.js com o prefixo /api e os middlewares corretos.

## ENTREGÁVEIS

17 arquivos de rotas + server.js atualizado

## CRITÉRIOS DE VALIDAÇÃO

- Cada CRUD funciona end-to-end (criar, listar, editar, deletar)
- Middleware tenant filtra por empresa_id
- Middleware permission bloqueia acesso indevido
- Middleware limit bloqueia criação quando excede
- API keys são mascaradas na listagem
- Dashboard retorna métricas corretas
- Logs retornam com paginação
- Impersonate gera JWT com empresa_id
```

---

## FASE 2: FRONTEND ADMIN

### Subfase 2A — Setup Frontend + Login + Layout Base

```
[Prompt para configurar React + Tailwind + shadcn/ui + rotas + AuthContext + layout com sidebar]
```

### Subfase 2B — Dashboard da Empresa

```
[Prompt para criar tela A1 com cards, barras de progresso, métricas por agente]
```

### Subfase 2C — CRUD de Agentes + Editor de Prompt

```
[Prompt para criar telas A2, A2.1, A2.2 com editor de prompt versionado]
```

### Subfase 2D — Tools do Agente + Transferências

```
[Prompt para criar telas A2.3, A2.4, A3, A3.1]
```

### Subfase 2E — WhatsApp + Chatwoot + API Keys

```
[Prompt para criar telas A4, A5, A6]
```

### Subfase 2F — Conversas + Logs + Usuários + Config

```
[Prompt para criar telas A7, A8, A9, A10]
```

### Subfase 2G — Chat de Teste do Agente

```
[Prompt para criar tela A2.5 com chat interativo e debug panel]
```

---

## FASE 3: FRONTEND MASTER

### Subfase 3A — Dashboard Global + Empresas

```
[Prompt para criar telas M1, M2, M2.1]
```

### Subfase 3B — Assinaturas + Cobrança

```
[Prompt para criar tela M2.2 com gestão de itens, faixas, preços]
```

### Subfase 3C — Planos + Itens Cobráveis + Impersonate

```
[Prompt para criar telas M3, M4, M2.3]
```

---

## FASE 4: REFINAMENTOS

### Subfase 4A — Alertas + Notificações

```
[Prompt para sistema de alertas (80%, 100%), notificações no painel, badge na sidebar]
```

### Subfase 4B — Exportação + Gráficos Avançados

```
[Prompt para exportação CSV nos logs, gráficos interativos no dashboard com recharts]
```

### Subfase 4C — Docker Production + Deploy

```
[Prompt para Dockerfile otimizado, nginx, SSL, docker-compose de produção, EasyPanel]
```

### Subfase 4D — Testes + Documentação

```
[Prompt para testes automatizados das rotas core, documentação da API, README completo]
```

---

## NOTA SOBRE FASES 2, 3 E 4

Os prompts das Fases 2, 3 e 4 serão detalhados APÓS a Fase 1 estar 100% concluída e validada. Isso porque:

1. O frontend depende dos endpoints reais do backend
2. Podem surgir ajustes na API durante a Fase 1 que impactam o frontend
3. É melhor gerar prompts de frontend com base nos endpoints reais e testados

Quando terminar a Fase 1, solicite os prompts das Fases 2-4 e eles serão gerados com a mesma precisão.

---

## CHECKLIST DE VALIDAÇÃO FINAL DA FASE 1

Antes de ir para a Fase 2, confirme:

```
[  ] docker-compose up sobe sem erros
[  ] Todas as 26 migrations executam
[  ] Seed insere dados iniciais
[  ] Login funciona e retorna JWT
[  ] Middleware tenant isola dados por empresa
[  ] Middleware permission bloqueia acesso indevido
[  ] Middleware limit verifica quantidade contratada
[  ] POST /api/chat processa mensagem com Gemini
[  ] Function calling funciona (tool é executada)
[  ] Loop de function calling para em 5 iterações
[  ] Failover de API key funciona
[  ] Histórico Redis persiste entre mensagens
[  ] Transferência entre agentes funciona
[  ] Contagem de atendimentos funciona
[  ] Limite diário bloqueia quando atinge
[  ] Webhook Chatwoot assign/unassign funciona
[  ] Controle IA/humano troca corretamente
[  ] Job de timeout devolve pra IA
[  ] Espelhamento no Chatwoot funciona
[  ] Todos os CRUDs funcionam
[  ] Dashboard retorna métricas
[  ] Logs retornam com paginação
[  ] Nenhum endpoint crasha (sempre retorna resposta)
```
