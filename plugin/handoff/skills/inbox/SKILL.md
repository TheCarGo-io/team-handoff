---
description: Show my handoff inbox: replies for me, reports waiting, in progress, overdue, returned
allowed-tools: mcp__plugin_handoff_handoff__inbox
---

Call the handoff `inbox` tool with `projects` set to this session's projects.

A "Handoff context from the plugin" block comes with this prompt: the user, their team, this session's project or projects, what is waiting, what the user holds and which reports have unread replies. Use it instead of looking those up. If the block is missing, call `inbox` first.

Show, in this order and leaving out empty parts:
1. **Replies for you** (`threads`): id, title, who replied, the excerpt.
2. **Waiting here**: rows that name one of this session's projects.
3. **Waiting elsewhere**.
4. **In progress**: holder and checklist progress (`items_here_done/items_here_total` when given, else `items_done/items_total`).
5. **Returned to you** (`returned_rows`).

One compact table per part: id, priority, project(s), from, title, due in the user's local time, readiness when not ready. Mark overdue rows, and rows whose `read` is false as unread. Leave `hidden_rows` out unless asked. Do not open or take anything. End with one line naming the next sensible command, for example `/handoff:take <id>` for a reply or `/handoff:take next`.
