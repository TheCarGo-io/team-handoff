---
description: Show the whole handoff board as one table by status (for a per-project view use handoff:status)
argument-hint: [project]
allowed-tools: mcp__plugin_handoff_handoff__board
---

Call the handoff `board` tool (pass `project` only if given: $ARGUMENTS). Show one compact table grouped by status — sent, taken, needs-changes, then done / rejected — with id, from → to, assignee, priority, project, title, due in local time. Keep it to the table; no commentary.
