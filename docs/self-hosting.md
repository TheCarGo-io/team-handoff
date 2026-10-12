# Self-hosting

One server is for one company. Every member can see every report; see [Security](../SECURITY.md).

## Install

```bash
git clone https://github.com/TheCarGo-io/team-handoff && cd team-handoff
cp .env.example .env
docker compose up -d
docker compose logs server
```

The first start prints a single-use link. Whoever opens it becomes the first admin.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:8080` | The address people reach. Invite links use it, and the MCP endpoint accepts only this host and localhost |
| `PORT` | `8080` | The port Compose publishes |
| `DB_PASSWORD` | `handoff` | Password of the bundled PostgreSQL |
| `TEAMS` | `backend,frontend,mobile,design` | Teams created on the first start |
| `PROJECTS` | empty | When set, reports may only name these repositories |
| `PROJECT_ALIASES` | `{}` | JSON map of other spellings onto a repository name |
| `CLOSED_VISIBLE_DAYS` | `14` | How long closed reports stay in the lists |
| `EXTRA_ALLOWED_HOSTS` | empty | More host names the MCP endpoint accepts |

To use an existing PostgreSQL, set `DATABASE_URL` (`postgresql+asyncpg://user:pass@host:5432/db`), or
`DB_HOST`, `DB_NAME`, `DB_USER` and `DB_PASSWORD` or `DB_PASSWORD_FILE`. If that connection goes through a
transaction pooler, give `LISTEN_DATABASE_URL` a direct one for events.

## Running it

- **TLS.** Put a proxy with HTTPS in front and set `PUBLIC_URL` to the `https://` address.
- **Event stream.** `/api/v1/events` is server-sent events; switch proxy buffering off for that path.
- **One replica.** Open sessions and the write limit are kept in the server's memory.
- **Health.** `/health/live` and `/health/ready`. The REST reference is at `/docs`.
- **Backup.** `docker compose exec db pg_dump -U handoff handoff > handoff.sql`
- **Upgrade.** `git pull && docker compose up -d --build`. Migrations run when the container starts, and the
  plugin warns when it and the server do not fit each other.

## People

Admins invite from Claude Code with `/handoff:invite <team>`. The newcomer opens the link, picks a name and
gets a personal token with the install commands. Inviting into a team that does not exist creates it.

| Action | Claude Code | REST |
|---|---|---|
| Invite | `/handoff:invite [team] [admin]` | `POST /api/v1/invites` |
| List | `/handoff:members` | `GET /api/v1/members` |
| Remove | `remove_member` tool | `DELETE /api/v1/members/{name}` |
| Replace my token | | `POST /api/v1/me/token` |

Removing someone revokes their token and returns the reports they held to the queue.

When nobody can log in, use the server:

```bash
docker compose exec server python -m app.cli invite --admin
docker compose exec server python -m app.cli admin <name>
docker compose exec server python -m app.cli list
docker compose exec server python -m app.cli remove <name>
```

## Architecture

```
Claude Code session                               server
┌──────────────────────────────┐                 ┌───────────────────────────────┐
│ skills   /handoff:send …     │── MCP tools ───▶│ /mcp                          │
│ pane, line, toasts           │── REST ────────▶│ /api/v1                       │──▶ PostgreSQL
│ curl ◀── server-sent events ─│◀────────────────│ /api/v1/events  LISTEN/NOTIFY │
└──────────────────────────────┘                 └───────────────────────────────┘
```

Events are pushed to each session and never start a model turn. A report reaches Claude only when someone
takes or reads it.
