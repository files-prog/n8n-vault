#!/usr/bin/env bash
# Desde tu portátil (WSL): sube tus cambios a GitHub y el servidor los trae con git pull y ejecuta deploy.sh.
# Uso:  git add -A && git commit -m "qué cambió"  &&  bash deploy/remoto.sh
# La primera vez el servidor necesita el clon en /srv/repos (bash preparar-servidor.sh, en la carpeta repos).
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=root@64.23.177.83
NAME=$(basename "$PWD"); B=$(git branch --show-current)
git diff --quiet && git diff --cached --quiet || echo "Aviso: hay cambios sin commit; no se desplegarán hasta que hagas commit."
git push -q origin "$B"
G="sudo git -C /srv/repos/$NAME"
ssh -t "$DEST" "$G fetch -q origin && $G checkout -q $B && $G pull -q --ff-only origin $B && echo \"servidor en: \$($G log --oneline -1)\" && sudo bash /srv/repos/$NAME/deploy/deploy.sh $*"
