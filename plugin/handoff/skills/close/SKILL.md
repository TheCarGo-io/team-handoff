---
description: Close a handoff report that is not needed (duplicate, obsolete, not for us) — anyone can, no reason required
argument-hint: <id> [note]
allowed-tools: mcp__plugin_handoff_handoff__close
---

Close a handoff report with the handoff `close` tool. Request: $ARGUMENTS

The first number is the report id; anything after it is an optional `note` the sender will see. Anyone may close any open report (waiting, taken or returned), so do not ask for a reason. Call the tool and confirm with the id. If the work was actually finished, use `/handoff:done <id>` instead so the sender sees it as done.
