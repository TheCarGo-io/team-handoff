---
description: Reply under a handoff report: ask the sender a question, report an issue, answer one, or say what was done
argument-hint: <id> <message>
allowed-tools: mcp__plugin_handoff_handoff__reply, mcp__plugin_handoff_handoff__get
---

Add a reply to a handoff report with the handoff `reply` tool. Request: $ARGUMENTS

The first number is the report id; the rest is the message. If the user gave only a gist, write the reply for them: specific, with the file, endpoint or field in question and what was expected versus found. `get` the report first when you have not read it in this session, so the reply answers the latest state of the thread.

A reply is the place for anything the other side has to act on or know: a question, a request for test data or a setting, the status of work that is not finished, or what was done in answer to their reply. It can be long (up to 20,000 characters) and use markdown. No secrets or customer data. Send it and show the text as sent.
