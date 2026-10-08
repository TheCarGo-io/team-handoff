# thecargo-handoff

Team handoff board that lives inside Claude Code. One team sends a short report (what shipped, how to use it,
or what is needed); the other team sees it in their terminal, takes it, and closes it as done, rejected or
needs-changes. Nothing goes through chat apps.

Two parts in this repo:

| Part | Where | What it is |
|---|---|---|
| Server | `app/` | FastAPI + Redis. REST under `/api/v1`, an SSE stream at `/api/v1/events`, MCP tools at `/mcp/` |
| Plugin | `plugin/handoff/` | Claude Code plugin: skills (`/handoff:send` …), the MCP connection, terminal notifications |

The repo root is also the plugin marketplace (`.claude-plugin/marketplace.json`).

## Report lifecycle

```
sent ──take──▶ taken ──done──────────▶ done      (kept 48 h, then deleted)
  │               └──needs-changes────▶ back to the sender ──edit (version+1)──▶ sent
  ├── done / needs-changes are also allowed straight from sent
  └── close, from any open status, by anyone ──▶ closed  (kept 48 h, then deleted)
```

An open report is deleted after `OPEN_TTL_DAYS` (7) without any change. Only one person can hold a report:
`take` is atomic. The sender can withdraw a report at any time, which deletes it for everyone; an edit replaces
the text and the old text is not kept.

Limits: 20 000 characters of text, 50 replies of 4 000 characters, 60 changes per user per minute (429), and
20 open event streams per user. `due` must carry a UTC offset. Set `PROJECTS` to refuse unknown project names.

## Run the server

```bash
make install
cp .env.example .env          # point REDIS_URL at a Redis db of its own
make run                      # http://127.0.0.1:8012, docs at /docs
make test
```

`PUBLIC_URL` must be the URL clients use: the MCP endpoint only accepts that host (plus localhost).
Every `/mcp` request needs the bearer token, the handshake included.
Behind nginx, turn proxy buffering off for `/api/v1/events` (the server already sends `X-Accel-Buffering: no`).
On SIGTERM the server ends its event streams first, so a redeploy does not wait on them; clients reconnect.
`/health/ready` is 503 when Redis is unreachable or the event listener is not subscribed. Every change is
logged by the `handoff.audit` logger (report, event, who).

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

The install screen asks for the server URL and the personal token (kept in the OS keychain). Needs a recent
Claude Code: the notification module uses the hooks-module API (written against 2.1.293).

| Command | What it does |
|---|---|
| `/handoff:send <team> [@person] …` | Writes the report from the session's work and sends it |
| `/handoff:inbox` | My team's queue, most pressing first |
| `/handoff:board [project]` | Every report of every team |
| `/handoff:take <id \| next \| all>` | Takes a report, checks it against the code, proposes a plan |
| `/handoff:reply <id> <message>` | Question or answer under a report |
| `/handoff:done <id> [note]` | Marks it done |
| `/handoff:close <id> [note]` | Closes a report nobody needs. Anyone can, no reason required |
| `/handoff:return <id> <what to change>` | Hands it back to the sender as needs-changes |
| `/handoff:edit <id> <change>` | Updates a report I sent; the receiver is notified |
| `/handoff:withdraw <id>` | Deletes a report I sent, for everyone |
| `/handoffs` | Opens the inbox in a side pane: Read a report in full (text and replies), Take, Continue, Fix, Reply, Done, Close (press twice, no model call). Listing and reading cost no tokens and do not take the report |

Notifications cost no tokens: the plugin holds one `curl` stream to `/api/v1/events` per interactive session
and draws a toast and a line above the prompt; both can be switched off in `/config`. With the line switched
off, the count moves to the status line instead, so it is never shown twice.
Take, Reply, Done and Fix never run anything by themselves: they put the command (`/handoff:take 12 `) in the
prompt box, where you can add to it and press Enter; a draft you were typing is left alone.
A toast cannot be clicked (Claude Code only lets a click dismiss it); the line above the prompt carries the
buttons instead: Read, Take, Hide (Open when nothing is new). Keyboard: ctrl+x tab focuses the line, then
r / t / h / o. Every session of a user shows the same inbox; the pane groups reports as For you, This project,
Other projects, In progress and Returned, marks the ones that arrived since the pane was last opened, and for
a report taken on this machine says which project's session took it.
If the stream drops, or goes silent for 60 s (sleep, VPN change), it reconnects with backoff and re-reads the
inbox; it also re-reads every 10 minutes. The server URL must have no trailing slash.

`project` on a report is the repository the work belongs in. The plugin reads the current repository name from
`git remote get-url origin` and shows how many reports wait for it.

## Plugin development

```bash
claude --plugin-dir plugin/handoff --settings <file with pluginConfigs."handoff@inline".options.{url,token}>
claude plugin validate plugin/handoff
claude plugin test plugin/handoff
```
