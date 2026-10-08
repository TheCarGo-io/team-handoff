import asyncio
from functools import partial

from app.core.config import settings
from app.dependencies.auth import is_authorized
from app.repositories.user import UserRepository
from app.schemas.user import User
from app.services.events import EventHub, stream
from tests.conftest import report_body


async def next_event(subscriber) -> dict:
    return await asyncio.wait_for(subscriber.queue.get(), timeout=2)


async def test_new_report_notifies_the_receiving_team_and_nobody_else(client, tokens, hub):
    ali = hub.subscribe(User(name="ali", team="frontend"))
    dana = hub.subscribe(User(name="dana", team="design"))
    sender = hub.subscribe(User(name="asliddin", team="backend"))

    await client.post("/api/v1/reports", json=report_body(priority="urgent"), headers=tokens["asliddin"])

    event = await next_event(ali)
    assert event["type"] == "new" and event["notify"] is True and event["priority"] == "urgent"
    assert event["by_user"] == "asliddin" and "teams" not in event
    await asyncio.sleep(0.05)
    assert dana.queue.empty() and sender.queue.empty()


async def test_addressed_report_toasts_only_the_named_person(client, tokens, hub):
    ali = hub.subscribe(User(name="ali", team="frontend"))
    vali = hub.subscribe(User(name="vali", team="frontend"))

    await client.post("/api/v1/reports", json=report_body(to_user="vali"), headers=tokens["asliddin"])

    assert (await next_event(ali))["notify"] is False
    assert (await next_event(vali))["notify"] is True


async def test_status_changes_notify_the_sender_and_refresh_teammates_silently(client, tokens, hub):
    report = (await client.post("/api/v1/reports", json=report_body(), headers=tokens["asliddin"])).json()
    await asyncio.sleep(0.05)
    sender = hub.subscribe(User(name="asliddin", team="backend"))
    colleague = hub.subscribe(User(name="bobur", team="backend"))
    taker = hub.subscribe(User(name="ali", team="frontend"))
    teammate = hub.subscribe(User(name="vali", team="frontend"))

    await client.post(f"/api/v1/reports/{report['id']}/take", headers=tokens["ali"])
    assert await next_event(sender) == sender_event(report, "taken")
    assert (await next_event(colleague))["notify"] is False
    assert (await next_event(taker))["notify"] is False
    assert (await next_event(teammate))["notify"] is False

    body = {"status": "done", "note": "PR #88"}
    await client.post(f"/api/v1/reports/{report['id']}/resolve", json=body, headers=tokens["ali"])
    done = await next_event(sender)
    assert done["type"] == "done" and done["notify"] is True and done["note"] == "PR #88"


def sender_event(report: dict, kind: str) -> dict:
    return {
        "type": kind,
        "id": report["id"],
        "title": report["title"],
        "project": report["project"],
        "priority": "normal",
        "by_team": "frontend",
        "by_user": "ali",
        "from_team": "backend",
        "from_user": "asliddin",
        "to_team": "frontend",
        "to_user": None,
        "note": "",
        "notify": True,
    }


async def allow() -> bool:
    return True


async def test_stream_emits_events_as_sse_lines_and_ends_on_shutdown(client, tokens, hub):
    lines = stream(hub, User(name="ali", team="frontend"), allow)
    assert await anext(lines) == ": connected\n\n"
    await client.post("/api/v1/reports", json=report_body(), headers=tokens["asliddin"])
    line = await asyncio.wait_for(anext(lines), timeout=2)
    assert line.startswith('data: {"type": "new"') and line.endswith("\n\n")
    hub.close()
    assert [extra async for extra in lines] == []
    assert hub.subscribers == []


async def test_stream_ends_at_the_next_heartbeat_after_the_token_is_revoked(redis, tokens, hub, monkeypatch):
    monkeypatch.setattr(settings, "SSE_HEARTBEAT_SECONDS", 0.05)
    lines = stream(hub, User(name="ali", team="frontend"), partial(is_authorized, tokens["ali"]["Authorization"]))
    assert await anext(lines) == ": connected\n\n"
    assert await anext(lines) == ": ping\n\n"
    await UserRepository(redis).create("ali", "frontend")
    assert [extra async for extra in lines] == []


