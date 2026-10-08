from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from redis.asyncio import Redis
from redis.exceptions import WatchError

from app.core.config import settings
from app.core.errors import Conflict, NotFound
from app.core.redis import key
from app.schemas.report import CLOSED_STATUSES, Report


def ttl_seconds(report: Report) -> int:
    if report.status in CLOSED_STATUSES and report.closed_at is not None:
        expires_at = report.closed_at + timedelta(hours=settings.CLOSED_TTL_HOURS)
        return max(60, int((expires_at - datetime.now(UTC)).total_seconds()))
    return settings.OPEN_TTL_DAYS * 86400


class ReportRepository:
    def __init__(self, redis: Redis):
        self.redis = redis

    async def next_id(self) -> int:
        return await self.redis.incr(key("seq"))

    async def next_reply_id(self) -> int:
        return await self.redis.incr(key("reply_seq"))

    async def count_write(self, user: str) -> int:
        name = key("writes", user, datetime.now(UTC).strftime("%Y%m%d%H%M"))
        async with self.redis.pipeline(transaction=True) as pipe:
            pipe.incr(name)
            pipe.expire(name, 120)
            count, _ = await pipe.execute()
        return count

    async def save(self, report: Report) -> None:
        async with self.redis.pipeline(transaction=True) as pipe:
            pipe.set(key("report", report.id), report.model_dump_json(), ex=ttl_seconds(report))
            pipe.sadd(key("reports"), report.id)
            await pipe.execute()

    async def get(self, report_id: int) -> Report:
        raw = await self.redis.get(key("report", report_id))
        if raw is None:
            raise NotFound(f"Report #{report_id} does not exist or has expired")
        return Report.model_validate_json(raw)

    async def all(self) -> list[Report]:
        ids = sorted(int(report_id) for report_id in await self.redis.smembers(key("reports")))
        if not ids:
            return []
        raws = await self.redis.mget([key("report", report_id) for report_id in ids])
        expired = [report_id for report_id, raw in zip(ids, raws, strict=True) if raw is None]
        if expired:
            await self.redis.srem(key("reports"), *expired)
        return [Report.model_validate_json(raw) for raw in raws if raw is not None]

    async def mutate(
        self, report_id: int, change: Callable[[Report], bool], delete: bool = False
    ) -> tuple[Report, bool]:
        name = key("report", report_id)
        async with self.redis.pipeline(transaction=True) as pipe:
            for _ in range(5):
                try:
                    await pipe.watch(name)
                    raw = await pipe.get(name)
                    if raw is None:
                        raise NotFound(f"Report #{report_id} does not exist or has expired")
                    report = Report.model_validate_json(raw)
                    if not change(report):
                        await pipe.unwatch()
                        return report, False
                    pipe.multi()
                    if delete:
                        pipe.delete(name)
                        pipe.srem(key("reports"), report_id)
                    else:
                        pipe.set(name, report.model_dump_json(), ex=ttl_seconds(report))
                    await pipe.execute()
                    return report, True
                except WatchError:
                    continue
        raise Conflict(f"Report #{report_id} is being changed by someone else, try again")
