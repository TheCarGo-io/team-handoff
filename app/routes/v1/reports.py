from typing import Annotated

from fastapi import APIRouter, Query

from app.dependencies.auth import CurrentUser, Reports
from app.schemas.report import (
    EditRequest,
    InboxResponse,
    ReplyRequest,
    Report,
    ReportRow,
    ResolveRequest,
    SendRequest,
)
from app.schemas.responses import BAD_REQUEST, CONFLICT, FORBIDDEN, NOT_FOUND, UNAUTHORIZED, WRITE
from app.schemas.user import User

router = APIRouter(prefix="/api/v1", tags=["reports"], responses=UNAUTHORIZED)

Project = Annotated[str | None, Query(description="Repository name, e.g. thecargo-frontend")]


@router.get("/me", response_model=User)
async def me(user: CurrentUser) -> User:
    """Who the token belongs to."""
    return user


@router.get("/inbox", response_model=InboxResponse)
async def inbox(user: CurrentUser, reports: Reports, project: Project = None) -> InboxResponse:
    """My team's open reports (most pressing first) with the counts the terminal badge shows."""
    return await reports.inbox(user, project)


@router.get("/board", response_model=list[ReportRow])
async def board(user: CurrentUser, reports: Reports, project: Project = None) -> list[ReportRow]:
    """Every report of every team, open ones first."""
    return await reports.board(project)


@router.post("/reports", response_model=Report, status_code=201, responses={**BAD_REQUEST, **WRITE})
async def send(body: SendRequest, user: CurrentUser, reports: Reports) -> Report:
    """Send a report to a team, optionally addressed to one person in it."""
    return await reports.send(user, body)


@router.post("/reports/take-next", response_model=Report, responses={**NOT_FOUND, **WRITE})
async def take_next(user: CurrentUser, reports: Reports, project: Project = None) -> Report:
    """Take the most pressing waiting report of my team that is not addressed to someone else."""
    return await reports.take_next(user, project)


@router.get("/reports/{report_id}", response_model=Report, responses=NOT_FOUND)
async def get(report_id: int, user: CurrentUser, reports: Reports) -> Report:
    """One report with its full text and replies."""
    return await reports.get(report_id)


@router.patch(
    "/reports/{report_id}",
    response_model=Report,
    responses={**BAD_REQUEST, **NOT_FOUND, **FORBIDDEN, **CONFLICT, **WRITE},
)
async def edit(report_id: int, body: EditRequest, user: CurrentUser, reports: Reports) -> Report:
    """Edit a report I sent. A real change bumps its version; a needs-changes report goes back to sent."""
    return await reports.edit(user, report_id, body)


@router.delete("/reports/{report_id}", status_code=204, responses={**NOT_FOUND, **FORBIDDEN, **WRITE})
async def withdraw(report_id: int, user: CurrentUser, reports: Reports) -> None:
    """Withdraw a report I sent: it is deleted at once, in any status."""
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
    """Close a report as done or rejected, or hand it back as needs-changes (the last two need a note)."""
    return await reports.resolve(user, report_id, body)
