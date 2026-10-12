# Contributing

Issues and pull requests are welcome. For anything larger than a fix, open an issue first so the direction is
agreed before the work.

## Setup

```bash
make install                              # python 3.12 venv with the dev dependencies
createdb team_handoff && createdb team_handoff_test
cp .env.example .env                      # set DATABASE_URL to the first database
make migrate && make run
```

## Before a pull request

```bash
make lint && make format                  # ruff
make test                                 # server tests, against a real PostgreSQL
claude plugin validate plugin/handoff
claude plugin test plugin/handoff         # plugin tests
```

The server tests reset the database they run on and refuse one whose name does not end in `_test` or `_ci`.

## Conventions

- Routes stay thin: validation in `app/schemas`, rules in `app/services`, SQL in `app/repositories`.
- Every schema change is an Alembic revision; migrations run when the container starts, so keep them fast
  and safe to run on a live database.
- A change to the plugin bumps `version` in `plugin/handoff/.claude-plugin/plugin.json`. A change the plugin
  needs from the server bumps `NEEDS_SERVER` in `hooks/register.tsx`; a change that breaks older plugins
  bumps `MIN_PLUGIN` in `app/__init__.py`.
- The live UI uses an early-access Claude Code API. Anything a user must be able to do needs to work through
  a skill or a tool as well.
- Tests describe behaviour in their names. Add one for what you change.
