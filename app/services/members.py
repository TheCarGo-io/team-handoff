import logging

from app import MIN_PLUGIN, __version__
from app.core.config import settings
from app.core.errors import Conflict, Forbidden, NotFound
from app.repositories.report import ReportRepository
from app.repositories.user import UserRepository
from app.schemas.report import Report, Status
from app.schemas.user import (
    Invite,
    InviteRequest,
    Joined,
    JoinRequest,
    Member,
    MembersResponse,
    Meta,
    Team,
    Token,
    User,
)
from app.services.events import EventHub

logger = logging.getLogger("handoff.audit")


def join_url(code: str) -> str:
    return f"{settings.PUBLIC_URL.rstrip('/')}/join/{code}"


class MemberService:
    def __init__(self, users: UserRepository, reports: ReportRepository, hub: EventHub):
        self.users = users
        self.reports = reports
        self.hub = hub

    def meta(self) -> Meta:
        return Meta(version=__version__, min_plugin=MIN_PLUGIN)

    async def members(self) -> MembersResponse:
        people = await self.users.all()
        teams = [
            Team(name=name, members=[Member(name=p.name, is_admin=p.is_admin) for p in people if p.team == name])
            for name in await self.users.teams()
        ]
        return MembersResponse(teams=teams)

    async def invite(self, actor: User, body: InviteRequest) -> Invite:
        if not actor.is_admin:
            raise Forbidden("Only an admin can invite people")
        code, expires_at = await self.users.create_invite(body.team, body.admin, actor.name, body.days)
        logger.info("invite by=%s team=%s admin=%s", actor.name, body.team, body.admin)
        return Invite(url=join_url(code), team=body.team, admin=body.admin, expires_at=expires_at)

    async def join(self, body: JoinRequest) -> Joined:
        user, token = await self.users.join(body.code, body.name, body.team)
        logger.info("joined name=%s team=%s admin=%s", user.name, user.team, user.is_admin)
        await self.hub.refresh_user(None)
        return Joined(name=user.name, team=user.team, is_admin=user.is_admin, url=settings.PUBLIC_URL, token=token)

    async def remove(self, actor: User, name: str) -> None:
        if not actor.is_admin:
            raise Forbidden("Only an admin can remove people")
        target = await self.users.get(name)
        if target is None:
            raise NotFound(f"Nobody is called '{name}'")
        if target.is_admin and await self.users.count(admins_only=True) < 2:
            raise Conflict("The last admin cannot be removed: make someone else an admin first")

        def free(report: Report) -> bool:
            if report.status != Status.taken or report.assignee != name:
                return False
            report.status = Status.sent
            report.assignee = None
            report.taken_at = None
            return True

        for report in await self.reports.listing():
            if report.status == Status.taken and report.assignee == name:
                await self.reports.mutate(report.id, free)
        await self.users.remove(name)
        logger.info("removed name=%s by=%s", name, actor.name)
        await self.hub.refresh_user(None)

    async def rotate(self, actor: User) -> Token:
        logger.info("token rotated name=%s", actor.name)
        return Token(token=await self.users.rotate(actor.name))

    async def bootstrap(self) -> str | None:
        if not await self.users.teams():
            await self.users.add_teams(*settings.TEAMS)
        if await self.users.count() > 0:
            return None
        code, _ = await self.users.create_invite(None, True, None, 7)
        return join_url(code)
