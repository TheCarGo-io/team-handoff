import asyncio
import json

import pytest

from app.mcp.server import mcp
from tests.conftest import report_body

HEADERS = {"content-type": "application/json", "accept": "application/json, text/event-stream"}


@pytest.fixture(scope="session")
async def session_manager():
    started, stop = asyncio.Event(), asyncio.Event()

    async def serve() -> None:
        async with mcp.session_manager.run():
            started.set()
            await stop.wait()

    task = asyncio.create_task(serve())
    await started.wait()
    yield
    stop.set()
    await task


@pytest.fixture
async def running(state, session_manager):
    yield


async def call(client, token: dict, name: str, arguments: dict) -> dict:
    payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}
    response = await client.post("/mcp/", json=payload, headers={**HEADERS, **token})
    assert response.status_code == 200, response.text
    return response.json()["result"]


async def test_tools_are_listed(client, tokens, running):
    payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    response = await client.post("/mcp/", json=payload, headers={**HEADERS, **tokens["ali"]})
    names = sorted(tool["name"] for tool in response.json()["result"]["tools"])
    assert names == [
        "board",
        "check",
        "close",
        "delivered",
        "edit",
        "get",
        "inbox",
        "invite",
        "members",
        "remove_member",
        "reopen",
        "reply",
        "resolve",
        "send",
        "take",
        "withdraw",
    ]


async def test_nothing_is_served_without_a_valid_token(client, tokens, running):
    for payload in (
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "board", "arguments": {}}},
    ):
        for headers in (HEADERS, {**HEADERS, "Authorization": "Bearer ho_wrong"}):
            response = await client.post("/mcp/", json=payload, headers=headers)
            assert response.status_code == 401 and response.json()["code"] == "unauthorized"
            assert response.headers["www-authenticate"] == "Bearer"


async def test_send_take_resolve_through_tools(client, tokens, running):
    sent = await call(client, tokens["sam"], "send", {k: v for k, v in report_body().items()})
    report_id = json.loads(sent["content"][0]["text"])["id"]

    inbox = json.loads((await call(client, tokens["ali"], "inbox", {"project": "web-app"}))["content"][0]["text"])
    assert inbox["waiting_for_project"] == 1 and "text" not in inbox["rows"][0]

    taken = json.loads((await call(client, tokens["ali"], "take", {}))["content"][0]["text"])
    assert taken["id"] == report_id and taken["status"] == "taken" and taken["text"] and "notice" in taken

    done = await call(client, tokens["ali"], "resolve", {"report_id": report_id, "status": "done", "note": "PR #88"})
    assert json.loads(done["content"][0]["text"])["status"] == "done"


async def test_tool_errors_come_back_as_readable_tool_errors(client, tokens, running):
    result = await call(client, tokens["dana"], "take", {"report_id": 999})
    assert result["isError"] is True and "#999" in result["content"][0]["text"]


async def test_tools_enforce_the_same_limits_as_the_rest_api(client, tokens, running):
    sent = await call(client, tokens["sam"], "send", dict(report_body()))
    report_id = json.loads(sent["content"][0]["text"])["id"]

    too_long = await call(client, tokens["ali"], "reply", {"report_id": report_id, "text": "x" * 200_000})
    empty = await call(client, tokens["ali"], "reply", {"report_id": report_id, "text": "   "})
    no_reason = await call(client, tokens["ali"], "resolve", {"report_id": report_id, "status": "needs-changes"})
    naive_due = await call(client, tokens["sam"], "send", {**report_body(), "due": "2026-10-09T18:00:00"})
    assert [r["isError"] for r in (too_long, empty, no_reason, naive_due)] == [True, True, True, True]

    stored = json.loads((await call(client, tokens["ali"], "get", {"report_id": report_id}))["content"][0]["text"])
    assert "replies" not in stored or stored["replies"] == []
    assert "to_user" not in stored and "due" not in stored


