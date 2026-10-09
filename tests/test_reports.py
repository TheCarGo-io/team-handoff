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
    raw = stored.json() | {"closed_at": closed_at.isoformat(), "retention_from": closed_at.isoformat()}
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
    assert (await client.post(url, json={"text": "x" * 20001}, headers=tokens["ali"])).status_code == 422


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


ITEMS = [{"title": "Stage history panel"}, {"title": "Response time chart"}, {"title": "Waiting leads list"}]


async def test_receiver_ticks_checklist_items_and_rows_show_the_progress(client, tokens):
    report = await send(client, tokens["asliddin"], items=ITEMS)
    assert [item["id"] for item in report["items"]] == [1, 2, 3] and not any(item["done"] for item in report["items"])
    url = f"/api/v1/reports/{report['id']}/items/check"

    assert (await client.post(url, json={"item_ids": [1]}, headers=tokens["asliddin"])).status_code == 403
    assert (await client.post(url, json={"item_ids": [9]}, headers=tokens["ali"])).status_code == 400
    ticked = await client.post(url, json={"item_ids": [1, 3, 3]}, headers=tokens["ali"])
    assert [item["done"] for item in ticked.json()["items"]] == [True, False, True]
    assert ticked.json()["items"][0]["done_by"] == "ali" and ticked.json()["items"][0]["done_at"]

    row = (await client.get("/api/v1/inbox", headers=tokens["ali"])).json()["rows"][0]
    assert (row["items_done"], row["items_total"]) == (2, 3) and "items" not in row

    unticked = await client.post(url, json={"item_ids": [3], "done": False}, headers=tokens["vali"])
    assert [item["done"] for item in unticked.json()["items"]] == [True, False, False]
    assert unticked.json()["items"][2]["done_by"] is None


async def test_editing_the_checklist_keeps_marks_of_unchanged_items(client, tokens):
    report = await send(client, tokens["asliddin"], items=ITEMS)
    await client.post(f"/api/v1/reports/{report['id']}/items/check", json={"item_ids": [2]}, headers=tokens["ali"])
    body = {"items": [{"title": "Response time chart"}, {"title": "Brand new item"}]}
    edited = await client.patch(f"/api/v1/reports/{report['id']}", json=body, headers=tokens["asliddin"])
    assert [(item["id"], item["title"], item["done"]) for item in edited.json()["items"]] == [
        (1, "Response time chart", True),
        (2, "Brand new item", False),
    ]
    assert edited.json()["version"] == 2


async def test_checklist_is_capped_and_closed_reports_cannot_be_ticked(client, tokens, monkeypatch):
    too_many = [{"title": f"item {number}"} for number in range(31)]
    response = await client.post("/api/v1/reports", json=report_body(items=too_many), headers=tokens["asliddin"])
    assert response.status_code == 422
    report = await send(client, tokens["asliddin"], items=ITEMS)
    await client.post(f"/api/v1/reports/{report['id']}/close", headers=tokens["ali"])
    url = f"/api/v1/reports/{report['id']}/items/check"
    assert (await client.post(url, json={"item_ids": [1]}, headers=tokens["ali"])).status_code == 409


async def test_take_next_skips_reports_that_are_not_ready_but_they_stay_visible(client, tokens):
    blocked = await send(
        client, tokens["asliddin"], priority="urgent", readiness="after-deploy", readiness_note="after shipment#178"
    )
    ready = await send(client, tokens["asliddin"], title="ready one")

    inbox = (await client.get("/api/v1/inbox", headers=tokens["ali"])).json()
    assert [(row["id"], row["readiness"]) for row in inbox["rows"]] == [
        (blocked["id"], "after-deploy"),
        (ready["id"], "ready"),
    ]
    assert inbox["rows"][0]["readiness_note"] == "after shipment#178"
    assert (await client.post("/api/v1/reports/take-next", headers=tokens["ali"])).json()["id"] == ready["id"]
    assert (await client.post("/api/v1/reports/take-next", headers=tokens["ali"])).status_code == 404
    assert (await client.post(f"/api/v1/reports/{blocked['id']}/take", headers=tokens["ali"])).status_code == 200


