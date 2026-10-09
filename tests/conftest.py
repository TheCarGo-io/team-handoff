import asyncio
import contextlib
import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://postgres:123@localhost:5432/thecargo_handoff_test")
os.environ.setdefault("DB_USE_NULLPOOL", "true")

import fakeredis  # noqa: E402
import httpx  # noqa: E402
import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.database import async_session  # noqa: E402
from app.core.redis import set_redis  # noqa: E402
from app.main import app  # noqa: E402
from app.repositories.user import UserRepository  # noqa: E402
from app.services.container import get_hub, reset_hub  # noqa: E402

TABLES = "reports, users, events"


def pytest_sessionstart(session) -> None:
    name = settings.DATABASE_URL.rsplit("/", 1)[-1]
    if not name.endswith(("_test", "_ci")):
        raise pytest.UsageError(f"Refusing to reset database '{name}': tests need one ending in _test or _ci")

    async def reset() -> None:
        engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
        async with engine.begin() as connection:
            await connection.execute(text("drop schema public cascade"))
            await connection.execute(text("create schema public"))
        await engine.dispose()

    asyncio.run(reset())
    command.upgrade(Config("alembic.ini"), "head")


@pytest.fixture
async def database():
    async def scalar(statement: str, **values):
        async with async_session() as session:
            return await session.scalar(text(statement), values)

    async def execute(statement: str, **values) -> None:
        async with async_session() as session, session.begin():
            await session.execute(text(statement), values)

    await execute(f"truncate {TABLES} restart identity cascade")
    scalar.execute = execute
    return scalar


@pytest.fixture
async def redis(database):
    client = fakeredis.FakeAsyncRedis(decode_responses=True)
    set_redis(client)
    reset_hub()
    yield client
    set_redis(None)
    reset_hub()
    await client.aclose()


@pytest.fixture
async def tokens(redis) -> dict[str, dict[str, str]]:
    users = UserRepository(async_session)
    people = {"asliddin": "backend", "bobur": "backend", "ali": "frontend", "vali": "frontend", "dana": "design"}
    return {name: {"Authorization": f"Bearer {await users.create(name, team)}"} for name, team in people.items()}


@pytest.fixture
async def client(redis):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8012") as http:
        yield http


@pytest.fixture
async def hub(redis):
    hub = get_hub()
    listener = asyncio.create_task(hub.run())
    await asyncio.sleep(0.05)
    yield hub
    hub.close()
    listener.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await listener


def report_body(**overrides) -> dict:
    body = {
        "to_team": "frontend",
        "title": "GET /loads is now paginated",
        "text": "Use ?page and ?size. Response is {items, total}.",
        "project": "thecargo-frontend",
    }
    return {**body, **overrides}
