import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Detail, HandoffEvent, Inbox, Readiness, Row, Thread, View } from '../types'

const PANE = 'handoffs'
const SAFETY_REFRESH_MS = 600000
const UPDATE_CHECK_MS = 3 * 60 * 60 * 1000
const LOAD_TIMEOUT_MS = 20000
const RETRY_FIRST_MS = 15000
const RETRY_MAX_MS = 60000
const EMPTY: Inbox = {
  isLoaded: false,
  isOffline: false,
  offlineSince: null,
  session: '',
  user: '',
  team: '',
  project: '',
  projects: [],
  waiting: 0,
  waitingForProject: 0,
  unread: 0,
  overdue: 0,
  takenByMe: 0,
  returned: 0,
  rows: [],
  returnedRows: [],
  hiddenRows: [],
  unreadReplies: 0,
  threads: [],
}
const inbox = atom({ plugin: 'handoff', key: 'inbox' } as const, EMPTY)

const LIST: View = { id: null, detail: null, problem: '', fresh: 0 }
const TAKE_TOOL = /^mcp__.*handoff.*__take$/
const latest = atom({ plugin: 'handoff', key: 'latest' } as const, null)
const view = atom({ plugin: 'handoff', key: 'view' } as const, LIST)
const confirming = atom({ plugin: 'handoff', key: 'confirming' } as const, null)
const selected = atom({ plugin: 'handoff', key: 'selected' } as const, [])
const showHidden = atom({ plugin: 'handoff', key: 'showHidden' } as const, false)
const showElsewhere = atom({ plugin: 'handoff', key: 'showElsewhere' } as const, false)
const newer = atom({ plugin: 'handoff', key: 'newer' } as const, null)
const lastClosed = atom({ plugin: 'handoff', key: 'lastClosed' } as const, null)

export const clip = (text: string, width: number): string =>
  text.length > width ? `${text.slice(0, Math.max(1, width - 1)).trimEnd()}…` : text

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
const readable = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g, '')
const PRIORITY_COLOR = { urgent: 'error', high: 'warning', normal: 'text', low: 'inactive' } as const
const DELIVERY = {
  none: '',
  local: 'on their machine only, not pushed',
  pushed: 'pushed to a branch',
  pr: 'in a pull request',
  merged: 'merged',
} as const
const WAITS: Record<Readiness, string> = {
  ready: '',
  'after-deploy': 'not live yet',
  'waiting-decision': 'waiting on a decision',
}

export const describeReadiness = (readiness: Readiness | undefined, note?: string | null): string => {
  const label = WAITS[readiness ?? 'ready']

  return label === '' ? '' : note ? `${label}: ${note}` : label
}

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
    case 'progress':
      return `Handoff #${event.id}: ${event.note} (${who})`
    case 'ready':
      return `Handoff #${event.id} is ready to work on${note} (${who})`
    case 'delivered':
      return `Handoff #${event.id} delivery update by ${who}${note}`
    case 'reopened':
      return `Handoff #${event.id} reopened by ${who}${note || `: ${event.title}`}`
    case 'closed':
      return `Handoff #${event.id} closed by ${who}${note || `: ${event.title}`}`
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const describeClock = (stamp: number): string => {
  const at = new Date(stamp)

  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

export const describeWhen = (stamp: string, now: number): string => {
  const then = Date.parse(stamp)
  const minutes = Math.max(0, Math.floor((now - then) / 60000))

  if (minutes < 60) {
    return minutes < 1 ? 'now' : `${minutes}m`
  }

  const at = new Date(then)
  const clock = describeClock(then)

  if (at.toDateString() === new Date(now).toDateString()) {
    return clock
  }

  const day = `${MONTHS[at.getMonth()]} ${at.getDate()}`

  return at.getFullYear() === new Date(now).getFullYear() ? `${day} ${clock}` : `${day} ${at.getFullYear()} ${clock}`
}

export const describeAge = (stamp: string, now: number): string => {
  const when = describeWhen(stamp, now)

  return when === 'now' ? 'just now' : /^\d+m$/.test(when) ? `${when} ago` : when
}

export const describeOffline = (box: Inbox): string => (box.offlineSince ? `offline since ${describeClock(box.offlineSince)}` : 'offline')

export const isElsewhere = (box: Inbox, row: Row): boolean =>
  row.status === 'taken' && row.assignee === box.user && row.session != null && row.session.live && row.session.id !== box.session

export const heldHere = (box: Inbox): number => box.takenByMe - box.rows.filter(row => isElsewhere(box, row)).length

export const summarize = (box: Inbox): string | undefined => {
  const parts = []

  if (box.waiting > 0) {
    parts.push(`${box.waiting} waiting`)
  }

  if (heldHere(box) > 0) {
    parts.push(`${heldHere(box)} in progress`)
  }

  if (box.returned > 0) {
    parts.push(`${box.returned} returned`)
  }

  if (box.unreadReplies > 0) {
    parts.push(`${box.unreadReplies} unread ${box.unreadReplies === 1 ? 'reply' : 'replies'}`)
  }

  return parts.length > 0 ? parts.join(' · ') : undefined
}

export const projectOf = (remote: string, cwd: string): string => {
  const source = remote.trim() || cwd
  const name = source.replace(/[/\\]+$/, '').split(/[/\\:]/).pop() ?? ''

  return name.replace(/\.git$/, '')
}

export const projectsOf = (remote: string, children: string, cwd: string): string[] => {
  if (remote.trim() !== '') {
    return [projectOf(remote, cwd)]
  }

  const names = children
    .split('\n')
    .map(line => projectOf(line, line))
    .filter(name => name !== '')

  return names.length > 0 ? [...new Set(names)].slice(0, 150) : [projectOf('', cwd)]
}

const WORKSPACE_SCAN =
  'for d in */; do [ -e "$d.git" ] && { git -C "$d" remote get-url origin 2>/dev/null || echo "$d"; }; done'

export const describeContext = (box: Inbox): string => {
  const mine = (row: Row) => (row.projects ?? [row.project]).some(name => box.projects.includes(name))
  const brief = (row: Row) => `#${row.id} "${row.title}" (${(row.projects ?? [row.project]).join(', ')})`
  const waiting = box.rows.filter(row => row.status === 'sent')
  const held = box.rows.filter(row => row.status === 'taken' && row.assignee === box.user)
  const away = held.filter(row => isElsewhere(box, row))
  const lines = [
    'Handoff context from the plugin, current as of this prompt (use it instead of looking these up):',
    `- user ${box.user}, team ${box.team}`,
    `- this session's ${box.projects.length === 1 ? 'project' : 'projects (a workspace of repositories)'}: ${box.projects.join(', ')}`,
    `- waiting for these projects: ${waiting.filter(mine).map(brief).join('; ') || 'none'}`,
    `- waiting for other projects: ${waiting.filter(row => !mine(row)).map(brief).join('; ') || 'none'}`,
    `- held by ${box.user}${away.length > 0 ? ', for this session' : ''}: ${held.filter(row => !away.includes(row)).map(brief).join('; ') || 'none'}`,
    ...(away.length > 0
      ? [`- held by ${box.user} in their other open sessions (leave these to those sessions unless the user names one): ${away.map(brief).join('; ')}`]
      : []),
    `- unread replies: ${box.threads.map(thread => `#${thread.id} (${thread.unread} from ${thread.last_reply_by})`).join('; ') || 'none'}`,
  ]

  return lines.join('\n')
}

export const parseInstall = (root: string) => {
  const match = /^(.*)\/cache\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(root.replace(/\\/g, '/').replace(/\/+$/, ''))

  return match ? { home: match[1] ?? '', marketplace: match[2] ?? '', plugin: match[3] ?? '', version: match[4] ?? '' } : undefined
}

export const isNewer = (candidate: string, current: string): boolean => {
  const numbers = (version: string) => version.split(/[.-]/).map(part => Number.parseInt(part, 10) || 0)
  const [left, right] = [numbers(candidate), numbers(current)]

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)

    if (difference !== 0) {
      return difference > 0
    }
  }

  return false
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

