# Agent Platform - Multi-Tenant AI Agents for WhatsApp

A high-performance SaaS platform for managing AI agents that handle customer service via WhatsApp. Built to replace n8n as the AI orchestrator, offering better performance, granular control, and scalability.

## 🚀 Features

- **Multi-Tenant Architecture**: Complete data isolation between companies
- **AI Agent Management**: Create specialized agents with custom prompts and tools
- **WhatsApp Integration**: Official Business API integration
- **Human Handoff**: Seamless AI to human control via Chatwoot
- **Flexible Billing**: Per-agent and per-number pricing with usage tiers
- **API Key Failover**: Automatic failover between multiple LLM API keys
- **Real-time Monitoring**: Dashboard with metrics and logs
- **High Performance**: 3-5x faster than n8n implementation

## 🛠️ Tech Stack

- **Backend**: Node.js 20+ with Fastify
- **Database**: PostgreSQL 15+
- **Cache**: Redis 7+
- **AI**: Google Gemini API
- **Frontend**: React + Tailwind + shadcn/ui
- **Deployment**: Docker + Docker Compose

## 📋 Prerequisites

- Node.js 20+
- Docker and Docker Compose
- PostgreSQL 15+ (or use Docker)
- Redis 7+ (or use Docker)
- Gemini API Key

## 🚀 Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/your-org/agent-platform.git
cd agent-platform
```

### 2. Environment Setup

```bash
# Copy environment variables
cp backend/.env.example backend/.env

# Edit the .env file with your configurations
# - Database credentials
# - Redis credentials
# - JWT secrets
# - Encryption keys
```

### 3. Start with Docker Compose

```bash
# Start all services
docker-compose up -d

# Check logs
docker-compose logs -f

# Run migrations
docker-compose exec backend npm run migrate

# Seed initial data
docker-compose exec backend npm run seed
```

### 4. Access the Application

- Backend API: http://localhost:3000
- Health Check: http://localhost:3000/health

Default master user:
- Email: admin@plataforma.com
- Password: admin123

## 🏗️ Development Setup

### Backend Development

```bash
cd backend

# Install dependencies
npm install

# Run migrations
npm run migrate

# Seed database
npm run seed

# Start development server
npm run dev
```

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage
```

## 📁 Project Structure

```
agent-platform/
├── backend/
│   ├── src/
│   │   ├── config/       # Database, Redis, environment configs
│   │   ├── middleware/   # Auth, tenant, permissions, rate-limit
│   │   ├── routes/       # API endpoints
│   │   ├── services/     # Business logic, Gemini, tools
│   │   ├── models/       # Database queries
│   │   └── server.js     # Fastify server
│   ├── migrations/       # SQL migrations
│   ├── scripts/          # Utility scripts
│   └── Dockerfile
├── frontend/             # React application (Phase 2)
├── docker-compose.yml
└── README.md
```

## 🔧 Configuration

### Database Connection

The platform supports both internal (Docker) and external database connections:

```env
# Internal (Docker)
DATABASE_URL=postgresql://user:pass@postgres:5432/agent_platform

# External (Production)
DATABASE_URL=postgresql://user:pass@15.235.36.103:54329/wschat
```

### Redis Configuration

```env
# Internal (Docker)
REDIS_URL=redis://default:password@redis:6379

# External (Production)
REDIS_URL=redis://default:password@15.235.36.103:63799
```

## 🚀 Deployment

### Using Docker

```bash
# Build the image
docker build -t agent-platform-backend ./backend

# Run with environment variables
docker run -d \
  --name agent-platform \
  -p 3000:3000 \
  --env-file ./backend/.env \
  agent-platform-backend
```

### Using PM2

```bash
# Install PM2
npm install -g pm2

# Start the application
pm2 start backend/src/server.js --name agent-platform

# Save PM2 configuration
pm2 save
pm2 startup
```

## 📊 Architecture Overview

```mermaid
graph TD
    A[WhatsApp] -->|Webhook| B[n8n]
    B -->|HTTP Request| C[Backend API]
    C -->|Query| D[PostgreSQL]
    C -->|Cache| E[Redis]
    C -->|AI Processing| F[Gemini API]
    C -->|Monitoring| G[Chatwoot]
    H[Admin Panel] -->|API| C
```

## 🔐 Security

- JWT authentication with refresh tokens
- AES-256 encryption for API keys
- Multi-tenant data isolation
- Rate limiting per company
- CORS configuration
- SQL injection prevention
- Input validation and sanitization

## 📈 Performance

| Metric | n8n (Previous) | Agent Platform (New) |
|--------|----------------|---------------------|
| Latency | 3-8 seconds | 1-3 seconds |
| RAM per execution | 50-150 MB | 5-20 MB |
| Prompt size | ~10,000 tokens | 1,500-4,000 tokens |
| Concurrent messages | 10-20 | 100+ |

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📜 License

This project is proprietary and confidential. All rights reserved by Santana Cred.

## 🆘 Support

For support, email support@santanacred.com.br or open an issue in the repository.

---

Built with ❤️ by William / Santana Cred