async def test_marking_ready_clears_the_note_unless_a_new_one_is_given(client, tokens):
    report = await send(client, tokens["asliddin"], readiness="waiting-decision", readiness_note="pricing undecided")
    url = f"/api/v1/reports/{report['id']}"
    ready = await client.patch(url, json={"readiness": "ready"}, headers=tokens["asliddin"])
    assert ready.json()["readiness"] == "ready" and ready.json()["readiness_note"] is None
    noted = await client.patch(
        url, json={"readiness": "ready", "readiness_note": "live on dev"}, headers=tokens["asliddin"]
    )
    assert noted.json()["readiness_note"] == "live on dev" and noted.json()["version"] == 3


async def test_hiding_is_personal_and_leaves_the_report_alone(client, tokens):
    mine = await send(client, tokens["asliddin"], title="for the team")
    held = await send(client, tokens["asliddin"], title="held by vali")
    await client.post(f"/api/v1/reports/{held['id']}/take", headers=tokens["vali"])

    assert (await client.post(f"/api/v1/reports/{held['id']}/hide", headers=tokens["ali"])).status_code == 204
    assert (await client.post("/api/v1/reports/999/hide", headers=tokens["ali"])).status_code == 404

    ali = (await client.get("/api/v1/inbox", headers=tokens["ali"])).json()
    assert [row["id"] for row in ali["rows"]] == [mine["id"]]
    assert ali["hidden"] == 1 and [row["id"] for row in ali["hidden_rows"]] == [held["id"]]

    vali = (await client.get("/api/v1/inbox", headers=tokens["vali"])).json()
    assert [row["id"] for row in vali["rows"]] == [mine["id"], held["id"]] and vali["hidden"] == 0
    assert (await client.get(f"/api/v1/reports/{held['id']}", headers=tokens["ali"])).json()["status"] == "taken"

    assert (await client.delete(f"/api/v1/reports/{held['id']}/hide", headers=tokens["ali"])).status_code == 204
    assert (await client.get("/api/v1/inbox", headers=tokens["ali"])).json()["hidden"] == 0


async def test_hidden_reports_leave_the_counts_and_come_back_when_taken(client, tokens, redis):
    report = await send(client, tokens["asliddin"], due=(datetime.now(UTC) - timedelta(hours=1)).isoformat())
    await client.post(f"/api/v1/reports/{report['id']}/hide", headers=tokens["ali"])
    inbox = (await client.get("/api/v1/inbox?project=thecargo-frontend", headers=tokens["ali"])).json()
    assert (inbox["waiting"], inbox["waiting_for_project"], inbox["overdue"]) == (0, 0, 0)

    await client.post(f"/api/v1/reports/{report['id']}/take", headers=tokens["ali"])
    inbox = (await client.get("/api/v1/inbox", headers=tokens["ali"])).json()
    assert inbox["taken_by_me"] == 1 and inbox["hidden"] == 0

    await client.post(f"/api/v1/reports/{report['id']}/hide", headers=tokens["ali"])
    await client.post(f"/api/v1/reports/{report['id']}/resolve", json={"status": "done"}, headers=tokens["ali"])
    assert (await client.get("/api/v1/inbox", headers=tokens["ali"])).json()["hidden"] == 0
    assert await redis.smembers(key("hidden", "ali")) == set()


