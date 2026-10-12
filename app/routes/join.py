from html import escape
from urllib.parse import parse_qs

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from app.core.config import settings
from app.core.errors import HandoffError
from app.dependencies.auth import Members
from app.schemas.user import JoinRequest
from app.services.container import get_users

router = APIRouter(include_in_schema=False)

NAME_PATTERN = r"[a-z0-9][a-z0-9._\-]{1,31}"
TEAM_PATTERN = r"[a-z0-9][a-z0-9\-]{1,31}"
HEADERS = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"}
STYLE = """
:root { color-scheme: light dark; }
body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }
h1 { font-size: 1.4rem; }
label { display: block; margin: 1rem 0 .25rem; font-weight: 600; }
input, button { font: inherit; padding: .5rem .7rem; border: 1px solid #8886; border-radius: .4rem; }
input { width: 100%; box-sizing: border-box; }
button { margin-top: 1.2rem; cursor: pointer; font-weight: 600; }
pre { background: #8882; padding: .8rem; border-radius: .4rem; overflow-x: auto; user-select: all; }
.problem { color: #c0392b; font-weight: 600; }
.note { opacity: .75; font-size: .9rem; }
"""


def page(title: str, body: str, status: int = 200) -> HTMLResponse:
    document = (
        "<!doctype html><html lang=en><meta charset=utf-8>"
        "<meta name=viewport content='width=device-width, initial-scale=1'>"
        f"<title>{escape(title)}</title><style>{STYLE}</style><h1>{escape(title)}</h1>{body}</html>"
    )
    return HTMLResponse(document, status_code=status, headers=HEADERS)


def form(code: str, team: str | None, teams: list[str], is_admin: bool, name: str = "", problem: str = "") -> str:
    options = "".join(f"<option value='{escape(one, quote=True)}'>" for one in teams)
    choose = (
        f"<label for=team>Team</label><input id=team name=team list=teams required pattern='{TEAM_PATTERN}' "
        f"placeholder='{escape(teams[0] if teams else 'backend', quote=True)}'><datalist id=teams>{options}</datalist>"
        f"<p class=note>{'An existing team, or a new name.' if is_admin else 'One of the existing teams.'}</p>"
    )
    return (
        (f"<p class=problem>{escape(problem)}</p>" if problem else "")
        + f"<p>You were invited to the team handoff board{' as an admin' if is_admin else ''}"
        + (f", team <b>{escape(team)}</b>." if team else ".")
        + "</p>"
        + f"<form method=post action='/join/{escape(code, quote=True)}'>"
        + "<label for=name>Your name on the board</label><input id=name name=name required autofocus "
        + f"pattern='{NAME_PATTERN}' value='{escape(name, quote=True)}' placeholder='sam'>"
        + "<p class=note>Lowercase letters, digits, dot, dash; 2 to 32 characters.</p>"
        + ("" if team else choose)
        + "<button>Join</button></form>"
    )


@router.get("/join/{code}")
async def invitation(code: str) -> HTMLResponse:
    users = get_users()
    try:
        invite = await users.open_invite(code)
    except HandoffError as error:
        return page("Invite not valid", f"<p>{escape(error.message)}</p>", error.status_code)
    return page("Join the handoff board", form(code, invite.team, await users.teams(), invite.is_admin))


@router.post("/join/{code}")
async def accept(code: str, request: Request, members: Members) -> HTMLResponse:
    fields = parse_qs((await request.body())[:2000].decode("utf-8", "replace"))
    name = (fields.get("name") or [""])[0]
    team = (fields.get("team") or [""])[0]
    users = get_users()
    try:
        invite = await users.open_invite(code)
    except HandoffError as error:
        return page("Invite not valid", f"<p>{escape(error.message)}</p>", error.status_code)
    try:
        joined = await members.join(JoinRequest(code=code, name=name, team=team or None))
    except HandoffError as error:
        body = form(code, invite.team, await users.teams(), invite.is_admin, name, error.message)
        return page("Join the handoff board", body, error.status_code)
    except ValueError:
        problem = "Use lowercase letters, digits, dot or dash for the name and the team (2 to 32 characters)."
        body = form(code, invite.team, await users.teams(), invite.is_admin, name, problem)
        return page("Join the handoff board", body, 422)
    steps = (
        f"<p>You are <b>{escape(joined.name)}</b> in team <b>{escape(joined.team)}</b>"
        f"{' (admin)' if joined.is_admin else ''}. In Claude Code, run:</p>"
        f"<pre>/plugin marketplace add {escape(settings.PLUGIN_SOURCE)}\n"
        f"/plugin install {escape(settings.PLUGIN_ID)}</pre>"
        "<p>It asks for two values:</p>"
        f"<label>Server URL</label><pre>{escape(joined.url)}</pre>"
        f"<label>Token</label><pre>{escape(joined.token)}</pre>"
        "<p class=note>The token is shown only now. If you lose it, an admin can invite you again after "
        "removing you, or you can replace it with <code>POST /api/v1/me/token</code>.</p>"
        "<p>Then <code>/handoff:inbox</code> shows what waits for your team.</p>"
    )
    return page("You are in", steps)