async def test_a_users_oldest_stream_is_closed_past_the_cap(hub, monkeypatch):
    monkeypatch.setattr(settings, "MAX_STREAMS_PER_USER", 2)
    ali = User(name="ali", team="frontend")
    first, second, third = hub.subscribe(ali), hub.subscribe(ali), hub.subscribe(ali)
    assert first.dropped and await next_event(first) is None
    assert hub.subscribers == [second, third]


async def test_a_slow_client_is_dropped_instead_of_blocking_delivery(client, tokens, hub):
    slow = hub.subscribe(User(name="ali", team="frontend"))
    for _ in range(slow.queue.maxsize):
        slow.queue.put_nowait({"type": "filler"})
    healthy = hub.subscribe(User(name="vali", team="frontend"))

    await client.post("/api/v1/reports", json=report_body(), headers=tokens["asliddin"])

    assert (await next_event(healthy))["type"] == "new"
    assert slow.dropped and slow not in hub.subscribers


async def test_subscribers_are_told_to_resync_when_the_listener_reconnects(redis):
    hub = EventHub(redis)
    ali = hub.subscribe(User(name="ali", team="frontend"))
    listener = asyncio.create_task(hub.run())
    assert await next_event(ali) == {"type": "resync", "notify": False}
    hub.close()
    listener.cancel()
    await asyncio.gather(listener, return_exceptions=True)


async def test_a_failed_publish_does_not_fail_the_change(client, tokens, redis, monkeypatch):
    async def broken(*args, **kwargs):
        raise ConnectionError("redis is away")

    monkeypatch.setattr(redis, "publish", broken)
    response = await client.post("/api/v1/reports", json=report_body(), headers=tokens["asliddin"])
    assert response.status_code == 201


async def test_retake_by_the_holder_does_not_notify_again(client, tokens, hub):
    report = (await client.post("/api/v1/reports", json=report_body(), headers=tokens["asliddin"])).json()
    await asyncio.sleep(0.05)
    sender = hub.subscribe(User(name="asliddin", team="backend"))
    for _ in range(3):
        await client.post(f"/api/v1/reports/{report['id']}/take", headers=tokens["ali"])
    assert (await next_event(sender))["type"] == "taken"
    await asyncio.sleep(0.05)
    assert sender.queue.empty()


async def test_holder_is_notified_when_a_teammate_closes_their_report(client, tokens, hub):
    report = (await client.post("/api/v1/reports", json=report_body(), headers=tokens["asliddin"])).json()
    await client.post(f"/api/v1/reports/{report['id']}/take", headers=tokens["ali"])
    await asyncio.sleep(0.05)
    holder = hub.subscribe(User(name="ali", team="frontend"))
    body = {"status": "rejected", "note": "duplicate of #3"}
    await client.post(f"/api/v1/reports/{report['id']}/resolve", json=body, headers=tokens["vali"])
    event = await next_event(holder)
    assert event["type"] == "rejected" and event["notify"] is True and event["by_user"] == "vali"


async def test_reply_reaches_both_the_sender_and_the_holder_except_its_author(client, tokens, hub):
    report = (await client.post("/api/v1/reports", json=report_body(), headers=tokens["asliddin"])).json()
    await client.post(f"/api/v1/reports/{report['id']}/take", headers=tokens["ali"])
    await asyncio.sleep(0.05)
    sender = hub.subscribe(User(name="asliddin", team="backend"))
    holder = hub.subscribe(User(name="ali", team="frontend"))
    colleague = hub.subscribe(User(name="bobur", team="backend"))
    bystander = hub.subscribe(User(name="vali", team="frontend"))

    await client.post(
        f"/api/v1/reports/{report['id']}/replies", json={"text": "total is exact"}, headers=tokens["bobur"]
    )

    assert (await next_event(sender))["notify"] is True
    assert (await next_event(holder))["notify"] is True
    assert (await next_event(colleague))["notify"] is False
    assert (await next_event(bystander))["notify"] is False


async def test_withdrawing_tells_the_holder(client, tokens, hub):
    report = (await client.post("/api/v1/reports", json=report_body(), headers=tokens["asliddin"])).json()
    await client.post(f"/api/v1/reports/{report['id']}/take", headers=tokens["ali"])
    await asyncio.sleep(0.05)
    holder = hub.subscribe(User(name="ali", team="frontend"))
    await client.delete(f"/api/v1/reports/{report['id']}", headers=tokens["asliddin"])
    event = await next_event(holder)
    assert event["type"] == "withdrawn" and event["notify"] is True