async def test_a_closed_report_reopens_to_the_state_it_had(client, tokens, redis):
    waiting = await send(client, tokens["asliddin"], title="was waiting")
    held = await send(client, tokens["asliddin"], title="was held")
    await client.post(f"/api/v1/reports/{held['id']}/take", headers=tokens["ali"])
    for report in (waiting, held):
        closed = await client.post(f"/api/v1/reports/{report['id']}/close", headers=tokens["vali"])
        assert closed.json()["closed_by"] == "vali"

    assert (await client.post(f"/api/v1/reports/{waiting['id']}/reopen", headers=tokens["dana"])).status_code == 403
    by_closer = await client.post(f"/api/v1/reports/{waiting['id']}/reopen", headers=tokens["vali"])
    assert (by_closer.json()["status"], by_closer.json()["assignee"], by_closer.json()["closed_by"]) == (
        "sent",
        None,
        None,
    )
    by_holder = await client.post(
        f"/api/v1/reports/{held['id']}/reopen", json={"note": "not finished"}, headers=tokens["ali"]
    )
    assert (by_holder.json()["status"], by_holder.json()["assignee"], by_holder.json()["note"]) == (
        "taken",
        "ali",
        "not finished",
    )
    assert by_holder.json()["closed_at"] is None
    assert 6 * 86400 < await redis.ttl(key("report", held["id"])) <= 7 * 86400

    assert (await client.post(f"/api/v1/reports/{held['id']}/reopen", headers=tokens["ali"])).status_code == 409
    assert [row["id"] for row in (await client.get("/api/v1/inbox", headers=tokens["ali"])).json()["rows"]] == [
        waiting["id"],
        held["id"],
    ]


async def test_the_sender_can_reopen_a_report_marked_done(client, tokens):
    report = await send(client, tokens["asliddin"])
    await client.post(f"/api/v1/reports/{report['id']}/resolve", json={"status": "done"}, headers=tokens["ali"])
    reopened = await client.post(
        f"/api/v1/reports/{report['id']}/reopen", json={"note": "the chart is missing"}, headers=tokens["asliddin"]
    )
    assert (reopened.json()["status"], reopened.json()["assignee"]) == ("taken", "ali")
    assert (await client.get("/api/v1/inbox", headers=tokens["ali"])).json()["taken_by_me"] == 1


async def test_a_returned_report_that_was_closed_reopens_as_returned(client, tokens):
    report = await send(client, tokens["asliddin"])
    body = {"status": "needs-changes", "note": "which fields?"}
    await client.post(f"/api/v1/reports/{report['id']}/resolve", json=body, headers=tokens["ali"])
    await client.post(f"/api/v1/reports/{report['id']}/close", headers=tokens["asliddin"])
    reopened = await client.post(f"/api/v1/reports/{report['id']}/reopen", headers=tokens["asliddin"])
    assert (reopened.json()["status"], reopened.json()["note"]) == ("needs-changes", None)
    assert (await client.get("/api/v1/inbox", headers=tokens["asliddin"])).json()["returned"] == 1


async def test_items_carry_their_own_project_and_each_session_sees_its_share(client, tokens):
    items = [
        {"title": "Web button"},
        {"title": "iOS button", "project": "thecargo-mobile"},
        {"title": "Pay page route", "project": "thecargo-invoice"},
    ]
    report = await send(client, tokens["asliddin"], items=items)
    assert [item["project"] for item in report["items"]] == [None, "thecargo-mobile", "thecargo-invoice"]
    await client.post(f"/api/v1/reports/{report['id']}/items/check", json={"item_ids": [2]}, headers=tokens["ali"])

    mobile = (await client.get("/api/v1/inbox?project=thecargo-mobile", headers=tokens["ali"])).json()
    assert mobile["waiting_for_project"] == 1
    row = mobile["rows"][0]
    assert row["projects"] == ["thecargo-frontend", "thecargo-mobile", "thecargo-invoice"]
    assert (row["items_here_done"], row["items_here_total"], row["items_done"], row["items_total"]) == (1, 1, 1, 3)

    elsewhere = (await client.get("/api/v1/inbox?project=thecargo-crm", headers=tokens["ali"])).json()
    assert elsewhere["waiting_for_project"] == 0 and elsewhere["rows"][0]["items_here_total"] == 0
    assert (await client.get("/api/v1/inbox", headers=tokens["ali"])).json()["rows"][0]["items_here_total"] is None

    taken = await client.post("/api/v1/reports/take-next?project=thecargo-invoice", headers=tokens["ali"])
    assert taken.json()["id"] == report["id"]
    board = (await client.get("/api/v1/board?project=thecargo-mobile", headers=tokens["ali"])).json()
    assert [row["id"] for row in board] == [report["id"]]


