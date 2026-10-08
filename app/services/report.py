import logging
from datetime import UTC, datetime

from app.core.config import settings
from app.core.errors import Conflict, Forbidden, HandoffError, NotFound, TooManyRequests
from app.repositories.report import ReportRepository
from app.repositories.user import UserRepository
from app.schemas.report import (
    CLOSED_STATUSES,
    EditRequest,
    Event,
    EventType,
    InboxResponse,
    Reply,
    ReplyRequest,
    Report,
    ReportRow,
    Resolution,
    ResolveRequest,
    SendRequest,
    Status,
)
from app.schemas.user import User
from app.services.events import EventHub

logger = logging.getLogger("handoff.audit")


def now() -> datetime:
    return datetime.now(UTC)


def others(actor: User, *names: str | None) -> list[str]:
    return sorted({name for name in names if name and name != actor.name})


class ReportService:
    def __init__(self, reports: ReportRepository, users: UserRepository, hub: EventHub):
        self.reports = reports
        self.users = users
        self.hub = hub

    async def guard(self, actor: User) -> None:
        if await self.reports.count_write(actor.name) > settings.WRITES_PER_MINUTE:
            raise TooManyRequests(f"More than {settings.WRITES_PER_MINUTE} changes in a minute; slow down")

    async def emit(
        self, kind: EventType, report: Report, actor: User, notify_users: list[str] | None, note: str = ""
    ) -> None:
        logger.info(
            "report=%s event=%s by=%s/%s status=%s", report.id, kind.value, actor.team, actor.name, report.status.value
        )
        teams = sorted({report.to_team, report.from_team}) if kind != EventType.new else [report.to_team]
        await self.hub.publish(
            Event(
                type=kind,
                id=report.id,
                title=report.title,
                project=report.project,
                priority=report.priority,
                by_team=actor.team,
                by_user=actor.name,
                from_team=report.from_team,
                from_user=report.from_user,
                to_team=report.to_team,
                to_user=report.to_user,
                note=note[:300],
                teams=teams,
                notify_users=notify_users,
            )
        )

    async def send(self, actor: User, body: SendRequest) -> Report:
        await self.guard(actor)
        if body.to_team not in settings.TEAMS:
            raise HandoffError(f"Unknown team '{body.to_team}'. Teams: {', '.join(settings.TEAMS)}")
        if settings.PROJECTS and body.project not in settings.PROJECTS:
            raise HandoffError(f"Unknown project '{body.project}'. Projects: {', '.join(settings.PROJECTS)}")
        if body.to_user is not None:
            recipient = await self.users.get(body.to_user)
            if recipient is None or recipient.team != body.to_team:
                raise HandoffError(f"'{body.to_user}' is not a member of team '{body.to_team}'")
        stamp = now()
        report = Report(
            id=await self.reports.next_id(),
            title=body.title,
            text=body.text,
            project=body.project,
            from_team=actor.team,
            from_user=actor.name,
            to_team=body.to_team,
            to_user=body.to_user,
            priority=body.priority,
            due=body.due.astimezone(UTC) if body.due else None,
            created_at=stamp,
            updated_at=stamp,
        )
        await self.reports.save(report)
        await self.emit(EventType.new, report, actor, [body.to_user] if body.to_user else None)
        return report

    async def get(self, report_id: int) -> Report:
        return await self.reports.get(report_id)

    async def board(self, project: str | None = None) -> list[ReportRow]:
        reports = [r for r in await self.reports.all() if project is None or r.project == project]
        return [r.row() for r in sorted(reports, key=lambda r: (r.status in CLOSED_STATUSES, r.sort_key()))]

    async def inbox(self, actor: User, project: str | None = None) -> InboxResponse:
        reports = await self.reports.all()
        mine = sorted(
            (r for r in reports if r.to_team == actor.team and r.status in (Status.sent, Status.taken)),
            key=lambda r: r.sort_key(),
        )
        waiting = [r for r in mine if r.status == Status.sent]
        returned = [r for r in reports if r.from_user == actor.name and r.status == Status.needs_changes]
        return InboxResponse(
            team=actor.team,
            user=actor.name,
            project=project,
            waiting=len(waiting),
            waiting_for_project=sum(1 for r in waiting if r.project == project),
            overdue=sum(1 for r in mine if r.overdue),
            taken_by_me=sum(1 for r in mine if r.status == Status.taken and r.assignee == actor.name),
            returned=len(returned),
            rows=[r.row() for r in mine],
            returned_rows=[r.row() for r in returned],
        )

    async def take(self, actor: User, report_id: int) -> Report:
        await self.guard(actor)

        def change(report: Report) -> bool:
            if report.to_team != actor.team:
                raise Forbidden(f"Report #{report.id} is for team '{report.to_team}', you are in '{actor.team}'")
            if report.status == Status.taken and report.assignee == actor.name:
                return False
            if report.status != Status.sent:
                holder = f" by {report.assignee}" if report.assignee else ""
                raise Conflict(f"Report #{report.id} is already {report.status.value}{holder}")
            report.status = Status.taken
            report.assignee = actor.name
            report.taken_at = report.updated_at = now()
            return True

        report, changed = await self.reports.mutate(report_id, change)
        if changed:
            await self.emit(EventType.taken, report, actor, [report.from_user])
        return report

    async def take_next(self, actor: User, project: str | None = None) -> Report:
        inbox = await self.inbox(actor)
        for row in inbox.rows:
            if row.status != Status.sent or row.to_user not in (None, actor.name):
                continue
            if project is not None and row.project != project:
                continue
            try:
                return await self.take(actor, row.id)
            except (Conflict, NotFound):
                continue
        scope = f" for project '{project}'" if project else ""
        raise NotFound(f"Nothing is waiting for team '{actor.team}'{scope}")

    async def reply(self, actor: User, report_id: int, body: ReplyRequest) -> Report:
        await self.guard(actor)
        reply_id = await self.reports.next_reply_id()

        def change(report: Report) -> bool:
            if actor.team not in (report.from_team, report.to_team):
                raise Forbidden(f"Only teams '{report.from_team}' and '{report.to_team}' can reply to #{report.id}")
            if len(report.replies) >= settings.MAX_REPLIES:
                raise Conflict(f"Report #{report.id} already has {settings.MAX_REPLIES} replies; send a new report")
            stamp = now()
            report.replies.append(
                Reply(id=reply_id, team=actor.team, user=actor.name, text=body.text, created_at=stamp)
            )
            report.updated_at = stamp
            return True

        report, _ = await self.reports.mutate(report_id, change)
        audience = others(actor, report.from_user, report.assignee)
        await self.emit(EventType.reply, report, actor, audience or None, note=body.text)
        return report

    async def resolve(self, actor: User, report_id: int, body: ResolveRequest) -> Report:
        await self.guard(actor)
        if body.status != Resolution.done and not body.note:
            raise HandoffError(f"A note saying why is required to mark a report {body.status.value}")
        holder: list[str | None] = [None]

        def change(report: Report) -> bool:
            if report.to_team != actor.team:
                raise Forbidden(f"Report #{report.id} is for team '{report.to_team}', you are in '{actor.team}'")
            if report.status not in (Status.sent, Status.taken):
                raise Conflict(f"Report #{report.id} is already {report.status.value}")
            holder[0] = report.assignee
            stamp = now()
            report.status = Status(body.status.value)
            report.assignee = report.assignee or actor.name
            report.note = body.note or None
            report.updated_at = stamp
            report.closed_at = stamp if report.status in CLOSED_STATUSES else None
            return True

        report, _ = await self.reports.mutate(report_id, change)
        await self.emit(
            EventType(body.status.value), report, actor, others(actor, report.from_user, holder[0]), body.note
        )
        return report

    async def edit(self, actor: User, report_id: int, body: EditRequest) -> Report:
        await self.guard(actor)
        if not body.model_fields_set - {"clear_due"} and not body.clear_due:
            raise HandoffError("Nothing to change: pass title, text, priority, due or clear_due")
        holder: list[str | None] = [None]

        def change(report: Report) -> bool:
            if report.from_user != actor.name:
                raise Forbidden(f"Only {report.from_user} can edit report #{report.id}")
            if report.status in CLOSED_STATUSES:
                raise Conflict(f"Report #{report.id} is already {report.status.value}; send a new one instead")
            holder[0] = report.assignee
            before = report.model_dump(include={"title", "text", "priority", "due"})
            report.text = body.text if body.text is not None else report.text
            report.title = body.title if body.title is not None else report.title
            report.priority = body.priority if body.priority is not None else report.priority
            if body.clear_due:
                report.due = None
            elif body.due is not None:
                report.due = body.due.astimezone(UTC)
            is_returned = report.status == Status.needs_changes
            if before == report.model_dump(include={"title", "text", "priority", "due"}) and not is_returned:
                return False
            if is_returned:
                report.status = Status.sent
                report.assignee = None
                report.note = None
            report.version += 1
            report.updated_at = now()
            return True

        report, changed = await self.reports.mutate(report_id, change)
        if changed:
            await self.emit(EventType.edited, report, actor, [holder[0]] if holder[0] else None)
        return report

    async def withdraw(self, actor: User, report_id: int) -> None:
        await self.guard(actor)

        def change(report: Report) -> bool:
            if report.from_user != actor.name:
                raise Forbidden(f"Only {report.from_user} can withdraw report #{report.id}")
            return True

        report, _ = await self.reports.mutate(report_id, change, delete=True)
        await self.emit(EventType.withdrawn, report, actor, [report.assignee] if report.assignee else None)
