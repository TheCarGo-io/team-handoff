#!/bin/bash
set -e

if [ -f /run/secrets/db_password ] && [ -z "$DATABASE_URL" ]; then
  DB_PASS=$(cat /run/secrets/db_password)
  export DATABASE_URL="postgresql+asyncpg://thecargo:${DB_PASS}@${DB_HOST:-postgres:5432}/thecargo_handoff"
fi

echo "Waiting for database..."
until python -c "
import socket, os, re, sys
url = os.environ.get('DATABASE_URL', '')
m = re.search(r'@([^:/]+):(\d+)/', url)
if not m: sys.exit(1)
s = socket.socket()
s.settimeout(3)
s.connect((m.group(1), int(m.group(2))))
s.close()
" 2>/dev/null; do
  echo "  db not ready, retrying in 3s..."
  sleep 3
done
echo "Database ready."

python -m alembic upgrade head
python -m app.import_redis
exec "$@"
