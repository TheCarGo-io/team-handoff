---
description: Show my team's handoff inbox — reports waiting, in progress, overdue, and ones returned to me
allowed-tools: mcp__plugin_handoff_handoff__inbox, Bash(git remote get-url origin)
---

Call the handoff `inbox` tool with `project` set to this repository's name (the last path segment of `git remote get-url origin`, without `.git`).

Show the rows as one compact table in the order returned: id, priority, status (with assignee), project, from, title, due. Show `due` in the user's local time and mark overdue rows. Put reports for this project first if the user is clearly working on it. Then list `returned_rows` (reports the user sent that came back as needs-changes) separately.

Do not open or take any report. End with one line: how many wait for this project and `/handoff:take <id|next>`.
