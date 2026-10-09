---
description: Reopen a handoff report that was closed or marked done (closed by mistake, or the work is not actually finished)
argument-hint: <id> [reason]
allowed-tools: mcp__plugin_handoff_handoff__reopen, mcp__plugin_handoff_handoff__get
---

Reopen a handoff report with the handoff `reopen` tool. Request: $ARGUMENTS

The first number is the report id; the rest is an optional `note` saying why (what is still missing, or that it was closed by mistake). Only the report's sender, its holder or whoever closed it can reopen it. It goes back to the state it had: waiting, or in progress with the same holder, who is told. Confirm with the id and its new status.
