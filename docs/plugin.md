# Plugin guide

## Commands

| Command | What it does |
|---|---|
| `/handoff:send <team> [@person] …` | Write a report from this session's work and send it |
| `/handoff:inbox` | My team's queue, most pressing first |
| `/handoff:take <id [id …] \| next \| all>` | Take reports into this session, check them against the code, propose a plan |
| `/handoff:reply <id> <message>` | Ask or answer under a report |
| `/handoff:done <id> [note]` | Tick finished items, record where the work is, mark it done |
| `/handoff:return <id> <what to change>` | Hand it back to the sender |
| `/handoff:check <id> <items>` | Tick checklist items |
| `/handoff:ready <id> [items] [note]` | Tell the receiver a waiting report can be worked on |
| `/handoff:edit <id> <change>` | Update a report I sent |
| `/handoff:close <id> [note]` | Close a report nobody needs |
| `/handoff:reopen <id> [reason]` | Reopen a closed or done report |
| `/handoff:withdraw <id>` | Delete a report I sent |
| `/handoff:board [project]` | Every report of every team |
| `/handoff:status [project]` | What is happening where |
| `/handoff:members` | Teams and who is in them |
| `/handoff:invite [team] [admin]` | A single-use invite link (admins) |
| `/handoffs` | The inbox in a side pane, no model call |

`/handoff:take` on a report you sent picks up its unread replies instead.

## The live line and pane

**The line above the prompt** shows what waits for this session's project and, when something arrives, the
buttons Read, Take and Dismiss.

**The pane** (`/handoffs`) lists reports by group. Unread reports are bright with a green dot, read ones
dimmed. Each row shows when it arrived: minutes under an hour, the exact local time after that. Click a title
to read the report with its checklist and replies.

Take, Continue, Reply and Done fill the prompt (`/handoff:take 12 `) and never submit it.

| Keys | Where | Action |
|---|---|---|
| `ctrl+x tab` | prompt | Focus the line |
| `o` `r` `t` `d` | line | Open, Read, Take, Dismiss |
| `ctrl+x ctrl+a` | prompt | Hide or show the line |
| `b` `n` `p` `t` `d` `r` | report view | Back, Next, Previous, Take, Done, Reply |
| `esc` | pane | Close the pane |

The line and the toasts can be switched off in `/config`.

## Sessions

A report belongs to the session it was taken in, or where you pressed `here`. That session lists it first
under "In this session"; your other open sessions fold it into "N in your other sessions" and leave it out of
their counts. `release`, or `here` in another session, moves it. When a session closes, its reports show
everywhere again.

## Projects

The plugin reads the session's repository from `git remote`; in a folder that is not a repository it takes
the repositories inside it. Reports for those are listed first.

## When the server is unreachable

The line and the pane say `offline since HH:MM` and keep the last known state. The plugin retries after 15
and 30 seconds, then every minute; `Retry` tries at once.

## Updates

An installed copy checks for a new version every three hours and shows `version X is out [ Update ]`. The
button installs it and reloads plugins in that session. By hand: `/plugin update handoff@thecargo`, then
`/reload-plugins`.

## Without the live part

The line, pane and toasts use Claude Code's function-hooks API, which is early access and may change between
releases. The plugin was written against Claude Code 2.1.296. Where that API is unavailable, the commands and
tools work as before, and a `SessionStart` hook prints one line when something waits:

```
Team handoff: 2 waiting for your team · 1 unread reply. /handoff:inbox lists them.
```

The hook needs `curl` and a POSIX shell (Git Bash on Windows). Windows is untested.
