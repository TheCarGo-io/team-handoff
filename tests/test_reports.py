import asyncio
import json
from datetime import UTC, datetime, timedelta

from app.core.config import settings
from app.core.redis import key
from tests.conftest import report_body


async def send(client, headers, **overrides) -> dict:
    response = await client.post("/api/v1/reports", json=report_body(**overrides), headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def test_requests_without_a_valid_token_are_refused(client, tokens):
    assert (await client.get("/api/v1/inbox")).status_code == 401
    response = await client.get("/api/v1/inbox", headers={"Authorization": "Bearer ho_wrong"})
    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


async def test_sent_report_lands_in_the_receiving_teams_inbox_only(client, tokens):
    report = await send(client, tokens["asliddin"])
    assert report["status"] == "sent" and report["from_user"] == "asliddin" and report["version"] == 1

    frontend = (await client.get("/api/v1/inbox?project=thecargo-frontend", headers=tokens["ali"])).json()
    assert frontend["waiting"] == 1 and frontend["waiting_for_project"] == 1
    assert [row["id"] for row in frontend["rows"]] == [report["id"]]
    assert "text" not in frontend["rows"][0]

    design = (await client.get("/api/v1/inbox", headers=tokens["dana"])).json()
    assert design["waiting"] == 0 and design["rows"] == []


async def test_inbox_orders_by_priority_then_deadline_then_age_and_marks_overdue(client, tokens):
    soon = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    past = (datetime.now(UTC) - timedelta(hours=2)).isoformat()
    normal_old = await send(client, tokens["asliddin"], title="normal old")
    normal_due = await send(client, tokens["asliddin"], title="normal due", due=soon)
    urgent = await send(client, tokens["asliddin"], title="urgent one", priority="urgent")
    high_overdue = await send(client, tokens["asliddin"], title="high overdue", priority="high", due=past)

    inbox = (await client.get("/api/v1/inbox", headers=tokens["ali"])).json()
    assert [row["id"] for row in inbox["rows"]] == [
        urgent["id"],
        high_overdue["id"],
        normal_due["id"],
        normal_old["id"],
    ]
    assert inbox["overdue"] == 1
    assert [row["overdue"] for row in inbox["rows"]] == [False, True, False, False]


async def test_unknown_team_and_foreign_recipient_are_rejected(client, tokens):
    response = await client.post("/api/v1/reports", json=report_body(to_team="sales"), headers=tokens["asliddin"])
    assert response.status_code == 400
    response = await client.post("/api/v1/reports", json=report_body(to_user="dana"), headers=tokens["asliddin"])
    assert response.status_code == 400


async def test_project_must_be_a_known_one_when_a_list_is_configured(client, tokens, monkeypatch):
    monkeypatch.setattr(settings, "PROJECTS", ["thecargo-frontend", "thecargo-mobile"])
    wrong = await client.post("/api/v1/reports", json=report_body(project="frontend"), headers=tokens["asliddin"])
    assert wrong.status_code == 400 and "thecargo-mobile" in wrong.json()["detail"]
    await send(client, tokens["asliddin"], project="thecargo-mobile")


async def test_invalid_fields_are_refused_in_the_common_error_shape(client, tokens):
    naive = await client.post(
        "/api/v1/reports", json=report_body(due="2026-10-09T18:00:00"), headers=tokens["asliddin"]
    )
    assert naive.status_code == 422
    assert naive.json()["code"] == "validation_error" and naive.json()["detail"].startswith("due:")
    spaced = await client.post("/api/v1/reports", json=report_body(project="the cargo"), headers=tokens["asliddin"])
    assert spaced.status_code == 422
    blank = await client.post("/api/v1/reports", json=report_body(text=" \n\t "), headers=tokens["asliddin"])
    assert blank.status_code == 422


async def test_deadline_is_stored_in_utc_and_control_characters_are_stripped(client, tokens):
    report = await send(
        client, tokens["asliddin"], due="2026-10-09T18:00:00+05:00", title="Loads\x1b[31m paged\n", text="a\x00b\r\nc"
    )
    assert report["due"] == "2026-10-09T13:00:00Z"
    assert report["title"] == "Loads [31m paged" and report["text"] == "ab\nc"


async def test_only_one_of_two_simultaneous_takes_wins(client, tokens):
    report = await send(client, tokens["asliddin"])
    url = f"/api/v1/reports/{report['id']}/take"
    first, second = await asyncio.gather(
        client.post(url, headers=tokens["ali"]), client.post(url, headers=tokens["vali"])
    )
    assert sorted([first.status_code, second.status_code]) == [200, 409]
    winner = first if first.status_code == 200 else second
    loser = second if first.status_code == 200 else first
    assert winner.json()["status"] == "taken"
    assert winner.json()["assignee"] in loser.json()["detail"]


async def test_take_is_limited_to_the_receiving_team_and_repeatable_by_the_holder(client, tokens):
    report = await send(client, tokens["asliddin"])
    url = f"/api/v1/reports/{report['id']}/take"
    assert (await client.post(url, headers=tokens["dana"])).status_code == 403
    first = await client.post(url, headers=tokens["ali"])
    again = await client.post(url, headers=tokens["ali"])
    assert first.status_code == again.status_code == 200
    assert again.json()["updated_at"] == first.json()["updated_at"]


async def test_take_next_follows_inbox_order_and_project_filter(client, tokens):
    await send(client, tokens["asliddin"], title="mobile thing", project="thecargo-mobile", priority="urgent")
    web = await send(client, tokens["asliddin"], title="web thing")

    taken = await client.post("/api/v1/reports/take-next?project=thecargo-frontend", headers=tokens["ali"])
    assert taken.json()["id"] == web["id"] and taken.json()["text"]
    empty = await client.post("/api/v1/reports/take-next?project=thecargo-frontend", headers=tokens["ali"])
    assert empty.status_code == 404


async def test_take_next_leaves_reports_addressed_to_a_teammate(client, tokens):
    for_vali = await send(client, tokens["asliddin"], to_user="vali", priority="urgent")
    open_one = await send(client, tokens["asliddin"], title="for anyone")

    assert (await client.post("/api/v1/reports/take-next", headers=tokens["ali"])).json()["id"] == open_one["id"]
    assert (await client.post("/api/v1/reports/take-next", headers=tokens["ali"])).status_code == 404
    assert (await client.post("/api/v1/reports/take-next", headers=tokens["vali"])).json()["id"] == for_vali["id"]


async def test_done_closes_the_report_and_shortens_its_lifetime(client, tokens, redis):
    report = await send(client, tokens["asliddin"])
    name = key("report", report["id"])
    assert 6 * 86400 < await redis.ttl(name) <= 7 * 86400

    await client.post(f"/api/v1/reports/{report['id']}/take", headers=tokens["ali"])
    body = {"status": "done", "note": "PR #88"}
    done = await client.post(f"/api/v1/reports/{report['id']}/resolve", json=body, headers=tokens["ali"])
    assert done.json()["status"] == "done" and done.json()["note"] == "PR #88" and done.json()["closed_at"]
    assert 47 * 3600 < await redis.ttl(name) <= 48 * 3600

    again = await client.post(f"/api/v1/reports/{report['id']}/resolve", json=body, headers=tokens["ali"])
    assert again.status_code == 409
    inbox = (await client.get("/api/v1/inbox", headers=tokens["ali"])).json()
    assert inbox["rows"] == []
    board = (await client.get("/api/v1/board", headers=tokens["dana"])).json()
    assert [row["status"] for row in board] == ["done"]


async def test_needs_changes_returns_to_the_sender_and_an_edit_resends_it(client, tokens):
    report = await send(client, tokens["asliddin"])
    rid = report["id"]
    await client.post(f"/api/v1/reports/{rid}/take", headers=tokens["ali"])
    body = {"status": "needs-changes", "note": "which sort fields?"}
    await client.post(f"/api/v1/reports/{rid}/resolve", json=body, headers=tokens["ali"])

    sender = (await client.get("/api/v1/inbox", headers=tokens["asliddin"])).json()
    assert sender["returned"] == 1 and sender["returned_rows"][0]["id"] == rid

    forbidden = await client.patch(f"/api/v1/reports/{rid}", json={"text": "hijack"}, headers=tokens["bobur"])
    assert forbidden.status_code == 403

    edited = await client.patch(
        f"/api/v1/reports/{rid}", json={"text": "Sort by created_at."}, headers=tokens["asliddin"]
    )
    assert edited.json()["version"] == 2 and edited.json()["status"] == "sent" and edited.json()["assignee"] is None
    assert edited.json()["text"] == "Sort by created_at." and edited.json()["note"] is None
    assert (await client.get("/api/v1/inbox", headers=tokens["ali"])).json()["waiting"] == 1


async def test_closed_report_cannot_be_edited(client, tokens):
    report = await send(client, tokens["asliddin"])
    await client.post(f"/api/v1/reports/{report['id']}/close", json={"note": "duplicate"}, headers=tokens["ali"])
    response = await client.patch(f"/api/v1/reports/{report['id']}", json={"text": "x"}, headers=tokens["asliddin"])
    assert response.status_code == 409


async def test_replies_are_limited_to_the_two_teams_involved(client, tokens):
    report = await send(client, tokens["asliddin"])
    url = f"/api/v1/reports/{report['id']}/replies"
    assert (await client.post(url, json={"text": "hi"}, headers=tokens["dana"])).status_code == 403
    replied = await client.post(url, json={"text": "is total exact?"}, headers=tokens["ali"])
    assert [reply["user"] for reply in replied.json()["replies"]] == ["ali"]
    assert (await client.get("/api/v1/inbox", headers=tokens["ali"])).json()["rows"][0]["replies"] == 1


async def test_expired_report_disappears_from_lists(client, tokens, redis):
    report = await send(client, tokens["asliddin"])
    await redis.delete(key("report", report["id"]))
    assert (await client.get("/api/v1/board", headers=tokens["ali"])).json() == []
    assert (await client.get(f"/api/v1/reports/{report['id']}", headers=tokens["ali"])).status_code == 404
    assert await redis.smembers(key("reports")) == set()


async def test_reply_after_closing_does_not_extend_the_48_hours(client, tokens, redis):
    report = await send(client, tokens["asliddin"])
    body = {"status": "done"}
    await client.post(f"/api/v1/reports/{report['id']}/resolve", json=body, headers=tokens["ali"])
    await redis.expire(key("report", report["id"]), 1000)
    stored = await client.get(f"/api/v1/reports/{report['id']}", headers=tokens["ali"])
    closed_at = datetime.fromisoformat(stored.json()["closed_at"]) - timedelta(hours=47)
    raw = stored.json() | {"closed_at": closed_at.isoformat()}
    raw.pop("overdue")
    await redis.set(key("report", report["id"]), json.dumps(raw), ex=3600)

    await client.post(f"/api/v1/reports/{report['id']}/replies", json={"text": "thanks"}, headers=tokens["asliddin"])
    assert 3000 < await redis.ttl(key("report", report["id"])) <= 3600


async def test_handing_back_needs_a_reason_and_rejected_is_gone(client, tokens):
    report = await send(client, tokens["asliddin"])
    url = f"/api/v1/reports/{report['id']}/resolve"
    assert (await client.post(url, json={"status": "rejected", "note": "no"}, headers=tokens["ali"])).status_code == 422
    assert (
        await client.post(url, json={"status": "needs-changes", "note": " "}, headers=tokens["ali"])
    ).status_code == 400
    assert (await client.post(url, json={"status": "done"}, headers=tokens["ali"])).status_code == 200


async def test_anyone_can_close_an_open_report_without_a_reason(client, tokens, redis):
    waiting = await send(client, tokens["asliddin"])
    held = await send(client, tokens["asliddin"], title="held one")
    await client.post(f"/api/v1/reports/{held['id']}/take", headers=tokens["ali"])

    by_outsider = await client.post(f"/api/v1/reports/{waiting['id']}/close", headers=tokens["dana"])
    assert by_outsider.status_code == 200 and by_outsider.json()["status"] == "closed"
    assert by_outsider.json()["note"] is None and by_outsider.json()["closed_at"]

    by_sender = await client.post(
        f"/api/v1/reports/{held['id']}/close", json={"note": "not needed"}, headers=tokens["bobur"]
    )
    assert by_sender.json()["status"] == "closed" and by_sender.json()["assignee"] == "ali"
    assert by_sender.json()["note"] == "not needed"

    again = await client.post(f"/api/v1/reports/{held['id']}/close", headers=tokens["ali"])
    assert again.status_code == 409
    assert (await client.get("/api/v1/inbox", headers=tokens["ali"])).json()["rows"] == []
    assert [row["status"] for row in (await client.get("/api/v1/board", headers=tokens["ali"])).json()] == [
        "closed"
    ] * 2
    assert 47 * 3600 < await redis.ttl(key("report", held["id"])) <= 48 * 3600


async def test_a_returned_report_can_be_closed_by_its_sender(client, tokens):
    report = await send(client, tokens["asliddin"])
    body = {"status": "needs-changes", "note": "which fields?"}
    await client.post(f"/api/v1/reports/{report['id']}/resolve", json=body, headers=tokens["ali"])
    closed = await client.post(f"/api/v1/reports/{report['id']}/close", headers=tokens["asliddin"])
    assert closed.json()["status"] == "closed"
    assert (await client.get("/api/v1/inbox", headers=tokens["asliddin"])).json()["returned"] == 0


async def test_edit_without_a_real_change_is_refused_or_ignored(client, tokens):
    report = await send(client, tokens["asliddin"])
    url = f"/api/v1/reports/{report['id']}"
    assert (await client.patch(url, json={}, headers=tokens["asliddin"])).status_code == 400
    same = await client.patch(url, json={"text": report["text"]}, headers=tokens["asliddin"])
    assert same.status_code == 200 and same.json()["version"] == 1
    real = await client.patch(url, json={"priority": "high"}, headers=tokens["asliddin"])
    assert real.json()["version"] == 2 and real.json()["priority"] == "high"


async def test_sender_can_withdraw_a_report_and_nobody_else_can(client, tokens, redis):
    report = await send(client, tokens["asliddin"], text="SECRET=xyz")
    url = f"/api/v1/reports/{report['id']}"
    await client.post(f"{url}/take", headers=tokens["ali"])
    assert (await client.delete(url, headers=tokens["ali"])).status_code == 403
    assert (await client.delete(url, headers=tokens["bobur"])).status_code == 403
    assert (await client.delete(url, headers=tokens["asliddin"])).status_code == 204
    assert (await client.get(url, headers=tokens["ali"])).status_code == 404
    assert (await client.get("/api/v1/board", headers=tokens["ali"])).json() == []
    assert await redis.exists(key("report", report["id"])) == 0


async def test_replies_are_capped_per_report(client, tokens, monkeypatch):
    monkeypatch.setattr(settings, "MAX_REPLIES", 2)
    report = await send(client, tokens["asliddin"])
    url = f"/api/v1/reports/{report['id']}/replies"
    for _ in range(2):
        assert (await client.post(url, json={"text": "ok"}, headers=tokens["ali"])).status_code == 200
    assert (await client.post(url, json={"text": "ok"}, headers=tokens["ali"])).status_code == 409
    assert (await client.post(url, json={"text": "x" * 4001}, headers=tokens["ali"])).status_code == 422


async def test_changes_are_rate_limited_per_user(client, tokens, monkeypatch):
    monkeypatch.setattr(settings, "WRITES_PER_MINUTE", 2)
    await send(client, tokens["asliddin"])
    await send(client, tokens["asliddin"])
    limited = await client.post("/api/v1/reports", json=report_body(), headers=tokens["asliddin"])
    assert limited.status_code == 429 and limited.json()["code"] == "too_many_requests"
    assert (await client.get("/api/v1/board", headers=tokens["asliddin"])).status_code == 200
    await send(client, tokens["bobur"])


async def test_readiness_reports_a_stopped_event_listener(client, redis):
    response = await client.get("/health/ready")
    assert response.status_code == 503 and response.json() == {"status": "degraded", "redis": True, "events": False}


async def test_readiness_is_ok_while_listening(client, hub):
    assert (await client.get("/health/ready")).json() == {"status": "ok", "redis": True, "events": True}
