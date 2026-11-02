import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Badge, Detail, HandoffEvent, Inbox, Manage, Readiness, Row, Thread, View, Workspaces } from '../types'
import { BUNDLED_INSTRUCTIONS, BUNDLED_TOOLS } from './tools'

const PANE = 'handoffs'
const WORKSPACES_COMMAND = 'handoff-workspaces'
const DEFAULT_ID = 'default'
const TOOL_PREFIX = 'mcp__handoff__'
const READ_ONLY = new Set(['inbox', 'board', 'get'])
const IDLE_ORIGINS = new Set(['composer', 'bridge', 'sdk'])
const BADGE_MS = 180000
const SERVER_TIMEOUT_MS = 5000
const CALL_TIMEOUT_MS = 60000
const MAX_LOOPS = 200
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
const latest = atom({ plugin: 'handoff', key: 'latest' } as const, null)
const view = atom({ plugin: 'handoff', key: 'view' } as const, LIST)
const confirming = atom({ plugin: 'handoff', key: 'confirming' } as const, null)
const selected = atom({ plugin: 'handoff', key: 'selected' } as const, [])
const showHidden = atom({ plugin: 'handoff', key: 'showHidden' } as const, false)
const showElsewhere = atom({ plugin: 'handoff', key: 'showElsewhere' } as const, false)
const newer = atom({ plugin: 'handoff', key: 'newer' } as const, null)
const lastClosed = atom({ plugin: 'handoff', key: 'lastClosed' } as const, null)
const NO_WORKSPACES: Workspaces = { active: '', claudeOn: '', places: [], badges: {} }
const spaces = atom({ plugin: 'handoff', key: 'workspaces' } as const, NO_WORKSPACES)
const CLOSED_FORM: Manage = { isOpen: false, problem: '', isSaving: false }
const manage = atom({ plugin: 'handoff', key: 'manage' } as const, CLOSED_FORM)

export type Workspace = { id: string; name: string; url: string; token: string }
type Target = { id: string; base: string; headers: Record<string, string> }
type ToolDef = { name: string; description?: string; inputSchema?: Record<string, unknown> }
type Answer = Awaited<ReturnType<EngineInterface['http']['fetch']>>

export const hostOf = (url: string): string => url.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '')

export const nameOf = (url: string): string => {
  const host = hostOf(url)
  const bare = host.replace(/:\d+$/, '')

  if (bare === 'localhost' || /^[\d.]+$/.test(bare) || !bare.includes('.')) {
    return host
  }

  const labels = bare.split('.')

  return labels[labels.length - 2] ?? bare
}

export const switchNote = (to: string, from: string): string =>
  `Handoff workspace is now ${to}: the mcp__handoff__* tools act on ${to}'s server from this message on. ` +
  `Report numbers mentioned earlier in this conversation refer to ${from}; the same number on ${to} is a different report.`

export const argsOf = (raw: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter(key => key in raw && raw[key] !== undefined).map(key => [key, raw[key]]))

export const rpcBody = (text: string): { result?: Record<string, unknown>; error?: { message?: string } } | undefined => {
  const data = text.trimStart().startsWith('{')
    ? text
    : text
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6))
        .pop()

  try {
    return data === undefined ? undefined : JSON.parse(data)
  } catch {
    return undefined
  }
}

export const textOf = (result: Record<string, unknown> | undefined): string =>
  ((result?.content ?? []) as { type?: string; text?: string }[])
    .map(block => block.text ?? '')
    .join('\n')

export const askText = (name: string, args: Record<string, unknown>, workspace: string | undefined): string => {
  const ids = [args.report_id, ...(Array.isArray(args.report_ids) ? args.report_ids : [])].filter(id => id !== undefined && id !== null)
  const what = ids.length > 0 ? ` #${ids.join(', #')}` : ''

  return `Allow handoff ${name}${what}${workspace ? ` on ${workspace}` : ''}?`
}

export const transportProblem = (url: string): string | undefined => {
  const host = hostOf(url).replace(/:\d+$/, '')

  return url.startsWith('https://') || ['localhost', '127.0.0.1', '[::1]'].includes(host)
    ? undefined
    : 'use an https:// URL: the token would travel in clear text'
}

