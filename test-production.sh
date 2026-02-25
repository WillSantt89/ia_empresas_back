#!/bin/bash

# Script para testar a API em produção
# Substitua API_URL pela URL do seu EasyPanel

# IMPORTANTE: Altere esta URL para a URL do seu backend no EasyPanel
API_URL="https://SEU-APP.easypanel.host"  # <-- ALTERE AQUI!

MASTER_EMAIL="admin@plataforma.com"
MASTER_PASSWORD="admin123"

echo "🧪 Testando API do Sistema de Agentes IA"
echo "========================================"
echo "📍 URL: $API_URL"
echo ""

# 1. Health check
echo "1️⃣ Health Check:"
curl -s "$API_URL/health" | jq . || echo "❌ Falha no health check"

# 2. Login
echo -e "\n2️⃣ Login Master:"
LOGIN_RESPONSE=$(curl -s -X POST "$API_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$MASTER_EMAIL\",\"password\":\"$MASTER_PASSWORD\"}")

TOKEN=$(echo $LOGIN_RESPONSE | jq -r .data.token 2>/dev/null)

if [ "$TOKEN" = "null" ] || [ -z "$TOKEN" ]; then
  echo "❌ Falha no login"
  echo $LOGIN_RESPONSE | jq . 2>/dev/null || echo $LOGIN_RESPONSE
  exit 1
else
  echo "✅ Login bem-sucedido"
  echo "Token obtido: ${TOKEN:0:20}..."
fi

# 3. Listar planos
echo -e "\n3️⃣ Listar Planos:"
curl -s "$API_URL/api/planos" \
  -H "Authorization: Bearer $TOKEN" | jq '.data[] | {id: .id, nome: .nome, preco: .preco_base_mensal}' 2>/dev/null || echo "❌ Falha ao listar planos"

# 4. Dashboard global
echo -e "\n4️⃣ Dashboard Global:"
curl -s "$API_URL/api/dashboard/global" \
  -H "Authorization: Bearer $TOKEN" | jq '.data' 2>/dev/null || echo "❌ Falha ao acessar dashboard"

# 5. Listar empresas
echo -e "\n5️⃣ Listar Empresas:"
curl -s "$API_URL/api/empresas" \
  -H "Authorization: Bearer $TOKEN" | jq '.data[] | {id: .id, nome: .nome, status: .status}' 2>/dev/null || echo "❌ Falha ao listar empresas"

# 6. Verificar configuração do sistema
echo -e "\n6️⃣ Configurações do Sistema:"
curl -s "$API_URL/api/auth/me" \
  -H "Authorization: Bearer $TOKEN" | jq '.data | {id: .id, email: .email, role: .role, empresa: .empresa_nome}' 2>/dev/null || echo "❌ Falha ao obter dados do usuário"

echo -e "\n✨ Testes concluídos!"
echo ""
echo "📝 Resumo:"
echo "- Se todos os testes passaram (✅), o backend está funcionando!"
echo "- Se algum teste falhou (❌), verifique:"
echo "  1. A URL está correta?"
echo "  2. O banco de dados foi inicializado (migrate + seed)?"
echo "  3. As variáveis de ambiente estão configuradas?"
echo "  4. Verifique os logs no EasyPanel"