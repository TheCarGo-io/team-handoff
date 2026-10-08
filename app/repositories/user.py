import hashlib
import secrets

from redis.asyncio import Redis

from app.core.redis import key
from app.schemas.user import User


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class UserRepository:
    def __init__(self, redis: Redis):
        self.redis = redis

    async def by_token(self, token: str) -> User | None:
        name = await self.redis.get(key("token", hash_token(token)))
        return await self.get(name) if name else None

    async def get(self, name: str) -> User | None:
        team = await self.redis.hget(key("users"), name)
        return User(name=name, team=team) if team else None

    async def all(self) -> list[User]:
        users = await self.redis.hgetall(key("users"))
        return [User(name=name, team=team) for name, team in sorted(users.items())]

    async def create(self, name: str, team: str) -> str:
        token = f"ho_{secrets.token_urlsafe(32)}"
        token_hash = hash_token(token)
        previous = await self.redis.hget(key("user_tokens"), name)
        async with self.redis.pipeline(transaction=True) as pipe:
            if previous:
                pipe.delete(key("token", previous))
            pipe.hset(key("users"), name, team)
            pipe.hset(key("user_tokens"), name, token_hash)
            pipe.set(key("token", token_hash), name)
            await pipe.execute()
        return token

    async def remove(self, name: str) -> bool:
        previous = await self.redis.hget(key("user_tokens"), name)
        async with self.redis.pipeline(transaction=True) as pipe:
            if previous:
                pipe.delete(key("token", previous))
            pipe.hdel(key("user_tokens"), name)
            pipe.hdel(key("users"), name)
            *_, removed = await pipe.execute()
        return bool(removed)
