#!/bin/sh
set -e

python -m app.cli wait
python -m alembic upgrade head
exec "$@"
