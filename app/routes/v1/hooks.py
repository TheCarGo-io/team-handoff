from fastapi import APIRouter

from app.dependencies.auth import CurrentUser, Reports
from app.schemas.report import HookInput
from app.schemas.responses import UNAUTHORIZED

router = APIRouter(prefix="/api/v1", tags=["hooks"], responses=UNAUTHORIZED)


@router.post("/hooks/session-start")
async def session_start(body: HookInput, user: CurrentUser, reports: Reports) -> dict:
    """What a Claude Code `SessionStart` command hook should print: one line saying what waits for me, as
    `systemMessage` and `additionalContext`, or `{}` when nothing waits or that session already listens to
    `/events`. The plugin's fallback hook posts its stdin here; only `session_id` and `source` are read."""
    return await reports.announce(user, body)
