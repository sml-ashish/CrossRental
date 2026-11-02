#!/bin/sh
# Container start-up: apply migrations, optionally seed, then run the API.
#
# - Migrations run on every boot and are idempotent (`migrate deploy` records
#   applied ones and skips them).
# - Seeding is also idempotent and creates the reference data (states, crane
#   types) and the internal SML accounts the first run needs. RUN_SEED=false
#   skips it once the database is set up.
# - SEED_DEMO_DATA=false keeps the demo vendors and cranes out of production.
set -e

echo "[entrypoint] applying database migrations"
npx prisma migrate deploy

if [ "${RUN_SEED:-true}" = "true" ]; then
  echo "[entrypoint] seeding reference data (SEED_DEMO_DATA=${SEED_DEMO_DATA:-false})"
  node dist/lib/seed.js
else
  echo "[entrypoint] skipping seed (RUN_SEED=${RUN_SEED})"
fi

echo "[entrypoint] starting API on port ${PORT:-3004}"
exec node dist/index.js
