from functools import partial
from typing import Annotated

from fastapi import APIRouter, Path, Query
from fastapi.responses import StreamingResponse

from app.dependencies.auth import Authorization, CurrentUser, is_authorized
from app.schemas.report import SESSION_ID
from app.schemas.responses import UNAUTHORIZED
from app.services.container import get_hub
from app.services.events import stream

router = APIRouter(prefix="/api/v1", tags=["events"], responses=UNAUTHORIZED)

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
Session = Annotated[
    str | None,
    Query(pattern=SESSION_ID, description="The Claude Code session's id: marks that session as open while it listens"),
]


@router.put("/sessions/{session}", status_code=204)
async def expect(user: CurrentUser, session: Annotated[str, Path(pattern=SESSION_ID)]) -> None:
    """Say that this Claude Code session is starting and will listen to `/events` in a moment, so it counts
    as open already and the session-start fallback stays quiet for it."""
    get_hub().expect(user.name, session)


@router.get(
    "/events",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {}}, "description": "One `data:` JSON line per event"}},
)
async def events(user: CurrentUser, authorization: Authorization = None, session: Session = None) -> StreamingResponse:
    """Server-sent events for my team: new, edited, ready, taken, progress, reply, done, needs-changes,
    closed, reopened, withdrawn.

    `resync` means events may have been missed: re-read the inbox. The stream ends when the token is revoked.
    """
    lines = stream(get_hub(), user, partial(is_authorized, authorization), session)
    return StreamingResponse(lines, media_type="text/event-stream", headers=SSE_HEADERS)
