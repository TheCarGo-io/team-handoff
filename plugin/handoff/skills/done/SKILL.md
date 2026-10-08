---
description: Mark a handoff report my team received as done
argument-hint: <id> [note]
allowed-tools: mcp__plugin_handoff_handoff__resolve
---

Close a handoff report with the handoff `resolve` tool, `status: "done"`. Request: $ARGUMENTS

The first number is the report id. `note` is one or two lines the sender will see: what was implemented and the PR or branch. If the user gave no note, write one from what was actually done in this session; if nothing was done here, ask instead of inventing one. Confirm with the id and the note as sent.
