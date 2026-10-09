import logging
from datetime import UTC, datetime

from app.core.config import settings
from app.core.errors import Conflict, Forbidden, HandoffError, NotFound, TooManyRequests
from app.repositories.report import ReportRepository
from app.repositories.user import UserRepository
from app.schemas.report import (
    CLOSED_STATUSES,
    OPEN_STATUSES,
    CheckRequest,
    CloseRequest,
    DeliveryRequest,
    EditRequest,
    Event,
    EventType,
    InboxResponse,
    Item,
    ItemInput,
    Readiness,
    ReopenRequest,
    Reply,
    ReplyRequest,
    Report,
    ReportRow,
    Resolution,
    ResolveRequest,
    SendRequest,
    Status,
    ThreadRow,
)
from app.schemas.user import User
from app.services.events import EventHub

logger = logging.getLogger("handoff.audit")


def now() -> datetime:
    return datetime.now(UTC)


def canonical(project: str) -> str:
    return settings.PROJECT_ALIASES.get(project.lower(), project)


def build_items(inputs: list[ItemInput], existing: list[Item] = (), home: str = "") -> list[Item]:
    kept = {item.title: item for item in existing}
    items = []
    for number, entry in enumerate(inputs, start=1):
        previous = kept.get(entry.title)
        done = previous is not None and previous.done
        items.append(
            Item(
                id=number,
                title=entry.title,
                project=canonical(entry.project) if entry.project and canonical(entry.project) != home else None,
                readiness=entry.readiness,
                done=done,
                done_by=previous.done_by if done else None,
                done_at=previous.done_at if done else None,
            )
        )
    return items


def others(actor: User, *names: str | None) -> list[str]:
    return sorted({name for name in names if name and name != actor.name})


def is_party(report: Report, user: User) -> bool:
    names = {report.from_user, report.assignee, report.to_user, *(reply.user for reply in report.replies)}
    return user.name in names


