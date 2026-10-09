# thecargo-handoff

Team handoff board that lives inside Claude Code. One team sends a short report (what shipped, how to use it,
or what is needed); the other team sees it in their terminal, takes it, and closes it as done, rejected or
needs-changes. Nothing goes through chat apps.

Two parts in this repo:

| Part | Where | What it is |
|---|---|---|
| Server | `app/` | FastAPI + PostgreSQL (+ Redis for live events). REST under `/api/v1`, an SSE stream at `/api/v1/events`, MCP tools at `/mcp/` |
| Plugin | `plugin/handoff/` | Claude Code plugin: skills (`/handoff:send` …), the MCP connection, terminal notifications |

The repo root is also the plugin marketplace (`.claude-plugin/marketplace.json`).

## Report lifecycle

```
sent ──take──▶ taken ──done──────────▶ done      
  │               └──needs-changes────▶ back to the sender ──edit (version+1)──▶ sent
  ├── done / needs-changes are also allowed straight from sent
  └── close, from any open status, by anyone ──▶ closed  
  closed / done ──reopen (sender, holder or closer)──▶ the status it had
```

Nothing is deleted on a timer. Reports, checklist items, replies, read marks and a history of every change
live in PostgreSQL; Redis only carries live events between sessions and the per-minute write counter. Lists
show open reports and those closed or touched in the last `CLOSED_VISIBLE_DAYS` (14); `board?archived=true`
shows everything. Only one person can hold a report: `take` locks the row. The sender can withdraw a report at
any time, which deletes it for everyone; an edit replaces the text and the old text is not kept.

A report can carry a checklist (`items`, up to 30): the receiving team ticks items in the pane or with
`/handoff:check`, and the sender sees the progress. A report and each item also carry a readiness: `ready`,
`after-deploy` (what it depends on is not live yet) or `waiting-decision`. `take next` skips reports that are
not ready; when the sender marks the last waiting part ready, the receiver is told.

Projects: `project` is the main repository; a checklist item can name another one, so one report covers a
change that touches web, mobile and desktop. A session asks for its own projects (`?project=` repeated; a
folder that is not a repository counts the repositories inside it) and gets `waiting_for_project` and per-row
`items_here_*`. `PROJECT_ALIASES` maps other spellings (`mobile`, a renamed repository) to the canonical name.

Replies: `inbox.threads` lists reports with replies I have not read, for anyone involved (sender, holder,
addressee, earlier repliers), on closed reports too. Reading a report with `mark_seen=true` or through the
`get` tool marks them read in all my sessions.

Done: `resolve` with `done` is refused while checklist items are unticked unless `allow_open_items` is set, and
records `delivery` (`local`, `pushed`, `pr`, `merged`) with `refs`. A done report whose work is not merged yet
is kept like an open one; `POST /reports/{id}/delivery` updates it and tells the sender. `related` links reports.

Limits: 60 000 characters of text, 50 replies of 20 000 characters, 60 changes per user per minute (429), and
20 open event streams per user. `due` must carry a UTC offset. Set `PROJECTS` to refuse unknown project names.

## Run the server

```bash
make install
cp .env.example .env          # DATABASE_URL and REDIS_URL of its own
make migrate                  # alembic upgrade head
make run                      # http://127.0.0.1:8012, docs at /docs
make test                     # needs a database whose name ends in _test (default: thecargo_handoff_test)
```

`PUBLIC_URL` must be the URL clients use: the MCP endpoint only accepts that host (plus localhost).
Every `/mcp` request needs the bearer token, the handshake included.
Behind nginx, turn proxy buffering off for `/api/v1/events` (the server already sends `X-Accel-Buffering: no`).
On SIGTERM the server ends its event streams first, so a redeploy does not wait on them; clients reconnect.
`/health/ready` is 503 when the database or Redis is unreachable or the event listener is not subscribed. Every change is
logged by the `handoff.audit` logger (report, event, who).

## Database

Schema changes are Alembic revisions under `migrations/` (`make revision MSG="…"`, then review the file).
The container entrypoint waits for the database, runs `alembic upgrade head`, and starts the server. In a
stack it builds `DATABASE_URL` from the `db_password` secret and `DB_HOST` (default `postgres:5432`; set it to
the pooler once the database is listed there — the engine already runs without prepared-statement caching).
`python -m app.import_redis` is the one-off copy from the Redis storage this service started with; it does
nothing once the database holds data.

## Users and tokens

Each person has one token; the server stores only its hash.

```bash
make user ARGS="add asliddin backend"     # prints the token once; running it again rotates the token
make user ARGS="list"
make user ARGS="remove asliddin"
```

In a container: `docker exec <container> python -m app.cli add <name> <team>`. Teams come from `TEAMS`.

## Install the plugin

```
/plugin marketplace add <this repo>
/plugin install handoff@thecargo
```

The install screen asks for the server URL and the personal token (kept in the OS keychain).

