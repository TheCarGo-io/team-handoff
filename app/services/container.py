from app.core.redis import get_redis
from app.repositories.report import ReportRepository
from app.repositories.user import UserRepository
from app.services.events import EventHub
from app.services.report import ReportService

_hub: EventHub | None = None


def get_hub() -> EventHub:
    global _hub
    if _hub is None:
        _hub = EventHub(get_redis())
    return _hub


def reset_hub() -> None:
    global _hub
    _hub = None


def get_users() -> UserRepository:
    return UserRepository(get_redis())


def get_report_service() -> ReportService:
    redis = get_redis()
    return ReportService(ReportRepository(redis), UserRepository(redis), get_hub())