async def test_checklist_and_readiness_through_tools(client, tokens, running):
    arguments = {
        **report_body(),
        "items": [{"title": "Stage history panel"}, {"title": "Response time chart", "readiness": "after-deploy"}],
        "readiness": "after-deploy",
        "readiness_note": "after crm#39 is on dev",
    }
    sent = json.loads((await call(client, tokens["sam"], "send", arguments))["content"][0]["text"])
    assert sent["items_total"] == 2 and sent["readiness"] == "after-deploy"

    not_ready = await call(client, tokens["ali"], "take", {})
    assert not_ready["isError"] is True and "Nothing ready" in not_ready["content"][0]["text"]

    ticked = await call(client, tokens["ali"], "check", {"report_id": sent["id"], "item_ids": [1]})
    progress = json.loads(ticked["content"][0]["text"])
    assert progress["items_done"] == 1 and [item["done"] for item in progress["items"]] == [True, False]

    edit = {
        "report_id": sent["id"],
        "readiness": "ready",
        "items": [{"title": "Stage history panel"}, {"title": "New one"}],
    }
    ready = json.loads((await call(client, tokens["sam"], "edit", edit))["content"][0]["text"])
    assert ready["readiness"] == "ready" and ready["items_done"] == 1 and "readiness_note" not in ready
    assert json.loads((await call(client, tokens["ali"], "take", {}))["content"][0]["text"])["id"] == sent["id"]


async def test_done_needs_ticked_items_or_an_explicit_override_and_records_delivery(client, tokens, running):
    arguments = {
        **report_body(),
        "items": [{"title": "Web page"}, {"title": "Pay page", "project": "invoice"}],
    }
    sent = json.loads((await call(client, tokens["sam"], "send", arguments))["content"][0]["text"])
    assert sent["projects"] == ["web-app", "invoice"]

    refused = await call(client, tokens["ali"], "resolve", {"report_id": sent["id"], "status": "done"})
    assert refused["isError"] is True and "unticked checklist item(s): 1, 2" in refused["content"][0]["text"]

    await call(client, tokens["ali"], "check", {"report_id": sent["id"], "item_ids": [1]})
    forced = {"report_id": sent["id"], "status": "done", "allow_open_items": True, "delivery": "local"}
    done = json.loads((await call(client, tokens["ali"], "resolve", forced))["content"][0]["text"])
    assert (done["status"], done["delivery"], done["items_done"]) == ("done", "local", 1)

    update = {"report_id": sent["id"], "delivery": "pr", "refs": ["https://github.com/acme/x/pull/9"]}
    moved = json.loads((await call(client, tokens["ali"], "delivered", update))["content"][0]["text"])
    assert moved["delivery"] == "pr"


async def test_get_reports_new_replies_once_and_tool_calls_are_logged(client, tokens, running, caplog):
    caplog.set_level("INFO", logger="handoff.audit")
    sent = json.loads((await call(client, tokens["sam"], "send", dict(report_body())))["content"][0]["text"])
    await call(client, tokens["ali"], "reply", {"report_id": sent["id"], "text": "which fields?"})

    first = json.loads((await call(client, tokens["sam"], "get", {"report_id": sent["id"]}))["content"][0]["text"])
    again = json.loads((await call(client, tokens["sam"], "get", {"report_id": sent["id"]}))["content"][0]["text"])
    assert len(first["new_reply_ids"]) == 1 and again["new_reply_ids"] == []

    await call(client, tokens["sam"], "take", {"report_id": sent["id"]})
    lines = [record.getMessage() for record in caplog.records]
    assert f"tool=get report={sent['id']} by=backend/sam ok" in lines
    assert any(line.startswith(f"tool=take report={sent['id']} by=backend/sam failed: Report") for line in lines)


async def test_close_through_tools(client, tokens, running):
    sent = await call(client, tokens["sam"], "send", dict(report_body()))
    report_id = json.loads(sent["content"][0]["text"])["id"]
    closed = await call(client, tokens["dana"], "close", {"report_id": report_id})
    assert json.loads(closed["content"][0]["text"])["status"] == "closed"


async def test_reopen_through_tools(client, tokens, running):
    sent = await call(client, tokens["sam"], "send", dict(report_body()))
    report_id = json.loads(sent["content"][0]["text"])["id"]
    await call(client, tokens["ali"], "close", {"report_id": report_id})
    refused = await call(client, tokens["dana"], "reopen", {"report_id": report_id})
    assert refused["isError"] is True
    reopened = await call(client, tokens["sam"], "reopen", {"report_id": report_id, "note": "still needed"})
    assert json.loads(reopened["content"][0]["text"])["status"] == "sent"


async def test_withdraw_through_tools(client, tokens, running):
    sent = await call(client, tokens["sam"], "send", dict(report_body()))
    report_id = json.loads(sent["content"][0]["text"])["id"]
    refused = await call(client, tokens["ali"], "withdraw", {"report_id": report_id})
    assert refused["isError"] is True
    done = await call(client, tokens["sam"], "withdraw", {"report_id": report_id})
    assert json.loads(done["content"][0]["text"]) == {"withdrawn": report_id}
