# Changelog

## 0.7.0

The first release meant for teams outside TheCargo.

- Self-hosting with `docker compose up`: the server and PostgreSQL, nothing else. Redis is gone; live events
  travel through PostgreSQL `LISTEN/NOTIFY`.
- People are managed without shell access: the first start prints a link for the first admin, admins create
  single-use invite links (`/handoff:invite`), newcomers pick their name on a join page and get their own
  token. Teams live in the database; inviting into a new team creates it. Members can be removed and tokens
  replaced.
- The server and the plugin check each other's version (`GET /api/v1/meta`).
- A stable `SessionStart` hook says what is waiting when the live line and pane are not available.
- The plugin no longer needs a POSIX shell to find the repositories in a workspace folder.

Upgrading from 0.6: remove `REDIS_URL`, set `DATABASE_URL` (or `DB_HOST`, `DB_NAME`, `DB_USER` and
`DB_PASSWORD` / `DB_PASSWORD_FILE`), then make one person an admin with `python -m app.cli admin <name>`.

## 0.6.1

Read and unread reports, arrival times, reports that belong to the session they were taken in.

## 0.6.0

PostgreSQL storage, an Update button for the plugin, offline state with retry.