const draftSkill = async (
  $: EngineInterface,
  skill: 'take' | 'edit' | 'reply' | 'done' | 'reopen',
  ids: number | number[],
) => {
  const command = `/handoff:${skill} ${(Array.isArray(ids) ? ids : [ids]).join(' ')} `
  const box = await $.prompt.read().catch(() => ({ text: '' }))

  if (box.text.trim() !== '' && !box.text.startsWith('/handoff:')) {
    $.ui.toast(`Your draft is still in the prompt. When ready, type ${command.trim()}`, { timeoutMs: 8000 })

    return
  }

  const filled = await $.prompt.fill({ text: command }).catch(() => ({ isFilled: false }))

  if (!filled.isFilled) {
    $.ui.toast(`Type ${command.trim()} in the prompt`, { timeoutMs: 8000 })
  } else if (skill === 'take') {
    await update($, selected, () => [])
  }
}

let api: { base: string; headers: Record<string, string> } | undefined
let refreshNow: (() => Promise<void>) | undefined

const openPane = async ($: EngineInterface) => {
  await update($, view, () => LIST)
  await $.ui.open({ id: PANE, title: 'Handoffs', focus: true, closeOnEscape: true })
}

const readReport = async ($: EngineInterface, id: number) => {
  const box = await read($, inbox)
  const fresh = box.threads.find(thread => thread.id === id)?.unread ?? 0
  const isUnread = [...box.rows, ...box.returnedRows, ...box.hiddenRows].some(row => row.id === id && row.read === false)
  await update($, view, () => ({ id, detail: null, problem: '', fresh }))
  const answer =
    api &&
    (await $.http.fetch(`${api.base}/api/v1/reports/${id}?mark_seen=true`, { headers: api.headers }).catch(() => undefined))
  const shown: View =
    answer?.ok === true
      ? { id, detail: JSON.parse(answer.text) as Detail, problem: '', fresh }
      : {
          id,
          detail: null,
          problem: answer?.status === 404 ? 'This report no longer exists.' : 'Could not load the report.',
          fresh: 0,
        }
  await update($, view, current => (current.id === id ? shown : current))

  if (fresh > 0 || isUnread) {
    void refreshNow?.()
  }
}

