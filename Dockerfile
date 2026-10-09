FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.6 /uv /uvx /bin/

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN uv pip install --system -r requirements.txt

COPY alembic.ini entrypoint.sh ./
COPY migrations/ migrations/
COPY app/ app/
RUN chmod +x entrypoint.sh

RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=5 \
    CMD curl -f http://localhost:8000/health/live || exit 1

ENTRYPOINT ["./entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--timeout-graceful-shutdown", "5"]
