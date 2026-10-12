import re
from datetime import UTC, datetime
from enum import Enum
from typing import Annotated

from pydantic import AwareDatetime, BaseModel, BeforeValidator, Field, computed_field

from app.core.config import settings

CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
CONTROL_KEEPING_LAYOUT = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def one_line(value: object) -> object:
    return CONTROL.sub(" ", value).strip() if isinstance(value, str) else value


def clean_text(value: object) -> object:
    if not isinstance(value, str):
        return value
    return CONTROL_KEEPING_LAYOUT.sub("", value.replace("\r\n", "\n")).strip()


Line = Annotated[str, BeforeValidator(one_line)]
Body = Annotated[str, BeforeValidator(clean_text)]
Project = Annotated[str, Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")]
Ref = Annotated[str, BeforeValidator(one_line), Field(min_length=1, max_length=300)]
SESSION_ID = r"^[A-Za-z0-9_-]{1,64}$"


class Priority(str, Enum):
    low = "low"
    normal = "normal"
    high = "high"
    urgent = "urgent"


class Status(str, Enum):
    sent = "sent"
    taken = "taken"
    done = "done"
    rejected = "rejected"
    closed = "closed"
    needs_changes = "needs-changes"


class Readiness(str, Enum):
    ready = "ready"
    after_deploy = "after-deploy"
    waiting_decision = "waiting-decision"


class Delivery(str, Enum):
    local = "local"
    pushed = "pushed"
    pr = "pr"
    merged = "merged"


class Resolution(str, Enum):
    done = "done"
    needs_changes = "needs-changes"


class EventType(str, Enum):
    new = "new"
    edited = "edited"
    taken = "taken"
    reply = "reply"
    done = "done"
    rejected = "rejected"
    needs_changes = "needs-changes"
    closed = "closed"
    withdrawn = "withdrawn"
    progress = "progress"
    ready = "ready"
    reopened = "reopened"
    delivered = "delivered"


PRIORITY_ORDER = {Priority.urgent: 0, Priority.high: 1, Priority.normal: 2, Priority.low: 3}
OPEN_STATUSES = (Status.sent, Status.taken, Status.needs_changes)
CLOSED_STATUSES = (Status.done, Status.rejected, Status.closed)


class Item(BaseModel):
    id: int = Field(examples=[1])
    title: str = Field(examples=["Lead panel: stage history"])
    project: str | None = Field(default=None, description="Repository this item belongs in; the report's when empty")
    readiness: Readiness = Readiness.ready
    done: bool = False
    done_by: str | None = None
    done_at: datetime | None = None


class ItemInput(BaseModel):
    title: Line = Field(min_length=3, max_length=200, examples=["Lead panel: stage history"])
    project: Project | None = Field(default=None, examples=["mobile-app"])
    readiness: Readiness = Readiness.ready


class Reply(BaseModel):
    id: int
    team: str
    user: str
    text: str
    created_at: datetime


class WorkSession(BaseModel):
    id: str = Field(examples=["0b9c2f6e-6a51-4d0f-9f0f-3b1c2a7d5e11"])
    label: str = Field(examples=["web-app"])
    live: bool = Field(description="Whether that session has its event stream open now")


class ReportBase(BaseModel):
    id: int = Field(examples=[12])
    title: str = Field(examples=["GET /loads is now paginated"])
    project: str = Field(examples=["web-app"])
    from_team: str = Field(examples=["backend"])
    from_user: str = Field(examples=["sam"])
    to_team: str = Field(examples=["frontend"])
    to_user: str | None = None
    priority: Priority = Priority.normal
    due: datetime | None = None
    status: Status = Status.sent
    assignee: str | None = None
    readiness: Readiness = Field(
        default=Readiness.ready,
        description="ready to work on, or waiting for a deploy (after-deploy) or a decision (waiting-decision)",
    )
    readiness_note: str | None = Field(default=None, examples=["after shipment#178 is on dev"])
    delivery: Delivery | None = Field(
        default=None,
        description="Where the finished work is: local (uncommitted or unpushed), pushed, pr, merged",
    )
    related: list[int] = Field(default=[], description="Ids of reports this one continues or depends on")
    version: int = 1
    created_at: datetime
    updated_at: datetime

    @computed_field
    @property
    def overdue(self) -> bool:
        return self.due is not None and self.status in OPEN_STATUSES and self.due < datetime.now(UTC)


class ReportRow(ReportBase):
    replies: int = 0
    items_total: int = 0
    items_done: int = 0
    projects: list[str] = Field(default=[], description="Every repository the report or one of its items names")
    items_here_total: int | None = Field(default=None, description="Items for the projects asked about")
    items_here_done: int | None = None
    read: bool | None = Field(
        default=None,
        description="In my inbox: whether I opened this version of the report. Null where no reader is meant",
    )
    session: WorkSession | None = Field(
        default=None, description="In my inbox, on a report I hold: the session of mine that works on it"
    )


class ThreadRow(ReportRow):
    unread: int = Field(description="Replies by others that I have not read")
    last_reply_by: str
    last_reply_at: datetime
    last_reply_excerpt: str


class Report(ReportBase):
    text: str
    note: str | None = None
    items: list[Item] = []
    replies: list[Reply] = []
    taken_at: datetime | None = None
    closed_at: datetime | None = None
    closed_by: str | None = None
    status_before_closing: Status | None = None
    delivery_refs: list[str] = Field(default=[], description="Branch, PR link or commit of the finished work")

    @property
    def projects(self) -> list[str]:
        return list(dict.fromkeys([self.project, *(item.project for item in self.items if item.project)]))

    def row(
        self, here: set[str] | None = None, read: bool | None = None, session: WorkSession | None = None
    ) -> ReportRow:
        local = [item for item in self.items if (item.project or self.project) in here] if here else None
        hidden = {"replies", "text", "overdue", "items", "status_before_closing", "delivery_refs"}
        return ReportRow(
            **self.model_dump(exclude=hidden),
            replies=len(self.replies),
            items_total=len(self.items),
            items_done=sum(1 for item in self.items if item.done),
            projects=self.projects,
            items_here_total=len(local) if local is not None and self.items else None,
            items_here_done=sum(1 for item in local if item.done) if local is not None and self.items else None,
            read=read,
            session=session,
        )

    def sort_key(self) -> tuple:
        return (PRIORITY_ORDER[self.priority], self.due is None, self.due or self.created_at, self.created_at)


class SendRequest(BaseModel):
    to_team: str = Field(examples=["frontend"])
    to_user: str | None = Field(default=None, examples=[None])
    title: Line = Field(min_length=3, max_length=120, examples=["GET /loads is now paginated"])
    text: Body = Field(min_length=1, max_length=settings.MAX_TEXT_LENGTH)
    project: Project = Field(examples=["web-app"])
    priority: Priority = Priority.normal
    due: AwareDatetime | None = Field(
        default=None, description="Deadline with a UTC offset, e.g. 2026-10-09T18:00:00+05:00"
    )
    readiness: Readiness = Readiness.ready
    readiness_note: Line | None = Field(default=None, max_length=200)
    items: list[ItemInput] = Field(default=[], max_length=settings.MAX_ITEMS, description="Checklist, one line each")
    related: list[int] = Field(default=[], max_length=10)


class EditRequest(BaseModel):
    title: Line | None = Field(default=None, min_length=3, max_length=120)
    text: Body | None = Field(default=None, min_length=1, max_length=settings.MAX_TEXT_LENGTH)
    priority: Priority | None = None
    due: AwareDatetime | None = None
    clear_due: bool = False
    readiness: Readiness | None = None
    readiness_note: Line | None = Field(default=None, max_length=200)
    items: list[ItemInput] | None = Field(
        default=None,
        max_length=settings.MAX_ITEMS,
        description="Replaces the checklist; an item whose title is unchanged keeps its done mark",
    )
    related: list[int] | None = Field(default=None, max_length=10)


class CheckRequest(BaseModel):
    item_ids: list[int] = Field(min_length=1, max_length=settings.MAX_ITEMS, examples=[[1, 2]])
    done: bool = True


class ReplyRequest(BaseModel):
    text: Body = Field(min_length=1, max_length=settings.MAX_REPLY_LENGTH)


class ResolveRequest(BaseModel):
    status: Resolution
    note: Line = Field(default="", max_length=1000, description="Required for needs-changes")
    delivery: Delivery | None = Field(default=None, description="With done: where the finished work is")
    refs: list[Ref] = Field(default=[], max_length=10, description="Branch, PR link or commit")
    allow_open_items: bool = Field(default=False, description="Mark done although checklist items are unticked")


class DeliveryRequest(BaseModel):
    delivery: Delivery
    refs: list[Ref] = Field(default=[], max_length=10, description="Branch, PR link or commit")


class SessionRequest(BaseModel):
    session: str = Field(pattern=SESSION_ID, description="The Claude Code session's id")
    label: Line = Field(min_length=1, max_length=80, examples=["web-app"])


class CloseRequest(BaseModel):
    note: Line = Field(default="", max_length=1000, description="Optional: why it is not needed")


class ReopenRequest(BaseModel):
    note: Line = Field(default="", max_length=1000, description="Optional: why it is open again")


class InboxResponse(BaseModel):
    team: str
    user: str
    project: str | None = None
    projects: list[str] = Field(default=[], description="The projects asked about, aliases resolved")
    waiting: int = Field(description="Reports sent to my team that nobody has taken yet")
    waiting_for_project: int = Field(description="Of those, the ones that name one of the requested projects")
    unread: int = Field(default=0, description="Of the waiting reports, the ones I have not opened")
    overdue: int
    taken_by_me: int
    returned: int = Field(description="Reports I sent that came back as needs-changes")
    rows: list[ReportRow] = Field(description="My team's open reports that I have not hidden, most pressing first")
    returned_rows: list[ReportRow]
    hidden: int = Field(default=0, description="Open reports of my team that I hid from my own view")
    hidden_rows: list[ReportRow] = []
    unread_replies: int = Field(default=0, description="Unread replies on reports I sent, hold or am named in")
    threads: list[ThreadRow] = Field(default=[], description="Those reports, newest reply first")


class Event(BaseModel):
    type: EventType
    id: int
    title: str
    project: str
    priority: Priority
    by_team: str
    by_user: str
    from_team: str
    from_user: str
    to_team: str
    to_user: str | None = None
    note: str = ""
    teams: list[str]
    notify_users: list[str] | None = None


class HookInput(BaseModel):
    session_id: str | None = Field(default=None, max_length=200)
    source: str | None = Field(default=None, max_length=40)


class ErrorResponse(BaseModel):
    code: str = Field(examples=["conflict"])
    detail: str = Field(examples=["Report #12 is already taken by ali"])
