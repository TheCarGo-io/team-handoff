---
description: Withdraw a handoff report I sent — deletes it for everyone (sent by mistake, or it contains something it should not)
argument-hint: <id>
allowed-tools: mcp__plugin_handoff_handoff__get
disable-model-invocation: true
---

Withdraw a handoff report the user sent, with the handoff `withdraw` tool. Request: $ARGUMENTS

The first number is the report id. `get` it and show the user its title, receiver and status, then call `withdraw`. It deletes the report at once for everyone, in any status, and cannot be undone; whoever had taken it is notified. Confirm with the id.
