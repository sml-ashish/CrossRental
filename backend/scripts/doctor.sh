#!/usr/bin/env bash
#
# Checks that the local dev setup is actually wired up, and that the seeded
# demo credentials work. Safe to run repeatedly; it only reads.
#
# Usage:  ./scripts/doctor.sh
#
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

pass=0
fail=0

ok()   { printf '  \033[32mpass\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
info() { printf '  ----  %s\n' "$1"; }

echo
echo "Backend"
echo "-------"

if [ ! -f .env ]; then
  bad ".env missing — run: cp .env.example .env"
else
  ok ".env present"
  db_url=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)
  info "DATABASE_URL = ${db_url//:*@/:***@}"
fi

if command -v psql >/dev/null 2>&1; then
  if psql crossrental -tAc 'SELECT 1' >/dev/null 2>&1; then
    ok "database 'crossrental' reachable"
  else
    bad "cannot reach database 'crossrental' — is Postgres running?"
  fi

  if psql crossrental -tAc 'SELECT 1' >/dev/null 2>&1; then
    users=$(psql crossrental -tAc "SELECT count(*) FROM users" 2>/dev/null)
    vendors=$(psql crossrental -tAc "SELECT count(*) FROM vendors" 2>/dev/null)
    if [ "${users:-0}" -gt 0 ]; then
      ok "seed data present ($users users, $vendors vendors)"
    else
      bad "no users in the database — run: npm run seed"
    fi
  fi
else
  info "psql not on PATH, skipping database checks"
fi

echo
echo "Seeded demo logins"
echo "-------------------"
echo "  These are the only four accounts created by 'npm run seed'."

if curl -sf -m 5 http://localhost:4000/health >/dev/null 2>&1; then
  ok "backend responding on :4000"
else
  bad "backend not responding on :4000 — run: npm run dev"
  echo
  echo "  Nothing below can succeed until the backend is running."
  echo
  printf '  vendor   %s\n' "vendor1@example.com / Vendor@Portal2026"
  printf '  vendor   %s\n' "vendor2@example.com / Vendor@Portal2026"
  printf '  admin    %s\n' "admin@sanghvimovers.com  — no password, use a code at /auth/otp"
  printf '  sales    %s\n' "sales@sanghvimovers.com  — no password, use a code at /auth/otp"
  echo
  echo "  $fail failed, $pass passed"
  exit 1
fi

check_login() {
  local label=$1 email=$2 password=$3
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
    -X POST http://localhost:4000/api/auth/login \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$password\"}")

  if [ "$code" = "200" ]; then
    ok "$label sign-in works"
  elif [ "$code" = "429" ]; then
    bad "$label rate limited (429) — wait 15 min, or restart the backend to clear the in-memory counter)"
  elif [ "$code" = "401" ]; then
    bad "$label returned 401 — the stored password does not match; re-run: npm run seed"
  else
    bad "$label returned HTTP $code"
  fi
}

check_login "vendor1" "vendor1@example.com" "Vendor@Portal2026"
check_login "vendor2" "vendor2@example.com" "Vendor@Portal2026"

# Internal accounts must NOT authenticate with a password; a 401 here is correct.
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
  -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@sanghvimovers.com","password":"Vendor@Portal2026"}')
if [ "$code" = "401" ]; then
  ok "admin correctly refuses password sign-in (use /auth/otp instead)"
else
  bad "admin returned HTTP $code for a password sign-in, expected 401"
fi

echo
echo "Frontend"
echo "--------"

if curl -sf -m 5 http://localhost:5173/ >/dev/null 2>&1; then
  ok "frontend responding on :5173"
else
  bad "frontend not responding on :5173 — run: npm run dev in ../frontend"
fi

proxy_code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://localhost:5173/api/vendors/me)
if [ "$proxy_code" = "401" ]; then
  ok "dev proxy forwards /api to the backend"
elif [ "$proxy_code" = "500" ]; then
  bad "proxy returns 500 with no body — the frontend is proxying to a backend that is not running"
else
  info "proxy returned HTTP $proxy_code for an unauthenticated request (401 is expected)"
fi

echo
echo "  $pass passed, $fail failed"
exit $((fail > 0 ? 1 : 0))