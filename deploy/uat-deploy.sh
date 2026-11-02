#!/usr/bin/env bash
#
# UAT deploy: update the checkout, then rebuild and restart the stack.
#
# Run from anywhere; it changes into the repository root. Usage:
#   bash deploy/uat-deploy.sh <tag-or-branch>
#   bash deploy/uat-deploy.sh            # pull the current branch
#
# The `.env` file is untracked and hand-managed, so updating the checkout with
# `git checkout -f` / `git pull` never overwrites it. Migrations and seeding
# run from the backend container entrypoint on start.
#
# DATABASE_URL is never committed. If it is present in the environment (the
# workflow passes it from the UAT_DATABASE_URL secret), this script writes it
# into `.env`; otherwise `.env` must already contain it.
set -euo pipefail

REF="${1:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Docker socket access needs the docker group. Add the deploy user once, then
# re-run this script in a shell that has that group -- a group change does not
# apply to the process that made it, and non-interactive SSH never re-logs-in.
if [ "${UAT_DOCKER_GROUP_REEXEC:-}" != "1" ] && ! id -nG | tr ' ' '\n' | grep -qx docker; then
  echo "[uat] $(id -un) is not in the docker group; adding it"
  if ! sudo -n usermod -aG docker "$(id -un)"; then
    echo "Could not add $(id -un) to the docker group without a password." >&2
    echo "Run once on the server: sudo usermod -aG docker $(id -un)" >&2
    exit 1
  fi
  printf -v script_q '%q' "$ROOT/deploy/uat-deploy.sh"
  if [ -n "$REF" ]; then
    printf -v ref_q '%q' "$REF"
    exec env UAT_DOCKER_GROUP_REEXEC=1 sg docker -c "bash $script_q $ref_q"
  fi
  exec env UAT_DOCKER_GROUP_REEXEC=1 sg docker -c "bash $script_q"
fi

if [ ! -f .env ]; then
  echo "Missing .env in $ROOT. Copy .env.docker.example to .env and fill it in." >&2
  exit 1
fi

if [ -n "${DATABASE_URL:-}" ]; then
  echo "[uat] updating DATABASE_URL in .env"
  sed -i '/^[[:space:]]*DATABASE_URL[[:space:]]*=/d' .env
  # Leading newline in case the file does not end with one, otherwise the line
  # would be glued onto the previous entry and never match the check below.
  printf '\nDATABASE_URL=%s\n' "$DATABASE_URL" >> .env
fi

chmod 600 .env 2>/dev/null || true

if ! grep -q '^DATABASE_URL=' .env; then
  echo "DATABASE_URL is missing from $ROOT/.env (expected the file at the repo root, not backend/.env)." >&2
  exit 1
fi

if [ ! -r .env ]; then
  echo "$ROOT/.env is not readable by $(id -un); fix its ownership with sudo." >&2
  exit 1
fi

echo "[uat] fetching refs"
git fetch --all --tags --prune

if [ -n "$REF" ]; then
  echo "[uat] checking out $REF"
  git checkout -f "$REF"
  # Tags are detached and need no pull; a branch should fast-forward.
  if git show-ref --verify --quiet "refs/remotes/origin/$REF"; then
    git pull --ff-only origin "$REF"
  fi
else
  echo "[uat] pulling current branch"
  git pull --ff-only
fi

echo "[uat] building and starting containers"
docker compose --env-file .env up -d --build --remove-orphans

docker image prune -f
docker compose --env-file .env ps
echo "[uat] done"
