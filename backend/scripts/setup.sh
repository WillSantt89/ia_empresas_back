#!/bin/bash

echo "🚀 Setup do Backend IA Empresas"
echo "================================"

# Check if .env exists
if [ ! -f .env ]; then
  echo "❌ Arquivo .env não encontrado!"
  echo "Copiando .env.example..."
  cp .env.example .env
  echo "⚠️  Configure as variáveis de ambiente no arquivo .env"
  exit 1
fi

echo "✅ Arquivo .env encontrado"

# Run diagnosis
echo -e "\n📋 Executando diagnóstico..."
npm run diagnose

# Ask to continue
echo -e "\nDeseja continuar com o setup? (s/n)"
read -r response
if [[ ! "$response" =~ ^[Ss]$ ]]; then
  exit 0
fi

# Run migrations
echo -e "\n🔄 Executando migrações..."
npm run migrate

# Run seed
echo -e "\n🌱 Populando banco de dados..."
npm run seed

# Final diagnosis
echo -e "\n📋 Diagnóstico final..."
npm run diagnose

echo -e "\n✨ Setup concluído!"
echo "Para iniciar o servidor: npm start"