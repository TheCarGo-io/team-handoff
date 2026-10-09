run:
	. venv/bin/activate && uvicorn app.main:app --port 8012 --timeout-graceful-shutdown 5 --no-use-colors

migrate:
	. venv/bin/activate && alembic upgrade head

revision:
	. venv/bin/activate && alembic revision --autogenerate -m "$(MSG)"

install:
	python3.12 -m venv venv && . venv/bin/activate && pip install -r requirements-dev.txt

lint:
	. venv/bin/activate && ruff check app/ tests/ --fix

format:
	. venv/bin/activate && ruff format app/ tests/

test:
	. venv/bin/activate && pytest tests/ -v

user:
	. venv/bin/activate && python -m app.cli $(ARGS)