export const isWorkspace = (value: unknown): value is Workspace => {
  const entry = value as Partial<Workspace> | null

  return (
    typeof entry?.id === 'string' &&
    entry.id !== DEFAULT_ID &&
    typeof entry.name === 'string' &&
    entry.name.trim() !== '' &&
    typeof entry.url === 'string' &&
    typeof entry.token === 'string' &&
    configProblem(entry.url, entry.token) === undefined &&
    transportProblem(entry.url) === undefined
  )
}

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

export const describeContext = (box: Inbox, workspace?: string): string => {
  const mine = (row: Row) => (row.projects ?? [row.project]).some(name => box.projects.includes(name))
  const brief = (row: Row) => `#${row.id} "${row.title}" (${(row.projects ?? [row.project]).join(', ')})`
  const waiting = box.rows.filter(row => row.status === 'sent')
  const held = box.rows.filter(row => row.status === 'taken' && row.assignee === box.user)
  const away = held.filter(row => isElsewhere(box, row))
  const lines = [
    'Handoff context from the plugin, current as of this prompt (use it instead of looking these up):',
    ...(workspace === undefined ? [] : [`- handoff workspace: ${workspace} (the mcp__handoff__* tools act on it)`]),
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

let api: Target | undefined
let refreshNow: (() => Promise<void>) | undefined
let preferences = { hasToasts: true, hasBand: true }
let fallback: Workspace = { id: DEFAULT_ID, name: '', url: '', token: '' }
let extras: Workspace[] = []
let activeId = DEFAULT_ID
let pendingMain: string | undefined
let schemas = new Map<string, string[]>()
let registered = ''
let draft = { name: '', url: '', token: '' }
let badgeTimer: { cancel: () => void } | undefined
const binding = new Map<string, string>()
const instructions = new Map<string, string>()

const sessionOf = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
const isKnown = (id: string | undefined): id is string => id === DEFAULT_ID || extras.some(space => space.id === id)
const workspaceOf = (id: string | undefined): Workspace => (id === DEFAULT_ID ? fallback : extras.find(space => space.id === id)) ?? fallback
const targetOf = (space: Workspace): Target => ({ id: space.id, base: space.url, headers: { Authorization: `Bearer ${space.token}` } })
const boundTo = (loop: string | undefined) => binding.get(loop ?? 'main') ?? binding.get('main') ?? activeId

const fetchWithin = async ($: EngineInterface, url: string, init: Parameters<EngineInterface['http']['fetch']>[1], ms: number) =>
  new Promise<Answer | undefined>(resolve => {
    const limit = $.clock.after(ms, () => resolve(undefined))
    void $.http
      .fetch(url, init)
      .catch(() => undefined)
      .then(got => {
        limit.cancel()
        resolve(got)
      })
  })

const rpc = async ($: EngineInterface, target: Target, method: string, params: unknown, ms: number) => {
  const answer = await fetchWithin(
    $,
    `${target.base}/mcp/`,
    {
      method: 'POST',
      headers: { ...target.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    },
    ms,
  )

  if (answer === undefined) {
    return { error: 'the handoff server did not answer in time' }
  }

  if (answer.status === 401) {
    return { error: 'the handoff server rejected the token' }
  }

  const body = rpcBody(answer.text)

  if (body?.error !== undefined) {
    return { error: body.error.message ?? 'the handoff server refused the call' }
  }

  return body?.result === undefined ? { error: `the handoff server answered ${answer.status}` } : { result: body.result }
}

const showPlaces = async ($: EngineInterface) => {
  await update($, spaces, shown => ({
    ...shown,
    active: activeId,
    claudeOn: binding.get('main') ?? activeId,
    places: [fallback, ...extras].map(space => ({ id: space.id, name: space.name, host: hostOf(space.url), isDefault: space.id === DEFAULT_ID })),
  }))
}

const loadExtras = async ($: EngineInterface) => {
  const stored = await $.store.get('workspaces').catch(() => undefined)
  extras = Array.isArray(stored) ? stored.filter(isWorkspace).slice(0, 20) : []
}

const restoreActive = async ($: EngineInterface) => {
  const fromState = (await read($, spaces)).active
  const fromStore = String((await $.store.get('active').catch(() => '')) ?? '')
  activeId = [fromState, activeId, fromStore].find(isKnown) ?? DEFAULT_ID
  await showPlaces($)
}

const registerTools = async ($: EngineInterface, tools: ToolDef[]) => {
  registered = JSON.stringify(tools)
  schemas = new Map(tools.map(tool => [tool.name, Object.keys((tool.inputSchema?.properties as object | undefined) ?? {})]))

  for (const tool of tools) {
    await $.tool
      .register({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? { type: 'object' } })
      .catch(() => undefined)
  }
}

const refreshServer = async ($: EngineInterface, space: Workspace) => {
  if (configProblem(space.url, space.token) !== undefined) {
    return
  }

  const target = targetOf(space)
  const hello = await rpc($, target, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'handoff', version: '0.6.3' } }, SERVER_TIMEOUT_MS)
  const text = String(hello.result?.instructions ?? '')

  if (text !== '' && instructions.get(space.id) !== text) {
    instructions.set(space.id, text)
    await $.store.set('instructions', Object.fromEntries(instructions)).catch(() => undefined)
  }

  const listed = await rpc($, target, 'tools/list', {}, SERVER_TIMEOUT_MS)
  const tools = (listed.result?.tools ?? []) as ToolDef[]

  if (!Array.isArray(tools) || tools.length === 0) {
    return
  }

  if (JSON.stringify(tools) !== registered) {
    await $.store.set('tools', tools).catch(() => undefined)
    await registerTools($, tools)
  }
}

const pollBadges = async ($: EngineInterface) => {
  const others = [fallback, ...extras].filter(space => space.id !== activeId && configProblem(space.url, space.token) === undefined)

  if (others.length === 0) {
    return
  }

  const found = await Promise.all(
    others.map(async (space): Promise<[string, Badge]> => {
      const answer = await fetchWithin($, `${space.url}/api/v1/inbox`, { headers: targetOf(space).headers }, SERVER_TIMEOUT_MS * 2)

      if (answer === undefined || answer.status >= 500) {
        return [space.id, { waiting: 0, unread: 0, problem: 'offline' }]
      }

      if (answer.status === 401) {
        return [space.id, { waiting: 0, unread: 0, problem: 'token rejected' }]
      }

      try {
        const body = JSON.parse(answer.text) as { waiting?: number; unread_replies?: number }

        return [space.id, { waiting: body.waiting ?? 0, unread: body.unread_replies ?? 0, problem: '' }]
      } catch {
        return [space.id, { waiting: 0, unread: 0, problem: 'offline' }]
      }
    }),
  )
  await update($, spaces, shown => ({ ...shown, badges: Object.fromEntries(found) }))
}

const switchTo = async ($: EngineInterface, id: string) => {
  if (id === activeId || !isKnown(id)) {
    return
  }

  activeId = id
  const space = workspaceOf(id)
  await $.store.set('active', id).catch(() => undefined)
  await update($, view, () => LIST)
  await update($, confirming, () => null)
  await update($, selected, () => [])
  await update($, latest, () => null)
  await update($, lastClosed, () => null)
  const session = (await read($, inbox)).session
  await update($, inbox, () => ({ ...EMPTY, session }))
  await showPlaces($)
  connection?.stop()
  connection = connect($, currentSetup(), await $.session.cwd().catch(() => ''), session)
  void refreshServer($, space).catch(() => undefined)
  void pollBadges($).catch(() => undefined)
  $.ui.toast(`Handoff: now on ${space.name}`, { timeoutMs: 5000 })
}

const openPane = async ($: EngineInterface) => {
  await update($, view, () => LIST)
  await loadExtras($)
  await showPlaces($)
  void pollBadges($).catch(() => undefined)
  await $.ui.open({ id: PANE, title: 'Handoffs', focus: true, closeOnEscape: true })
}

const openManager = async ($: EngineInterface) => {
  await update($, manage, () => ({ ...CLOSED_FORM, isOpen: true }))
  await openPane($)
}

const pressSave = async ($: EngineInterface) => {
  const name = draft.name.trim().slice(0, 40)
  const url = draft.url.trim().replace(/\/+$/, '')
  const token = draft.token.trim()
  const taken = [fallback, ...extras].some(space => space.name.toLowerCase() === name.toLowerCase())
  const early =
    name === '' ? 'Give the workspace a name.' : taken ? `A workspace named ${name} already exists.` : (configProblem(url, token) ?? transportProblem(url))

  if (early !== undefined) {
    await update($, manage, shown => ({ ...shown, problem: early.replace(/^the /, 'The ') }))

    return
  }

  await update($, manage, shown => ({ ...shown, problem: '', isSaving: true }))
  const answer = await fetchWithin($, `${url}/api/v1/inbox`, { headers: { Authorization: `Bearer ${token}` } }, SERVER_TIMEOUT_MS * 2)
  const problem =
    answer === undefined ? 'The server did not answer.' : answer.status === 401 ? 'The server rejected the token.' : answer.ok ? '' : `The server answered ${answer.status}.`

  if (problem !== '') {
    await update($, manage, shown => ({ ...shown, problem, isSaving: false }))

    return
  }

  await loadExtras($)
  const space: Workspace = { id: `ws-${Date.now().toString(36)}`, name, url, token }
  extras = [...extras, space]
  await $.store.set('workspaces', extras).catch(() => undefined)
  draft = { name: '', url: '', token: '' }
  await update($, manage, () => ({ ...CLOSED_FORM, isOpen: true }))
  await showPlaces($)
  void refreshServer($, space).catch(() => undefined)
  void pollBadges($).catch(() => undefined)
  $.ui.toast(`Handoff: added ${name}. Press w in the pane to switch.`, { timeoutMs: 6000 })
}

const pressRemove = async ($: EngineInterface, id: string) => {
  if (id === DEFAULT_ID) {
    return
  }

  if (id === activeId) {
    await switchTo($, DEFAULT_ID)
  }

  await loadExtras($)
  extras = extras.filter(space => space.id !== id)
  await $.store.set('workspaces', extras).catch(() => undefined)
  instructions.delete(id)
  await $.store.set('instructions', Object.fromEntries(instructions)).catch(() => undefined)
  await update($, spaces, shown => ({ ...shown, badges: Object.fromEntries(Object.entries(shown.badges).filter(([key]) => key !== id)) }))
  await showPlaces($)
}

const readReport = async ($: EngineInterface, id: number) => {
  const target = api
  const box = await read($, inbox)
  const fresh = box.threads.find(thread => thread.id === id)?.unread ?? 0
  const isUnread = [...box.rows, ...box.returnedRows, ...box.hiddenRows].some(row => row.id === id && row.read === false)
  await update($, view, () => ({ id, detail: null, problem: '', fresh }))
  const answer =
    target &&
    (await $.http.fetch(`${target.base}/api/v1/reports/${id}?mark_seen=true`, { headers: target.headers }).catch(() => undefined))

  if (api !== target) {
    return
  }

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
  const target = api

  if ((await read($, confirming)) !== id) {
    await update($, confirming, () => id)
    $.clock.after(5000, () => void update($, confirming, armed => (armed === id ? null : armed)))

    return
  }

  await update($, confirming, () => null)
  const answer = await post($, target, `${id}/close`)

  if (answer?.ok !== true) {
    const reason = answer?.status === 409 ? 'it is already closed' : answer?.status === 404 ? 'it no longer exists' : 'the server did not answer'
    $.ui.toast(`Could not close #${id}: ${reason}`, { timeoutMs: 6000 })
  } else {
    $.ui.toast(`Closed #${id} for everyone. Undo is in the handoff pane.`, { timeoutMs: 6000 })

    if (api === target) {
      await update($, lastClosed, () => id)
      await update($, view, shown => (shown.id === id ? LIST : shown))
    }
  }

  await refreshNow?.()
}

const post = async ($: EngineInterface, target: Target | undefined, path: string, method = 'POST', body = '{}') =>
  target &&
  (await $.http
    .fetch(`${target.base}/api/v1/reports/${path}`, {
      method,
      headers: { ...target.headers, 'content-type': 'application/json' },
      body: method === 'DELETE' ? undefined : body,
    })
    .catch(() => undefined))

const placeHere = async ($: EngineInterface, target: Target | undefined, id: number | string) => {
  const box = await read($, inbox)

  return box.session === ''
    ? undefined
    : post($, target, `${id}/session`, 'PUT', JSON.stringify({ session: box.session, label: (box.project || 'session').slice(0, 80) }))
}

const pressHere = async ($: EngineInterface, id: number, isHere: boolean) => {
  const target = api
  const answer = isHere ? await placeHere($, target, id) : await post($, target, `${id}/session`, 'DELETE')

  if (answer?.ok !== true) {
    $.ui.toast(`Could not ${isHere ? 'put' : 'release'} #${id} ${isHere ? 'in' : 'from'} this session: the server refused`, { timeoutMs: 6000 })
  }

  await refreshNow?.()
}

const pressUndo = async ($: EngineInterface, id: number) => {
  const answer = await post($, api, `${id}/reopen`)

  if (answer?.ok === true) {
    $.ui.toast(`Reopened #${id}`)
  } else {
    $.ui.toast(`Could not reopen #${id}. Try /handoff:reopen ${id}`, { timeoutMs: 6000 })
  }

  await update($, lastClosed, () => null)
  await refreshNow?.()
}

const pressHide = async ($: EngineInterface, id: number, isHidden: boolean) => {
  const answer = await post($, api, `${id}/hide`, isHidden ? 'POST' : 'DELETE')

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
  const target = api
  const answer = await post($, target, `${id}/items/check`, 'POST', JSON.stringify({ item_ids: [item], done: isDone }))

  if (answer?.ok === true) {
    const fresh = JSON.parse(answer.text) as Detail

    if (api === target) {
      await update($, view, shown => (shown.id === id ? { ...shown, detail: fresh } : shown))
      void refreshNow?.()
    }
  } else {
    const reason = answer?.status === 403 ? 'only the receiving team ticks items' : 'the server refused'
    $.ui.toast(`Could not update item ${item} of #${id}: ${reason}`, { timeoutMs: 6000 })
  }
}

type Setup = { id: string; base: string; token: string; hasToasts: boolean; hasBand: boolean }

const currentSetup = (): Setup => {
  const space = workspaceOf(activeId)

  return { id: space.id, base: space.url, token: space.token, ...preferences }
}

let connection: { session: string; stop: () => void } | undefined

const connect = ($: EngineInterface, setup: Setup, startedIn: string, session: string) => {
  const { id, base, token, hasToasts, hasBand } = setup
  const headers = { Authorization: `Bearer ${token}` }
  api = { id, base, headers }
  void update($, inbox, box => ({ ...box, session })).catch(() => undefined)
  let project = ''
  let projects: string[] = []
  let locatedIn = ''
  let isRejected = false
  let isStale = false
  let isStopped = false
  let running: Promise<void> | undefined
  let retry: { cancel: () => void } | undefined
  let retryIn = RETRY_FIRST_MS
  let curl: ReturnType<EngineInterface['process']['spawn']> | undefined

  const locate = async () => {
    const cwd = await $.session.cwd().catch(() => startedIn)

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

    if (isStopped) {
      return
    }

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
    $.ui.status(!hasBand && summary !== undefined ? `${summary} · /handoffs` : undefined)
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
    if (isStopped) {
      return
    }

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
    const stream = $.process.spawn({
      argv: ['curl', '-sN', '--fail', '--connect-timeout', '10', '--speed-limit', '1', '--speed-time', '60', '-K', '-'],
      input: `url = "${base}/api/v1/events${session === '' ? '' : `?session=${session}`}"\nheader = "Authorization: Bearer ${token}"\n`,
    })
    curl = stream
    let rest = ''

    for await (const piece of stream) {
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

    while (!isRejected && !isStopped) {
      const connectedAt = await $.clock.now()
      await listen().catch(() => undefined)
      const lived = (await $.clock.now()) - connectedAt
      wait = lived > 30000 ? 2000 : Math.min(wait * 2, 60000)
      await $.clock.sleep(wait)

      if (isStopped) {
        return
      }

      await refresh()
    }
  }

  refreshNow = refresh
  void follow().catch(() => undefined)
  const tick = $.clock.every(SAFETY_REFRESH_MS, () => {
    void refresh()
    void findUpdate($).catch(() => undefined)
  })

  const stop = () => {
    isStopped = true
    tick.cancel()
    retry?.cancel()
    void curl?.return({ code: null, signal: null }).catch(() => undefined)
  }

  return { session, stop }
}

export const register: Register = (on, options) => {
  preferences = { hasToasts: options.notifications !== false, hasBand: options.band !== false }
  fallback = { id: DEFAULT_ID, name: nameOf(String(options.url ?? '')), url: String(options.url ?? ''), token: String(options.token ?? '') }

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.command.register({ name: PANE, description: 'Show my team handoff inbox in a pane (no model call)' })
    await $.command.register({ name: WORKSPACES_COMMAND, description: 'Add, switch or remove handoff workspaces (no model call)' })
    await loadExtras($)
    await restoreActive($)
    const saved = await $.store.get('instructions').catch(() => undefined)

    for (const [id, text] of Object.entries((saved ?? {}) as Record<string, unknown>)) {
      if (typeof text === 'string' && !instructions.has(id)) {
        instructions.set(id, text)
      }
    }

    const cached = await $.store.get('tools').catch(() => undefined)
    await registerTools($, Array.isArray(cached) && cached.length > 0 ? (cached as ToolDef[]) : BUNDLED_TOOLS)
    void refreshServer($, workspaceOf(activeId)).catch(() => undefined)

    if (!e.isInteractive) {
      return started
    }

    const problem = configProblem(workspaceOf(activeId).url, workspaceOf(activeId).token)

    if (problem !== undefined) {
      $.ui.toast(`Handoff is not connected: ${problem}. Fix it in /plugin.`, { timeoutMs: 10000 })

      return started
    }

    connection?.stop()
    connection = connect($, currentSetup(), e.cwd, sessionOf(await $.session.id().catch(() => '')))
    void findUpdate($).catch(() => undefined)
    badgeTimer?.cancel()
    badgeTimer = $.clock.every(BADGE_MS, () => void pollBadges($).catch(() => undefined))
    void pollBadges($).catch(() => undefined)

    return started
  })

  on('classic.SessionStart', async ($, e, next) => {
    const session = sessionOf(e.session_id)

    if (connection !== undefined && session !== '' && session !== connection.session) {
      connection.stop()
      binding.delete('main')
      pendingMain = undefined
      await showPlaces($)
      connection = connect($, currentSetup(), e.cwd, session)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    connection?.stop()

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const was = binding.get('main')
      binding.set('main', pendingMain ?? was ?? activeId)
      pendingMain = undefined

      if (binding.get('main') !== was) {
        await showPlaces($)
      }
    } else if (!binding.has(e.agentId)) {
      if (binding.size >= MAX_LOOPS) {
        const oldest = [...binding.keys()].find(key => key !== 'main')

        if (oldest !== undefined) {
          binding.delete(oldest)
        }
      }

      binding.set(e.agentId, binding.get('main') ?? activeId)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^mcp__handoff__/ }, async ($, e) => {
    const name = e.tool.slice(TOOL_PREFIX.length)
    const space = workspaceOf(boundTo(e.agentId))
    const target = targetOf(space)
    const args = argsOf(e as unknown as Record<string, unknown>, schemas.get(name) ?? [])

    if (!READ_ONLY.has(name)) {
      const verdict = await $.tool.check({ tool: e.tool, input: args } as never).catch(() => ({ decision: 'deny' as const, reason: undefined }))

      if (verdict.decision === 'deny') {
        return { deny: verdict.reason ?? `Your permission rules deny handoff ${name}.` }
      }

      if (verdict.decision !== 'allow') {
        const answer = await $.ui
          .ask(askText(name, args, extras.length > 0 ? space.name : undefined), ['Allow once', 'Deny'])
          .catch(() => 'Deny')

        if (answer !== 'Allow once') {
          return { deny: `The person did not allow handoff ${name}. Ask them what to do instead.` }
        }
      }
    }

    const called = await rpc($, target, 'tools/call', { name, arguments: args }, CALL_TIMEOUT_MS)

    if (called.error !== undefined) {
      return { deny: `Handoff ${name} failed: ${called.error}.` }
    }

    const text = textOf(called.result)

    if (called.result?.isError === true) {
      return { deny: text || `Handoff ${name} failed.` }
    }

    const taken = name === 'take' ? /"id":\s*(\d+)/.exec(text)?.[1] : undefined

    if (taken !== undefined) {
      void placeHere($, target, taken).catch(() => undefined)
    }

    return { result: text }
  }).catch(() => ({ deny: 'The handoff plugin could not run this tool.' }))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const space = workspaceOf(binding.get('main') ?? activeId)
    const text = instructions.get(space.id) ?? BUNDLED_INSTRUCTIONS
    const where = extras.length > 0 ? `Handoff workspace of the main conversation: ${space.name}. ` : ''

    return {
      sections: [
        ...composed.sections,
        { id: 'handoff:instructions', text: `${where}How to treat the mcp__handoff__* tools and what they return:\n${text}`, scope: 'session' as const },
      ],
    }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const context = [...(e.context ?? [])]
    const isIdle = IDLE_ORIGINS.has(e.origin?.kind ?? '') && e.turnId === undefined
    const was = binding.get('main')

    if (isIdle) {
      pendingMain = activeId

      if (was !== undefined && was !== activeId) {
        context.push(switchNote(workspaceOf(activeId).name, workspaceOf(was).name))
      }
    }

    const box = await read($, inbox)
    const isSame = (isIdle ? activeId : (was ?? activeId)) === activeId

    if (e.text.trimStart().startsWith('/handoff:') && box.isLoaded && isSame) {
      context.push(describeContext(box, extras.length > 0 ? workspaceOf(activeId).name : undefined))
    }

    return context.length === (e.context ?? []).length ? next(e) : next({ ...e, context })
  }).catch(($, e, next) => next(e))

  on('command.run', { command: WORKSPACES_COMMAND }, async $ => {
    await openManager($)

    return { text: 'Handoff workspaces opened.' }
  })

  on('command.run', { command: PANE }, async $ => {
    await openPane($)

    return { text: 'Handoff inbox opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const box = await read($, inbox)
    const event = await read($, latest)
    const summary = summarize(box)
    const published = await read($, newer)
    const where = await read($, spaces)
    const isSeveral = where.places.length > 1
    const activeName = where.places.find(place => place.id === where.active)?.name ?? ''
    const claudeName = where.places.find(place => place.id === where.claudeOn)?.name ?? ''
    const isBehind = isSeveral && where.claudeOn !== '' && where.claudeOn !== where.active

    if (options.band === false || e.props.hasSurvey || (summary === undefined && event === null && published === null && !isBehind)) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const beneath = await next(e)
    const open = () => void openPane($)
    const label = isSeveral ? `Handoff · ${printable(activeName)}` : 'Handoff'
    const behind = isBehind ? (
      <Box key="band-behind" flexShrink={1}>
        <Text color="warning" wrap="truncate-end">
          · Claude on {printable(claudeName)} until your next message
        </Text>
      </Box>
    ) : undefined

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
            <Box key="band-label" flexShrink={0}>
              <Text color="warning" bold>
                {label}
              </Text>
            </Box>
            {box.waitingForProject > 0 && <Text bold>{box.waitingForProject} here</Text>}
            {rest.length > 0 && (
              <Text dimColor wrap="truncate-end">
                {(box.waitingForProject > 0 ? '· ' : '') + rest.join(' · ')}
              </Text>
            )}
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
            {behind}
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
          {isSeveral && (
            <Box key="band-label" flexShrink={0}>
              <Text dimColor>{printable(activeName)}</Text>
            </Box>
          )}
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
    const elements = $.ui.resolve(e)
    const { Box, Button, Markdown, Text } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const box = await read($, inbox)
    const shown = await read($, view)
    const where = await read($, spaces)
    const managing = await read($, manage)
    const now = Date.now()
    const isSeveral = where.places.length > 1
    const order = where.places.map(place => place.id)
    const following = order[(order.indexOf(where.active) + 1) % Math.max(1, order.length)]
    const badgeOf = (id: string): Badge =>
      id === where.active ? { waiting: box.waiting, unread: box.unreadReplies, problem: box.isOffline ? 'offline' : '' } : (where.badges[id] ?? { waiting: 0, unread: 0, problem: '' })
    const switcher = isSeveral ? (
      <Box gap={1} flexShrink={0}>
        {where.places.map(place => {
          const badge = badgeOf(place.id)
          const count = badge.problem !== '' ? badge.problem : String(badge.waiting)

          return (
            <Button
              key={`space-${place.id}`}
              label={`${place.id === where.active ? '[ ' : ''}${place.name} ${count}${badge.unread > 0 ? '●' : ''}${place.id === where.active ? ' ]' : ''}`}
              plain
              dimColor={place.id !== where.active}
              hotkey={place.id === following && place.id !== where.active ? 'w' : undefined}
              onPress={() => void switchTo($, place.id)}
            />
          )
        })}
      </Box>
    ) : undefined

    if (managing.isOpen) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Box gap={1}>
            <Button key="manage-back" label="← Back" hotkey="b" dimColor onPress={() => void update($, manage, () => CLOSED_FORM)} />
            <Text bold>Handoff workspaces</Text>
          </Box>
          <Text dimColor>A workspace is a whole team server. The tools, the pane and the band follow the one you pick.</Text>
          <Box flexDirection="column" marginTop={1}>
            {where.places.map(place => (
              <Box key={`place-${place.id}`} gap={1}>
                <Box width={2} flexShrink={0}>
                  <Text color="success">{place.id === where.active ? '●' : ' '}</Text>
                </Box>
                <Box width={16} flexShrink={0}>
                  <Text bold={place.id === where.active}>{clip(printable(place.name), 16)}</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text dimColor wrap="truncate-end">
                    {printable(place.host)}
                    {place.isDefault ? ' · from /plugin' : ''}
                  </Text>
                </Box>
                {place.id !== where.active && <Button key={`use-${place.id}`} label="Use" onPress={() => void switchTo($, place.id)} />}
                {!place.isDefault && <Button key={`remove-${place.id}`} label="Remove" dimColor onPress={() => void pressRemove($, place.id)} />}
              </Box>
            ))}
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text color="suggestion" bold>
              Add a workspace
            </Text>
            {Input === undefined && <Text dimColor>Add workspaces from the terminal or the desktop app.</Text>}
            {Input !== undefined && (
              <Box flexDirection="column">
                <Input
                  key="ws-name"
                  label="Name "
                  placeholder="GoWay"
                  value={draft.name}
                  onInput={(value: string) => void (draft = { ...draft, name: value })}
                  onSubmit={(value: string) => void (draft = { ...draft, name: value })}
                />
                <Input
                  key="ws-url"
                  label="Server URL "
                  placeholder="https://handoff.example.com"
                  value={draft.url}
                  onInput={(value: string) => void (draft = { ...draft, url: value })}
                  onSubmit={(value: string) => void (draft = { ...draft, url: value })}
                />
                <Input
                  key="ws-token"
                  label="Token "
                  placeholder="ho_…"
                  value={draft.token}
                  submitLabel="save"
                  onInput={(value: string) => void (draft = { ...draft, token: value })}
                  onSubmit={(value: string) => {
                    draft = { ...draft, token: value }
                    void pressSave($)
                  }}
                />
                <Box gap={1}>
                  <Button key="ws-save" label={managing.isSaving ? 'Checking…' : 'Save'} variant="primary" onPress={() => void pressSave($)} />
                  {managing.problem !== '' && <Text color="error">{printable(managing.problem)}</Text>}
                </Box>
                <Text dimColor>The token stays on this machine, in the plugin's own file. It is shown while you type and never sent to Claude.</Text>
              </Box>
            )}
          </Box>
        </Box>
      )
    }

    if (!box.isLoaded) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Box gap={1}>
            <Text bold>Handoffs</Text>
            <Box flexGrow={1} />
            {switcher}
          </Box>
          <Text dimColor>
            {isSeveral
              ? `Not connected to ${printable(where.places.find(place => place.id === where.active)?.name ?? 'this workspace')} yet. Check its server and token in /${WORKSPACES_COMMAND}.`
              : 'Not connected yet. Check the server URL and your token in /plugin.'}
          </Text>
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
          <Box flexGrow={1} />
          {switcher}
        </Box>
        {where.claudeOn !== '' && where.claudeOn !== where.active && isSeveral && (
          <Text color="warning">
            Claude is still on {printable(where.places.find(place => place.id === where.claudeOn)?.name ?? '')} until your next message.
          </Text>
        )}
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
        {isSeveral && (
          <Box>
            <Text dimColor>w switches workspace (Claude follows from your next message) · /{WORKSPACES_COMMAND} adds or removes one</Text>
          </Box>
        )}
        {box.takenByMe > 0 && box.session !== '' && (
          <Box>
            <Text dimColor>here keeps a report you hold in this session: your other sessions tuck it away · release undoes it</Text>
          </Box>
        )}
      </Box>
    )
  })
}
