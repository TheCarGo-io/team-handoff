---
description: Hand a handoff report back to its sender as needs-changes (missing detail, wrong contract)
argument-hint: <id> <what to change>
allowed-tools: mcp__plugin_handoff_handoff__resolve
---

Hand a handoff report back with the handoff `resolve` tool, `status: "needs-changes"`. Request: $ARGUMENTS

The first number is the report id. `note` says what the sender must fix or add, in one or two lines; the server refuses without it, so ask if the user gave none. The report returns to the sender; when they edit it, it comes back to this team's inbox. For a report that is simply not needed, use `/handoff:close <id>`.
