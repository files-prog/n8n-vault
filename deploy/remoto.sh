#!/usr/bin/env bash
# Desde tu portátil (WSL): sube este repo al servidor y ejecuta deploy.sh allí.
# Uso:  bash deploy/remoto.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=root@64.23.177.83
NAME=$(basename "$PWD")
git diff --quiet 2>/dev/null || echo "Aviso: hay cambios sin commit (se suben igual)."
tar czf - --exclude .git --exclude node_modules --exclude .env . \
  | ssh "$DEST" "rm -rf /tmp/$NAME && mkdir -p /tmp/$NAME && tar xzf - -C /tmp/$NAME"
ssh -t "$DEST" "sudo bash /tmp/$NAME/deploy/deploy.sh $*"
