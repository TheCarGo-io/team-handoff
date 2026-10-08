from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.core.redis import get_redis
from app.services.container import get_hub

router = APIRouter(tags=["health"])


@router.get("/health/live")
async def live() -> dict[str, str]:
    """Liveness probe."""
    return {"status": "ok"}


@router.get("/health/ready", responses={503: {"description": "Redis is unreachable or the event listener is down"}})
async def ready() -> JSONResponse:
    """Readiness probe: Redis answers and the event listener is subscribed."""
    try:
        await get_redis().ping()
        redis_ok = True
    except Exception:
        redis_ok = False
    listening = get_hub().listening
    healthy = redis_ok and listening
    body = {"status": "ok" if healthy else "degraded", "redis": redis_ok, "events": listening}
    return JSONResponse(body, status_code=200 if healthy else 503)