async def test_a_workspace_session_counts_every_repository_it_holds_and_aliases_resolve(client, tokens, monkeypatch):
    aliases = {"mobile": "thecargo-mobile", "thecargo-desktop-electron": "thecargo-desktop"}
    monkeypatch.setattr(settings, "PROJECT_ALIASES", aliases)
    await send(client, tokens["asliddin"], title="for the web")
    await send(client, tokens["asliddin"], title="for mobile", project="mobile")
    await send(client, tokens["asliddin"], title="for desktop", project="thecargo-desktop-electron")
    await send(client, tokens["asliddin"], title="for the crm", project="thecargo-crm")

    url = "/api/v1/inbox?project=thecargo-frontend&project=mobile&project=thecargo-desktop-electron"
    inbox = (await client.get(url, headers=tokens["ali"])).json()
    assert inbox["projects"] == ["thecargo-frontend", "thecargo-mobile", "thecargo-desktop"]
    assert (inbox["waiting"], inbox["waiting_for_project"]) == (4, 3)
    assert sorted(row["project"] for row in inbox["rows"]) == [
        "thecargo-crm",
        "thecargo-desktop",
        "thecargo-frontend",
        "thecargo-mobile",
    ]


async def test_unread_replies_follow_the_people_involved_until_they_read_them(client, tokens):
    report = await send(client, tokens["asliddin"])
    rid = report["id"]
    await client.post(f"/api/v1/reports/{rid}/take", headers=tokens["ali"])
    await client.post(f"/api/v1/reports/{rid}/replies", json={"text": "Android SHA-1s:\nE9:53…"}, headers=tokens["ali"])
    await client.post(f"/api/v1/reports/{rid}/replies", json={"text": "and the bundle id"}, headers=tokens["ali"])

    sender = (await client.get("/api/v1/inbox", headers=tokens["asliddin"])).json()
    assert sender["unread_replies"] == 2 and sender["rows"] == []
    thread = sender["threads"][0]
    assert (thread["id"], thread["unread"], thread["last_reply_by"]) == (rid, 2, "ali")
    assert thread["last_reply_excerpt"] == "and the bundle id"

    assert (await client.get("/api/v1/inbox", headers=tokens["ali"])).json()["unread_replies"] == 0
    assert (await client.get("/api/v1/inbox", headers=tokens["bobur"])).json()["threads"] == []

    await client.get(f"/api/v1/reports/{rid}", headers=tokens["asliddin"])
    assert (await client.get("/api/v1/inbox", headers=tokens["asliddin"])).json()["unread_replies"] == 2
    await client.get(f"/api/v1/reports/{rid}?mark_seen=true", headers=tokens["asliddin"])
    assert (await client.get("/api/v1/inbox", headers=tokens["asliddin"])).json()["unread_replies"] == 0

    body = {"text": "added to the console"}
    await client.post(f"/api/v1/reports/{rid}/replies", json=body, headers=tokens["asliddin"])
    holder = (await client.get("/api/v1/inbox", headers=tokens["ali"])).json()
    assert holder["unread_replies"] == 1 and holder["threads"][0]["last_reply_by"] == "asliddin"
    assert (await client.get("/api/v1/inbox", headers=tokens["asliddin"])).json()["unread_replies"] == 0


async def test_unread_replies_stay_visible_on_a_closed_report_and_vanish_with_it(client, tokens, redis):
    report = await send(client, tokens["asliddin"])
    rid = report["id"]
    await client.post(f"/api/v1/reports/{rid}/replies", json={"text": "done, see PR"}, headers=tokens["ali"])
    await client.post(f"/api/v1/reports/{rid}/resolve", json={"status": "done"}, headers=tokens["ali"])
    assert (await client.get("/api/v1/inbox", headers=tokens["asliddin"])).json()["threads"][0]["status"] == "done"

    await client.get(f"/api/v1/reports/{rid}?mark_seen=true", headers=tokens["asliddin"])
    assert await redis.hgetall(key("seen", "asliddin")) != {}
    await redis.delete(key("report", rid))
    assert (await client.get("/api/v1/inbox", headers=tokens["asliddin"])).json()["threads"] == []
    assert await redis.hgetall(key("seen", "asliddin")) == {}


