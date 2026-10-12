from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, false, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

Stamp = DateTime(timezone=True)


class UserRecord(Base):
    __tablename__ = "users"

    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    team: Mapped[str] = mapped_column(String(32))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, server_default=false())
    announced_at: Mapped[datetime | None] = mapped_column(Stamp)
    created_at: Mapped[datetime] = mapped_column(Stamp, server_default=func.now())


class TeamRecord(Base):
    __tablename__ = "teams"

    name: Mapped[str] = mapped_column(String(32), primary_key=True)


class InviteRecord(Base):
    __tablename__ = "invites"

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    team: Mapped[str | None] = mapped_column(String(32))
    is_admin: Mapped[bool] = mapped_column(Boolean, server_default=false())
    created_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(Stamp, server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(Stamp)
    used_by: Mapped[str | None] = mapped_column(String(64))
    used_at: Mapped[datetime | None] = mapped_column(Stamp)
