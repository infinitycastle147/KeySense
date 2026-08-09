#!/usr/bin/env bash
# Applies migrations / runs SQL against the KeySense database.
#
# Reads SUPABASE_DB_URL from .env.local, which is gitignored. The connection
# string is never echoed — `set +x` and quiet psql flags keep it out of logs and
# terminal scrollback.
#
#   ./scripts/db.sh migrate            apply all migrations in order
#   ./scripts/db.sh sql "select 1"     run one statement
#   ./scripts/db.sh verify             list tables + RLS status

set -euo pipefail
set +x  # never trace — would leak the connection string

cd "$(dirname "$0")/.."

if [ ! -f .env.local ]; then
  echo "error: .env.local not found" >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; . ./.env.local; set +a

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  cat >&2 <<'EOF'
error: SUPABASE_DB_URL is not set in .env.local

Add this line (Dashboard -> Connect -> Session pooler, URI format):

  SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@<host>:5432/postgres
EOF
  exit 1
fi

PSQL=(psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 --quiet --no-psqlrc)

case "${1:-}" in
  migrate)
    for f in supabase/migrations/*.sql; do
      echo "applying $(basename "$f")"
      "${PSQL[@]}" -f "$f"
    done
    echo "migrations applied"
    ;;

  sql)
    "${PSQL[@]}" -c "${2:?usage: db.sh sql \"<statement>\"}"
    ;;

  verify)
    "${PSQL[@]}" <<'SQL'
\echo '--- tables + RLS ---'
select tablename, rowsecurity as rls
from pg_tables where schemaname = 'public' order by tablename;
\echo '--- policies ---'
select tablename, policyname from pg_policies
where schemaname = 'public' order by tablename;
\echo '--- indexes ---'
select tablename, indexname from pg_indexes
where schemaname = 'public' order by tablename, indexname;
SQL
    ;;

  *)
    echo "usage: db.sh {migrate|sql \"<stmt>\"|verify}" >&2
    exit 1
    ;;
esac
