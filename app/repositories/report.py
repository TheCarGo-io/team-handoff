from collections.abc import Callable, Iterable
from datetime import UTC, datetime, timedelta
from typing import NamedTuple

from redis.asyncio import Redis
from sqlalchemy import delete, func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import defer

from app.core.config import settings
from app.core.errors import NotFound
from app.core.redis import key
from app.models import EventRecord, HiddenReport, ItemRecord, ReplyRead, ReplyRecord, ReportRecord
from app.schemas.report import OPEN_STATUSES, Event, Item, Reply, Report

EXCERPT_LENGTH = 300
COLUMNS = (
    "title",
    "project",
    "from_team",
    "from_user",
    "to_team",
    "to_user",
    "due",
    "assignee",
    "readiness_note",
    "note",
    "version",
    "created_at",
    "updated_at",
    "taken_at",
    "closed_at",
    "closed_by",
    "related",
)
ENUMS = ("priority", "status", "readiness", "delivery", "status_before_closing")


class Mark(NamedTuple):
    reply_id: int = 0
    version: int = 0
    session: str | None = None
    label: str | None = None


UNSEEN = Mark()


def to_item(record: ItemRecord) -> Item:
    return Item(
        id=record.position,
        title=record.title,
        project=record.project,
        readiness=record.readiness,
        done=record.done,
        done_by=record.done_by,
        done_at=record.done_at,
    )


def to_report(record: ReportRecord, items: Iterable[Item], replies: Iterable[Reply], body: str) -> Report:
    fields = {name: getattr(record, name) for name in (*COLUMNS, *ENUMS)}
    return Report(
        id=record.id,
        text=body,
        delivery_refs=record.delivery_refs,
        items=list(items),
        replies=list(replies),
        **fields,
    )


def values_of(report: Report) -> dict:
    values = {name: getattr(report, name) for name in COLUMNS}
    values.update({name: getattr(getattr(report, name), "value", None) for name in ENUMS})
    return {**values, "text": report.text, "projects": report.projects, "delivery_refs": report.delivery_refs}


def item_values(report_id: int, item: Item) -> dict:
    return {
        "report_id": report_id,
        "position": item.id,
        "title": item.title,
        "project": item.project,
        "readiness": item.readiness.value,
        "done": item.done,
        "done_by": item.done_by,
        "done_at": item.done_at,
    }


def reply_values(report_id: int, reply: Reply) -> dict:
    return {
        "report_id": report_id,
        "team": reply.team,
        "user_name": reply.user,
        "text": reply.text,
        "created_at": reply.created_at,
    }


