import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Detail, HandoffEvent, Inbox, Row, View } from '../types'

const PANE = 'handoffs'
const SAFETY_REFRESH_MS = 600000
const EMPTY: Inbox = {
  isLoaded: false,
  user: '',
  project: '',
  waiting: 0,
  waitingForProject: 0,
  overdue: 0,
  takenByMe: 0,
  returned: 0,
  rows: [],
  returnedRows: [],
}
const inbox = atom({ plugin: 'handoff', key: 'inbox' } as const, EMPTY)

const LIST: View = { id: null, detail: null, problem: '' }
const TAKE_TOOL = 'mcp__plugin_handoff_handoff__take'
const latest = atom({ plugin: 'handoff', key: 'latest' } as const, null)
const view = atom({ plugin: 'handoff', key: 'view' } as const, LIST)
const seenBefore = atom({ plugin: 'handoff', key: 'seenBefore' } as const, 0)
const places = atom({ plugin: 'handoff', key: 'places' } as const, {})

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
const readable = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g, '')
const PRIORITY_COLOR = { urgent: 'error', high: 'warning', normal: 'text', low: 'inactive' } as const

export const describeEvent = (event: HandoffEvent): string => {
  const who = `${event.by_team}/${event.by_user}`
  const note = event.note ? `: ${event.note}` : ''

  switch (event.type) {
    case 'new':
      return `New handoff #${event.id} (${event.priority}) from ${who}: ${event.title}`
    case 'edited':
      return `Handoff #${event.id} updated by ${who}: ${event.title}`
    case 'taken':
      return `Handoff #${event.id} taken by ${who}: ${event.title}`
    case 'reply':
      return `Reply on handoff #${event.id} from ${who}${note}`
    case 'needs-changes':
      return `Handoff #${event.id} sent back by ${who}${note}`
    case 'withdrawn':
      return `Handoff #${event.id} withdrawn by ${who}: ${event.title}`
    default:
      return `Handoff #${event.id} ${event.type} by ${who}${note}`
  }
}

export const describeDue = (due: string | null, now: number): string => {
  if (due === null) {
    return ''
  }

  const minutes = Math.round((Date.parse(due) - now) / 60000)
  const span = (value: number) => (value < 90 ? `${value}m` : value < 2880 ? `${Math.round(value / 60)}h` : `${Math.round(value / 1440)}d`)

  return minutes < 0 ? `overdue by ${span(-minutes)}` : `due in ${span(minutes)}`
}

