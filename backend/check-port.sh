#!/bin/bash

echo "🔍 Verificando processos na porta 3000..."
ps aux | grep node | grep -v grep

echo -e "\n📍 Tentando identificar o que está na porta 3000..."
netstat -tlnp 2>/dev/null | grep :3000 || lsof -i :3000 2>/dev/null || echo "Não foi possível verificar (falta permissão)"

echo -e "\n💡 Matando processos node antigos..."
pkill -f "node src/server.js" || echo "Nenhum processo server.js rodando"
pkill -f "node debug-server.js" || echo "Nenhum processo debug-server.js rodando"

echo -e "\n✅ Iniciando debug server..."
node debug-server.js