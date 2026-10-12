import re

from app.core.database import async_session
from app.repositories.user import UserRepository
from app.schemas.user import User
from app.services import report as report_service
from app.services.container import get_member_service
from tests.conftest import report_body


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def admin(name: str = "root", team: str = "backend") -> dict[str, str]:
    return bearer(await UserRepository(async_session).create(name, team, True))


async def test_the_first_person_joins_as_admin_through_the_link_the_server_prints(client, state):
    link = await get_member_service().bootstrap()
    path = link.removeprefix("http://127.0.0.1:8012")
    assert re.fullmatch(r"/join/[\w-]{20,}", path)

    page = await client.get(path)
    assert page.status_code == 200 and "name=team" in page.text and page.headers["cache-control"] == "no-store"

    taken = await client.post(path, content="name=Sam&team=platform")
    assert taken.status_code == 201 or taken.status_code == 200
    token = re.search(r"ho_[\w-]{30,}", taken.text).group(0)
    assert "/plugin install handoff@thecargo" in taken.text

    me = (await client.get("/api/v1/me", headers=bearer(token))).json()
    assert me == {"name": "sam", "team": "platform", "is_admin": True}
    assert (await client.get(path)).status_code == 404
    assert (await client.post(path, content="name=eve&team=platform")).status_code == 404
    assert await get_member_service().bootstrap() is None


async def test_a_join_page_escapes_what_it_echoes_and_explains_a_bad_name(client, state):
    link = await get_member_service().bootstrap()
    path = link.removeprefix("http://127.0.0.1:8012")

    refused = await client.post(path, content="name=%3Cscript%3E&team=backend")
    assert refused.status_code == 422 and "<script>" not in refused.text and "&lt;script&gt;" in refused.text
    assert "Use lowercase letters" in refused.text


async def test_only_an_admin_invites_and_the_invite_works_once(client, tokens, database):
    root = await admin()
    assert (await client.post("/api/v1/invites", json={"team": "qa"}, headers=tokens["ali"])).status_code == 403

    invite = (await client.post("/api/v1/invites", json={"team": "QA"}, headers=root)).json()
    assert invite["team"] == "qa" and invite["admin"] is False
    code = invite["url"].rsplit("/", 1)[-1]

    assert (await client.post("/api/v1/join", json={"code": code, "name": "ali"})).status_code == 409
    assert (await client.post("/api/v1/join", json={"code": code, "name": "Bad Name"})).status_code == 422
    joined = await client.post("/api/v1/join", json={"code": code, "name": "nora"})
    assert joined.status_code == 201
    body = joined.json()
    assert (body["name"], body["team"], body["is_admin"], body["url"]) == ("nora", "qa", False, "http://127.0.0.1:8012")
    assert (await client.get("/api/v1/me", headers=bearer(body["token"]))).json()["team"] == "qa"
    assert (await client.post("/api/v1/join", json={"code": code, "name": "omar"})).status_code == 404

    teams = (await client.get("/api/v1/members", headers=tokens["ali"])).json()["teams"]
    assert {"name": "qa", "members": [{"name": "nora", "is_admin": False}]} in teams
    assert {"name": "root", "is_admin": True} in next(team for team in teams if team["name"] == "backend")["members"]

    sent = await client.post("/api/v1/reports", json=report_body(to_team="qa"), headers=tokens["ali"])
    assert sent.status_code == 201


async def test_an_open_invite_lets_the_newcomer_choose_an_existing_team_and_expires(client, tokens, database):
    root = await admin()
    code = (await client.post("/api/v1/invites", json={}, headers=root)).json()["url"].rsplit("/", 1)[-1]

    assert (await client.post("/api/v1/join", json={"code": code, "name": "nora"})).status_code == 400
    unknown = await client.post("/api/v1/join", json={"code": code, "name": "nora", "team": "sales"})
    assert unknown.status_code == 400 and "Unknown team 'sales'" in unknown.json()["detail"]

    await database.execute("update invites set expires_at = now() - interval '1 minute'")
    late = await client.post("/api/v1/join", json={"code": code, "name": "nora", "team": "frontend"})
    assert late.status_code == 404


async def test_removing_a_member_revokes_the_token_and_frees_what_they_held(client, tokens):
    root = await admin()
    rid = (await client.post("/api/v1/reports", json=report_body(), headers=tokens["sam"])).json()["id"]
    await client.post(f"/api/v1/reports/{rid}/take", headers=tokens["ali"])

    assert (await client.delete("/api/v1/members/ali", headers=tokens["vali"])).status_code == 403
    assert (await client.delete("/api/v1/members/nobody", headers=root)).status_code == 404
    assert (await client.delete("/api/v1/members/root", headers=root)).status_code == 409

    assert (await client.delete("/api/v1/members/ali", headers=root)).status_code == 204
    assert (await client.get("/api/v1/me", headers=tokens["ali"])).status_code == 401
    row = (await client.get("/api/v1/inbox", headers=tokens["vali"])).json()["rows"][0]
    assert (row["status"], row["assignee"]) == ("sent", None)


async def test_a_member_can_replace_their_own_token(client, tokens):
    fresh = (await client.post("/api/v1/me/token", headers=tokens["ali"])).json()["token"]
    assert (await client.get("/api/v1/me", headers=tokens["ali"])).status_code == 401
    assert (await client.get("/api/v1/me", headers=bearer(fresh))).json()["name"] == "ali"


async def test_anyone_can_ask_the_server_its_version(client, state):
    meta = (await client.get("/api/v1/meta")).json()
    assert meta["name"] == "team-handoff" and re.fullmatch(r"\d+\.\d+\.\d+", meta["version"])
    assert re.fullmatch(r"\d+\.\d+\.\d+", meta["min_plugin"])


async def test_the_session_start_fallback_speaks_only_when_something_waits_and_nobody_listens(
    client, tokens, hub, monkeypatch
):
    monkeypatch.setattr(report_service, "HOOK_WAIT_SECONDS", 0)
    url = "/api/v1/hooks/session-start"
    start = {"hook_event_name": "SessionStart", "session_id": "sess-1", "source": "startup", "cwd": "/work/app"}

    assert (await client.post(url, json=start, headers=tokens["ali"])).json() == {}

    await client.post("/api/v1/reports", json=report_body(), headers=tokens["sam"])
    said = (await client.post(url, json=start, headers=tokens["ali"])).json()
    line = "Team handoff: 1 waiting for your team · 1 not read yet. /handoff:inbox lists them."
    assert said["systemMessage"] == line
    assert said["hookSpecificOutput"]["hookEventName"] == "SessionStart"
    assert said["hookSpecificOutput"]["additionalContext"].startswith(line)

    assert (await client.post(url, json={**start, "source": "compact"}, headers=tokens["ali"])).json() == {}
    assert (await client.post(url, json=start, headers=tokens["sam"])).json() == {}

    hub.subscribe(User(name="ali", team="frontend"), "sess-1")
    assert (await client.post(url, json=start, headers=tokens["ali"])).json() == {}
    assert (
        "systemMessage"
        in (await client.post(url, json={**start, "session_id": "sess-2"}, headers=tokens["ali"])).json()
    )
