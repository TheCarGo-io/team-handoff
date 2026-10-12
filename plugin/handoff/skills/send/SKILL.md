---
description: Send a handoff report to another team from this session's work
argument-hint: <team> [@person] [what to report] [priority] [due]
allowed-tools: mcp__plugin_handoff_handoff__send, mcp__plugin_handoff_handoff__members, Bash(date:*), Bash(git log:*), Bash(git status:*), Bash(gh pr view:*), Bash(gh pr list:*)
---

Send a handoff report with the handoff `send` tool. Request: $ARGUMENTS

A "Handoff context from the plugin" block comes with this prompt: the user, their team, this session's project or projects, what is waiting, what the user holds and which reports have unread replies. Use it instead of looking those up. If the block is missing, call `inbox` first.

**1. Receiver.** The first word is the receiving team; `@name` addresses one person in it. If no team is given, call `members` and ask which. The server lists the valid teams if the name is wrong.

**2. Facts first.** Write from what was actually done in this session and in the code; do not invent endpoints or fields. If the request names something you have no context for, read the code. Find the pull requests behind the change (`gh pr list`, `gh pr view`) and whether each is merged. Say "on dev" only when the PR is merged and you know it deployed, or the user says so. If the code contradicts what the user asked you to report, say so instead of sending.

**3. One report per change, not per client.** When the same change needs work in several repositories (web, mobile, desktop, pay page, console), send one report and give each checklist item its own `project`. Send separate reports only when different people will do the work.

**4. Fields.**
- `title`: one line, what changed or what is needed.
- `project`: the main repository the receiver works in, by its exact repository name. Ask if it is not obvious; a wrong name hides the report from the receiver's project count.
- `items`: one short line per piece of work the receiver can finish separately, in the order the text describes them. Add `project` to an item that belongs in another repository than the report's. Leave `items` out only for a single piece of work.
- `readiness`: `ready` when the receiver can start now, `after-deploy` when what it depends on is not on dev yet, `waiting-decision` when someone still has to decide. Set it per item when only some are waiting, and say what it waits for in `readiness_note`.
- `related`: ids of earlier reports this one continues or depends on (the context block lists what is open).
- `priority`: normal unless the user said otherwise.
- `due`: only if the user gave a deadline. Run `date "+%Y-%m-%dT%H:%M:%S%z"` for today's date and the UTC offset, and send ISO-8601 with that offset.

**5. Text.** Markdown in English that the receiver's Claude can act on without asking. Use these sections, in this order, and drop any that would be empty:

```
## Why
## What changed        each service: repository, PR, merged or not, on dev since when
## API                 exact endpoints, request and response examples, error codes
## What to build       per repository, matching the checklist
## Try it on dev       account, data and steps
## Not included
## What I need from you    questions, and things only the receiver can do
```

A report can be up to 60,000 characters: keep one change in one report instead of splitting it into parts.

**6.** Never put secrets, tokens, credentials or customer data in a report.

**7.** Show the user the draft (receiver, project, priority, due, readiness, related, title, checklist with each item's project, text) and send when they confirm. Send without asking only if they said to in this request or already approved this exact text.

**8.** After sending, give the id. Mention `/handoff:edit <id>` for corrections, `/handoff:ready <id>` once a waiting report can be worked on, and `/handoff:withdraw <id>` to take it back.