async def test_done_is_refused_while_items_are_unticked_unless_told_otherwise(client, tokens):
    report = await send(client, tokens["asliddin"], items=ITEMS)
    url = f"/api/v1/reports/{report['id']}"
    refused = await client.post(f"{url}/resolve", json={"status": "done"}, headers=tokens["ali"])
    assert refused.status_code == 409 and "3 unticked checklist item(s): 1, 2, 3" in refused.json()["detail"]
    body = {"status": "needs-changes", "note": "unclear"}
    assert (await client.post(f"{url}/resolve", json=body, headers=tokens["ali"])).status_code == 200

    other = await send(client, tokens["asliddin"], items=ITEMS)
    url = f"/api/v1/reports/{other['id']}"
    await client.post(f"{url}/items/check", json={"item_ids": [1, 2, 3]}, headers=tokens["ali"])
    assert (await client.post(f"{url}/resolve", json={"status": "done"}, headers=tokens["ali"])).status_code == 200

    third = await send(client, tokens["asliddin"], items=ITEMS)
    body = {"status": "done", "allow_open_items": True}
    forced = await client.post(f"/api/v1/reports/{third['id']}/resolve", json=body, headers=tokens["ali"])
    assert forced.status_code == 200 and forced.json()["status"] == "done"


async def test_done_says_where_the_work_is_and_unshipped_work_is_kept_longer(client, tokens, redis):
    report = await send(client, tokens["asliddin"])
    url = f"/api/v1/reports/{report['id']}"
    body = {"status": "done", "note": "built", "delivery": "local", "refs": ["branch feat/apple-sign-in"]}
    done = await client.post(f"{url}/resolve", json=body, headers=tokens["ali"])
    assert (done.json()["delivery"], done.json()["delivery_refs"]) == ("local", ["branch feat/apple-sign-in"])
    assert 6 * 86400 < await redis.ttl(key("report", report["id"])) <= 7 * 86400
    assert (await client.get("/api/v1/board", headers=tokens["asliddin"])).json()[0]["delivery"] == "local"

    by_sender = await client.post(f"{url}/delivery", json={"delivery": "merged"}, headers=tokens["asliddin"])
    assert by_sender.status_code == 403
    body = {"delivery": "merged", "refs": ["PR #88"]}
    merged = (await client.post(f"{url}/delivery", json=body, headers=tokens["vali"])).json()
    assert (merged["delivery"], merged["delivery_refs"], merged["status"]) == ("merged", ["PR #88"], "done")
    assert 47 * 3600 < await redis.ttl(key("report", report["id"])) <= 48 * 3600

    reopened = await client.post(f"{url}/reopen", headers=tokens["asliddin"])
    assert (reopened.json()["delivery"], reopened.json()["delivery_refs"]) == (None, [])
    waiting = await send(client, tokens["asliddin"])
    url = f"/api/v1/reports/{waiting['id']}/delivery"
    assert (await client.post(url, json={"delivery": "pr"}, headers=tokens["ali"])).status_code == 409


async def test_reports_can_point_at_related_reports(client, tokens):
    first = await send(client, tokens["asliddin"], title="Phone billing: contract")
    second = await send(client, tokens["asliddin"], title="Phone billing: pages", related=[first["id"], first["id"]])
    assert second["related"] == [first["id"]]
    url = f"/api/v1/reports/{second['id']}"
    edited = await client.patch(url, json={"related": [second["id"], 77]}, headers=tokens["asliddin"])
    assert edited.json()["related"] == [77]
    assert (await client.get("/api/v1/inbox", headers=tokens["ali"])).json()["rows"][1]["related"] == [77]


async def test_a_long_report_and_a_long_reply_fit(client, tokens):
    report = await send(client, tokens["asliddin"], text="x" * 45000)
    url = f"/api/v1/reports/{report['id']}/replies"
    assert (await client.post(url, json={"text": "y" * 15000}, headers=tokens["ali"])).status_code == 200
    too_long = await client.post("/api/v1/reports", json=report_body(text="x" * 60001), headers=tokens["asliddin"])
    assert too_long.status_code == 422
