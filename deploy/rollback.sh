#!/usr/bin/env bash
set -euo pipefail
BK=${1:-$(ls -d /root/backups/n8n-vault/*/ | sort | tail -1)}
echo "Restaurando $BK"; cp -a "$BK"/. /; nginx -t && systemctl reload nginx; echo "Hecho."
