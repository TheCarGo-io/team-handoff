---
description: Send a handoff report to another team from this session's work
argument-hint: <team> [@person] [what to report] [priority] [due]
allowed-tools: mcp__plugin_handoff_handoff__send, Bash(date:*)
---

Send a handoff report with the handoff `send` tool. Request: $ARGUMENTS

1. The first word is the receiving team. `@name` addresses one person in it. If no team is given, ask which. The server lists the valid teams if the name is wrong.
2. Write the report from what was actually done in this session and in the code — do not invent endpoints or fields. If the request names a topic you have no context for, read the code first. If the code contradicts what the user asked you to report, say so instead of sending.
   - `title`: one line, what changed or what is needed.
   - `text`: markdown the receiver's Claude can act on without asking: what shipped or what is needed, exact endpoints / payloads / field names with a short example, PR or branch links, how to test, known gaps.
   - `project`: the exact repository name the receiver will work in (for frontend usually `thecargo-frontend`, for the console `thecargo-admin-frontend`, for mobile `thecargo-mobile`). Ask if it is not obvious; a wrong name hides the report from the receiver's project count.
   - `priority`: normal unless the user said otherwise.
   - `due`: only if the user gave a deadline. Run `date "+%Y-%m-%dT%H:%M:%S%z"` for today's date and the user's UTC offset, and send ISO-8601 with that offset.
3. Never put secrets, tokens, credentials or customer data in a report.
4. Show the user the draft (receiver, project, priority, due, title, text) and send it when they confirm. Send without asking only if they said to in this request ("send now", "don't ask") or already approved this exact text.
5. After sending, give the id. Mention `/handoff:edit <id>` for corrections and `/handoff:withdraw <id>` to take it back.