const pressClose = async ($: EngineInterface, id: number) => {
  if ((await read($, confirming)) !== id) {
    await update($, confirming, () => id)
    $.clock.after(5000, () => void update($, confirming, armed => (armed === id ? null : armed)))

    return
  }

  await update($, confirming, () => null)
  const answer =
    api &&
    (await $.http
      .fetch(`${api.base}/api/v1/reports/${id}/close`, {
        method: 'POST',
        headers: { ...api.headers, 'content-type': 'application/json' },
        body: '{}',
      })
      .catch(() => undefined))

  if (answer?.ok !== true) {
    const reason = answer?.status === 409 ? 'it is already closed' : answer?.status === 404 ? 'it no longer exists' : 'the server did not answer'
    $.ui.toast(`Could not close #${id}: ${reason}`, { timeoutMs: 6000 })
  } else {
    $.ui.toast(`Closed #${id} for everyone. Undo is in the handoff pane.`, { timeoutMs: 6000 })
    await update($, lastClosed, () => id)
    await update($, view, shown => (shown.id === id ? LIST : shown))
  }

  await refreshNow?.()
}

const post = async ($: EngineInterface, path: string, method = 'POST', body = '{}') =>
  api &&
  (await $.http
    .fetch(`${api.base}/api/v1/reports/${path}`, {
      method,
      headers: { ...api.headers, 'content-type': 'application/json' },
      body: method === 'DELETE' ? undefined : body,
    })
    .catch(() => undefined))

const placeHere = async ($: EngineInterface, id: number | string) => {
  const box = await read($, inbox)

  return box.session === ''
    ? undefined
    : post($, `${id}/session`, 'PUT', JSON.stringify({ session: box.session, label: (box.project || 'session').slice(0, 80) }))
}

const pressHere = async ($: EngineInterface, id: number, isHere: boolean) => {
  const answer = isHere ? await placeHere($, id) : await post($, `${id}/session`, 'DELETE')

  if (answer?.ok !== true) {
    $.ui.toast(`Could not ${isHere ? 'put' : 'release'} #${id} ${isHere ? 'in' : 'from'} this session: the server refused`, { timeoutMs: 6000 })
  }

  await refreshNow?.()
}

const pressUndo = async ($: EngineInterface, id: number) => {
  const answer = await post($, `${id}/reopen`)

  if (answer?.ok === true) {
    $.ui.toast(`Reopened #${id}`)
  } else {
    $.ui.toast(`Could not reopen #${id}. Try /handoff:reopen ${id}`, { timeoutMs: 6000 })
  }

  await update($, lastClosed, () => null)
  await refreshNow?.()
}

const pressHide = async ($: EngineInterface, id: number, isHidden: boolean) => {
  const answer = await post($, `${id}/hide`, isHidden ? 'POST' : 'DELETE')

  if (answer?.ok !== true) {
    $.ui.toast(`Could not ${isHidden ? 'hide' : 'show'} #${id}: the server did not answer`, { timeoutMs: 6000 })
  }

  await refreshNow?.()
}

const pressRetry = async ($: EngineInterface) => {
  await refreshNow?.()
  const box = await read($, inbox)
  $.ui.toast(box.isOffline ? 'Handoff: the server still does not answer.' : 'Handoff: back online.', { timeoutMs: 4000 })
}

const findUpdate = async ($: EngineInterface) => {
  const install = parseInstall($.plugin.root)

  if (install === undefined) {
    return
  }

  const checkedAt = Number((await $.store.get('updateCheckedAt').catch(() => 0)) ?? 0)

  if (Date.now() - checkedAt > UPDATE_CHECK_MS) {
    await $.store.set('updateCheckedAt', Date.now()).catch(() => undefined)
    await $.process
      .run(['claude', 'plugin', 'marketplace', 'update', install.marketplace], { timeoutMs: 60000 })
      .catch(() => undefined)
    const manifest = await $.fs
      .read(`${install.home}/marketplaces/${install.marketplace}/plugin/${install.plugin}/.claude-plugin/plugin.json`)
      .catch(() => '{}')
    const published = String((JSON.parse(manifest) as { version?: string }).version ?? '')

    if (published !== '') {
      await $.store.set('latestVersion', published).catch(() => undefined)
    }
  }

  const latestKnown = String((await $.store.get('latestVersion').catch(() => '')) ?? '')
  await update($, newer, () => (isNewer(latestKnown, install.version) ? latestKnown : null))
}

const pressUpdate = async ($: EngineInterface) => {
  const install = parseInstall($.plugin.root)

  if (install === undefined) {
    return
  }

  const target = `${install.plugin}@${install.marketplace}`
  $.ui.toast('Updating the handoff plugin…')
  const ran = await $.process.run(['claude', 'plugin', 'update', target], { timeoutMs: 120000 }).catch(() => undefined)

  if (ran?.exitCode !== 0) {
    $.ui.toast(`Could not update. Run /plugin update ${target}`, { timeoutMs: 8000 })

    return
  }

  await update($, newer, () => null)
  const isReloaded = await $.command.run({ command: 'reload-plugins' }).then(
    () => true,
    () => false,
  )

  if (!isReloaded) {
    $.ui.toast('Updated. Run /reload-plugins to start using it.', { timeoutMs: 8000 })
  }
}

