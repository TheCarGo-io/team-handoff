from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.database import async_session
from app.services.container import get_hub

router = APIRouter(tags=["health"])


@router.get("/health/live")
async def live() -> dict[str, str]:
    """Liveness probe."""
    return {"status": "ok"}


@router.get(
    "/health/ready",
    responses={503: {"description": "The database is unreachable, or the event listener is down"}},
)
async def ready() -> JSONResponse:
    """Readiness probe: the database answers and the event listener is subscribed."""
    try:
        async with async_session() as session:
            await session.execute(text("select 1"))
        database_ok = True
    except Exception:
        database_ok = False
    listening = get_hub().listening
    healthy = database_ok and listening
    status = "ok" if healthy else "degraded"
    body = {"status": status, "database": database_ok, "events": listening}
    return JSONResponse(body, status_code=200 if healthy else 503)
