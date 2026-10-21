#!/usr/bin/env bash
# Desde tu portátil (WSL): sube tus cambios a GitHub y el servidor los trae con git pull.
# Al hacer pull, el servidor aplica los cambios solo (deploy/aplicar.sh) y, si algo falla, vuelve al commit anterior.
# Uso:  git add -A && git commit -m "qué cambió"  &&  bash deploy/remoto.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=root@64.23.177.83; CARPETA=/root/n8n-vault
B=$(git branch --show-current)
git diff --quiet && git diff --cached --quiet || echo "Aviso: hay cambios sin commit; no se subirán hasta que hagas commit."
git push -q origin "$B"
ssh -t "$DEST" "cd $CARPETA && sudo git pull --ff-only origin $B"
