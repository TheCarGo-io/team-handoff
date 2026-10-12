# Team Handoff

[![CI](https://github.com/TheCarGo-io/team-handoff/actions/workflows/ci.yml/badge.svg)](https://github.com/TheCarGo-io/team-handoff/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Handoffs between teams, inside Claude Code.

When one team ships something another team has to act on, their Claude session sends a short report: what
changed, how to use it, what is needed. The other team sees it in the terminal, takes it into the session
where the work belongs, and Claude checks it against the code before building anything.

```
Handoff 2 here · 1 elsewhere · 1 unread reply                                   [ Open ]
──────────────────────────────────────────────────────────────────────────────────────
❯ /handoff:take next
```

Self-hosted: one small server for your company, one Claude Code plugin per person.

## Features

- **Reports written from the work.** `/handoff:send` drafts the report from what the session just did.
- **Taken, not just read.** The receiver takes a report into a session; Claude verifies it and proposes a plan.
- **Live in the terminal.** A line above the prompt, a side pane and toasts, pushed by the server at no token cost.
- **Checklists, readiness and replies**, tracked per report and per person.
- **One report, one session.** Work stays in the session that took it; your other sessions stay quiet.
- **Two containers.** The server and PostgreSQL. No other services.

## Quick start

Run the server:

```bash
git clone https://github.com/TheCarGo-io/team-handoff && cd team-handoff
cp .env.example .env          # set PUBLIC_URL and DB_PASSWORD
docker compose up -d
docker compose logs server    # prints the link that makes you the first admin
```

Install the plugin in Claude Code, with the server URL and the token from that link:

```
/plugin marketplace add TheCarGo-io/team-handoff
/plugin install handoff@thecargo
```

Invite a teammate and send the first report:

```
/handoff:invite frontend
/handoff:send frontend the loads endpoint is paginated now
```

## Commands

| Command | What it does |
|---|---|
| `/handoff:send <team> …` | Write a report from this session's work and send it |
| `/handoff:inbox` | What waits for my team |
| `/handoff:take <id \| next \| all>` | Take reports into this session and plan the work |
| `/handoff:reply <id> …` | Ask or answer under a report |
| `/handoff:done <id>` | Mark it done and say where the work is |
| `/handoffs` | Open the inbox in a side pane |

The [plugin guide](docs/plugin.md) lists all of them.

## Documentation

- [Self-hosting](docs/self-hosting.md): configuration, people and invites, upgrades, backups
- [Plugin guide](docs/plugin.md): commands, the live line and pane, sessions
- [How reports work](docs/reports.md): statuses, checklists, readiness, limits
- [Security](SECURITY.md): the trust model and what the plugin sends
- [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## Requirements

- Docker with Compose for the server.
- Claude Code for the plugin. The live line, pane and toasts use an early-access Claude Code API; where it is
  unavailable, the commands still work and a start-up notice says what is waiting.

## License

[MIT](LICENSE). Built at [TheCargo](https://thecargo.io).
