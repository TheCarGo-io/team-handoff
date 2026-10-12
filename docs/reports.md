# How reports work

## Statuses

```
sent ──take──▶ taken ──done──────────▶ done
  │               └──needs-changes────▶ back to the sender ──edit──▶ sent
  ├── done / needs-changes are also allowed straight from sent
  └── close, from any open status, by anyone ──▶ closed
  closed / done ──reopen (sender, holder or closer)──▶ the status it had
```

Only one person holds a report at a time.

## Parts of a report

- **Project.** The repository the work belongs in. A checklist item can name another repository, so one
  report covers a change that touches several.
- **Checklist.** Up to 30 items. The receiver ticks them and the sender sees the progress. `done` is refused
  while items are unticked, unless told otherwise.
- **Readiness.** `ready`, `after-deploy` (what it depends on is not live yet) or `waiting-decision`, for the
  report and for each item. `take next` skips what is not ready; the receiver is told when it becomes ready.
- **Priority and due date.** `low`, `normal`, `high`, `urgent`; a due date must carry a UTC offset.
- **Replies.** Tracked per person: unread ones show under "Replies for you" until read.
- **Delivery.** A done report says where the work is: `local`, `pushed`, `pr` or `merged`, with links.
- **Related reports** link to each other by id.

## Read and unread

A report is unread for me until I open it, in the pane, with the `get` tool or by taking it. An edit by the
sender makes it unread again.

## Retention

Nothing is deleted on a timer. Lists show open reports and those closed or touched in the last 14 days;
`board` with `archived` shows everything. Withdrawing a report deletes it for everyone, and an edit replaces
the text.

## Limits

| | |
|---|---|
| Report text | 60 000 characters |
| Replies | 50 per report, 20 000 characters each |
| Checklist | 30 items |
| Changes | 60 per person per minute |
| Event streams | 20 per person |
