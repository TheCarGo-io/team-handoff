from functools import partial

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from app.dependencies.auth import Authorization, CurrentUser, is_authorized
from app.schemas.responses import UNAUTHORIZED
from app.services.container import get_hub
from app.services.events import stream

router = APIRouter(prefix="/api/v1", tags=["events"], responses=UNAUTHORIZED)

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


@router.get(
    "/events",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {}}, "description": "One `data:` JSON line per event"}},
)
async def events(user: CurrentUser, authorization: Authorization = None) -> StreamingResponse:
    """Server-sent events for my team: new, edited, taken, reply, done, rejected, needs-changes, withdrawn.

    `resync` means events may have been missed: re-read the inbox. The stream ends when the token is revoked.
    """
    lines = stream(get_hub(), user, partial(is_authorized, authorization))
    return StreamingResponse(lines, media_type="text/event-stream", headers=SSE_HEADERS)
