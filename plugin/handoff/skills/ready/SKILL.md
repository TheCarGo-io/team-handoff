---
description: Tell the receiver a handoff report I sent can now be worked on (the backend is live, the decision is made)
argument-hint: <id> [item numbers] [note]
allowed-tools: mcp__plugin_handoff_handoff__edit, mcp__plugin_handoff_handoff__get
---

Mark a handoff report the user sent as ready, with the handoff `edit` tool. Request: $ARGUMENTS

1. `get` the report. The first number is its id.
2. With no item numbers: set `readiness: "ready"` on the report and resend `items` with every item `ready`.
3. With item numbers: resend `items` with only those items changed to `ready`; set the report's own `readiness` to `ready` only if no item is left waiting.
4. Keep every item title exactly as it is, so ticks already made are not lost.
5. `readiness_note`: the user's note if they gave one (for example "live on dev since 14:00"); otherwise leave it out.

Say this only when it is true: check that the PR is merged and deployed if you can, and ask the user if you cannot tell. The receiver is notified when nothing is left waiting.
