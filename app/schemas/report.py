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
    needs_changes = "needs-changes"


class Resolution(str, Enum):
    done = "done"
    rejected = "rejected"
    needs_changes = "needs-changes"


class EventType(str, Enum):
    new = "new"
    edited = "edited"
    taken = "taken"
    reply = "reply"
    done = "done"
    rejected = "rejected"
    needs_changes = "needs-changes"
    withdrawn = "withdrawn"


PRIORITY_ORDER = {Priority.urgent: 0, Priority.high: 1, Priority.normal: 2, Priority.low: 3}
OPEN_STATUSES = (Status.sent, Status.taken, Status.needs_changes)
CLOSED_STATUSES = (Status.done, Status.rejected)


class Reply(BaseModel):
    id: int
    team: str
    user: str
    text: str
    created_at: datetime


class ReportBase(BaseModel):
    id: int = Field(examples=[12])
    title: str = Field(examples=["GET /loads is now paginated"])
    project: str = Field(examples=["thecargo-frontend"])
    from_team: str = Field(examples=["backend"])
    from_user: str = Field(examples=["asliddin"])
    to_team: str = Field(examples=["frontend"])
    to_user: str | None = None
    priority: Priority = Priority.normal
    due: datetime | None = None
    status: Status = Status.sent
    assignee: str | None = None
    version: int = 1
    created_at: datetime
    updated_at: datetime

    @computed_field
    @property
    def overdue(self) -> bool:
        return self.due is not None and self.status in OPEN_STATUSES and self.due < datetime.now(UTC)


class ReportRow(ReportBase):
    replies: int = 0


class Report(ReportBase):
    text: str
    note: str | None = None
    replies: list[Reply] = []
    taken_at: datetime | None = None
    closed_at: datetime | None = None

    def row(self) -> ReportRow:
        return ReportRow(**self.model_dump(exclude={"replies", "text", "overdue"}), replies=len(self.replies))

    def sort_key(self) -> tuple:
        return (PRIORITY_ORDER[self.priority], self.due is None, self.due or self.created_at, self.created_at)


class SendRequest(BaseModel):
    to_team: str = Field(examples=["frontend"])
    to_user: str | None = Field(default=None, examples=[None])
    title: Line = Field(min_length=3, max_length=120, examples=["GET /loads is now paginated"])
    text: Body = Field(min_length=1, max_length=settings.MAX_TEXT_LENGTH)
    project: Project = Field(examples=["thecargo-frontend"])
    priority: Priority = Priority.normal
    due: AwareDatetime | None = Field(
        default=None, description="Deadline with a UTC offset, e.g. 2026-10-09T18:00:00+05:00"
    )


class EditRequest(BaseModel):
    title: Line | None = Field(default=None, min_length=3, max_length=120)
    text: Body | None = Field(default=None, min_length=1, max_length=settings.MAX_TEXT_LENGTH)
    priority: Priority | None = None
    due: AwareDatetime | None = None
    clear_due: bool = False


class ReplyRequest(BaseModel):
    text: Body = Field(min_length=1, max_length=settings.MAX_REPLY_LENGTH)


class ResolveRequest(BaseModel):
    status: Resolution
    note: Line = Field(default="", max_length=1000, description="Required for rejected and needs-changes")


class InboxResponse(BaseModel):
    team: str
    user: str
    project: str | None = None
    waiting: int = Field(description="Reports sent to my team that nobody has taken yet")
    waiting_for_project: int = Field(description="Of those, the ones for the requested project")
    overdue: int
    taken_by_me: int
    returned: int = Field(description="Reports I sent that came back as needs-changes")
    rows: list[ReportRow] = Field(description="My team's open reports, most pressing first")
    returned_rows: list[ReportRow]


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


class ErrorResponse(BaseModel):
    code: str = Field(examples=["conflict"])
    detail: str = Field(examples=["Report #12 is already taken by ali"])