def unread_replies(report: Report, user: User, seen: dict[int, int]) -> list[Reply]:
    mark = seen.get(report.id, 0)
    return [reply for reply in report.replies if reply.user != user.name and reply.id > mark]


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
        project = canonical(body.project)
        named = [project, *(canonical(item.project) for item in body.items if item.project)]
        unknown = sorted({name for name in named if settings.PROJECTS and name not in settings.PROJECTS})
        if unknown:
            raise HandoffError(f"Unknown project '{unknown[0]}'. Projects: {', '.join(settings.PROJECTS)}")
        if body.to_user is not None:
            recipient = await self.users.get(body.to_user)
            if recipient is None or recipient.team != body.to_team:
                raise HandoffError(f"'{body.to_user}' is not a member of team '{body.to_team}'")
        stamp = now()
        report = Report(
            id=await self.reports.next_id(),
            title=body.title,
            text=body.text,
            project=project,
            from_team=actor.team,
            from_user=actor.name,
            to_team=body.to_team,
            to_user=body.to_user,
            priority=body.priority,
            due=body.due.astimezone(UTC) if body.due else None,
            readiness=body.readiness,
            readiness_note=body.readiness_note or None,
            items=build_items(body.items, home=project),
            related=list(dict.fromkeys(body.related)),
            created_at=stamp,
            updated_at=stamp,
        )
        await self.reports.save(report)
        await self.emit(EventType.new, report, actor, [body.to_user] if body.to_user else None)
        return report

    async def get(self, report_id: int) -> Report:
        return await self.reports.get(report_id)

    async def read(self, actor: User, report_id: int, mark_seen: bool = True) -> tuple[Report, list[int]]:
        report = await self.reports.get(report_id)
        fresh = unread_replies(report, actor, await self.reports.seen(actor.name))
        if mark_seen and fresh:
            await self.reports.mark_seen(actor.name, report_id, report.replies[-1].id)
            await self.hub.refresh_user(actor.name)
        return report, [reply.id for reply in fresh]

    async def board(self, project: str | None = None) -> list[ReportRow]:
        wanted = canonical(project) if project else None
        reports = [r for r in await self.reports.all() if wanted is None or wanted in r.projects]
        return [r.row() for r in sorted(reports, key=lambda r: (r.status in CLOSED_STATUSES, r.sort_key()))]

    async def inbox(self, actor: User, projects: list[str] | None = None) -> InboxResponse:
        here = list(dict.fromkeys(canonical(name) for name in projects or []))
        here_set = set(here)
        reports = await self.reports.all()
        team_open = sorted(
            (r for r in reports if r.to_team == actor.team and r.status in (Status.sent, Status.taken)),
            key=lambda r: r.sort_key(),
        )
        hidden = await self.reports.hidden(actor.name)
        stale = hidden - {r.id for r in team_open}
        if stale:
            await self.reports.unhide(actor.name, *stale)
        mine = [r for r in team_open if r.id not in hidden]
        tucked = [r for r in team_open if r.id in hidden]
        waiting = [r for r in mine if r.status == Status.sent]
        returned = [r for r in reports if r.from_user == actor.name and r.status == Status.needs_changes]
        seen = await self.reports.seen(actor.name)
        gone = set(seen) - {r.id for r in reports}
        if gone:
            await self.reports.forget_seen(actor.name, *gone)
        threads = []
        for report in reports:
            fresh = unread_replies(report, actor, seen) if is_party(report, actor) else []
            if fresh:
                last = fresh[-1]
                excerpt = " ".join(last.text.split())[:200]
                extra = {"unread": len(fresh), "last_reply_by": last.user, "last_reply_excerpt": excerpt}
                threads.append((last.id, ThreadRow(**report.row(here_set).model_dump(exclude={"overdue"}), **extra)))
        threads.sort(key=lambda pair: pair[0], reverse=True)
        return InboxResponse(
            team=actor.team,
            user=actor.name,
            project=here[0] if here else None,
            projects=here,
            waiting=len(waiting),
            waiting_for_project=sum(1 for r in waiting if here_set.intersection(r.projects)),
            overdue=sum(1 for r in mine if r.overdue),
            taken_by_me=sum(1 for r in mine if r.status == Status.taken and r.assignee == actor.name),
            returned=len(returned),
            rows=[r.row(here_set) for r in mine],
            returned_rows=[r.row(here_set) for r in returned],
            hidden=len(tucked),
            hidden_rows=[r.row(here_set) for r in tucked],
            unread_replies=sum(row.unread for _, row in threads),
            threads=[row for _, row in threads],
        )

    async def hide(self, actor: User, report_id: int, hidden: bool) -> None:
        await self.reports.get(report_id)
        if hidden:
            await self.reports.hide(actor.name, report_id)
        else:
            await self.reports.unhide(actor.name, report_id)
        await self.hub.refresh_user(actor.name)

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
        await self.reports.unhide(actor.name, report_id)
        if report.replies:
            await self.reports.mark_seen(actor.name, report_id, report.replies[-1].id)
        if changed:
            await self.emit(EventType.taken, report, actor, [report.from_user])
        return report

    async def take_next(self, actor: User, project: str | None = None) -> Report:
        inbox = await self.inbox(actor)
        for row in inbox.rows:
            if row.status != Status.sent or row.to_user not in (None, actor.name) or row.readiness != Readiness.ready:
                continue
            if project is not None and canonical(project) not in row.projects:
                continue
            try:
                return await self.take(actor, row.id)
            except (Conflict, NotFound):
                continue
        scope = f" for project '{project}'" if project else ""
        raise NotFound(f"Nothing ready is waiting for team '{actor.team}'{scope}")

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
        await self.reports.mark_seen(actor.name, report_id, reply_id)
        audience = others(actor, report.from_user, report.assignee, report.to_user)
        await self.emit(EventType.reply, report, actor, audience or None, note=body.text)
        return report

    async def resolve(self, actor: User, report_id: int, body: ResolveRequest) -> Report:
        await self.guard(actor)
        if body.status == Resolution.needs_changes and not body.note:
            raise HandoffError("A note saying what to change is required to hand a report back")
        holder: list[str | None] = [None]

        def change(report: Report) -> bool:
            if report.to_team != actor.team:
                raise Forbidden(f"Report #{report.id} is for team '{report.to_team}', you are in '{actor.team}'")
            if report.status not in (Status.sent, Status.taken):
                raise Conflict(f"Report #{report.id} is already {report.status.value}")
            unticked = [str(item.id) for item in report.items if not item.done]
            if body.status == Resolution.done and unticked and not body.allow_open_items:
                raise Conflict(
                    f"Report #{report.id} still has {len(unticked)} unticked checklist item(s): {', '.join(unticked)}. "
                    "Tick what is finished with check; pass allow_open_items only if the rest is not needed"
                )
            holder[0] = report.assignee
            stamp = now()
            report.status = Status(body.status.value)
            report.assignee = report.assignee or actor.name
            report.note = body.note or None
            report.updated_at = stamp
            is_closing = report.status in CLOSED_STATUSES
            report.closed_at = report.retention_from = stamp if is_closing else None
            report.closed_by = actor.name if is_closing else None
            report.status_before_closing = Status.taken if is_closing else None
            report.delivery = body.delivery if is_closing else None
            report.delivery_refs = list(body.refs) if is_closing else []
            return True

        report, _ = await self.reports.mutate(report_id, change)
        await self.emit(
            EventType(body.status.value), report, actor, others(actor, report.from_user, holder[0]), body.note
        )
        return report

    async def close(self, actor: User, report_id: int, body: CloseRequest) -> Report:
        await self.guard(actor)
        holder: list[str | None] = [None]

        def change(report: Report) -> bool:
            if report.status not in OPEN_STATUSES:
                raise Conflict(f"Report #{report.id} is already {report.status.value}")
            holder[0] = report.assignee
            stamp = now()
            report.status_before_closing = report.status
            report.status = Status.closed
            report.note = body.note or None
            report.closed_by = actor.name
            report.updated_at = report.closed_at = report.retention_from = stamp
            return True

        report, _ = await self.reports.mutate(report_id, change)
        await self.emit(EventType.closed, report, actor, others(actor, report.from_user, holder[0]), body.note)
        return report

    async def reopen(self, actor: User, report_id: int, body: ReopenRequest) -> Report:
        await self.guard(actor)
        closer: list[str | None] = [None]

        def change(report: Report) -> bool:
            if report.status not in CLOSED_STATUSES:
                raise Conflict(f"Report #{report.id} is {report.status.value}, not closed")
            if actor.name not in (report.from_user, report.closed_by, report.assignee):
                raise Forbidden(f"Only its sender, its holder or whoever closed it can reopen report #{report.id}")
            closer[0] = report.closed_by
            before = report.status_before_closing
            if before == Status.needs_changes:
                report.status = Status.needs_changes
            else:
                report.status = Status.taken if report.assignee else Status.sent
            report.note = body.note or (report.note if before == Status.needs_changes else None)
            report.closed_at = report.closed_by = report.status_before_closing = None
            report.delivery = report.retention_from = None
            report.delivery_refs = []
            report.updated_at = now()
            return True

        report, _ = await self.reports.mutate(report_id, change)
        audience = others(actor, report.from_user, report.assignee, closer[0])
        await self.emit(EventType.reopened, report, actor, audience or None, body.note)
        return report

    async def deliver(self, actor: User, report_id: int, body: DeliveryRequest) -> Report:
        await self.guard(actor)

        def change(report: Report) -> bool:
            if report.to_team != actor.team:
                raise Forbidden(f"Report #{report.id} is for team '{report.to_team}', you are in '{actor.team}'")
            if report.status != Status.done:
                raise Conflict(f"Report #{report.id} is {report.status.value}; delivery is recorded on a done report")
            if report.delivery == body.delivery and report.delivery_refs == body.refs:
                return False
            report.delivery = body.delivery
            report.delivery_refs = list(body.refs)
            report.updated_at = report.retention_from = now()
            return True

        report, changed = await self.reports.mutate(report_id, change)
        if changed:
            note = " ".join([body.delivery.value, *body.refs])
            await self.emit(EventType.delivered, report, actor, others(actor, report.from_user), note)
        return report

    async def edit(self, actor: User, report_id: int, body: EditRequest) -> Report:
        await self.guard(actor)
        if not body.model_fields_set - {"clear_due"} and not body.clear_due:
            raise HandoffError("Nothing to change: pass title, text, priority, due, readiness, items or related")
        holder: list[str | None] = [None]
        became_ready = [False]
        watched = {"title", "text", "priority", "due", "readiness", "readiness_note", "items", "related"}

        def change(report: Report) -> bool:
            if report.from_user != actor.name:
                raise Forbidden(f"Only {report.from_user} can edit report #{report.id}")
            if report.status in CLOSED_STATUSES:
                raise Conflict(f"Report #{report.id} is already {report.status.value}; send a new one instead")
            holder[0] = report.assignee
            before = report.model_dump(include=watched)
            was_waiting = report.readiness != Readiness.ready or any(
                i.readiness != Readiness.ready for i in report.items
            )
            report.readiness = body.readiness if body.readiness is not None else report.readiness
            if "readiness_note" in body.model_fields_set:
                report.readiness_note = body.readiness_note or None
            if report.readiness == Readiness.ready and body.readiness is not None:
                report.readiness_note = body.readiness_note or None
            if body.items is not None:
                report.items = build_items(body.items, report.items, home=report.project)
            if body.related is not None:
                report.related = [number for number in dict.fromkeys(body.related) if number != report.id]
            report.text = body.text if body.text is not None else report.text
            report.title = body.title if body.title is not None else report.title
            report.priority = body.priority if body.priority is not None else report.priority
            if body.clear_due:
                report.due = None
            elif body.due is not None:
                report.due = body.due.astimezone(UTC)
            is_returned = report.status == Status.needs_changes
            if before == report.model_dump(include=watched) and not is_returned:
                return False
            is_waiting = report.readiness != Readiness.ready or any(
                i.readiness != Readiness.ready for i in report.items
            )
            became_ready[0] = was_waiting and not is_waiting
            if is_returned:
                report.status = Status.sent
                report.assignee = None
                report.note = None
            report.version += 1
            report.updated_at = now()
            return True

        report, changed = await self.reports.mutate(report_id, change)
        if changed:
            kind = EventType.ready if became_ready[0] else EventType.edited
            await self.emit(kind, report, actor, [holder[0]] if holder[0] else None, report.readiness_note or "")
        return report

    async def check(self, actor: User, report_id: int, body: CheckRequest) -> Report:
        await self.guard(actor)
        touched: list[str] = []

        def change(report: Report) -> bool:
            if report.to_team != actor.team:
                raise Forbidden(f"Report #{report.id} is for team '{report.to_team}', you are in '{actor.team}'")
            if report.status not in (Status.sent, Status.taken):
                raise Conflict(f"Report #{report.id} is already {report.status.value}")
            known = {item.id: item for item in report.items}
            missing = [number for number in body.item_ids if number not in known]
            if missing:
                raise HandoffError(
                    f"Report #{report.id} has no item {', '.join(map(str, missing))}; it has {len(known)}"
                )
            stamp = now()
            touched.clear()
            for number in dict.fromkeys(body.item_ids):
                item = known[number]
                if item.done == body.done:
                    continue
                item.done = body.done
                item.done_by = actor.name if body.done else None
                item.done_at = stamp if body.done else None
                touched.append(item.title)
            if not touched:
                return False
            report.updated_at = stamp
            return True

        report, changed = await self.reports.mutate(report_id, change)
        if changed:
            done = sum(1 for item in report.items if item.done)
            verb = "done" if body.done else "reopened"
            note = f"{done}/{len(report.items)} done; {verb}: {'; '.join(touched)}"
            await self.emit(EventType.progress, report, actor, others(actor, report.from_user), note)
        return report

    async def withdraw(self, actor: User, report_id: int) -> None:
        await self.guard(actor)

        def change(report: Report) -> bool:
            if report.from_user != actor.name:
                raise Forbidden(f"Only {report.from_user} can withdraw report #{report.id}")
            return True

        report, _ = await self.reports.mutate(report_id, change, delete=True)
        await self.emit(EventType.withdrawn, report, actor, [report.assignee] if report.assignee else None)
