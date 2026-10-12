import asyncio
from functools import partial

from app.core.config import settings
from app.core.database import async_session
from app.dependencies.auth import is_authorized
from app.repositories.user import UserRepository
from app.schemas.user import User
from app.services.container import get_hub
from app.services.events import EventHub, stream
from tests.conftest import report_body


async def next_event(subscriber) -> dict:
    return await asyncio.wait_for(subscriber.queue.get(), timeout=2)


async def test_new_report_notifies_the_receiving_team_and_nobody_else(client, tokens, hub):
    ali = hub.subscribe(User(name="ali", team="frontend"))
    dana = hub.subscribe(User(name="dana", team="design"))
    sender = hub.subscribe(User(name="sam", team="backend"))

    await client.post("/api/v1/reports", json=report_body(priority="urgent"), headers=tokens["sam"])

    event = await next_event(ali)
    assert event["type"] == "new" and event["notify"] is True and event["priority"] == "urgent"
    assert event["by_user"] == "sam" and "teams" not in event
    await asyncio.sleep(0.05)
    assert dana.queue.empty() and sender.queue.empty()


async def test_addressed_report_toasts_only_the_named_person(client, tokens, hub):
    ali = hub.subscribe(User(name="ali", team="frontend"))
    vali = hub.subscribe(User(name="vali", team="frontend"))

    await client.post("/api/v1/reports", json=report_body(to_user="vali"), headers=tokens["sam"])

    assert (await next_event(ali))["notify"] is False
    assert (await next_event(vali))["notify"] is True


async def test_status_changes_notify_the_sender_and_refresh_teammates_silently(client, tokens, hub):
    report = (await client.post("/api/v1/reports", json=report_body(), headers=tokens["sam"])).json()
    await asyncio.sleep(0.05)
    sender = hub.subscribe(User(name="sam", team="backend"))
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
        "from_user": "sam",
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
    await client.post("/api/v1/reports", json=report_body(), headers=tokens["sam"])
    line = await asyncio.wait_for(anext(lines), timeout=2)
    assert line.startswith('data: {"type": "new"') and line.endswith("\n\n")
    hub.close()
    assert [extra async for extra in lines] == []
    assert hub.subscribers == []


async def test_stream_ends_at_the_next_heartbeat_after_the_token_is_revoked(tokens, hub, monkeypatch):
    monkeypatch.setattr(settings, "SSE_HEARTBEAT_SECONDS", 0.05)
    lines = stream(hub, User(name="ali", team="frontend"), partial(is_authorized, tokens["ali"]["Authorization"]))
    assert await anext(lines) == ": connected\n\n"
    assert await anext(lines) == ": ping\n\n"
    await UserRepository(async_session).create("ali", "frontend")
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

    await client.post("/api/v1/reports", json=report_body(), headers=tokens["sam"])

    assert (await next_event(healthy))["type"] == "new"
    assert slow.dropped and slow not in hub.subscribers


async def test_subscribers_are_told_to_resync_when_the_listener_reconnects(state):
    hub = EventHub(async_session, settings.listen_dsn)
    ali = hub.subscribe(User(name="ali", team="frontend"))
    listener = asyncio.create_task(hub.run())
    assert await next_event(ali) == {"type": "resync", "notify": False}
    hub.close()
    listener.cancel()
    await asyncio.gather(listener, return_exceptions=True)


async def test_a_failed_publish_does_not_fail_the_change(client, tokens, monkeypatch):
    async def broken(*args, **kwargs):
        raise ConnectionError("the database is away")

    monkeypatch.setattr(get_hub(), "notify", broken)
    response = await client.post("/api/v1/reports", json=report_body(), headers=tokens["sam"])
    assert response.status_code == 201


async def test_retake_by_the_holder_does_not_notify_again(client, tokens, hub):
    report = (await client.post("/api/v1/reports", json=report_body(), headers=tokens["sam"])).json()
    await asyncio.sleep(0.05)
    sender = hub.subscribe(User(name="sam", team="backend"))
    for _ in range(3):
        await client.post(f"/api/v1/reports/{report['id']}/take", headers=tokens["ali"])
    assert (await next_event(sender))["type"] == "taken"
    await asyncio.sleep(0.05)
    assert sender.queue.empty()


async def test_holder_is_notified_when_a_teammate_closes_their_report(client, tokens, hub):
    report = (await client.post("/api/v1/reports", json=report_body(), headers=tokens["sam"])).json()
    await client.post(f"/api/v1/reports/{report['id']}/take", headers=tokens["ali"])
    await asyncio.sleep(0.05)
    holder = hub.subscribe(User(name="ali", team="frontend"))
    body = {"status": "needs-changes", "note": "duplicate of #3"}
    await client.post(f"/api/v1/reports/{report['id']}/resolve", json=body, headers=tokens["vali"])
    event = await next_event(holder)
    assert event["type"] == "needs-changes" and event["notify"] is True and event["by_user"] == "vali"


