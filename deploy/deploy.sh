#!/usr/bin/env bash
# Instala el sitio nginx endurecido de vault.entirety.biz (DigitalOcean). El código no cambia.
# Uso: sudo bash deploy/deploy.sh            (añade --build para reconstruir el contenedor tras cambiar código)
set -euo pipefail
# Solo restaura archivos (nunca permisos de carpetas: copiar "$BK/." sobre "/" cambiaría los de la raíz).
cd "$(dirname "$0")/.."; REPO=$PWD
[ "$(id -u)" = 0 ] || { echo "Ejecuta con sudo"; exit 1; }
SITE=/etc/nginx/sites-available/vault.entirety.biz
BK=/root/backups/n8n-vault/$(date +%F-%H%M); mkdir -p "$BK"; chmod 700 "$BK"
for f in "$SITE" /etc/nginx/snippets/vault-proxy.conf; do [ -e "$f" ] && cp -a --parents "$f" "$BK/"; done
deshacer(){ echo; echo "!! Algo falló: restaurando $BK"; (cd "$BK" && find . -mindepth 2 \( -type f -o -type l \) -print) | while IFS= read -r f; do cp -a "$BK/$f" "/${f#./}"; done; nginx -t && systemctl reload nginx; exit 1; }
trap deshacer ERR
install -m 644 "$REPO/nginx/vault.entirety.biz.conf" "$SITE"
install -m 644 "$REPO/nginx/vault-proxy.conf" /etc/nginx/snippets/vault-proxy.conf
nginx -t; systemctl reload nginx; sleep 2
curl -fsS -o /dev/null --resolve vault.entirety.biz:443:127.0.0.1 https://vault.entirety.biz/healthz
if [ "${1:-}" = "--build" ]; then
  cp -a "$REPO/src" "$REPO/public" "$REPO/inject" "$REPO/package.json" "$REPO/Dockerfile" /root/n8n-vault/
  (cd /root/n8n-vault && docker compose -f docker-compose.standalone.yml up -d --build)
fi
trap - ERR
echo "Listo. Deshacer: sudo bash deploy/rollback.sh"
