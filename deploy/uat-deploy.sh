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
set -euo pipefail

REF="${1:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  echo "Missing .env in $ROOT. Copy .env.docker.example to .env and fill it in." >&2
  exit 1
fi

if ! grep -q '^DATABASE_URL=' .env; then
  echo "DATABASE_URL is missing from $ROOT/.env (expected the file at the repo root, not backend/.env)." >&2
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
