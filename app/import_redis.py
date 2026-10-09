import argparse
import asyncio

from sqlalchemy import func, insert, select, text

from app.core.database import async_session, engine
from app.core.redis import get_redis, key
from app.models import HiddenReport, ItemRecord, ReplyRead, ReplyRecord, ReportRecord, UserRecord
from app.repositories.report import item_values, reply_values, values_of
from app.schemas.report import Report

SEQUENCE = "select setval(pg_get_serial_sequence(:table, 'id'), :value)"


async def run(force: bool) -> None:
    redis = get_redis()
    async with async_session() as session, session.begin():
        users = await session.scalar(select(func.count()).select_from(UserRecord))
        reports = await session.scalar(select(func.count()).select_from(ReportRecord))
        if (users or reports) and not force:
            print(f"database already holds {users} users and {reports} reports: nothing imported")
            return
        teams = await redis.hgetall(key("users"))
        hashes = await redis.hgetall(key("user_tokens"))
        people = [{"name": n, "team": t, "token_hash": hashes[n]} for n, t in teams.items() if n in hashes]
        if people:
            await session.execute(insert(UserRecord).values(people))
        imported, replies = [], 0
        for report_id in sorted(int(member) for member in await redis.smembers(key("reports"))):
            raw = await redis.get(key("report", report_id))
            if raw is None:
                continue
            report = Report.model_validate_json(raw)
            await session.execute(insert(ReportRecord).values(id=report.id, **values_of(report)))
            if report.items:
                await session.execute(insert(ItemRecord).values([item_values(report.id, i) for i in report.items]))
            if report.replies:
                rows = [{"id": reply.id, **reply_values(report.id, reply)} for reply in report.replies]
                await session.execute(insert(ReplyRecord).values(rows))
                replies += len(rows)
            imported.append(report.id)
        marks = 0
        for name in teams:
            hidden = {int(member) for member in await redis.smembers(key("hidden", name))} & set(imported)
            if hidden:
                await session.execute(
                    insert(HiddenReport).values([{"user_name": name, "report_id": i} for i in hidden])
                )
            seen = {int(k): int(v) for k, v in (await redis.hgetall(key("seen", name))).items() if int(k) in imported}
            if seen:
                rows = [{"user_name": name, "report_id": k, "reply_id": v} for k, v in seen.items()]
                await session.execute(insert(ReplyRead).values(rows))
            marks += len(hidden) + len(seen)
        last_report = max([int(await redis.get(key("seq")) or 0), *imported])
        last_reply = max(int(await redis.get(key("reply_seq")) or 0), replies and 1)
        if last_report:
            await session.execute(text(SEQUENCE), {"table": "reports", "value": last_report})
        if last_reply:
            await session.execute(text(SEQUENCE), {"table": "replies", "value": last_reply})
    print(f"imported {len(people)} users, {len(imported)} reports, {replies} replies, {marks} personal marks")


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m app.import_redis", description="One-off copy of Redis data")
    parser.add_argument("--force", action="store_true", help="import even if the database already holds data")

    async def go() -> None:
        try:
            await run(parser.parse_args().force)
        finally:
            await get_redis().aclose()
            await engine.dispose()

    asyncio.run(go())


if __name__ == "__main__":
    main()
