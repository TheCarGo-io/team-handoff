from app.core.config import settings
from app.core.database import async_session
from app.repositories.report import ReportRepository
from app.repositories.user import UserRepository
from app.services.events import EventHub
from app.services.limits import WriteCounter
from app.services.members import MemberService
from app.services.report import ReportService

_hub: EventHub | None = None
_writes = WriteCounter()


def get_hub() -> EventHub:
    global _hub
    if _hub is None:
        _hub = EventHub(async_session, settings.listen_dsn)
    return _hub


def reset_hub() -> None:
    global _hub, _writes
    _hub = None
    _writes = WriteCounter()


def get_users() -> UserRepository:
    return UserRepository(async_session)


def get_member_service() -> MemberService:
    return MemberService(UserRepository(async_session), ReportRepository(async_session), get_hub())


def get_report_service() -> ReportService:
    return ReportService(ReportRepository(async_session), UserRepository(async_session), get_hub(), _writes)
