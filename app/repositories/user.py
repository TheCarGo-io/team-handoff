import hashlib
import secrets

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import UserRecord
from app.schemas.user import User


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class UserRepository:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]):
        self.sessions = sessions

    async def by_token(self, token: str) -> User | None:
        async with self.sessions() as session:
            record = await session.scalar(select(UserRecord).where(UserRecord.token_hash == hash_token(token)))
        return User(name=record.name, team=record.team) if record else None

    async def get(self, name: str) -> User | None:
        async with self.sessions() as session:
            record = await session.get(UserRecord, name)
        return User(name=record.name, team=record.team) if record else None

    async def all(self) -> list[User]:
        async with self.sessions() as session:
            records = await session.scalars(select(UserRecord).order_by(UserRecord.name))
            return [User(name=record.name, team=record.team) for record in records]

    async def create(self, name: str, team: str) -> str:
        token = f"ho_{secrets.token_urlsafe(32)}"
        await self.store(name, team, hash_token(token))
        return token

    async def store(self, name: str, team: str, token_hash: str) -> None:
        statement = insert(UserRecord).values(name=name, team=team, token_hash=token_hash)
        statement = statement.on_conflict_do_update(
            index_elements=[UserRecord.name], set_={"team": team, "token_hash": token_hash}
        )
        async with self.sessions() as session, session.begin():
            await session.execute(statement)

    async def remove(self, name: str) -> bool:
        async with self.sessions() as session, session.begin():
            result = await session.execute(delete(UserRecord).where(UserRecord.name == name))
        return result.rowcount > 0