async def test_closing_tells_the_sender_and_the_holder_but_not_the_closer(client, tokens, hub):
    report = (await client.post("/api/v1/reports", json=report_body(), headers=tokens["sam"])).json()
    await client.post(f"/api/v1/reports/{report['id']}/take", headers=tokens["ali"])
    await asyncio.sleep(0.05)
    sender = hub.subscribe(User(name="sam", team="backend"))
    holder = hub.subscribe(User(name="ali", team="frontend"))
    closer = hub.subscribe(User(name="vali", team="frontend"))

    await client.post(f"/api/v1/reports/{report['id']}/close", json={"note": "obsolete"}, headers=tokens["vali"])

    for watcher, notified in ((sender, True), (holder, True), (closer, False)):
        event = await next_event(watcher)
        assert event["type"] == "closed" and event["notify"] is notified and event["note"] == "obsolete"


async def test_reply_reaches_both_the_sender_and_the_holder_except_its_author(client, tokens, hub):
    report = (await client.post("/api/v1/reports", json=report_body(), headers=tokens["sam"])).json()
    await client.post(f"/api/v1/reports/{report['id']}/take", headers=tokens["ali"])
    await asyncio.sleep(0.05)
    sender = hub.subscribe(User(name="sam", team="backend"))
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
    report = (await client.post("/api/v1/reports", json=report_body(), headers=tokens["sam"])).json()
    await client.post(f"/api/v1/reports/{report['id']}/take", headers=tokens["ali"])
    await asyncio.sleep(0.05)
    holder = hub.subscribe(User(name="ali", team="frontend"))
    await client.delete(f"/api/v1/reports/{report['id']}", headers=tokens["sam"])
    event = await next_event(holder)
    assert event["type"] == "withdrawn" and event["notify"] is True


async def test_ticking_items_tells_the_sender_the_progress_once(client, tokens, hub):
    body = report_body(items=[{"title": "Stage history panel"}, {"title": "Response time chart"}])
    report = (await client.post("/api/v1/reports", json=body, headers=tokens["sam"])).json()
    await asyncio.sleep(0.05)
    sender = hub.subscribe(User(name="sam", team="backend"))
    url = f"/api/v1/reports/{report['id']}/items/check"

    await client.post(url, json={"item_ids": [2]}, headers=tokens["ali"])
    await client.post(url, json={"item_ids": [2]}, headers=tokens["ali"])

    event = await next_event(sender)
    assert event["type"] == "progress" and event["notify"] is True
    assert event["note"] == "1/2 done; done: Response time chart"
    await asyncio.sleep(0.05)
    assert sender.queue.empty()


async def test_becoming_ready_is_announced_as_ready_not_as_an_edit(client, tokens, hub):
    body = report_body(readiness="after-deploy", items=[{"title": "Chart", "readiness": "after-deploy"}])
    report = (await client.post("/api/v1/reports", json=body, headers=tokens["sam"])).json()
    await client.post(f"/api/v1/reports/{report['id']}/take", headers=tokens["ali"])
    await asyncio.sleep(0.05)
    holder = hub.subscribe(User(name="ali", team="frontend"))
    url = f"/api/v1/reports/{report['id']}"

    await client.patch(url, json={"readiness": "ready"}, headers=tokens["sam"])
    assert (await next_event(holder))["type"] == "edited"

    change = {"items": [{"title": "Chart"}], "readiness_note": "live on dev"}
    await client.patch(url, json=change, headers=tokens["sam"])
    event = await next_event(holder)
    assert event["type"] == "ready" and event["notify"] is True and event["note"] == "live on dev"


async def test_a_session_counts_as_open_while_it_listens_and_for_a_while_after(hub, monkeypatch):
    ali = User(name="ali", team="frontend")
    other_tab = hub.subscribe(ali)

    first = hub.subscribe(ali, "s-1")
    assert await next_event(other_tab) == {"type": "resync", "notify": False}
    assert hub.sessions("ali") == {"s-1"} and hub.sessions("vali") == set()

    hub.unsubscribe(first)
    assert hub.sessions("ali") == {"s-1"}
    again = hub.subscribe(ali, "s-1")
    await asyncio.sleep(0.05)
    assert other_tab.queue.empty()

    hub.unsubscribe(again)
    monkeypatch.setattr(settings, "SESSION_GRACE_SECONDS", 0)
    await asyncio.sleep(0.01)
    assert hub.sessions("ali") == set()
    hub.settle("ali", "s-1")
    assert await next_event(other_tab) == {"type": "resync", "notify": False}


