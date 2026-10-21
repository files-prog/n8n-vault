#!/usr/bin/env bash
# Aplica en el servidor lo que acaba de traer `git pull` (lo llama .git/hooks/post-merge).
# Si termina con error, el hook vuelve solo al commit anterior y lo reaplica.
set -euo pipefail
cd "$(dirname "$0")/.."
nginx -t -q && systemctl reload nginx
docker compose -f docker-compose.standalone.yml up -d --build
for i in $(seq 30); do curl -fsS -o /dev/null http://127.0.0.1:3444/healthz && exit 0; sleep 2; done
echo "n8n-vault no responde en 127.0.0.1:3444"; exit 1
