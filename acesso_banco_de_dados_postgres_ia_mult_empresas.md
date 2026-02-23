# Acesso Banco de Dados — ia_mult_empresas

---

## PostgreSQL

| Campo | Valor |
|---|---|
| **Usuário** | `postgres` |
| **Senha** | `eb0a428497ad695b787f` |
| **Nome do Banco de Dados** | `wschat` |
| **Host Interno** | `wschat_ia_mult_empresas_db` |
| **Porta Interna** | `5432` |
| **URL de Conexão Interna** | `postgres://postgres:eb0a428497ad695b787f@wschat_ia_mult_empresas_db:5432/wschat?sslmode=disable` |
| **Host Externo** | `15.235.36.103` |
| **Porta Externa** | `54329` |
| **URL de Conexão Externa** | `postgres://postgres:eb0a428497ad695b787f@15.235.36.103:54329/wschat?sslmode=disable` |

---

## Redis

| Campo | Valor |
|---|---|
| **Usuário** | `default` |
| **Senha** | `b17497c484d027d251dc` |
| **Host Interno** | `wschat_ia_mult_empresas_redis` |
| **Porta Interna** | `6379` |
| **URL de Conexão Interna** | `redis://default:b17497c484d027d251dc@wschat_ia_mult_empresas_redis:6379` |
| **Host Externo** | `15.235.36.103` |
| **Porta Externa** | `63799` |
| **URL de Conexão Externa** | `redis://default:b17497c484d027d251dc@15.235.36.103:63799` |

---

## Variáveis de Ambiente (.env)

```env
# PostgreSQL
DATABASE_URL=postgres://postgres:eb0a428497ad695b787f@wschat_ia_mult_empresas_db:5432/wschat?sslmode=disable

# Redis
REDIS_URL=redis://default:b17497c484d027d251dc@wschat_ia_mult_empresas_redis:6379
```

> **Nota:** Use as URLs internas quando o backend estiver rodando no mesmo servidor (EasyPanel). Use as URLs externas para acessar de fora (ex: desenvolvimento local, ferramentas como DBeaver/pgAdmin).
