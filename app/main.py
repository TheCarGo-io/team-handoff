import asyncio
import contextlib
import logging
import signal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.errors import HandoffError
from app.core.redis import close_redis
from app.dependencies.auth import BearerGate
from app.mcp.server import mcp
from app.routes import health
from app.routes.v1 import events, reports
from app.services.container import get_hub
from app.services.events import EventHub

logging.basicConfig(level=logging.DEBUG if settings.DEBUG else logging.INFO)


def end_streams_on_shutdown(hub: EventHub) -> None:
    for number in (signal.SIGTERM, signal.SIGINT):
        previous = signal.getsignal(number)

        def handler(received: int, frame: object, previous: object = previous) -> None:
            hub.close()
            if callable(previous):
                previous(received, frame)

        with contextlib.suppress(ValueError):
            signal.signal(number, handler)


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    hub = get_hub()
    end_streams_on_shutdown(hub)
    listener = asyncio.create_task(hub.run())
    async with mcp.session_manager.run():
        yield
    hub.close()
    listener.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await listener
    await close_redis()


app = FastAPI(title="TheCargo Handoff", version="0.1.0", lifespan=lifespan)


@app.exception_handler(HandoffError)
async def handoff_error(_: Request, error: HandoffError) -> JSONResponse:
    return JSONResponse({"code": error.code, "detail": error.message}, status_code=error.status_code)


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, error: RequestValidationError) -> JSONResponse:
    problems = [
        f"{'.'.join(str(part) for part in item['loc'][1:]) or item['loc'][0]}: {item['msg']}" for item in error.errors()
    ]
    return JSONResponse({"code": "validation_error", "detail": "; ".join(problems)}, status_code=422)


app.include_router(health.router)
app.include_router(reports.router)
app.include_router(events.router)
app.mount("/mcp", BearerGate(mcp.streamable_http_app()))
