import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.errors import Conflict, HandoffError, NotFound
from app.models import InviteRecord, TeamRecord, UserRecord
from app.schemas.user import User


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_token() -> str:
    return f"ho_{secrets.token_urlsafe(32)}"


def to_user(record: UserRecord) -> User:
    return User(name=record.name, team=record.team, is_admin=record.is_admin)


class UserRepository:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]):
        self.sessions = sessions

    async def by_token(self, token: str) -> User | None:
        async with self.sessions() as session:
            record = await session.scalar(select(UserRecord).where(UserRecord.token_hash == hash_token(token)))
        return to_user(record) if record else None

    async def get(self, name: str) -> User | None:
        async with self.sessions() as session:
            record = await session.get(UserRecord, name)
        return to_user(record) if record else None

    async def all(self) -> list[User]:
        async with self.sessions() as session:
            records = await session.scalars(select(UserRecord).order_by(UserRecord.name))
            return [to_user(record) for record in records]

    async def count(self, admins_only: bool = False) -> int:
        statement = select(func.count()).select_from(UserRecord)
        if admins_only:
            statement = statement.where(UserRecord.is_admin)
        async with self.sessions() as session:
            return await session.scalar(statement) or 0

    async def create(self, name: str, team: str, is_admin: bool = False) -> str:
        token = new_token()
        statement = insert(UserRecord).values(name=name, team=team, token_hash=hash_token(token), is_admin=is_admin)
        statement = statement.on_conflict_do_update(
            index_elements=[UserRecord.name], set_={"team": team, "token_hash": hash_token(token)}
        )
        async with self.sessions() as session, session.begin():
            await session.execute(insert(TeamRecord).values(name=team).on_conflict_do_nothing())
            await session.execute(statement)
        return token

    async def rotate(self, name: str) -> str:
        token = new_token()
        statement = update(UserRecord).where(UserRecord.name == name).values(token_hash=hash_token(token))
        async with self.sessions() as session, session.begin():
            await session.execute(statement)
        return token

    async def set_admin(self, name: str, is_admin: bool) -> bool:
        statement = update(UserRecord).where(UserRecord.name == name).values(is_admin=is_admin)
        async with self.sessions() as session, session.begin():
            result = await session.execute(statement)
        return result.rowcount > 0

    async def remove(self, name: str) -> bool:
        async with self.sessions() as session, session.begin():
            result = await session.execute(delete(UserRecord).where(UserRecord.name == name))
        return result.rowcount > 0

    async def teams(self) -> list[str]:
        async with self.sessions() as session:
            return list(await session.scalars(select(TeamRecord.name).order_by(TeamRecord.name)))

    async def add_teams(self, *names: str) -> None:
        if not names:
            return
        rows = [{"name": name} for name in names]
        async with self.sessions() as session, session.begin():
            await session.execute(insert(TeamRecord).values(rows).on_conflict_do_nothing())

    async def announced(self, name: str) -> datetime | None:
        async with self.sessions() as session:
            return await session.scalar(select(UserRecord.announced_at).where(UserRecord.name == name))

    async def set_announced(self, name: str, at: datetime) -> None:
        async with self.sessions() as session, session.begin():
            await session.execute(update(UserRecord).where(UserRecord.name == name).values(announced_at=at))

    async def create_invite(
        self, team: str | None, is_admin: bool, created_by: str | None, days: int
    ) -> tuple[str, datetime]:
        code = secrets.token_urlsafe(18)
        expires_at = datetime.now(UTC) + timedelta(days=days)
        async with self.sessions() as session, session.begin():
            if team is not None:
                await session.execute(insert(TeamRecord).values(name=team).on_conflict_do_nothing())
            if created_by is None:
                await session.execute(
                    delete(InviteRecord).where(InviteRecord.created_by.is_(None), InviteRecord.used_at.is_(None))
                )
            session.add(
                InviteRecord(
                    code_hash=hash_token(code),
                    team=team,
                    is_admin=is_admin,
                    created_by=created_by,
                    expires_at=expires_at,
                )
            )
        return code, expires_at

    async def open_invite(self, code: str) -> InviteRecord:
        async with self.sessions() as session:
            invite = await session.get(InviteRecord, hash_token(code))
        if invite is None or invite.used_at is not None or invite.expires_at < datetime.now(UTC):
            raise NotFound("This invite link is not valid any more: ask for a new one")
        return invite

    async def join(self, code: str, name: str, team: str | None) -> tuple[User, str]:
        token = new_token()
        async with self.sessions() as session, session.begin():
            invite = await session.get(InviteRecord, hash_token(code), with_for_update=True)
            if invite is None or invite.used_at is not None or invite.expires_at < datetime.now(UTC):
                raise NotFound("This invite link is not valid any more: ask for a new one")
            chosen = invite.team or team
            if not chosen:
                raise HandoffError("Choose the team you join")
            if await session.get(UserRecord, name) is not None:
                raise Conflict(f"The name '{name}' is taken: pick another")
            if await session.get(TeamRecord, chosen) is None:
                if not invite.is_admin:
                    known = ", ".join(await session.scalars(select(TeamRecord.name).order_by(TeamRecord.name)))
                    raise HandoffError(f"Unknown team '{chosen}'. Teams: {known}")
                session.add(TeamRecord(name=chosen))
            record = UserRecord(name=name, team=chosen, token_hash=hash_token(token), is_admin=invite.is_admin)
            session.add(record)
            invite.used_by = name
            invite.used_at = datetime.now(UTC)
        return User(name=name, team=chosen, is_admin=record.is_admin), token
