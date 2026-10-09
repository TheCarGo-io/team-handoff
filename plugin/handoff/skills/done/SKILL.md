---
description: Mark a handoff report my team received as done, with where the work is
argument-hint: <id> [note]
allowed-tools: mcp__plugin_handoff_handoff__resolve, mcp__plugin_handoff_handoff__check, mcp__plugin_handoff_handoff__get, Bash(git status:*), Bash(git log:*), Bash(git rev-parse:*), Bash(git branch:*), Bash(gh pr view:*)
---

Finish a handoff report with the handoff `resolve` tool, `status: "done"`. Request: $ARGUMENTS

A "Handoff context from the plugin" block comes with this prompt: the user, their team, this session's project or projects, what is waiting, what the user holds and which reports have unread replies. Use it instead of looking those up. If the block is missing, call `inbox` first.

The first number is the report id; the rest is an optional note.

1. **Checklist.** `get` the report if you do not have it. Tick every item that is finished and verified with `check`. If items are still open, tell the user which, and ask: keep the report in progress (then stop here and offer `/handoff:reply` with a status), or finish it anyway because the rest is not needed (then pass `allow_open_items: true`). Never pass it on your own.
2. **Where the work is.** Look at the repository the work was done in: `git status --porcelain`, the current branch, whether it is pushed (`git log origin/<branch>..HEAD`), and any pull request (`gh pr view --json url,state`). Send `delivery`: `local` when anything is uncommitted or unpushed, `pushed` when it is on a remote branch without a PR, `pr` when a PR is open, `merged` when it is merged. Put the branch name, PR link or commit in `refs`.
3. **Note.** One or two lines the sender will see: what was built. Write it from what was done in this session; if nothing was done here, ask instead of inventing one.
4. **Requests do not belong in the note.** If the sender still has to do something (test data, a setting, an answer), the report is not done: say so, and send the request with `/handoff:reply <id>` instead.

Confirm with the id, the delivery state and the note as sent. If the work is `local` or `pushed`, remind the user that `/handoff:done <id>` can be run again later, or tell them to say when it is merged so you can update it with the `delivered` tool.
