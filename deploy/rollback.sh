#!/usr/bin/env bash
set -euo pipefail
# Solo restaura archivos (nunca permisos de carpetas: copiar "$BK/." sobre "/" cambiaría los de la raíz).
BK=${1:-$(ls -d /root/backups/n8n-vault/*/ | sort | tail -1)}
echo "Restaurando $BK"; (cd "$BK" && find . -mindepth 2 \( -type f -o -type l \) -print) | while IFS= read -r f; do cp -a "$BK/$f" "/${f#./}"; done; nginx -t && systemctl reload nginx; echo "Hecho."
