# Plataforma Multi-Tenant de Agentes IA - Backend

Sistema de atendimento inteligente via WhatsApp com múltiplos agentes IA, integração Chatwoot e controle humano/IA.

## 🚀 Tecnologias

- **Node.js 20+** - Runtime JavaScript
- **Fastify** - Framework web de alta performance
- **PostgreSQL 15+** - Banco de dados relacional
- **Redis 7+** - Cache e gerenciamento de sessões
- **Gemini API** - LLM para processamento de linguagem natural
- **Docker** - Containerização

## 📋 Pré-requisitos

- Node.js 20 ou superior
- PostgreSQL 15 ou superior
- Redis 7 ou superior
- Docker e Docker Compose (opcional)

## 🔧 Instalação

### 1. Clone o repositório

```bash
git clone https://github.com/WillSantt89/ia_empresas_back.git
cd ia_empresas_back/backend
```

### 2. Instale as dependências

```bash
npm install
```

### 3. Configure as variáveis de ambiente

Copie o arquivo `.env.example` para `.env`:

```bash
cp .env.example .env
```

Edite o arquivo `.env` com suas configurações:

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/agent_platform
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-secret-key-min-32-chars
JWT_EXPIRES_IN=24h
JWT_REFRESH_EXPIRES_IN=7d
ENCRYPTION_KEY=your-aes-256-key-exactly-32-chars
PORT=3000
NODE_ENV=development
WEBHOOK_API_KEY=your-webhook-secret
```

### 4. Execute as migrações do banco de dados

```bash
npm run migrate
```

### 5. Popule o banco com dados iniciais

```bash
npm run seed
```

Isso criará:
- 3 planos (Starter, Pro, Enterprise)
- 2 itens cobráveis (agente_ia, numero_whatsapp)
- 4 faixas de preço para agentes
- Usuário master: `admin@plataforma.com` / `admin123`
- Empresa demo com usuário admin: `admin@empresa-demo.com` / `admin123`

## 🐳 Docker

Para executar com Docker:

```bash
docker-compose up -d
```

Isso iniciará:
- PostgreSQL na porta 5432
- Redis na porta 6379
- Backend na porta 3000

## 🏃‍♂️ Executando o projeto

### Desenvolvimento

```bash
npm run dev
```

### Produção

```bash
npm start
```

## 📡 API Endpoints

### Autenticação

- `POST /api/auth/login` - Login de usuário
- `POST /api/auth/refresh` - Renovar token
- `GET /api/auth/me` - Dados do usuário logado
- `POST /api/auth/forgot-password` - Esqueceu senha
- `POST /api/auth/reset-password` - Resetar senha

### Chat (Core)

- `POST /api/chat` - Processar mensagem do WhatsApp
- `POST /api/webhook/chatwoot` - Webhook do Chatwoot

### Gestão de Empresas (Master)

- `GET /api/empresas` - Listar empresas
- `POST /api/empresas` - Criar empresa
- `GET /api/empresas/:id` - Detalhes da empresa
- `PUT /api/empresas/:id` - Editar empresa
- `DELETE /api/empresas/:id` - Deletar empresa
- `POST /api/empresas/:id/impersonate` - Impersonar empresa

### Agentes IA

- `GET /api/agentes` - Listar agentes
- `POST /api/agentes` - Criar agente
- `GET /api/agentes/:id` - Detalhes do agente
- `PUT /api/agentes/:id` - Editar agente
- `DELETE /api/agentes/:id` - Deletar agente

### Tools (Ferramentas)

- `GET /api/tools` - Listar tools
- `POST /api/tools` - Criar tool
- `GET /api/tools/:id` - Detalhes da tool
- `PUT /api/tools/:id` - Editar tool
- `DELETE /api/tools/:id` - Deletar tool
- `POST /api/tools/:id/testar` - Testar tool

### Dashboard e Analytics

- `GET /api/dashboard` - Métricas da empresa
- `GET /api/dashboard/global` - Métricas globais (Master)

## 🔒 Segurança

- Autenticação via JWT
- Isolamento multi-tenant automático
- Rate limiting por endpoint
- Criptografia AES-256 para API keys
- Validação de permissões por role

## 👥 Roles de Usuário

- **master**: Acesso total ao sistema
- **admin**: Acesso total à empresa
- **operador**: Visualização e teste de agentes
- **viewer**: Apenas visualização

## 🔄 Jobs Agendados

- **Timeout Checker**: Verifica conversas inativas a cada 5 minutos
- **Daily Reset**: Reseta contadores diários à meia-noite

## 📊 Estrutura do Banco

O sistema possui 26 tabelas organizadas em:

- **Plataforma**: planos, itens_cobraveis, faixas_item, alertas_config
- **Empresas**: empresas, usuarios, api_keys, assinaturas
- **Infraestrutura**: inboxes, whatsapp_numbers
- **Inteligência**: agentes, prompts, tools, transferências
- **Operação**: conversas, atendimentos, logs, uso diário

## 🧪 Testes

```bash
# Executar testes (quando implementados)
npm test

# Testar endpoint de chat
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Key: your-webhook-secret" \
  -d '{"message": "Olá", "phone_number_id": "123", "from": "5511999999999"}'
```

## 📝 Licença

Proprietary - Todos os direitos reservados

## 🤝 Suporte

Para suporte, entre em contato: admin@plataforma.com