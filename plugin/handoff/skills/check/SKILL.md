---
description: Tick checklist items of a handoff report my team received as finished
argument-hint: <id> <item numbers>
allowed-tools: mcp__plugin_handoff_handoff__check, mcp__plugin_handoff_handoff__get
---

Tick checklist items with the handoff `check` tool. Request: $ARGUMENTS

The first number is the report id, the rest are item numbers (`12 1 3` ticks items 1 and 3 of report 12). If the user named items by what they are instead of by number, `get` the report and match them. Tick only what is actually finished and verified in this session or what the user says is finished. "untick" or "reopen" means `done: false`. Show the checklist afterwards; when every item is ticked, suggest `/handoff:done <id>`.
