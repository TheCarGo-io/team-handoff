---
description: What is happening where: handoff reports grouped by project and service, with who holds what and what is not shipped yet
argument-hint: [project]
allowed-tools: mcp__plugin_handoff_handoff__board
---

Show the state of handoff work per project with the handoff `board` tool (pass `project` only if one is named: $ARGUMENTS).

A "Handoff context from the plugin" block comes with this prompt: the user, their team, this session's project or projects, what is waiting, what the user holds and which reports have unread replies. Use it instead of looking those up. If the block is missing, call `inbox` first.

Group the rows by project; a report whose `projects` names several repositories appears under each. Start with one summary line per project, most active first, for example:

`thecargo-frontend: 2 waiting, 1 in progress (aydos, 3/5), 1 built but not merged`

Then, per project, short lists in this order, leaving out empty ones:
- **Waiting**: id, title, from, age, and what it waits for when `readiness` is not ready.
- **In progress**: id, title, holder, checklist progress.
- **Returned to sender** (needs-changes).
- **Done, not shipped**: done reports whose `delivery` is `local`, `pushed` or `pr`, with that state.
- **Done and merged**, **Closed**: ids and titles only.

Put this session's projects first. No commentary beyond the lists; end with nothing.