export const describeAge = (stamp: string, now: number): string => {
  const minutes = Math.max(0, Math.round((now - Date.parse(stamp)) / 60000))

  if (minutes < 1) {
    return 'just now'
  }

  return minutes < 90 ? `${minutes}m ago` : minutes < 2880 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`
}

export const summarize = (box: Inbox): string | undefined => {
  const parts = []

  if (box.waiting > 0) {
    parts.push(`${box.waiting} waiting`)
  }

  if (box.takenByMe > 0) {
    parts.push(`${box.takenByMe} in progress`)
  }

  if (box.returned > 0) {
    parts.push(`${box.returned} returned`)
  }

  return parts.length > 0 ? parts.join(' · ') : undefined
}

export const projectOf = (remote: string, cwd: string): string => {
  const source = remote.trim() || cwd
  const name = source.replace(/[/\\]+$/, '').split(/[/\\:]/).pop() ?? ''

  return name.replace(/\.git$/, '')
}

export const configProblem = (url: string, token: string): string | undefined => {
  if (!/^https?:\/\/[A-Za-z0-9._~:/?#@!$&()*+,;=%[\]-]+$/.test(url)) {
    return 'the server URL must be a plain http(s) URL'
  }

  if (url.endsWith('/')) {
    return 'remove the trailing slash from the server URL'
  }

  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    return 'the token contains characters a handoff token never has'
  }

  return undefined
}

const draftSkill = async ($: EngineInterface, skill: 'take' | 'edit' | 'reply' | 'done', id: number) => {
  const command = `/handoff:${skill} ${id} `
  const box = await $.prompt.read().catch(() => ({ text: '' }))

  if (box.text.trim() !== '' && !box.text.startsWith('/handoff:')) {
    $.ui.toast(`Your draft is still in the prompt. When ready, type ${command.trim()}`, { timeoutMs: 8000 })

    return
  }

  const filled = await $.prompt.fill({ text: command }).catch(() => ({ isFilled: false }))

  if (!filled.isFilled) {
    $.ui.toast(`Type ${command.trim()} in the prompt`, { timeoutMs: 8000 })
  }
}

let api: { base: string; headers: Record<string, string> } | undefined
let here = ''

const openPane = async ($: EngineInterface) => {
  const stored = Number((await $.store.get('seenAt').catch(() => 0)) ?? 0)
  await update($, seenBefore, () => stored)
  await update($, view, () => LIST)
  void $.store.set('seenAt', Date.now()).catch(() => undefined)
  await $.ui.open({ id: PANE, title: 'Handoffs', focus: true, closeOnEscape: true })
}

const readReport = async ($: EngineInterface, id: number) => {
  await update($, view, () => ({ id, detail: null, problem: '' }))
  const answer = api && (await $.http.fetch(`${api.base}/api/v1/reports/${id}`, { headers: api.headers }).catch(() => undefined))
  const shown: View =
    answer?.ok === true
      ? { id, detail: JSON.parse(answer.text) as Detail, problem: '' }
      : { id, detail: null, problem: answer?.status === 404 ? 'This report no longer exists.' : 'Could not load the report.' }
  await update($, view, current => (current.id === id ? shown : current))
}

export const register: Register = (on, options) => {
  on('tool.call', { tool: TAKE_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    const id = /"id":\s*(\d+)/.exec(ran.text ?? '')?.[1]

    if (id !== undefined && ran.isError !== true && here !== '') {
      const known = { ...(((await $.store.get('places').catch(() => undefined)) as Record<string, string> | undefined) ?? {}), [id]: here }
      const kept = Object.fromEntries(Object.entries(known).slice(-100))
      void $.store.set('places', kept).catch(() => undefined)
      await update($, places, () => kept)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.command.register({ name: PANE, description: 'Show my team handoff inbox in a pane (no model call)' })

    if (!e.isInteractive) {
      return started
    }

    const base = String(options.url ?? '')
    const token = String(options.token ?? '')
    const hasToasts = options.notifications !== false
    const problem = configProblem(base, token)

    if (problem !== undefined) {
      $.ui.toast(`Handoff is not connected: ${problem}. Fix it in /plugin.`, { timeoutMs: 10000 })

      return started
    }

    const headers = { Authorization: `Bearer ${token}` }
    api = { base, headers }
    let project = ''
    let locatedIn = ''
    let isRejected = false
    let isRefreshing = false
    let isStale = false

    const locate = async () => {
      const cwd = await $.session.cwd().catch(() => e.cwd)

      if (cwd !== locatedIn) {
        const remote = await $.process.run(['git', 'remote', 'get-url', 'origin'], { cwd }).catch(() => ({ stdout: '' }))
        locatedIn = cwd
        project = projectOf(remote.stdout, cwd)
        here = project
      }
    }

    const load = async () => {
      await locate()
      const answer = await $.http
        .fetch(`${base}/api/v1/inbox?project=${encodeURIComponent(project)}`, { headers })
        .catch(() => undefined)

      if (answer === undefined) {
        return
      }

      if (answer.status === 401) {
        if (!isRejected) {
          $.ui.toast('Handoff: the server rejected your token. Update it in /plugin.', { timeoutMs: 10000 })
        }

        isRejected = true
        $.ui.status('token rejected')

        return
      }

      if (!answer.ok) {
        return
      }

      const body = JSON.parse(answer.text) as {
        user: string
        waiting: number
        waiting_for_project: number
        overdue: number
        taken_by_me: number
        returned: number
        rows: Row[]
        returned_rows: Row[]
      }
      const fresh: Inbox = {
        isLoaded: true,
        user: body.user,
        project,
        waiting: body.waiting,
        waitingForProject: body.waiting_for_project,
        overdue: body.overdue,
        takenByMe: body.taken_by_me,
        returned: body.returned,
        rows: body.rows.slice(0, 50),
        returnedRows: body.returned_rows.slice(0, 20),
      }
      isRejected = false
      await update($, inbox, () => fresh)
      await update($, latest, shown =>
        shown?.type === 'new' && !body.rows.some(row => row.id === shown.id && row.status === 'sent') ? null : shown,
      )
      const summary = summarize(fresh)
      $.ui.status(options.band === false && summary !== undefined ? `${summary} · /handoffs` : undefined)
    }

    const refresh = async () => {
      isStale = true

      if (isRefreshing) {
        return
      }

      isRefreshing = true

      try {
        while (isStale) {
          isStale = false
          await load()
        }
      } catch {
        isStale = false
      } finally {
        isRefreshing = false
      }
    }

    const receive = (line: string) => {
      if (line.startsWith(': connected')) {
        void refresh()

        return
      }

      if (!line.startsWith('data: ')) {
        return
      }

      let event: HandoffEvent | { type: 'resync' }

      try {
        event = JSON.parse(line.slice(6))
      } catch {
        return
      }

      if (event.type !== 'resync' && event.notify) {
        const shown = event
        void update($, latest, () => shown)

        if (hasToasts) {
          $.ui.toast(printable(describeEvent(shown)), { timeoutMs: 8000 })
        }
      }

      void refresh()
    }

    const listen = async () => {
      const curl = $.process.spawn({
        argv: ['curl', '-sN', '--fail', '--connect-timeout', '10', '--speed-limit', '1', '--speed-time', '60', '-K', '-'],
        input: `url = "${base}/api/v1/events"\nheader = "Authorization: Bearer ${token}"\n`,
      })
      let rest = ''

      for await (const piece of curl) {
        if (!('text' in piece) || piece.stream !== 'stdout') {
          continue
        }

        const lines = (rest + piece.text).split('\n')
        rest = lines.pop() ?? ''
        lines.forEach(receive)
      }
    }

    const follow = async () => {
      const stored = (await $.store.get('places').catch(() => undefined)) as Record<string, string> | undefined
      await update($, places, () => stored ?? {})
      await refresh()
      let wait = 2000

      while (!isRejected) {
        const connectedAt = await $.clock.now()
        await listen().catch(() => undefined)
        const lived = (await $.clock.now()) - connectedAt
        wait = lived > 30000 ? 2000 : Math.min(wait * 2, 60000)
        await $.clock.sleep(wait)
        await refresh()
      }
    }

    void follow().catch(() => undefined)
    $.clock.every(SAFETY_REFRESH_MS, () => void refresh())

    return started
  })

  on('command.run', { command: PANE }, async $ => {
    await openPane($)

    return { text: 'Handoff inbox opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const box = await read($, inbox)
    const event = await read($, latest)
    const summary = summarize(box)

    if (options.band === false || e.props.hasSurvey || (summary === undefined && event === null)) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const beneath = await next(e)
    const open = () => void openPane($)

    if (event === null) {
      const elsewhere = box.waiting - box.waitingForProject
      const rest = [
        elsewhere > 0 ? `${elsewhere} ${box.waitingForProject > 0 ? 'elsewhere' : 'waiting'}` : '',
        box.takenByMe > 0 ? `${box.takenByMe} in progress` : '',
        box.returned > 0 ? `${box.returned} returned` : '',
      ].filter(part => part !== '')

      return (
        <Box flexDirection="column">
          <Box gap={1}>
            <Text color="warning" bold>
              Handoff
            </Text>
            {box.waitingForProject > 0 && <Text bold>{box.waitingForProject} here</Text>}
            {rest.length > 0 && <Text dimColor>{(box.waitingForProject > 0 ? '· ' : '') + rest.join(' · ')}</Text>}
            {box.overdue > 0 && <Text color="error">· {box.overdue} overdue</Text>}
            <Button key="open" label="Open" hotkey="o" dimColor onPress={open} />
          </Box>
          {beneath}
        </Box>
      )
    }

    const isNew = event.type === 'new'
    const take = () => void draftSkill($, 'take', event.id)
    const peek = () => {
      void openPane($).then(() => readReport($, event.id))
      void update($, latest, () => null)
    }

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text color={isNew ? PRIORITY_COLOR[event.priority] : 'success'} bold>
            ●
          </Text>
          <Text wrap="truncate-end">{printable(describeEvent(event))}</Text>
          {event.type !== 'withdrawn' && <Button key="read" label="Read" hotkey="r" variant="primary" onPress={peek} />}
          {isNew && <Button key="take" label={`Take #${event.id}`} hotkey="t" onPress={take} />}
          <Button key="hide" label="Hide" hotkey="h" dimColor role="dismiss" onPress={() => void update($, latest, () => null)} />
        </Box>
        {beneath}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const box = await read($, inbox)
    const shown = await read($, view)
    const taken = await read($, places)
    const now = Date.now()

    if (!box.isLoaded) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>Handoffs</Text>
          <Text dimColor>Not connected yet. Check the server URL and your token in /plugin.</Text>
        </Box>
      )
    }

    const isMine = (row: Row) => row.status === 'taken' && row.assignee === box.user
    const place = (row: Row) => (taken[String(row.id)] === undefined ? '' : ` in ${taken[String(row.id)] === box.project ? 'this project' : taken[String(row.id)]}`)

    const action = (row: Row, isFirst: boolean) => {
      if (row.status === 'sent') {
        return (
          <Button
            key={`take-${row.id}`}
            label="Take"
            variant={isFirst ? 'primary' : 'secondary'}
            onPress={() => void draftSkill($, 'take', row.id)}
          />
        )
      }

      if (isMine(row)) {
        return <Button key={`take-${row.id}`} label="Continue" onPress={() => void draftSkill($, 'take', row.id)} />
      }

      if (row.status === 'needs-changes') {
        return <Button key={`edit-${row.id}`} label="Fix" onPress={() => void draftSkill($, 'edit', row.id)} />
      }

      return undefined
    }

    if (shown.id !== null) {
      const report = shown.detail
      const back = <Button key="back" label="← Back" hotkey="b" dimColor autoFocus onPress={() => void update($, view, () => LIST)} />

      if (report === null) {
        return (
          <Box flexDirection="column" paddingX={1}>
            <Box>{back}</Box>
            <Text dimColor>{shown.problem || `Loading #${shown.id}…`}</Text>
          </Box>
        )
      }

      const queue = [...box.rows, ...box.returnedRows]
      const at = queue.findIndex(row => row.id === report.id)
      const previous = at > 0 ? queue[at - 1] : undefined
      const following = at >= 0 ? queue[at + 1] : undefined
      const rule = '─'.repeat(Math.max(10, Math.min(e.props.bodyColumns - 2, 100)))
      const status =
        report.status === 'taken'
          ? `taken by ${report.assignee === box.user ? 'you' : report.assignee}${place(report)}`
          : report.status === 'sent'
            ? 'waiting'
            : report.status
      const facts: [string, string, boolean][] = [
        ['From', `${report.from_team}/${report.from_user}`, false],
        ['To', `${report.to_team}${report.to_user ? `/${report.to_user}` : ''}`, false],
        ['Sent', `${describeAge(report.created_at, now)}${report.version > 1 ? ` · edited, v${report.version}` : ''}`, false],
        ['Status', status, false],
        ['Due', describeDue(report.due, now).replace(/^due /, ''), report.overdue],
        ['Note', report.note ?? '', false],
      ]

      return (
        <Box flexDirection="column" paddingX={1}>
          <Box gap={1}>
            {back}
            {action(report, true)}
            {isMine(report) && <Button key="done" label="Done" hotkey="d" onPress={() => void draftSkill($, 'done', report.id)} />}
            <Button key="reply" label="Reply" hotkey="r" dimColor onPress={() => void draftSkill($, 'reply', report.id)} />
            <Box flexGrow={1} />
            {previous && <Button key="previous" label="‹ Prev" hotkey="p" dimColor onPress={() => void readReport($, previous.id)} />}
            {following && <Button key="next" label="Next ›" hotkey="n" dimColor onPress={() => void readReport($, following.id)} />}
          </Box>
          <Box gap={1} marginTop={1}>
            <Text bold>#{report.id}</Text>
            <Text color={PRIORITY_COLOR[report.priority]} inverse bold>
              {` ${report.priority.toUpperCase()} `}
            </Text>
            <Text color="suggestion">{printable(report.project)}</Text>
          </Box>
          <Text bold wrap="wrap">
            {printable(report.title)}
          </Text>
          <Text dimColor>{rule}</Text>
          {facts
            .filter(([, value]) => value !== '')
            .map(([name, value, isAlert]) => (
              <Box key={`fact-${name}`}>
                <Box width={8} flexShrink={0}>
                  <Text dimColor>{name}</Text>
                </Box>
                <Text color={isAlert ? 'error' : undefined} wrap="wrap">
                  {printable(value)}
                </Text>
              </Box>
            ))}
          <Text dimColor>{rule}</Text>
          <Box marginTop={1} flexDirection="column">
            <Markdown text={readable(report.text)} />
          </Box>
          {report.replies.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>{rule}</Text>
              <Text color="suggestion" bold>
                {report.replies.length === 1 ? '1 reply' : `${report.replies.length} replies`}
              </Text>
              {report.replies.map(reply => (
                <Box key={`reply-${reply.id}`} flexDirection="column" marginTop={1}>
                  <Box gap={1}>
                    <Text color={reply.user === box.user ? 'success' : 'suggestion'}>↳</Text>
                    <Text bold>{printable(reply.user === box.user ? 'you' : `${reply.team}/${reply.user}`)}</Text>
                    <Text dimColor>{describeAge(reply.created_at, now)}</Text>
                  </Box>
                  <Box paddingLeft={2} flexDirection="column">
                    <Markdown text={readable(reply.text)} />
                  </Box>
                </Box>
              ))}
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>Take, Reply and Done put the command in the prompt; press Enter there to run it · b back · n / p · esc closes</Text>
          </Box>
        </Box>
      )
    }

    const since = await read($, seenBefore)
    const waiting = box.rows.filter(row => row.status === 'sent')
    const forMe = waiting.filter(row => row.to_user === box.user)
    const open = waiting.filter(row => row.to_user !== box.user)
    const groups = [
      { title: 'For you', rows: forMe },
      { title: `This project · ${box.project}`, rows: open.filter(row => row.project === box.project) },
      { title: 'Other projects', rows: open.filter(row => row.project !== box.project) },
      { title: 'In progress', rows: box.rows.filter(row => row.status === 'taken') },
      { title: 'Returned to you · needs changes', rows: box.returnedRows },
    ].filter(group => group.rows.length > 0)
    let room = Math.max(2, Math.floor(((e.viewport?.rows ?? 30) - 5 - groups.length * 2) / 2))
    const first = groups[0]?.rows[0]?.id

    const details = (row: Row) =>
      [
        `from ${row.from_team}/${row.from_user}`,
        row.project === box.project ? '' : row.project,
        describeDue(row.due, now),
        row.replies > 0 ? `${row.replies} ${row.replies === 1 ? 'reply' : 'replies'}` : '',
        row.status === 'taken' ? `taken by ${isMine(row) ? 'you' : row.assignee}${place(row)}` : '',
      ]
        .filter(part => part !== '')
        .join(' · ')

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box gap={1}>
          <Text bold>{plural(box.waiting, 'report')} waiting</Text>
          <Text dimColor>
            · {box.takenByMe} in progress{box.overdue > 0 ? ` · ${box.overdue} overdue` : ''}
          </Text>
        </Box>
        {groups.length === 0 && <Text dimColor>Nothing waiting. New reports appear here as they arrive.</Text>}
        {groups.map(group => {
          const rows = group.rows.slice(0, Math.max(0, room))
          room -= rows.length

          return (
            <Box key={group.title} flexDirection="column" marginTop={1}>
              <Text color="suggestion" bold>
                {printable(group.title)}
              </Text>
              {rows.map(row => {
                const isUnread = row.status === 'sent' && Date.parse(row.created_at) > since

                return (
                  <Box key={`row-${row.id}`} flexDirection="column">
                    <Box gap={1}>
                      <Box width={1} flexShrink={0}>
                        <Text color="success">{isUnread ? '●' : ' '}</Text>
                      </Box>
                      <Box width={4} flexShrink={0}>
                        <Text bold>#{row.id}</Text>
                      </Box>
                      <Box width={6} flexShrink={0}>
                        <Text color={PRIORITY_COLOR[row.priority]}>{row.priority}</Text>
                      </Box>
                      <Box flexGrow={1} flexShrink={1}>
                        <Text bold={isUnread} wrap="truncate-end">
                          {printable(row.title)}
                        </Text>
                      </Box>
                      <Box gap={1} flexShrink={0}>
                        <Button
                          key={`read-${row.id}`}
                          label="Read"
                          dimColor
                          autoFocus={row.id === first ? true : undefined}
                          onPress={() => void readReport($, row.id)}
                        />
                        {action(row, row.id === first)}
                      </Box>
                    </Box>
                    <Text color={row.overdue ? 'error' : undefined} dimColor={!row.overdue} wrap="truncate-end">
                      {'              '}
                      {printable(details(row))}
                    </Text>
                  </Box>
                )
              })}
              {group.rows.length > rows.length && (
                <Text dimColor>
                  {'              '}… {group.rows.length - rows.length} more — /handoff:inbox lists everything
                </Text>
              )}
            </Box>
          )
        })}
        <Box marginTop={1}>
          <Text dimColor>● new since you last looked · Read opens it here · Take puts the command in the prompt · esc closes</Text>
        </Box>
      </Box>
    )
  })
}
