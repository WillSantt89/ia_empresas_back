# 🚀 Guia de Setup - Plataforma de Agentes IA

## Pré-requisitos

- Docker e Docker Compose
- Node.js 20+ (para desenvolvimento local)
- Git

## Setup Rápido com Docker

### 1. Clone os repositórios

```bash
git clone https://github.com/WillSantt89/ia_empresas_back.git
cd ia_empresas_back
```

### 2. Configure as variáveis de ambiente

```bash
cd backend
cp .env.example .env
# Edite o .env com suas configurações
```

### 3. Inicie os serviços

```bash
# Na raiz do projeto (onde está o docker-compose.yml)
docker-compose up -d
```

### 4. Execute as migrações

```bash
# Aguarde os containers iniciarem
sleep 10

# Execute as migrações
docker-compose exec backend npm run migrate
```

### 5. Popule o banco com dados iniciais

```bash
docker-compose exec backend npm run seed
```

## Credenciais Padrão

- **Master**: admin@plataforma.com / admin123
- **Admin Demo**: admin@empresa-demo.com / admin123
- **pgAdmin**: admin@admin.com / admin123

## URLs de Acesso

- **API**: http://localhost:3000
- **pgAdmin**: http://localhost:5050 (perfil tools)
- **Redis Commander**: http://localhost:8081 (perfil tools)

## Comandos Úteis

### Visualizar logs

```bash
docker-compose logs -f backend
```

### Executar testes da API

```bash
cd backend
./test-api.sh
```

### Acessar ferramentas administrativas

```bash
# Iniciar com pgAdmin e Redis Commander
docker-compose --profile tools up -d
```

### Parar os serviços

```bash
docker-compose down
```

### Limpar tudo (incluindo volumes)

```bash
docker-compose down -v
```

## Desenvolvimento Local

### 1. Instale as dependências

```bash
cd backend
npm install
```

### 2. Configure o banco local

```bash
# Crie o banco PostgreSQL local
createdb agent_platform

# Execute as migrações
npm run migrate

# Popule com dados
npm run seed
```

### 3. Inicie o servidor

```bash
npm run dev
```

## Estrutura da API

### Endpoints Principais

- `POST /api/auth/login` - Login
- `POST /api/chat` - Processar mensagem (webhook)
- `GET /api/dashboard` - Dashboard da empresa
- `GET /api/agentes` - Listar agentes
- `GET /api/tools` - Listar ferramentas

### Headers de Autenticação

```bash
Authorization: Bearer <JWT_TOKEN>
```

### Header de Webhook

```bash
X-Webhook-Key: webhook-secret-key-12345
```

## Troubleshooting

### Erro de conexão com banco

```bash
# Verifique se o PostgreSQL está rodando
docker-compose ps

# Reinicie o container
docker-compose restart postgres
```

### Erro de permissão

```bash
# Ajuste permissões dos arquivos
sudo chown -R $USER:$USER .
```

### Porta em uso

```bash
# Altere as portas no docker-compose.yml
# ou pare o serviço que está usando a porta
sudo lsof -i :3000
```

## Próximos Passos

1. Configure o Chatwoot
2. Configure números WhatsApp
3. Crie agentes e ferramentas
4. Teste o fluxo completo

## Suporte

Em caso de dúvidas, verifique:
- Logs: `docker-compose logs`
- README.md do projeto
- Código fonte em `/src`