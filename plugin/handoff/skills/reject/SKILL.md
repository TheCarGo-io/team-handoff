---
description: Reject a handoff report, or hand it back to the sender as needs-changes
argument-hint: <id> <reason> [--needs-changes]
allowed-tools: mcp__plugin_handoff_handoff__resolve
---

Close a handoff report with the handoff `resolve` tool. Request: $ARGUMENTS

The first number is the report id. Use `status: "needs-changes"` when the report should come back corrected (missing detail, wrong contract, the user said "needs changes" or "send back"); use `status: "rejected"` when it will not be done at all. `note` is the reason in one or two lines. The server refuses both statuses without it, so ask for the reason if the user gave none. Confirm with the id, status and note as sent.
