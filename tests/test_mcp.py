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
async def running(redis, session_manager):
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
    assert names == ["board", "edit", "get", "inbox", "reply", "resolve", "send", "take", "withdraw"]


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
    sent = await call(client, tokens["asliddin"], "send", {k: v for k, v in report_body().items()})
    report_id = json.loads(sent["content"][0]["text"])["id"]

    inbox = json.loads(
        (await call(client, tokens["ali"], "inbox", {"project": "thecargo-frontend"}))["content"][0]["text"]
    )
    assert inbox["waiting_for_project"] == 1 and "text" not in inbox["rows"][0]

    taken = json.loads((await call(client, tokens["ali"], "take", {}))["content"][0]["text"])
    assert taken["id"] == report_id and taken["status"] == "taken" and taken["text"] and "notice" in taken

    done = await call(client, tokens["ali"], "resolve", {"report_id": report_id, "status": "done", "note": "PR #88"})
    assert json.loads(done["content"][0]["text"])["status"] == "done"


async def test_tool_errors_come_back_as_readable_tool_errors(client, tokens, running):
    result = await call(client, tokens["dana"], "take", {"report_id": 999})
    assert result["isError"] is True and "#999" in result["content"][0]["text"]


async def test_tools_enforce_the_same_limits_as_the_rest_api(client, tokens, running):
    sent = await call(client, tokens["asliddin"], "send", dict(report_body()))
    report_id = json.loads(sent["content"][0]["text"])["id"]

    too_long = await call(client, tokens["ali"], "reply", {"report_id": report_id, "text": "x" * 200_000})
    empty = await call(client, tokens["ali"], "reply", {"report_id": report_id, "text": "   "})
    no_reason = await call(client, tokens["ali"], "resolve", {"report_id": report_id, "status": "rejected"})
    naive_due = await call(client, tokens["asliddin"], "send", {**report_body(), "due": "2026-10-09T18:00:00"})
    assert [r["isError"] for r in (too_long, empty, no_reason, naive_due)] == [True, True, True, True]

    stored = json.loads((await call(client, tokens["ali"], "get", {"report_id": report_id}))["content"][0]["text"])
    assert "replies" not in stored or stored["replies"] == []
    assert "to_user" not in stored and "due" not in stored


async def test_withdraw_through_tools(client, tokens, running):
    sent = await call(client, tokens["asliddin"], "send", dict(report_body()))
    report_id = json.loads(sent["content"][0]["text"])["id"]
    refused = await call(client, tokens["ali"], "withdraw", {"report_id": report_id})
    assert refused["isError"] is True
    done = await call(client, tokens["asliddin"], "withdraw", {"report_id": report_id})
    assert json.loads(done["content"][0]["text"]) == {"withdrawn": report_id}
