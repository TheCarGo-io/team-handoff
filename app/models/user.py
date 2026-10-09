from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class UserRecord(Base):
    __tablename__ = "users"

    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    team: Mapped[str] = mapped_column(String(32))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
