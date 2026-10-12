from typing import Annotated

from fastapi import APIRouter, Query

from app.dependencies.auth import CurrentUser, Reports
from app.schemas.report import (
    CheckRequest,
    CloseRequest,
    DeliveryRequest,
    EditRequest,
    InboxResponse,
    ReopenRequest,
    ReplyRequest,
    Report,
    ReportRow,
    ResolveRequest,
    SendRequest,
    SessionRequest,
)
from app.schemas.responses import BAD_REQUEST, CONFLICT, FORBIDDEN, NOT_FOUND, UNAUTHORIZED, WRITE
from app.schemas.user import User

router = APIRouter(prefix="/api/v1", tags=["reports"], responses=UNAUTHORIZED)

Project = Annotated[str | None, Query(description="Repository name, e.g. web-app")]
Projects = Annotated[
    list[str],
    Query(alias="project", description="Repository names of this session; repeat the parameter for a workspace"),
]


@router.get("/me", response_model=User)
async def me(user: CurrentUser) -> User:
    """Who the token belongs to."""
    return user


@router.get("/inbox", response_model=InboxResponse)
async def inbox(user: CurrentUser, reports: Reports, projects: Projects = []) -> InboxResponse:  # noqa: B006
    """My team's open reports (most pressing first) with the counts the terminal badge shows. Reports I hid
    are left out of both and listed under `hidden_rows`; `threads` are reports with replies I have not read,
    whichever team they were sent to."""
    return await reports.inbox(user, projects)


@router.get("/board", response_model=list[ReportRow])
async def board(
    user: CurrentUser, reports: Reports, project: Project = None, archived: bool = False
) -> list[ReportRow]:
    """Every team's reports, open ones first. Closed ones show for 14 days; `archived=true` lists them all."""
    return await reports.board(project, archived)


@router.post("/reports", response_model=Report, status_code=201, responses={**BAD_REQUEST, **WRITE})
async def send(body: SendRequest, user: CurrentUser, reports: Reports) -> Report:
    """Send a report to a team, optionally addressed to one person in it."""
    return await reports.send(user, body)


@router.post("/reports/take-next", response_model=Report, responses={**NOT_FOUND, **WRITE})
async def take_next(user: CurrentUser, reports: Reports, project: Project = None) -> Report:
    """Take the most pressing waiting report of my team that is ready and not addressed to someone else."""
    return await reports.take_next(user, project)


@router.get("/reports/{report_id}", response_model=Report, responses=NOT_FOUND)
async def get(report_id: int, user: CurrentUser, reports: Reports, mark_seen: bool = False) -> Report:
    """One report with its full text and replies. `mark_seen=true` marks it and its replies as read by me."""
    report, _ = await reports.read(user, report_id, mark_seen)
    return report


@router.patch(
    "/reports/{report_id}",
    response_model=Report,
    responses={**BAD_REQUEST, **NOT_FOUND, **FORBIDDEN, **CONFLICT, **WRITE},
)
async def edit(report_id: int, body: EditRequest, user: CurrentUser, reports: Reports) -> Report:
    """Edit a report I sent: text, checklist, readiness. A real change bumps its version; a needs-changes
    report goes back to sent; flipping to ready tells the receiver."""
    return await reports.edit(user, report_id, body)


@router.delete("/reports/{report_id}", status_code=204, responses={**NOT_FOUND, **FORBIDDEN, **WRITE})
async def withdraw(report_id: int, user: CurrentUser, reports: Reports) -> None:
    """Withdraw a report I sent: it is deleted for good, in any status."""
    await reports.withdraw(user, report_id)


@router.post(
    "/reports/{report_id}/take",
    response_model=Report,
    responses={**NOT_FOUND, **FORBIDDEN, **CONFLICT, **WRITE},
)
async def take(report_id: int, user: CurrentUser, reports: Reports) -> Report:
    """Take a waiting report. Only one person can hold it."""
    return await reports.take(user, report_id)


@router.post(
    "/reports/{report_id}/replies",
    response_model=Report,
    responses={**NOT_FOUND, **FORBIDDEN, **CONFLICT, **WRITE},
)
async def reply(report_id: int, body: ReplyRequest, user: CurrentUser, reports: Reports) -> Report:
    """Add a reply under a report."""
    return await reports.reply(user, report_id, body)


@router.post(
    "/reports/{report_id}/resolve",
    response_model=Report,
    responses={**BAD_REQUEST, **NOT_FOUND, **FORBIDDEN, **CONFLICT, **WRITE},
)
async def resolve(report_id: int, body: ResolveRequest, user: CurrentUser, reports: Reports) -> Report:
    """Mark a report my team received as done, or hand it back as needs-changes (which needs a note)."""
    return await reports.resolve(user, report_id, body)


@router.post(
    "/reports/{report_id}/items/check",
    response_model=Report,
    responses={**BAD_REQUEST, **NOT_FOUND, **FORBIDDEN, **CONFLICT, **WRITE},
)
async def check(report_id: int, body: CheckRequest, user: CurrentUser, reports: Reports) -> Report:
    """Tick (or untick) checklist items of a report my team received. The sender is told the progress."""
    return await reports.check(user, report_id, body)


@router.post("/reports/{report_id}/close", response_model=Report, responses={**NOT_FOUND, **CONFLICT, **WRITE})
async def close(report_id: int, user: CurrentUser, reports: Reports, body: CloseRequest | None = None) -> Report:
    """Close an open report that is not needed. Anyone may do it; the sender and the holder are notified."""
    return await reports.close(user, report_id, body or CloseRequest())


@router.post(
    "/reports/{report_id}/reopen",
    response_model=Report,
    responses={**NOT_FOUND, **FORBIDDEN, **CONFLICT, **WRITE},
)
async def reopen(report_id: int, user: CurrentUser, reports: Reports, body: ReopenRequest | None = None) -> Report:
    """Reopen a closed or done report. Its sender, its holder or whoever closed it may."""
    return await reports.reopen(user, report_id, body or ReopenRequest())


@router.post("/reports/{report_id}/hide", status_code=204, responses=NOT_FOUND)
async def hide(report_id: int, user: CurrentUser, reports: Reports) -> None:
    """Hide a report from my own inbox and counts. Nothing changes for anyone else."""
    await reports.hide(user, report_id, True)


@router.delete("/reports/{report_id}/hide", status_code=204, responses=NOT_FOUND)
async def unhide(report_id: int, user: CurrentUser, reports: Reports) -> None:
    """Show a report I hid again."""
    await reports.hide(user, report_id, False)


@router.put("/reports/{report_id}/session", status_code=204, responses={**NOT_FOUND, **CONFLICT})
async def assign(report_id: int, body: SessionRequest, user: CurrentUser, reports: Reports) -> None:
    """Say which of my Claude Code sessions works on a report I hold. My other sessions then list it apart;
    nobody else is told. Taking a report in a session does this by itself when the plugin is installed."""
    await reports.assign(user, report_id, body)


@router.delete("/reports/{report_id}/session", status_code=204, responses=NOT_FOUND)
async def release(report_id: int, user: CurrentUser, reports: Reports) -> None:
    """Take a report I hold out of the session it was put in: every session of mine lists it again."""
    await reports.release(user, report_id)


@router.post(
    "/reports/{report_id}/delivery",
    response_model=Report,
    responses={**NOT_FOUND, **FORBIDDEN, **CONFLICT, **WRITE},
)
async def deliver(report_id: int, body: DeliveryRequest, user: CurrentUser, reports: Reports) -> Report:
    """Record where the work of a done report is now: local, pushed, pr or merged. The sender is told."""
    return await reports.deliver(user, report_id, body)