Updates do not need a restart. An installed copy checks its marketplace at most once every three hours (one
check per machine, shared by all sessions) and, when a higher version is published, shows `version X is out
[ Update ]` on the line above the prompt. The button downloads it (`claude plugin update`) and runs
`/reload-plugins` in that session; other open sessions show the same button until they reload. Without the
button: `/plugin update handoff@thecargo`, then `/reload-plugins`. Only a changed `version` in `plugin.json`
counts as an update. Needs a recent
Claude Code: the notification module uses the hooks-module API (written against 2.1.293).

When the server does not answer (the request fails, comes back 5xx or takes longer than 20 seconds) the line
above the prompt and the pane say `offline since HH:MM` and keep showing the last known state. The plugin
tries again after 15 and 30 seconds, then every minute; `[ Retry ]` tries at once.

| Command | What it does |
|---|---|
| `/handoff:send <team> [@person] …` | Writes the report from the session's work and sends it |
| `/handoff:inbox` | My team's queue, most pressing first |
| `/handoff:board [project]` | Every report of every team |
| `/handoff:take <id [id …] \| next \| all>` | Takes one or several reports in this session, checks each against the code, proposes one plan. On a report I sent or cannot take, it picks up the unread replies instead |
| `/handoff:status [project]` | What is happening where: reports grouped by project, who holds what, what is built but not merged |
| `/handoff:reply <id> <message>` | Question or answer under a report |
| `/handoff:done <id> [note]` | Ticks finished items, records where the work is (local, pushed, PR, merged) and marks it done |
| `/handoff:check <id> <item numbers>` | Ticks checklist items of a report my team received |
| `/handoff:ready <id> [items] [note]` | Tells the receiver a waiting report I sent can now be worked on |
| `/handoff:close <id> [note]` | Closes a report nobody needs. Anyone can, no reason required |
| `/handoff:reopen <id> [reason]` | Reopens a closed or done report (sender, holder or closer) |
| `/handoff:return <id> <what to change>` | Hands it back to the sender as needs-changes |
| `/handoff:edit <id> <change>` | Updates a report I sent; the receiver is notified |
| `/handoff:withdraw <id>` | Deletes a report I sent, for everyone |
| `/handoffs` | Opens the inbox in a side pane: click a title to read the report in full (text and replies), Take, Continue, Fix, Reply, Done, close (press twice, no model call). Tick `[ ]` on several rows and press "Take N selected" to take them together. `hide` removes a report from your own list and counts only (it stays where it is for everyone else, and sits under "hidden from your list"); Close ends it for everyone, is not offered on a report a teammate holds, and can be undone from the pane or with `/handoff:reopen`. Listing and reading cost no tokens and do not take the report |

Notifications cost no tokens: the plugin holds one `curl` stream to `/api/v1/events` per interactive session
and draws a toast and a line above the prompt; both can be switched off in `/config`. With the line switched
off, the count moves to the status line instead, so it is never shown twice.
Take, Reply, Done and Fix never run anything by themselves: they put the command (`/handoff:take 12 `) in the
prompt box, where you can add to it and press Enter; a draft you were typing is left alone.
A toast cannot be clicked (Claude Code only lets a click dismiss it); the line above the prompt carries the
buttons instead: Read, Take, Hide (Open when nothing is new). Keyboard: ctrl+x tab focuses the line, then
r / t / h / o. Every session of a user shows the same inbox; the pane groups reports as For you, This project,
Other projects, In progress and Returned. A report I hold belongs to the session it was taken in (or where I
pressed `here`): that session lists it first under "In this session", my other open sessions fold it into "N in
your other sessions" and leave it out of their counts, and `release` or `here` in another session moves it.
A session counts as open while its event stream is connected (the stream names the session:
`/events?session=<id>`) and for `SESSION_GRACE_SECONDS` (90) after it drops; once it is closed, its reports
show in every session again. The server keeps that list in the memory of its one process. A report is unread (bright, bold, green dot) until I open it — in the pane, with `get` or by
taking it — and read ones are dimmed; the mark is kept per person on the server, so it is the same in every
session, and an edit by the sender makes the report unread again. Each row shows when the report arrived:
minutes while it is under an hour old, the exact local time after that (`14:20`, `Oct 9 14:20`).
If the stream drops, or goes silent for 60 s (sleep, VPN change), it reconnects with backoff and re-reads the
inbox; it also re-reads every 10 minutes. The server URL must have no trailing slash.

The plugin reads the session's project from `git remote get-url origin`; in a folder that is not a repository
it takes the repositories inside it. It shows how many reports wait for those, and attaches the user, team,
projects and open report ids as context to every `/handoff:` command, so the skills do not look them up.
Unread replies show under "Replies for you" in every session until read; Take on one hands the thread to Claude.

## Plugin development

```bash
claude --plugin-dir plugin/handoff --settings <file with pluginConfigs."handoff@inline".options.{url,token}>
claude plugin validate plugin/handoff
claude plugin test plugin/handoff
```
