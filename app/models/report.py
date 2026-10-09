from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Identity, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

Stamp = DateTime(timezone=True)


class ReportRecord(Base):
    __tablename__ = "reports"
    __table_args__ = (
        Index("ix_reports_to_team_status", "to_team", "status"),
        Index("ix_reports_from_user_status", "from_user", "status"),
        Index("ix_reports_closed_at", "closed_at"),
        Index("ix_reports_projects", "projects", postgresql_using="gin"),
    )

    id: Mapped[int] = mapped_column(Integer, Identity(always=False), primary_key=True)
    title: Mapped[str] = mapped_column(Text)
    text: Mapped[str] = mapped_column(Text)
    project: Mapped[str] = mapped_column(String(80))
    projects: Mapped[list[str]] = mapped_column(ARRAY(String(80)), server_default="{}")
    from_team: Mapped[str] = mapped_column(String(32))
    from_user: Mapped[str] = mapped_column(String(64))
    to_team: Mapped[str] = mapped_column(String(32))
    to_user: Mapped[str | None] = mapped_column(String(64))
    priority: Mapped[str] = mapped_column(String(10))
    due: Mapped[datetime | None] = mapped_column(Stamp)
    status: Mapped[str] = mapped_column(String(16))
    assignee: Mapped[str | None] = mapped_column(String(64))
    readiness: Mapped[str] = mapped_column(String(20), server_default="ready")
    readiness_note: Mapped[str | None] = mapped_column(Text)
    delivery: Mapped[str | None] = mapped_column(String(10))
    delivery_refs: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    related: Mapped[list[int]] = mapped_column(ARRAY(Integer), server_default="{}")
    note: Mapped[str | None] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, server_default="1")
    created_at: Mapped[datetime] = mapped_column(Stamp)
    updated_at: Mapped[datetime] = mapped_column(Stamp)
    taken_at: Mapped[datetime | None] = mapped_column(Stamp)
    closed_at: Mapped[datetime | None] = mapped_column(Stamp)
    closed_by: Mapped[str | None] = mapped_column(String(64))
    status_before_closing: Mapped[str | None] = mapped_column(String(16))


class ItemRecord(Base):
    __tablename__ = "report_items"

    report_id: Mapped[int] = mapped_column(ForeignKey("reports.id", ondelete="CASCADE"), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(Text)
    project: Mapped[str | None] = mapped_column(String(80))
    readiness: Mapped[str] = mapped_column(String(20), server_default="ready")
    done: Mapped[bool] = mapped_column(Boolean, server_default="false")
    done_by: Mapped[str | None] = mapped_column(String(64))
    done_at: Mapped[datetime | None] = mapped_column(Stamp)


class ReplyRecord(Base):
    __tablename__ = "replies"

    id: Mapped[int] = mapped_column(Integer, Identity(always=False), primary_key=True)
    report_id: Mapped[int] = mapped_column(ForeignKey("reports.id", ondelete="CASCADE"), index=True)
    team: Mapped[str] = mapped_column(String(32))
    user_name: Mapped[str] = mapped_column(String(64))
    text: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(Stamp)


class ReplyRead(Base):
    __tablename__ = "reply_reads"

    user_name: Mapped[str] = mapped_column(String(64), primary_key=True)
    report_id: Mapped[int] = mapped_column(ForeignKey("reports.id", ondelete="CASCADE"), primary_key=True)
    reply_id: Mapped[int] = mapped_column(Integer)


class HiddenReport(Base):
    __tablename__ = "hidden_reports"

    user_name: Mapped[str] = mapped_column(String(64), primary_key=True)
    report_id: Mapped[int] = mapped_column(ForeignKey("reports.id", ondelete="CASCADE"), primary_key=True)


class EventRecord(Base):
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(Integer, Identity(always=False), primary_key=True)
    report_id: Mapped[int] = mapped_column(Integer, index=True)
    type: Mapped[str] = mapped_column(String(20))
    by_team: Mapped[str] = mapped_column(String(32))
    by_user: Mapped[str] = mapped_column(String(64))
    note: Mapped[str] = mapped_column(Text, server_default="")
    created_at: Mapped[datetime] = mapped_column(Stamp, server_default=func.now(), index=True)
