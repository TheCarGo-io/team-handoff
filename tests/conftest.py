import asyncio
import contextlib

import fakeredis
import httpx
import pytest

from app.core.redis import set_redis
from app.main import app
from app.repositories.user import UserRepository
from app.services.container import get_hub, reset_hub


@pytest.fixture
async def redis():
    client = fakeredis.FakeAsyncRedis(decode_responses=True)
    set_redis(client)
    reset_hub()
    yield client
    set_redis(None)
    reset_hub()
    await client.aclose()


@pytest.fixture
async def tokens(redis) -> dict[str, dict[str, str]]:
    users = UserRepository(redis)
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