const pressCheck = async ($: EngineInterface, id: number, item: number, isDone: boolean) => {
  const answer =
    api &&
    (await $.http
      .fetch(`${api.base}/api/v1/reports/${id}/items/check`, {
        method: 'POST',
        headers: { ...api.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ item_ids: [item], done: isDone }),
      })
      .catch(() => undefined))

  if (answer?.ok === true) {
    const fresh = JSON.parse(answer.text) as Detail
    await update($, view, shown => (shown.id === id ? { ...shown, detail: fresh } : shown))
    void refreshNow?.()
  } else {
    const reason = answer?.status === 403 ? 'only the receiving team ticks items' : 'the server refused'
    $.ui.toast(`Could not update item ${item} of #${id}: ${reason}`, { timeoutMs: 6000 })
  }
}

export const register: Register = (on, options) => {
  on('tool.call', { tool: TAKE_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    const id = /"id":\s*(\d+)/.exec(ran.text ?? '')?.[1]

    if (id !== undefined && ran.isError !== true) {
      void placeHere($, id).catch(() => undefined)
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
    const session = (await $.session.id().catch(() => '')).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
    await update($, inbox, box => ({ ...box, session }))
    let project = ''
    let projects: string[] = []
    let locatedIn = ''
    let isRejected = false
    let isStale = false
    let running: Promise<void> | undefined
    let retry: { cancel: () => void } | undefined
    let retryIn = RETRY_FIRST_MS

    const locate = async () => {
      const cwd = await $.session.cwd().catch(() => e.cwd)

      if (cwd !== locatedIn) {
        const remote = await $.process.run(['git', 'remote', 'get-url', 'origin'], { cwd }).catch(() => ({ stdout: '' }))
        const children =
          remote.stdout.trim() === ''
            ? await $.process.run(['sh', '-c', WORKSPACE_SCAN], { cwd }).catch(() => ({ stdout: '' }))
            : { stdout: '' }
        locatedIn = cwd
        projects = projectsOf(remote.stdout, children.stdout, cwd)
        project = projects.length === 1 ? (projects[0] ?? '') : projectOf('', cwd)
      }
    }

    const load = async () => {
      await locate()
      const query = projects.map(name => `project=${encodeURIComponent(name)}`).join('&')
      const answer = await new Promise<Awaited<ReturnType<typeof $.http.fetch>> | undefined>(resolve => {
        const limit = $.clock.after(LOAD_TIMEOUT_MS, () => resolve(undefined))
        void $.http
          .fetch(`${base}/api/v1/inbox?${query}`, { headers })
          .catch(() => undefined)
          .then(got => {
            limit.cancel()
            resolve(got)
          })
      })

      if (answer === undefined || answer.status >= 500) {
        const since = await $.clock.now()
        await update($, inbox, box => ({ ...box, isOffline: true, offlineSince: (box.isOffline && box.offlineSince) || since }))

        if (retry === undefined) {
          retry = $.clock.after(retryIn, () => {
            retry = undefined
            void refresh()
          })
          retryIn = Math.min(retryIn * 2, RETRY_MAX_MS)
        }

        return
      }

      retry?.cancel()
      retry = undefined
      retryIn = RETRY_FIRST_MS

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
        team: string
        projects?: string[]
        unread_replies?: number
        threads?: Thread[]
        waiting: number
        waiting_for_project: number
        unread?: number
        overdue: number
        taken_by_me: number
        returned: number
        rows: Row[]
        returned_rows: Row[]
        hidden_rows?: Row[]
      }
      const fresh: Inbox = {
        isLoaded: true,
        isOffline: false,
        offlineSince: null,
        session,
        user: body.user,
        team: body.team,
        project,
        projects: body.projects && body.projects.length > 0 ? body.projects : projects,
        waiting: body.waiting,
        waitingForProject: body.waiting_for_project,
        unread: body.unread ?? 0,
        overdue: body.overdue,
        takenByMe: body.taken_by_me,
        returned: body.returned,
        rows: body.rows.slice(0, 50),
        returnedRows: body.returned_rows.slice(0, 20),
        hiddenRows: (body.hidden_rows ?? []).slice(0, 50),
        unreadReplies: body.unread_replies ?? 0,
        threads: (body.threads ?? []).slice(0, 20),
      }
      isRejected = false
      await update($, inbox, () => fresh)
      await update($, latest, shown => {
        const isTakenNow = shown?.type === 'new' && !body.rows.some(row => row.id === shown.id && row.status === 'sent')
        const isReadNow = shown?.type === 'reply' && !fresh.threads.some(thread => thread.id === shown.id)

        return isTakenNow || isReadNow ? null : shown
      })
      const summary = summarize(fresh)
      $.ui.status(options.band === false && summary !== undefined ? `${summary} · /handoffs` : undefined)
    }

    const refresh = (): Promise<void> => {
      isStale = true
      running ??= (async () => {
        try {
          while (isStale) {
            isStale = false
            await load()
          }
        } catch {
          isStale = false
        } finally {
          running = undefined
        }
      })()

      return running
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
        input: `url = "${base}/api/v1/events${session === '' ? '' : `?session=${session}`}"\nheader = "Authorization: Bearer ${token}"\n`,
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

    refreshNow = refresh
    void follow().catch(() => undefined)
    void findUpdate($).catch(() => undefined)
    $.clock.every(SAFETY_REFRESH_MS, () => {
      void refresh()
      void findUpdate($).catch(() => undefined)
    })

    return started
  })

  on('prompt.submit', async ($, e, next) => {
    const box = await read($, inbox)

    return e.text.trimStart().startsWith('/handoff:') && box.isLoaded
      ? next({ ...e, context: [...(e.context ?? []), describeContext(box)] })
      : next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: PANE }, async $ => {
    await openPane($)

    return { text: 'Handoff inbox opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const box = await read($, inbox)
    const event = await read($, latest)
    const summary = summarize(box)
    const published = await read($, newer)

    if (options.band === false || e.props.hasSurvey || (summary === undefined && event === null && published === null)) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const beneath = await next(e)
    const open = () => void openPane($)

    if (event === null) {
      const elsewhere = box.waiting - box.waitingForProject
      const rest = [
        elsewhere > 0 ? `${elsewhere} ${box.waitingForProject > 0 ? 'elsewhere' : 'waiting'}` : '',
        heldHere(box) > 0 ? `${heldHere(box)} in progress` : '',
        box.returned > 0 ? `${box.returned} returned` : '',
      ].filter(part => part !== '')
      const replies = box.unreadReplies === 1 ? '1 unread reply' : `${box.unreadReplies} unread replies`

      return (
        <Box flexDirection="column">
          <Box gap={1}>
            <Text color="warning" bold>
              Handoff
            </Text>
            {box.waitingForProject > 0 && <Text bold>{box.waitingForProject} here</Text>}
            {rest.length > 0 && <Text dimColor>{(box.waitingForProject > 0 ? '· ' : '') + rest.join(' · ')}</Text>}
            {box.unreadReplies > 0 && (
              <Text color="success" bold>
                · {replies}
              </Text>
            )}
            {box.overdue > 0 && <Text color="error">· {box.overdue} overdue</Text>}
            {box.isOffline && <Text color="error">· {describeOffline(box)}</Text>}
            {box.isOffline && <Button key="retry" label="Retry" onPress={() => void pressRetry($)} />}
            {summary !== undefined && (
              <Button key="open" label="Open" hotkey="o" dimColor={box.unreadReplies === 0} onPress={open} />
            )}
            {published !== null && <Text dimColor>{summary === undefined ? '' : '· '}version {published} is out</Text>}
            {published !== null && <Button key="update" label="Update" onPress={() => void pressUpdate($)} />}
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
          {(isNew || event.type === 'reply') && (
            <Button key="take" label={isNew ? `Take #${event.id}` : 'Take reply'} hotkey="t" onPress={take} />
          )}
          {(event.type === 'closed' || event.type === 'done') && event.from_user === box.user && (
            <Button key="reopen" label="Reopen" hotkey="u" onPress={() => void draftSkill($, 'reopen', event.id)} />
          )}
          <Button key="dismiss" label="Dismiss" hotkey="d" dimColor role="dismiss" onPress={() => void update($, latest, () => null)} />
          {published !== null && <Button key="update" label={`Update to ${published}`} dimColor onPress={() => void pressUpdate($)} />}
        </Box>
        {beneath}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const box = await read($, inbox)
    const shown = await read($, view)
    const now = Date.now()

    if (!box.isLoaded) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>Handoffs</Text>
          <Text dimColor>Not connected yet. Check the server URL and your token in /plugin.</Text>
        </Box>
      )
    }

    const armed = await read($, confirming)
    const picked = await read($, selected)
    const isMine = (row: Row) => row.status === 'taken' && row.assignee === box.user
    const isHere = (row: Row) => (row.projects ?? [row.project]).some(name => box.projects.includes(name))
    const hereLabel = box.projects.length > 1 ? `this workspace (${box.projects.length} repositories)` : box.project
    const isTeammates = (row: Row) => row.status === 'taken' && row.assignee !== box.user
    const canReopen = (row: Row) =>
      (row.status === 'closed' || row.status === 'done' || row.status === 'rejected') &&
      [row.from_user, row.closed_by, row.assignee].includes(box.user)
    const closer = (row: Row, isQuiet = false) =>
      (row.status === 'sent' || row.status === 'taken' || row.status === 'needs-changes') && !isTeammates(row) ? (
        <Button
          key={`close-${row.id}`}
          label={armed === row.id ? (isQuiet ? 'close? again' : 'Close? again') : isQuiet ? 'close' : 'Close'}
          plain={isQuiet ? true : undefined}
          variant={armed === row.id ? 'primary' : 'secondary'}
          dimColor={armed !== row.id}
          onPress={() => void pressClose($, row.id)}
        />
      ) : undefined
    const isThisSession = (row: Row) => isMine(row) && box.session !== '' && row.session?.id === box.session
    const place = (row: Row) => {
      if (!isMine(row) || row.session == null) {
        return ''
      }

      return isThisSession(row) ? ' in this session' : ` in another session (${row.session.label}${row.session.live ? '' : ', closed'})`
    }

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
          ? `taken by ${report.assignee === box.user ? 'you' : report.assignee}${place(box.rows.find(row => row.id === report.id) ?? report)}`
          : report.status === 'sent'
            ? 'waiting'
            : report.status
      const facts: [string, string, boolean][] = [
        ['From', `${report.from_team}/${report.from_user}`, false],
        ['To', `${report.to_team}${report.to_user ? `/${report.to_user}` : ''}`, false],
        ['Sent', `${describeAge(report.created_at, now)}${report.version > 1 ? ` · edited, v${report.version}` : ''}`, false],
        ['Status', status, false],
        ['Due', describeDue(report.due, now).replace(/^due /, ''), report.overdue],
        ['Ready', describeReadiness(report.readiness, report.readiness_note), true],
        ['Work is', [DELIVERY[report.delivery ?? 'none'], ...(report.delivery_refs ?? [])].filter(Boolean).join(' · '), report.delivery === 'local'],
        ['Repos', (report.projects ?? []).length > 1 ? (report.projects ?? []).join(', ') : '', false],
        ['Note', report.note ?? '', false],
      ]
      const others = report.replies.filter(reply => reply.user !== box.user)
      const unread = new Set(others.slice(Math.max(0, others.length - shown.fresh)).map(reply => reply.id))

      return (
        <Box flexDirection="column" paddingX={1}>
          <Box gap={1}>
            {back}
            {action(report, true)}
            {action(report, true) === undefined && others.length > 0 && (
              <Button key="take-thread" label="Take reply" hotkey="t" variant="primary" onPress={() => void draftSkill($, 'take', report.id)} />
            )}
            {isMine(report) && <Button key="done" label="Done" hotkey="d" onPress={() => void draftSkill($, 'done', report.id)} />}
            <Button key="reply" label="Reply" hotkey="r" dimColor onPress={() => void draftSkill($, 'reply', report.id)} />
            {closer(report)}
            {canReopen(report) && <Button key="reopen" label="Reopen" onPress={() => void draftSkill($, 'reopen', report.id)} />}
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
          {(report.related ?? []).length > 0 && (
            <Box gap={1}>
              <Text dimColor>Related</Text>
              {(report.related ?? []).map(number => (
                <Button key={`related-${number}`} label={`#${number}`} dimColor onPress={() => void readReport($, number)} />
              ))}
            </Box>
          )}
          {report.items.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text color="suggestion" bold>
                Checklist · {report.items.filter(item => item.done).length}/{report.items.length} done
              </Text>
              {report.items.map(item => (
                <Box key={`item-${item.id}`} gap={1}>
                  <Button
                    key={`check-${item.id}`}
                    label={item.done ? '[x]' : '[ ]'}
                    plain
                    dimColor={item.done}
                    onPress={() => void pressCheck($, report.id, item.id, !item.done)}
                  />
                  <Box flexGrow={1} flexShrink={1}>
                    <Text dimColor={item.done} strikethrough={item.done} wrap="wrap">
                      {item.id}. {printable(item.title)}
                    </Text>
                  </Box>
                  {item.project && <Text color="suggestion">{printable(item.project)}</Text>}
                  {item.done && item.done_by && <Text dimColor>{printable(item.done_by)}</Text>}
                  {!item.done && item.readiness !== 'ready' && <Text color="warning">{WAITS[item.readiness]}</Text>}
                </Box>
              ))}
              <Text dimColor>{rule}</Text>
            </Box>
          )}
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
                    {unread.has(reply.id) && (
                      <Text color="success" bold>
                        ● new
                      </Text>
                    )}
                  </Box>
                  <Box paddingLeft={2} flexDirection="column">
                    <Markdown text={readable(reply.text)} />
                  </Box>
                </Box>
              ))}
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>Take, Reply and Done put the command in the prompt · Close (press twice) ends the report · b back · n / p</Text>
          </Box>
        </Box>
      )
    }

    const waiting = box.rows.filter(row => row.status === 'sent')
    const forMe = waiting.filter(row => row.to_user === box.user)
    const open = waiting.filter(row => row.to_user !== box.user)
    const taken = box.rows.filter(row => row.status === 'taken')
    const away = taken.filter(row => isElsewhere(box, row))
    const groups = [
      { title: 'In this session', rows: taken.filter(isThisSession) },
      { title: 'For you', rows: forMe },
      { title: `Here · ${hereLabel}`, rows: open.filter(isHere) },
      { title: 'Other projects', rows: open.filter(row => !isHere(row)) },
      { title: 'In progress', rows: taken.filter(row => !isThisSession(row) && !isElsewhere(box, row)) },
      { title: 'Returned to you · needs changes', rows: box.returnedRows },
    ].filter(group => group.rows.length > 0)
    let room = Math.max(2, Math.floor(((e.viewport?.rows ?? 30) - 6 - groups.length * 2) / 2))
    const first = groups[0]?.rows[0]?.id
    const mine = waiting.filter(row => (row.to_user === null || row.to_user === box.user) && (row.readiness ?? 'ready') === 'ready')
    const here = mine.filter(isHere)
    const takeable = here.length > 1 ? here : mine
    const chosen = picked.filter(id => waiting.some(row => row.id === id))
    const justClosed = await read($, lastClosed)
    const isShowingHidden = await read($, showHidden)
    const isShowingElsewhere = await read($, showElsewhere)
    const toggle = (id: number) => void update($, selected, ids => (ids.includes(id) ? ids.filter(one => one !== id) : [...ids, id]))

    const progress = (row: Row) => {
      if ((row.items_total ?? 0) === 0) {
        return ''
      }

      const all = `${row.items_done ?? 0}/${row.items_total} done`
      const share = row.items_here_total ?? 0

      return share > 0 && share < (row.items_total ?? 0) ? `${row.items_here_done ?? 0}/${share} here · ${all}` : all
    }

    const isUnread = (row: Row) => row.read === false && !isTeammates(row)
    const title = (row: Row, when: string) => clip(printable(row.title), Math.max(12, (e.props.bodyColumns || 80) - 14 - when.length))
    const details = (row: Row) =>
      [
        row.from_user,
        isHere(row) && (row.projects ?? []).length < 2 ? '' : (row.projects ?? [row.project]).join(', '),
        progress(row),
        describeReadiness(row.readiness, row.readiness_note),
        row.replies > 0 ? `${row.replies} ${row.replies === 1 ? 'reply' : 'replies'}` : '',
        row.status !== 'taken' || isThisSession(row) ? '' : `taken by ${isMine(row) ? 'you' : row.assignee}${place(row)}`,
      ]
        .filter(part => part !== '')
        .join(' · ')

    return (
      <Box flexDirection="column" paddingX={1}>
        {box.isOffline && (
          <Box gap={1}>
            <Text color="error">
              {describeOffline(box).replace('offline', 'Offline')}: the server does not answer. This is the last known state.
            </Text>
            <Button key="retry" label="Retry" variant="primary" onPress={() => void pressRetry($)} />
          </Box>
        )}
        <Box gap={1}>
          <Text bold>{plural(box.waiting, 'report')} waiting</Text>
          {box.unread > 0 && (
            <Text color="success" bold>
              · {box.unread} unread
            </Text>
          )}
          <Text dimColor>
            · {heldHere(box)} in progress{box.overdue > 0 ? ` · ${box.overdue} overdue` : ''}
          </Text>
        </Box>
        {justClosed !== null && (
          <Box gap={1}>
            <Text color="warning">You closed #{justClosed} for everyone.</Text>
            <Button key="undo-close" label="Undo" variant="primary" onPress={() => void pressUndo($, justClosed)} />
            <Button key="keep-closed" label="Keep closed" dimColor onPress={() => void update($, lastClosed, () => null)} />
          </Box>
        )}
        {box.threads.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="success" bold>
              Replies for you
            </Text>
            {box.threads.map(thread => (
              <Box key={`thread-${thread.id}`} flexDirection="column">
                <Box gap={1}>
                  <Box width={1} flexShrink={0}>
                    <Text color="success">●</Text>
                  </Box>
                  <Box width={3} flexShrink={0} />
                  <Box width={4} flexShrink={0}>
                    <Text bold>#{thread.id}</Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Button key={`read-thread-${thread.id}`} plain onPress={() => void readReport($, thread.id)}>
                      <Text bold>{title(thread, thread.last_reply_at === undefined ? '' : describeWhen(thread.last_reply_at, now))}</Text>
                    </Button>
                  </Box>
                  {thread.last_reply_at !== undefined && (
                    <Box flexShrink={0}>
                      <Text>{describeWhen(thread.last_reply_at, now)}</Text>
                    </Box>
                  )}
                </Box>
                <Box gap={1}>
                  <Box width={10} flexShrink={0} />
                  <Box flexGrow={1} flexShrink={1}>
                    <Text dimColor wrap="truncate-end">
                      {printable(`${thread.unread === 1 ? '1 new reply' : `${thread.unread} new replies`} · ${thread.last_reply_by}: ${thread.last_reply_excerpt}`)}
                    </Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Button
                      key={`take-thread-${thread.id}`}
                      label="Take"
                      variant="primary"
                      onPress={() => void draftSkill($, 'take', thread.id)}
                    />
                  </Box>
                </Box>
              </Box>
            ))}
          </Box>
        )}
        {groups.length === 0 && box.threads.length === 0 && (
          <Text dimColor>Nothing waiting. New reports appear here as they arrive.</Text>
        )}
        {(chosen.length > 0 || takeable.length > 1) && (
          <Box gap={1}>
            {chosen.length > 0 && (
              <Button
                key="take-selected"
                label={`Take ${chosen.length} selected`}
                variant="primary"
                onPress={() => void draftSkill($, 'take', chosen)}
              />
            )}
            {chosen.length > 0 && <Button key="clear-selected" label="Clear" dimColor onPress={() => void update($, selected, () => [])} />}
            {chosen.length === 0 && (
              <Button
                key="take-all"
                label={`Take all ${takeable.length}${here.length > 1 ? ' here' : ''}`}
                dimColor
                onPress={() => void draftSkill($, 'take', takeable.map(row => row.id))}
              />
            )}
          </Box>
        )}
        {groups.map(group => {
          const rows = group.rows.slice(0, Math.max(0, room))
          room -= rows.length

          return (
            <Box key={group.title} flexDirection="column" marginTop={1}>
              <Text color="suggestion" bold>
                {printable(group.title)}
              </Text>
              {rows.map(row => {
                const isFresh = isUnread(row)

                return (
                  <Box key={`row-${row.id}`} flexDirection="column">
                    <Box gap={1}>
                      <Box width={1} flexShrink={0}>
                        <Text color="success">{isFresh ? '●' : ' '}</Text>
                      </Box>
                      <Box width={3} flexShrink={0}>
                        {row.status === 'sent' && (
                          <Button
                            key={`pick-${row.id}`}
                            label={chosen.includes(row.id) ? '[x]' : '[ ]'}
                            plain
                            dimColor={!chosen.includes(row.id)}
                            onPress={() => toggle(row.id)}
                          />
                        )}
                      </Box>
                      <Box width={4} flexShrink={0}>
                        <Text bold={isFresh} dimColor={!isFresh}>
                          #{row.id}
                        </Text>
                      </Box>
                      <Box flexGrow={1} flexShrink={1}>
                        <Button
                          key={`read-${row.id}`}
                          plain
                          autoFocus={row.id === first ? true : undefined}
                          onPress={() => void readReport($, row.id)}
                        >
                          <Text bold={isFresh} dimColor={!isFresh}>
                            {title(row, describeWhen(row.created_at, now))}
                          </Text>
                        </Button>
                      </Box>
                      <Box flexShrink={0}>
                        <Text dimColor={!isFresh}>{describeWhen(row.created_at, now)}</Text>
                      </Box>
                    </Box>
                    <Box gap={1}>
                      <Box width={10} flexShrink={0} />
                      {row.priority !== 'normal' && (
                        <Box flexShrink={0}>
                          <Text color={PRIORITY_COLOR[row.priority]} bold={row.priority === 'urgent'}>
                            {row.priority}
                          </Text>
                        </Box>
                      )}
                      {row.due !== null && (
                        <Box flexShrink={0}>
                          <Text color={row.overdue ? 'error' : undefined} dimColor={!row.overdue}>
                            {describeDue(row.due, now)}
                          </Text>
                        </Box>
                      )}
                      <Box flexGrow={1} flexShrink={1}>
                        <Text dimColor wrap="truncate-end">
                          {printable(details(row))}
                        </Text>
                      </Box>
                      <Box gap={1} flexShrink={0}>
                        {action(row, row.id === first)}
                        {isMine(row) && box.session !== '' && (
                          <Button
                            key={`here-${row.id}`}
                            label={isThisSession(row) ? 'release' : 'here'}
                            plain
                            dimColor
                            onPress={() => void pressHere($, row.id, !isThisSession(row))}
                          />
                        )}
                        {closer(row, true)}
                        {(row.status === 'sent' || (row.status === 'taken' && !isThisSession(row))) && (
                          <Button key={`hide-${row.id}`} label="hide" plain dimColor onPress={() => void pressHide($, row.id, true)} />
                        )}
                      </Box>
                    </Box>
                  </Box>
                )
              })}
              {group.rows.length > rows.length && (
                <Text dimColor>
                  {'           '}… {group.rows.length - rows.length} more — /handoff:inbox lists everything
                </Text>
              )}
            </Box>
          )
        })}
        {away.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Box gap={1}>
              <Text dimColor>{away.length} in your other sessions</Text>
              <Button
                key="toggle-elsewhere"
                label={isShowingElsewhere ? 'Collapse' : 'Show'}
                dimColor
                onPress={() => void update($, showElsewhere, isOn => !isOn)}
              />
            </Box>
            {isShowingElsewhere &&
              away.map(row => (
                <Box key={`away-${row.id}`} gap={1}>
                  <Box width={5} flexShrink={0}>
                    <Text dimColor>#{row.id}</Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Button key={`read-${row.id}`} plain onPress={() => void readReport($, row.id)}>
                      <Text dimColor>
                        {clip(printable(row.title), Math.max(12, (e.props.bodyColumns || 80) - 16 - (row.session?.label.length ?? 0)))}
                      </Text>
                    </Button>
                  </Box>
                  <Box gap={1} flexShrink={0}>
                    <Text dimColor>{printable(row.session?.label ?? '')}</Text>
                    <Button key={`here-${row.id}`} label="here" plain dimColor onPress={() => void pressHere($, row.id, true)} />
                  </Box>
                </Box>
              ))}
          </Box>
        )}
        {box.hiddenRows.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Box gap={1}>
              <Text dimColor>{box.hiddenRows.length} hidden from your list</Text>
              <Button
                key="toggle-hidden"
                label={isShowingHidden ? 'Collapse' : 'Show'}
                dimColor
                onPress={() => void update($, showHidden, isOn => !isOn)}
              />
            </Box>
            {isShowingHidden &&
              box.hiddenRows.map(row => (
                <Box key={`hidden-${row.id}`} gap={1}>
                  <Box width={5} flexShrink={0}>
                    <Text dimColor>#{row.id}</Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Button key={`read-${row.id}`} plain onPress={() => void readReport($, row.id)}>
                      <Text dimColor>{clip(printable(row.title), Math.max(12, (e.props.bodyColumns || 80) - 28))}</Text>
                    </Button>
                  </Box>
                  <Box gap={1} flexShrink={0}>
                    <Text dimColor>{describeWhen(row.created_at, now)}</Text>
                    <Button key={`unhide-${row.id}`} label="unhide" plain dimColor onPress={() => void pressHide($, row.id, false)} />
                  </Box>
                </Box>
              ))}
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>● not read yet · a title opens the report here · [ ] selects several to take together</Text>
        </Box>
        <Box>
          <Text dimColor>Take on a reply hands the whole thread to Claude to answer or act on</Text>
        </Box>
        <Box>
          <Text dimColor>hide removes a report from your own list only · close ends it for everyone (press twice)</Text>
        </Box>
        {box.takenByMe > 0 && box.session !== '' && (
          <Box>
            <Text dimColor>here keeps a report you hold in this session: your other sessions tuck it away · release undoes it</Text>
          </Box>
        )}
      </Box>
    )
  })
}