class ReportRepository:
    def __init__(self, sessions: async_sessionmaker[AsyncSession], redis: Redis):
        self.sessions = sessions
        self.redis = redis

    async def count_write(self, user: str) -> int:
        name = key("writes", user, datetime.now(UTC).strftime("%Y%m%d%H%M"))
        async with self.redis.pipeline(transaction=True) as pipe:
            pipe.incr(name)
            pipe.expire(name, 120)
            count, _ = await pipe.execute()
        return count

    async def hidden(self, user: str) -> set[int]:
        async with self.sessions() as session:
            rows = await session.scalars(select(HiddenReport.report_id).where(HiddenReport.user_name == user))
            return set(rows)

    async def hide(self, user: str, *report_ids: int) -> None:
        if not report_ids:
            return
        rows = [{"user_name": user, "report_id": report_id} for report_id in report_ids]
        async with self.sessions() as session, session.begin():
            await session.execute(insert(HiddenReport).values(rows).on_conflict_do_nothing())

    async def unhide(self, user: str, *report_ids: int) -> None:
        if not report_ids:
            return
        statement = delete(HiddenReport).where(HiddenReport.user_name == user, HiddenReport.report_id.in_(report_ids))
        async with self.sessions() as session, session.begin():
            await session.execute(statement)

    async def seen(self, user: str) -> dict[int, Mark]:
        async with self.sessions() as session:
            rows = await session.execute(
                select(
                    ReplyRead.report_id,
                    ReplyRead.reply_id,
                    ReplyRead.report_version,
                    ReplyRead.session_id,
                    ReplyRead.session_label,
                ).where(ReplyRead.user_name == user)
            )
            return {report_id: Mark(*mark) for report_id, *mark in rows}

    async def mark_seen(self, user: str, report: Report) -> None:
        reply_id = report.replies[-1].id if report.replies else 0
        statement = insert(ReplyRead).values(
            user_name=user, report_id=report.id, reply_id=reply_id, report_version=report.version
        )
        statement = statement.on_conflict_do_update(
            index_elements=[ReplyRead.user_name, ReplyRead.report_id],
            set_={
                "reply_id": func.greatest(ReplyRead.reply_id, reply_id),
                "report_version": func.greatest(ReplyRead.report_version, report.version),
            },
        )
        async with self.sessions() as session, session.begin():
            await session.execute(statement)

    async def assign(self, user: str, report_id: int, work_session: str, label: str) -> None:
        statement = insert(ReplyRead).values(
            user_name=user, report_id=report_id, reply_id=0, session_id=work_session, session_label=label
        )
        statement = statement.on_conflict_do_update(
            index_elements=[ReplyRead.user_name, ReplyRead.report_id],
            set_={"session_id": work_session, "session_label": label},
        )
        async with self.sessions() as session, session.begin():
            await session.execute(statement)

    async def release(self, user: str, report_id: int) -> None:
        statement = (
            update(ReplyRead)
            .where(ReplyRead.user_name == user, ReplyRead.report_id == report_id)
            .values(session_id=None, session_label=None)
        )
        async with self.sessions() as session, session.begin():
            await session.execute(statement)

    async def create(self, report: Report) -> Report:
        async with self.sessions() as session, session.begin():
            record = ReportRecord(**values_of(report))
            session.add(record)
            await session.flush()
            if report.items:
                await session.execute(insert(ItemRecord).values([item_values(record.id, i) for i in report.items]))
        return report.model_copy(update={"id": record.id})

    async def get(self, report_id: int) -> Report:
        async with self.sessions() as session:
            record = await session.get(ReportRecord, report_id)
            if record is None:
                raise NotFound(f"Report #{report_id} does not exist")
            return await self.assemble(session, record)

    async def assemble(self, session: AsyncSession, record: ReportRecord) -> Report:
        items = await session.scalars(
            select(ItemRecord).where(ItemRecord.report_id == record.id).order_by(ItemRecord.position)
        )
        replies = await session.scalars(
            select(ReplyRecord).where(ReplyRecord.report_id == record.id).order_by(ReplyRecord.id)
        )
        thread = [Reply(id=r.id, team=r.team, user=r.user_name, text=r.text, created_at=r.created_at) for r in replies]
        return to_report(record, [to_item(item) for item in items], thread, record.text)

    async def listing(self, archived: bool = False) -> list[Report]:
        statement = select(ReportRecord).options(defer(ReportRecord.text)).order_by(ReportRecord.id)
        if not archived:
            cutoff = datetime.now(UTC) - timedelta(days=settings.CLOSED_VISIBLE_DAYS)
            is_open = ReportRecord.status.in_([status.value for status in OPEN_STATUSES])
            statement = statement.where(
                or_(is_open, ReportRecord.closed_at >= cutoff, ReportRecord.updated_at >= cutoff)
            )
        async with self.sessions() as session:
            records = list(await session.scalars(statement))
            ids = [record.id for record in records]
            items: dict[int, list[Item]] = {}
            replies: dict[int, list[Reply]] = {}
            if ids:
                rows = await session.scalars(
                    select(ItemRecord).where(ItemRecord.report_id.in_(ids)).order_by(ItemRecord.position)
                )
                for row in rows:
                    items.setdefault(row.report_id, []).append(to_item(row))
                excerpt = func.left(ReplyRecord.text, EXCERPT_LENGTH)
                columns = (ReplyRecord.id, ReplyRecord.report_id, ReplyRecord.team, ReplyRecord.user_name, excerpt)
                found = await session.execute(
                    select(*columns, ReplyRecord.created_at)
                    .where(ReplyRecord.report_id.in_(ids))
                    .order_by(ReplyRecord.id)
                )
                for reply_id, report_id, team, user, body, created_at in found:
                    reply = Reply(id=reply_id, team=team, user=user, text=body, created_at=created_at)
                    replies.setdefault(report_id, []).append(reply)
        return [to_report(r, items.get(r.id, []), replies.get(r.id, []), "") for r in records]

    async def mutate(
        self, report_id: int, change: Callable[[Report], bool], delete: bool = False
    ) -> tuple[Report, bool]:
        async with self.sessions() as session, session.begin():
            record = await session.get(ReportRecord, report_id, with_for_update=True)
            if record is None:
                raise NotFound(f"Report #{report_id} does not exist")
            report = await self.assemble(session, record)
            known = {reply.id for reply in report.replies}
            if not change(report):
                return report, False
            if delete:
                await session.delete(record)
                return report, True
            for name, value in values_of(report).items():
                setattr(record, name, value)
            await session.execute(text("delete from report_items where report_id = :id"), {"id": report_id})
            if report.items:
                await session.execute(insert(ItemRecord).values([item_values(report_id, i) for i in report.items]))
            for reply in report.replies:
                if reply.id not in known:
                    created = ReplyRecord(**reply_values(report_id, reply))
                    session.add(created)
                    await session.flush()
                    reply.id = created.id
            return report, True

    async def record(self, event: Event) -> None:
        async with self.sessions() as session, session.begin():
            session.add(
                EventRecord(
                    report_id=event.id,
                    type=event.type.value,
                    by_team=event.by_team,
                    by_user=event.by_user,
                    note=event.note,
                )
            )