async def test_a_session_that_says_it_is_starting_counts_as_open_before_it_listens(client, tokens, hub):
    other_tab = hub.subscribe(User(name="ali", team="frontend"))

    assert (await client.put("/api/v1/sessions/s-9", headers=tokens["ali"])).status_code == 204
    assert hub.sessions("ali") == {"s-9"}
    assert await next_event(other_tab) == {"type": "resync", "notify": False}
    assert (await client.put("/api/v1/sessions/not%20an%20id", headers=tokens["ali"])).status_code == 422


async def test_putting_a_report_in_a_session_refreshes_only_my_own_sessions(client, tokens, hub):
    report = (await client.post("/api/v1/reports", json=report_body(), headers=tokens["sam"])).json()
    await client.post(f"/api/v1/reports/{report['id']}/take", headers=tokens["ali"])
    await asyncio.sleep(0.05)
    mine = hub.subscribe(User(name="ali", team="frontend"))
    teammate = hub.subscribe(User(name="vali", team="frontend"))

    body = {"session": "s-1", "label": "web-app"}
    await client.put(f"/api/v1/reports/{report['id']}/session", json=body, headers=tokens["ali"])

    assert await next_event(mine) == {"type": "resync", "notify": False}
    await asyncio.sleep(0.05)
    assert teammate.queue.empty()
    assert (await client.get("/api/v1/events?session=not%20an%20id", headers=tokens["ali"])).status_code == 422


async def test_hiding_refreshes_only_my_own_sessions(client, tokens, hub):
    report = (await client.post("/api/v1/reports", json=report_body(), headers=tokens["sam"])).json()
    await asyncio.sleep(0.05)
    mine = hub.subscribe(User(name="ali", team="frontend"))
    other_tab = hub.subscribe(User(name="ali", team="frontend"))
    teammate = hub.subscribe(User(name="vali", team="frontend"))

    await client.post(f"/api/v1/reports/{report['id']}/hide", headers=tokens["ali"])

    assert await next_event(mine) == {"type": "resync", "notify": False}
    assert await next_event(other_tab) == {"type": "resync", "notify": False}
    await asyncio.sleep(0.05)
    assert teammate.queue.empty()


async def test_reopening_tells_the_sender_the_holder_and_the_closer(client, tokens, hub):
    report = (await client.post("/api/v1/reports", json=report_body(), headers=tokens["sam"])).json()
    await client.post(f"/api/v1/reports/{report['id']}/take", headers=tokens["ali"])
    await client.post(f"/api/v1/reports/{report['id']}/close", headers=tokens["vali"])
    await asyncio.sleep(0.05)
    sender = hub.subscribe(User(name="sam", team="backend"))
    holder = hub.subscribe(User(name="ali", team="frontend"))
    closer = hub.subscribe(User(name="vali", team="frontend"))

    await client.post(f"/api/v1/reports/{report['id']}/reopen", json={"note": "by mistake"}, headers=tokens["sam"])

    for watcher, notified in ((sender, False), (holder, True), (closer, True)):
        event = await next_event(watcher)
        assert event["type"] == "reopened" and event["notify"] is notified and event["note"] == "by mistake"


async def test_reading_replies_refreshes_my_other_sessions_and_delivery_tells_the_sender(client, tokens, hub):
    report = (await client.post("/api/v1/reports", json=report_body(), headers=tokens["sam"])).json()
    rid = report["id"]
    await client.post(f"/api/v1/reports/{rid}/replies", json={"text": "question"}, headers=tokens["ali"])
    await asyncio.sleep(0.05)
    sender = hub.subscribe(User(name="sam", team="backend"))

    await client.get(f"/api/v1/reports/{rid}?mark_seen=true", headers=tokens["sam"])
    assert await next_event(sender) == {"type": "resync", "notify": False}

    body = {"status": "done", "delivery": "local"}
    await client.post(f"/api/v1/reports/{rid}/resolve", json=body, headers=tokens["ali"])
    assert (await next_event(sender))["type"] == "done"
    body = {"delivery": "pr", "refs": ["https://github.com/acme/web-app/pull/9"]}
    await client.post(f"/api/v1/reports/{rid}/delivery", json=body, headers=tokens["ali"])
    event = await next_event(sender)
    assert event["type"] == "delivered" and event["notify"] is True
    assert event["note"] == "pr https://github.com/acme/web-app/pull/9"


async def test_a_reply_reaches_the_person_the_report_is_addressed_to(client, tokens, hub):
    body = report_body(to_user="vali")
    report = (await client.post("/api/v1/reports", json=body, headers=tokens["sam"])).json()
    await asyncio.sleep(0.05)
    named = hub.subscribe(User(name="vali", team="frontend"))
    body = {"text": "one more thing"}
    await client.post(f"/api/v1/reports/{report['id']}/replies", json=body, headers=tokens["sam"])
    event = await next_event(named)
    assert event["type"] == "reply" and event["notify"] is True
