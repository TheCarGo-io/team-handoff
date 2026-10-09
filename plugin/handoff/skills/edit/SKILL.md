---
description: Update a handoff report I sent (fix or extend it after shipping); the receiver is notified
argument-hint: <id> <what to change>
allowed-tools: mcp__plugin_handoff_handoff__edit, mcp__plugin_handoff_handoff__get
---

Edit a handoff report the user sent, with the handoff `edit` tool. Request: $ARGUMENTS

1. `get` the report first so the new text keeps everything still true.
2. `text` replaces the whole body and the old text is not kept: send the full corrected report, and start it with a short "Changed in v<n>:" line saying what is different, so a receiver who already took it sees the delta.
3. Pass only the fields that change (`title`, `text`, `priority`, `due` with a UTC offset, `clear_due`, `readiness`, `readiness_note`, `items`, `related`). `items` replaces the whole checklist: resend every item, with titles unchanged where the item is the same, so its tick survives, and keep each item's `project`.
4. A report that came back as needs-changes returns to the receiving team's inbox when edited — answer the reviewer's note in the new text.
5. If the report was sent by mistake or contains something it should not, use `/handoff:withdraw <id>` instead of editing.

Show the new version number and the text as sent.
