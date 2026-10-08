from redis.asyncio import Redis

from app.core.config import settings

_client: Redis | None = None


def get_redis() -> Redis:
    global _client
    if _client is None:
        _client = Redis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
            socket_keepalive=True,
            socket_connect_timeout=5,
            health_check_interval=30,
        )
    return _client


def set_redis(client: Redis | None) -> None:
    global _client
    _client = client


async def close_redis() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def key(*parts: object) -> str:
    return ":".join([settings.REDIS_PREFIX, *(str(part) for part in parts)])
