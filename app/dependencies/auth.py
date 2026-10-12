from typing import Annotated

from fastapi import Depends, Header
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.core.errors import HandoffError, Unauthorized
from app.schemas.user import User
from app.services.container import get_member_service, get_report_service, get_users
from app.services.members import MemberService
from app.services.report import ReportService

USER_KEY = "handoff_user"


async def authenticate(authorization: str | None) -> User:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise Unauthorized("Send your handoff token as 'Authorization: Bearer <token>'")
    user = await get_users().by_token(token.strip())
    if user is None:
        raise Unauthorized("Unknown or revoked handoff token")
    return user


async def is_authorized(authorization: str | None) -> bool:
    try:
        await authenticate(authorization)
    except Unauthorized:
        return False
    return True


async def current_user(authorization: Annotated[str | None, Header()] = None) -> User:
    return await authenticate(authorization)


class BearerGate:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope["headers"])
        try:
            user = await authenticate(headers.get(b"authorization", b"").decode("latin-1") or None)
        except HandoffError as error:
            body = {"code": error.code, "detail": error.message}
            response = JSONResponse(body, status_code=error.status_code, headers={"WWW-Authenticate": "Bearer"})
            await response(scope, receive, send)
            return
        scope.setdefault("state", {})[USER_KEY] = user
        await self.app(scope, receive, send)


Authorization = Annotated[str | None, Header(include_in_schema=False)]
CurrentUser = Annotated[User, Depends(current_user)]
Reports = Annotated[ReportService, Depends(get_report_service)]
Members = Annotated[MemberService, Depends(get_member_service)]
