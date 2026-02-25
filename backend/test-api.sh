#!/bin/bash

# Script para testar a API

API_URL="http://localhost:3000"
MASTER_EMAIL="admin@plataforma.com"
MASTER_PASSWORD="admin123"

echo "🧪 Testando API do Sistema de Agentes IA"
echo "========================================"

# Health check
echo -e "\n1️⃣ Health Check:"
curl -s "$API_URL/health" | jq .

# Login
echo -e "\n2️⃣ Login Master:"
LOGIN_RESPONSE=$(curl -s -X POST "$API_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$MASTER_EMAIL\",\"password\":\"$MASTER_PASSWORD\"}")

TOKEN=$(echo $LOGIN_RESPONSE | jq -r .data.token)

if [ "$TOKEN" = "null" ] || [ -z "$TOKEN" ]; then
  echo "❌ Falha no login"
  echo $LOGIN_RESPONSE | jq .
  exit 1
else
  echo "✅ Login bem-sucedido"
  echo "Token: ${TOKEN:0:20}..."
fi

# Listar planos
echo -e "\n3️⃣ Listar Planos:"
curl -s "$API_URL/api/planos" \
  -H "Authorization: Bearer $TOKEN" | jq '.data[] | {id: .id, nome: .nome, preco: .preco_base_mensal}'

# Dashboard global
echo -e "\n4️⃣ Dashboard Global:"
curl -s "$API_URL/api/dashboard/global" \
  -H "Authorization: Bearer $TOKEN" | jq '.data.metricas_globais'

# Listar empresas
echo -e "\n5️⃣ Listar Empresas:"
curl -s "$API_URL/api/empresas" \
  -H "Authorization: Bearer $TOKEN" | jq '.data[] | {id: .id, nome: .nome, plano: .plano_nome}'

# Teste de webhook (simulando mensagem WhatsApp)
echo -e "\n6️⃣ Teste de Webhook Chat (deve falhar sem configuração):"
curl -s -X POST "$API_URL/api/chat" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Key: webhook-secret-key-12345" \
  -d '{
    "message": "Olá, teste do sistema",
    "phone_number_id": "123456789",
    "from": "5511999999999",
    "conversation_id_chatwoot": 1,
    "inbox_id_chatwoot": 1,
    "message_type": "incoming",
    "content_type": "text",
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
  }' | jq .

echo -e "\n✨ Testes concluídos!"