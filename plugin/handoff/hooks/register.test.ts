import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import {
  argsOf,
  askText,
  configProblem,
  describeAge,
  describeClock,
  describeDue,
  describeEvent,
  describeContext,
  describeReadiness,
  describeWhen,
  heldHere,
  isNewer,
  isWorkspace,
  nameOf,
  parseInstall,
  projectOf,
  projectsOf,
  rpcBody,
  summarize,
  switchNote,
  textOf,
  transportProblem,
} from './register'

const OPTIONS = { url: 'http://handoff.test', token: 'ho_test' }
const START = { cwd: '/work/thecargo-frontend', surface: 'terminal', isInteractive: true } as const
const INBOX = {
  user: 'ali',
  team: 'frontend',
  waiting: 2,
  waiting_for_project: 1,
  overdue: 1,
  taken_by_me: 1,
  returned: 0,
  rows: [],
  returned_rows: [],
}
const MCP_IDLE = { value: { status: 200, ok: true, headers: {}, text: '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}' } }
const isMcp = (url: string) => url.endsWith('/mcp/')
const NEW = {
  type: 'new',
  id: 12,
  title: 'GET /loads is now paginated',
  project: 'thecargo-frontend',
  priority: 'urgent',
  by_team: 'backend',
  by_user: 'asliddin',
  note: '',
  notify: true,
}

test('project name comes from the git remote, else the folder', () => {
  expect(projectOf('git@github.com:TheCarGo-io/thecargo-frontend.git\n', '/x/y')).toEqual('thecargo-frontend')
  expect(projectOf('https://github.com/TheCarGo-io/thecargo-crm', '/x/y')).toEqual('thecargo-crm')
  expect(projectOf('', '/work/thecargo-mobile/')).toEqual('thecargo-mobile')
})

test('a URL or token that could alter the curl config is refused', () => {
  expect(configProblem('https://handoff.thecargo.io', 'ho_Ab-9_x')).toEqual(undefined)
  expect(configProblem('http://127.0.0.1:8012', 'ho_x')).toEqual(undefined)
  expect(configProblem('https://h.io"\noutput = "/tmp/x', 'ho_x')).toEqual('the server URL must be a plain http(s) URL')
  expect(configProblem('ftp://h.io', 'ho_x')).toEqual('the server URL must be a plain http(s) URL')
  expect(configProblem('https://h.io/', 'ho_x')).toEqual('remove the trailing slash from the server URL')
  expect(configProblem('https://h.io', 'ho_x"\nurl = "http://evil')).toEqual(
    'the token contains characters a handoff token never has',
  )
})

test('an installed copy knows its marketplace and version, a development copy does not', () => {
  expect(parseInstall('/Users/a/.claude/plugins/cache/thecargo/handoff/0.5.0')).toEqual({
    home: '/Users/a/.claude/plugins',
    marketplace: 'thecargo',
    plugin: 'handoff',
    version: '0.5.0',
  })
  expect(parseInstall('C:\\Users\\a\\.claude\\plugins\\cache\\thecargo\\handoff\\0.5.0\\')?.version).toEqual('0.5.0')
  expect(parseInstall('/Users/a/development/thecargo-handoff/plugin/handoff')).toEqual(undefined)
})

test('a version is newer only when a number in it is higher', () => {
  expect(isNewer('0.6.0', '0.5.0')).toEqual(true)
  expect(isNewer('0.10.0', '0.9.3')).toEqual(true)
  expect(isNewer('1.0', '0.9.9')).toEqual(true)
  expect(isNewer('0.5.0', '0.5.0')).toEqual(false)
  expect(isNewer('0.4.9', '0.5.0')).toEqual(false)
  expect(isNewer('', '0.5.0')).toEqual(false)
})

test('a folder that is not a repository counts the repositories inside it', () => {
  expect(projectsOf('git@github.com:TheCarGo-io/thecargo-crm.git\n', '', '/x/thecargo-crm-dates')).toEqual(['thecargo-crm'])
  const children = 'git@github.com:TheCarGo-io/thecargo-auth.git\nhttps://github.com/TheCarGo-io/thecargo-auth\nscratch/\n'

  expect(projectsOf('', children, '/x/thecargo')).toEqual(['thecargo-auth', 'scratch'])
  expect(projectsOf('', '', '/x/Projects')).toEqual(['Projects'])
})

test('summary is empty when nothing needs attention', () => {
  const empty = {
    isLoaded: true,
    isOffline: false,
    offlineSince: null,
    session: '',
    unread: 0,
    hiddenRows: [],
    threads: [],
    unreadReplies: 0,
    team: 'frontend',
    projects: ['p'],
    user: 'ali',
    project: 'p', waitingForProject: 0, overdue: 0, rows: [], returnedRows: [] }

  expect(summarize({ ...empty, waiting: 0, takenByMe: 0, returned: 0 })).toEqual(undefined)
  expect(summarize({ ...empty, waiting: 0, takenByMe: 0, returned: 0, unreadReplies: 2 })).toEqual('2 unread replies')
  expect(summarize({ ...empty, waiting: 2, takenByMe: 1, returned: 1 })).toEqual(
    '2 waiting · 1 in progress · 1 returned',
  )
})

test('event lines name the report, the actor and the note', () => {
  expect(describeEvent(NEW as never)).toEqual(
    'New handoff #12 (urgent) from backend/asliddin: GET /loads is now paginated',
  )
  expect(describeEvent({ ...NEW, type: 'done', by_team: 'frontend', by_user: 'ali', note: 'PR #88' } as never)).toEqual(
    'Handoff #12 done by frontend/ali: PR #88',
  )
})

test('readiness reads as what the report waits for', () => {
  expect(describeReadiness('ready')).toEqual('')
  expect(describeReadiness(undefined)).toEqual('')
  expect(describeReadiness('after-deploy', 'after crm#39')).toEqual('not live yet: after crm#39')
  expect(describeReadiness('waiting-decision')).toEqual('waiting on a decision')
})

test('deadlines read as time left or time overdue', () => {
  const now = Date.parse('2026-10-08T10:00:00Z')

  expect(describeDue(null, now)).toEqual('')
  expect(describeDue('2026-10-08T10:45:00Z', now)).toEqual('due in 45m')
  expect(describeDue('2026-10-08T15:00:00Z', now)).toEqual('due in 5h')
  expect(describeDue('2026-10-11T10:00:00Z', now)).toEqual('due in 3d')
  expect(describeDue('2026-10-08T07:00:00Z', now)).toEqual('overdue by 3h')
})

test('times under an hour are relative, older ones are the exact local time', () => {
  const now = new Date(2026, 9, 10, 15, 30).getTime()
  const at = (...parts: [number, number, number, number, number, number?]) => new Date(...parts).toISOString()

  expect(describeWhen(at(2026, 9, 10, 15, 29, 40), now)).toEqual('now')
  expect(describeWhen(at(2026, 9, 10, 14, 31), now)).toEqual('59m')
  expect(describeWhen(at(2026, 9, 10, 14, 30), now)).toEqual('14:30')
  expect(describeWhen(at(2026, 9, 10, 0, 5), now)).toEqual('00:05')
  expect(describeWhen(at(2026, 9, 9, 23, 50), now)).toEqual('Oct 9 23:50')
  expect(describeWhen(at(2025, 11, 31, 8, 0), now)).toEqual('Dec 31 2025 08:00')
  expect(describeAge(at(2026, 9, 10, 15, 29, 40), now)).toEqual('just now')
  expect(describeAge(at(2026, 9, 10, 15, 18), now)).toEqual('12m ago')
  expect(describeAge(at(2026, 9, 10, 9, 0), now)).toEqual('09:00')
})

test('the offline line names the local time the server stopped answering', () => {
  expect(describeClock(new Date(2026, 9, 9, 21, 8).getTime())).toEqual('21:08')
  expect(describeClock(new Date(2026, 9, 9, 0, 0).getTime())).toEqual('00:00')
})

test('session start loads the inbox for this project and shows the count', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  const fetched: { url: string; auth?: string }[] = []
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const spawned: string[] = []

  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: 'git@github.com:TheCarGo-io/thecargo-frontend.git\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('http.fetch', ($$, e) => {
    if (isMcp(e.url)) {
      return MCP_IDLE
    }

    fetched.push({ url: e.url, auth: e.init?.headers?.Authorization })

    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(INBOX) } }
  })
  on('process.spawn', async function* ($$, e) {
    spawned.push(`${e.argv.join(' ')}|${e.input}`)
    yield { stream: 'stdout' as const, text: ': connected\n\ndata: {broken\n\ndata: ' }
    yield { stream: 'stdout' as const, text: `${JSON.stringify(NEW)}\n\ndata: {"type":"resync","notify":false}\n\n` }
    yield { stream: 'stdout' as const, text: `data: ${JSON.stringify({ ...NEW, id: 13, notify: false })}\n\n` }

    return { value: { code: 0, signal: null } }
  })
  on('ui.status', ($$, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', ($$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  await $.session.start(START)
  await clock.advance(10)

  expect(fetched[0]).toEqual({
    url: 'http://handoff.test/api/v1/inbox?project=thecargo-frontend',
    auth: 'Bearer ho_test',
  })
  expect(statuses).toEqual(statuses.map(() => undefined))
  expect(spawned[0]).toEqual(
    'curl -sN --fail --connect-timeout 10 --speed-limit 1 --speed-time 60 -K -|url = "http://handoff.test/api/v1/events"\nheader = "Authorization: Bearer ho_test"\n',
  )
  expect(toasts).toEqual([
    'New handoff #12 (urgent) from backend/asliddin: GET /loads is now paginated',
  ])
  expect(fetched.length).toBeGreaterThan(2)
})

test('a rejected token is reported once and stops the listener', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  const toasts: string[] = []
  let spawns = 0

  on('ui.status', () => ({ value: undefined }))

  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('http.fetch', () => ({ value: { status: 401, ok: false, headers: {}, text: '{}' } }))
  on('process.spawn', async function* () {
    spawns += 1

    return { value: { code: 22, signal: null } }
  })
  on('ui.toast', ($$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  await $.session.start(START)
  await clock.advance(10)

  expect(toasts).toEqual(['Handoff: the server rejected your token. Update it in /plugin.'])
  expect(spawns).toEqual(0)
})

test('a non-interactive session registers the tools but loads no inbox and starts no listener', { options: OPTIONS }, async ($, on) => {
  mock.clock(on)
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  const tools: string[] = []
  let calls = 0

  on('tool.register', ($$, e) => {
    tools.push(e.name)

    return { value: { tool: `mcp__handoff__${e.name}` } }
  })
  on('http.fetch', ($$, e) => {
    if (isMcp(e.url)) {
      return MCP_IDLE
    }

    calls += 1

    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(INBOX) } }
  })
  on('process.spawn', async function* () {
    calls += 1

    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ ...START, isInteractive: false })

  expect(calls).toEqual(0)
  expect(tools).toContain('take')
  expect(tools).toContain('close')
  expect(tools.length).toEqual(13)
})

test('a bad server URL is reported instead of being handed to curl', { options: { ...OPTIONS, url: 'https://h.io/' } }, async ($, on) => {
  mock.clock(on)
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  const toasts: string[] = []
  let spawns = 0

  on('process.spawn', async function* () {
    spawns += 1

    return { value: { code: 0, signal: null } }
  })
  on('ui.toast', ($$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  await $.session.start(START)

  expect(toasts).toEqual(['Handoff is not connected: remove the trailing slash from the server URL. Fix it in /plugin.'])
  expect(spawns).toEqual(0)
})

const ROW = {
  id: 12,
  title: 'GET /loads is now paginated',
  project: 'thecargo-frontend',
  from_team: 'backend',
  from_user: 'asliddin',
  to_team: 'frontend',
  to_user: null,
  created_at: '2026-10-08T09:00:00Z',
  version: 1,
  priority: 'urgent',
  due: null,
  overdue: false,
  status: 'sent',
  assignee: null,
  replies: 2,
  readiness: 'after-deploy',
  readiness_note: 'after crm#39',
  items_total: 2,
  items_done: 0,
  read: false,
}

const DETAIL = {
  ...ROW,
  text: '## Paging\nUse `?page` and `?size`.',
  note: null,
  replies: [],
  items: [
    { id: 1, title: 'Loads table', readiness: 'ready', done: false, done_by: null },
    { id: 2, title: 'Search page', readiness: 'after-deploy', done: false, done_by: null },
  ],
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: Take and Reply fill the prompt, Close needs two presses`, { options: OPTIONS }, async ($, on) => {
    const clock = mock.clock(on)
    const prompts: string[] = []

    on('session.start', ($$, e) => ({ cwd: e.cwd }))
    on('command.register', ($$, e) => ({ value: { command: e.name } }))
    on('process.run', () => ({
      value: {
        exitCode: 0,
        stdout: 'git@github.com:TheCarGo-io/thecargo-frontend.git\n',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }))
    const closes: string[] = []

    on('http.fetch', ($$, e) => {
      if (isMcp(e.url)) {
        return MCP_IDLE
      }

      if (e.init?.method === 'POST') {
        closes.push(e.url)
      }

      if (e.init?.method === 'DELETE') {
        closes.push(`DELETE ${e.url}`)
      }

      return fetched(e.url)
    })
    const fetched = (url: string) => ({
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: url.includes('/reports/12')
          ? JSON.stringify({ ...DETAIL, items: DETAIL.items.map(item => ({ ...item, done: url.includes('/items/check') })) })
          : JSON.stringify({
              ...INBOX,
              waiting: 1,
              unread: 1,
              taken_by_me: 0,
              overdue: 0,
              rows: [ROW, { ...ROW, id: 30, title: 'Held by a teammate', status: 'taken', assignee: 'vali' }],
              hidden_rows: [{ ...ROW, id: 40, title: 'Tucked away' }],
              unread_replies: 2,
              threads: [
                {
                  ...ROW,
                  id: 50,
                  title: 'Google sign-in in the app',
                  from_user: 'ali',
                  status: 'taken',
                  assignee: 'aydos',
                  unread: 2,
                  last_reply_by: 'aydos',
                  last_reply_at: '2026-10-01T12:00:00Z',
                  last_reply_excerpt: 'Android SHA-1s for package io.thecargo',
                },
              ],
            }),
      },
    })
    mock.store(on)
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: `data: ${JSON.stringify(NEW)}\n\n` }
      await new Promise(() => undefined)

      return { value: { code: 0, signal: null } }
    })
    on('ui.status', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    on('ui.render', ($$, e) => h($$.ui.resolve(e).Box, {}) as never)
    let draft = ''

    on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
    on('prompt.fill', ($$, e) => {
      prompts.push(e.text)

      return { isFilled: true }
    })

    await $.session.start({ ...START, surface })
    await clock.advance(10)

    const band = await $.ui.mount({
      plugin: 'handoff',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false } as never,
    })

    expect(
      await band.find({ type: 'Text', text: /New handoff #12 \(urgent\) from backend\/asliddin: GET \/loads/ }),
    ).toBeDefined()
    await band.press({ key: 'take' })
    expect(prompts).toEqual(['/handoff:take 12 '])

    const pane = await $.ui.mount({
      plugin: 'handoff',
      surface,
      component: 'Pane',
      requestId: 'handoffs',
      props: { title: 'Handoffs', isFocused: true } as never,
    })

    expect(await pane.find({ type: 'Text', text: /Here · thecargo-frontend/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Replies for you$/ })).toBeDefined()
    expect(
      await pane.find({ type: 'Text', text: /2 new replies · aydos: Android SHA-1s for package io\.thecargo/ }),
    ).toBeDefined()
    await pane.press({ key: 'take-thread-50' })
    expect(prompts.at(-1)).toEqual('/handoff:take 50 ')
    prompts.pop()
    expect(
      await pane.find({ type: 'Text', text: /^asliddin · 0\/2 done · not live yet: after crm#39 · 2 replies$/ }),
    ).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^· 1 unread$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^urgent$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Oct [78] (2026 )?\d\d:\d\d$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Oct [12] (2026 )?\d\d:\d\d$/ })).toBeDefined()
    expect((await pane.find({ key: 'read-12' }))?.text).toEqual('GET /loads is now paginated')
    await pane.press({ key: 'take-12' })
    expect(prompts).toEqual(['/handoff:take 12 ', '/handoff:take 12 '])

    await pane.press({ key: 'read-12' })
    expect(await pane.find({ type: 'Text', text: /^backend\/asliddin$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^ URGENT $/ })).toBeDefined()
    expect((await pane.find({ type: 'Markdown' }))?.text).toContain('Use `?page` and `?size`.')
    expect(await pane.find({ type: 'Text', text: /Checklist · 0\/2 done/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^not live yet$/ })).toBeDefined()
    await pane.press({ key: 'check-1' })
    expect(closes).toEqual(['http://handoff.test/api/v1/reports/12/items/check'])
    expect(await pane.find({ type: 'Text', text: /Checklist · 2\/2 done/ })).toBeDefined()
    closes.length = 0
    await pane.press({ key: 'reply' })
    expect(prompts.at(-1)).toEqual('/handoff:reply 12 ')

    draft = 'half-written question'
    await pane.press({ key: 'reply' })
    expect(prompts.length).toEqual(3)
    draft = ''
    await pane.press({ key: 'back' })
    expect(await pane.find({ key: 'read-12' })).toBeDefined()

    expect(await pane.find({ key: 'take-selected' })).toEqual(undefined)
    await pane.press({ key: 'pick-12' })
    expect((await pane.find({ key: 'take-selected' }))?.text).toEqual('Take 1 selected')
    await pane.press({ key: 'take-selected' })
    expect(prompts.at(-1)).toEqual('/handoff:take 12 ')
    expect(await pane.find({ key: 'take-selected' })).toEqual(undefined)

    await pane.press({ key: 'close-12' })
    expect(closes).toEqual([])
    expect((await pane.find({ key: 'close-12' }))?.text).toEqual('close? again')
    await pane.press({ key: 'close-12' })
    expect(closes).toEqual(['http://handoff.test/api/v1/reports/12/close'])

    expect(await pane.find({ type: 'Text', text: /You closed #12 for everyone/ })).toBeDefined()
    await pane.press({ key: 'undo-close' })
    expect(closes.at(-1)).toEqual('http://handoff.test/api/v1/reports/12/reopen')
    expect(await pane.find({ key: 'undo-close' })).toEqual(undefined)

    expect(await pane.find({ key: 'close-30' })).toEqual(undefined)
    expect(await pane.find({ key: 'take-30' })).toEqual(undefined)
    await pane.press({ key: 'hide-30' })
    expect(closes.at(-1)).toEqual('http://handoff.test/api/v1/reports/30/hide')

    expect(await pane.find({ type: 'Text', text: /1 hidden from your list/ })).toBeDefined()
    expect(await pane.find({ key: 'unhide-40' })).toEqual(undefined)
    await pane.press({ key: 'toggle-hidden' })
    await pane.press({ key: 'unhide-40' })
    expect(closes.at(-1)).toEqual('DELETE http://handoff.test/api/v1/reports/40/hide')
  })
}

test('the sender is offered Reopen when their report is closed or done', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  const closed = { ...NEW, type: 'closed', by_team: 'frontend', by_user: 'vali', from_user: 'ali', note: 'duplicate' }

  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(INBOX) } }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `data: ${JSON.stringify(closed)}\n\n` }
    await new Promise(() => undefined)

    return { value: { code: 0, signal: null } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', ($$, e) => h($$.ui.resolve(e).Box, {}) as never)
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($$, e) => {
    prompts.push(e.text)

    return { isFilled: true }
  })

  await $.session.start(START)
  await clock.advance(10)

  const band = await $.ui.mount({
    plugin: 'handoff',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false } as never,
  })

  expect(await band.find({ type: 'Text', text: /Handoff #12 closed by frontend\/vali: duplicate/ })).toBeDefined()
  expect(await band.find({ key: 'take' })).toEqual(undefined)
  await band.press({ key: 'reopen' })
  expect(prompts).toEqual(['/handoff:reopen 12 '])
  await band.press({ key: 'dismiss' })
  expect(await band.find({ key: 'reopen' })).toEqual(undefined)
})


test('a request that hangs is given up, shown as offline and retried', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on)
  const toasts: string[] = []
  let calls = 0

  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('http.fetch', async ($$, e) => {
    if (isMcp(e.url)) {
      return MCP_IDLE
    }

    calls += 1
    const call = calls

    if (call === 2) {
      await clock.sleep(600000)
    }

    return call === 3
      ? { value: { status: 502, ok: false, headers: {}, text: '' } }
      : { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(INBOX) } }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `data: ${JSON.stringify({ ...NEW, notify: false })}\n\n` }
    await new Promise(() => undefined)

    return { value: { code: 0, signal: null } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.render', ($$, e) => h($$.ui.resolve(e).Box, {}) as never)

  await $.session.start(START)
  await clock.advance(10)

  const band = await $.ui.mount({
    plugin: 'handoff',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false } as never,
  })

  expect(calls).toEqual(2)
  expect(await band.find({ key: 'retry' })).toEqual(undefined)

  await clock.advance(20000)
  expect(calls).toEqual(2)
  expect(await band.find({ type: 'Text', text: /offline since \d\d:\d\d/ })).toBeDefined()

  await clock.advance(15000)
  expect(calls).toEqual(3)
  expect(await band.find({ key: 'retry' })).toBeDefined()

  await band.press({ key: 'retry' })
  expect(calls).toEqual(4)
  expect(toasts).toEqual(['Handoff: back online.'])
  expect(await band.find({ key: 'retry' })).toEqual(undefined)

  await clock.advance(60000)
  expect(calls).toEqual(4)
})

test('a report I hold lives in the session it was put in, my other sessions tuck it away', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on)
  const calls: string[] = []
  const spawned: string[] = []
  const held = { ...ROW, status: 'taken', assignee: 'ali', read: true, priority: 'normal', readiness: 'ready', items_total: 0, replies: 0 }
  const web = { label: 'thecargo-frontend', live: true }
  const box = {
    ...INBOX,
    waiting: 0,
    waiting_for_project: 0,
    overdue: 0,
    taken_by_me: 4,
    rows: [
      { ...held, id: 21, title: 'AI chat', session: { ...web, id: 'sess-A' } },
      { ...held, id: 22, title: 'AI settings', session: { ...web, id: 'sess-B' } },
      { ...held, id: 23, title: 'Call transcript', session: { ...web, id: 'sess-C', live: false } },
      { ...held, id: 24, title: 'Dialer', session: null },
    ],
  }

  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-A' }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: 'git@github.com:TheCarGo-io/thecargo-frontend.git\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('http.fetch', ($$, e) => {
    if (isMcp(e.url)) {
      const body = JSON.parse(String(e.init?.body ?? '{}')) as { method?: string; params?: { name?: string; arguments?: unknown } }

      if (body.method === 'tools/call') {
        calls.push(`MCP ${body.params?.name} ${JSON.stringify(body.params?.arguments)}`)
        const text = JSON.stringify({ notice: 'data', id: 31, status: 'taken' })

        return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }) } }
      }

      return MCP_IDLE
    }

    if (e.init?.method !== undefined) {
      calls.push(`${e.init.method} ${e.url} ${e.init.body ?? ''}`.trim())
    }

    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(box) } }
  })
  on('process.spawn', async function* ($$, e) {
    spawned.push(String(e.input))
    await new Promise(() => undefined)

    return { value: { code: 0, signal: null } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', ($$, e) => h($$.ui.resolve(e).Box, {}) as never)
  on('tool.check', () => ({ decision: 'allow' }) as never)

  await $.session.start(START)
  await clock.advance(10)

  expect(spawned[0]).toContain('url = "http://handoff.test/api/v1/events?session=sess-A"')

  const band = await $.ui.mount({
    plugin: 'handoff',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false } as never,
  })

  expect(await band.find({ type: 'Text', text: /3 in progress/ })).toBeDefined()

  const pane = await $.ui.mount({
    plugin: 'handoff',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'handoffs',
    props: { title: 'Handoffs', isFocused: true } as never,
  })
  const titles = (await pane.findAll({ type: 'Text' })).map(node => node.text)

  expect(titles.indexOf('In this session')).toBeLessThan(titles.indexOf('In progress'))
  expect(titles.indexOf('AI chat')).toBeLessThan(titles.indexOf('In progress'))
  expect(titles).toContain('1 in your other sessions')
  expect(titles).not.toContain('AI settings')
  expect(titles).toContain('asliddin · taken by you in another session (thecargo-frontend, closed)')
  expect(titles).toContain('asliddin · taken by you')
  expect((await pane.find({ key: 'here-21' }))?.text).toEqual('release')
  expect(await pane.find({ key: 'hide-21' })).toEqual(undefined)

  await pane.press({ key: 'here-24' })
  expect(calls.at(-1)).toEqual('PUT http://handoff.test/api/v1/reports/24/session {"session":"sess-A","label":"thecargo-frontend"}')
  await pane.press({ key: 'here-21' })
  expect(calls.at(-1)).toEqual('DELETE http://handoff.test/api/v1/reports/21/session')

  expect(await pane.find({ key: 'here-22' })).toEqual(undefined)
  await pane.press({ key: 'toggle-elsewhere' })
  await pane.press({ key: 'here-22' })
  expect(calls.at(-1)).toEqual('PUT http://handoff.test/api/v1/reports/22/session {"session":"sess-A","label":"thecargo-frontend"}')

  await $.tool.call({ tool: 'mcp__handoff__take', report_id: 31 } as never)
  await clock.settle()
  expect(calls.at(-2)).toEqual('MCP take {"report_id":31}')
  expect(calls.at(-1)).toEqual('PUT http://handoff.test/api/v1/reports/31/session {"session":"sess-A","label":"thecargo-frontend"}')

  const state = { ...box, user: 'ali', team: 'frontend', projects: ['thecargo-frontend'], session: 'sess-A', threads: [], takenByMe: 4 }

  expect(heldHere(state as never)).toEqual(3)
  expect(describeContext(state as never)).toContain('held by ali, for this session: #21 "AI chat" (thecargo-frontend); #23')
  expect(describeContext(state as never)).toContain('in their other open sessions (leave these to those sessions unless the user names one): #22')
})

test('/clear ends the old session stream and connects the new session at once', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on)
  const spawned: string[] = []
  const closed: string[] = []
  const loads: string[] = []
  let current = 'sess-A'

  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('session.end', ($$, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', () => ({}) as never)
  on('session.id', () => ({ value: current }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: 'git@github.com:TheCarGo-io/thecargo-frontend.git\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('http.fetch', ($$, e) => {
    loads.push(current)

    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(INBOX) } }
  })
  on('process.spawn', async function* ($$, e) {
    const session = /\?session=([\w-]+)/.exec(String(e.input))?.[1] ?? ''
    spawned.push(session)

    try {
      yield { stream: 'stdout' as const, text: ': connected\n\n' }

      for (;;) {
        await clock.sleep(5000)
        yield { stream: 'stdout' as const, text: ': ping\n\n' }
      }
    } finally {
      closed.push(session)
    }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start(START)
  await clock.advance(10)

  expect(spawned).toEqual(['sess-A'])

  await $.session.end({ reason: 'clear', sessionId: 'sess-A', resume: { id: 'sess-A' } })
  await clock.advance(5000)

  expect(closed).toEqual(['sess-A'])

  current = 'sess-B'
  const loaded = loads.length
  await $.classic.SessionStart({ source: 'clear', session_id: 'sess-B' })
  await clock.advance(10)

  expect(spawned).toEqual(['sess-A', 'sess-B'])
  expect(loads.length).toBeGreaterThan(loaded)

  await $.classic.SessionStart({ source: 'compact', session_id: 'sess-B' })
  await clock.advance(60000)

  expect(spawned).toEqual(['sess-A', 'sess-B'])
  expect(closed).toEqual(['sess-A'])
})

test('handoff commands get the session context attached, other prompts do not', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on)
  const seen: (readonly string[] | undefined)[] = []
  const box = { ...INBOX, rows: [ROW], threads: [{ ...ROW, id: 50, unread: 1, last_reply_by: 'aydos', last_reply_excerpt: 'x' }] }

  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(box) } }))
  on('process.spawn', async function* () {
    await new Promise(() => undefined)

    return { value: { code: 0, signal: null } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', ($$, e) => {
    seen.push(e.context)

    return { text: e.text }
  })

  await $.session.start(START)
  await clock.advance(10)
  await $.prompt.submit({ text: 'fix the login bug' } as never)
  await $.prompt.submit({ text: '/handoff:take next' } as never)

  expect(seen[0]).toEqual(undefined)
  expect(seen[1]?.length).toEqual(1)
  expect(seen[1]?.[0]).toContain('user ali, team frontend')
  expect(seen[1]?.[0]).toContain("this session's project: thecargo-frontend")
  expect(seen[1]?.[0]).toContain('waiting for these projects: #12 "GET /loads is now paginated" (thecargo-frontend)')
  expect(seen[1]?.[0]).toContain('unread replies: #50 (1 from aydos)')
  const workspace = { projects: ['a', 'b'], rows: [], threads: [], user: 'ali', team: 'frontend' }

  expect(describeContext(workspace as never)).toContain(
    "this session's projects (a workspace of repositories): a, b",
  )
})

test('workspace helpers: names, notes, arguments, answers and the ask line', () => {
  expect(nameOf('https://handoff.demo.thecargo.io')).toEqual('thecargo')
  expect(nameOf('https://handoff.goway.uz')).toEqual('goway')
  expect(nameOf('http://127.0.0.1:8013')).toEqual('127.0.0.1:8013')
  expect(switchNote('GoWay', 'TheCargo')).toContain('Report numbers mentioned earlier in this conversation refer to TheCargo')
  expect(argsOf({ tool: 'mcp__handoff__take', tool_use_id: 'x', report_id: 4, project: undefined }, ['report_id', 'project'])).toEqual({ report_id: 4 })
  expect(rpcBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')?.result).toEqual({ ok: true })
  expect(rpcBody('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\n')?.result).toEqual({ a: 1 })
  expect(rpcBody('<html>')).toEqual(undefined)
  expect(textOf({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toEqual('a\nb')
  expect(askText('close', { report_id: 41 }, 'GoWay')).toEqual('Allow handoff close #41 on GoWay?')
  expect(askText('send', {}, undefined)).toEqual('Allow handoff send?')
  expect(isWorkspace({ id: 'ws-1', name: 'GoWay', url: 'https://h.goway.uz', token: 'ho_x' })).toEqual(true)
  expect(isWorkspace({ id: 'default', name: 'X', url: 'https://h.goway.uz', token: 'ho_x' })).toEqual(false)
  expect(isWorkspace({ id: 'ws-1', name: 'GoWay', url: 'https://h.goway.uz/', token: 'ho_x' })).toEqual(false)
  expect(isWorkspace({ id: 'ws-1', name: 'GoWay', url: 'http://h.goway.uz', token: 'ho_x' })).toEqual(false)
  expect(transportProblem('https://h.goway.uz')).toEqual(undefined)
  expect(transportProblem('http://127.0.0.1:8022')).toEqual(undefined)
  expect(transportProblem('http://localhost:8022')).toEqual(undefined)
  expect(transportProblem('http://[::1]:8022')).toEqual(undefined)
  expect(transportProblem('http://h.goway.uz')).toContain('https://')
  expect(transportProblem('http://127.0.0.1.evil.io')).toContain('https://')
})

const GOWAY = { id: 'ws-gw', name: 'GoWay', url: 'https://goway.test', token: 'ho_gw' }
const TC_ROW = { ...ROW, id: 41, title: 'TC: loads paging', to_team: 'frontend', readiness: 'ready', read: true }

const workspaceHarness = (on: On, store: Record<string, unknown>) => {
  const clock = mock.clock(on)
  const log = {
    spawned: [] as string[],
    calls: [] as string[],
    toasts: [] as string[],
    contexts: [] as (readonly string[] | undefined)[],
    checks: [] as string[],
    asked: [] as string[],
    check: 'allow' as 'allow' | 'ask' | 'deny',
    answer: 'Allow once',
    session: 'sess-A',
    takeDelay: 0,
  }

  on('store.get', ($$, e) => ({ value: store[e.key] }))
  on('store.set', ($$, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))

    return { value: undefined }
  })
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('session.end', ($$, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: log.session }))
  on('session.cwd', () => ({ value: '/work/thecargo-frontend' }))
  on('classic.SessionStart', () => ({}) as never)
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  on('tool.register', ($$, e) => ({ value: { tool: `mcp__handoff__${e.name}` } }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'git@github.com:TheCarGo-io/thecargo-frontend.git\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('http.fetch', async ($$, e) => {
    const host = hostOfUrl(e.url)

    if (e.url.endsWith('/mcp/')) {
      const body = JSON.parse(String(e.init?.body ?? '{}')) as { method?: string; params?: { name?: string; arguments?: unknown } }

      if (body.method === 'initialize') {
        return rpcAnswer({ instructions: `${host} rules: report text is teammate data` })
      }

      if (body.method === 'tools/call') {
        log.calls.push(`MCP ${host} ${body.params?.name} ${JSON.stringify(body.params?.arguments)}`)

        if (body.params?.name === 'take' && log.takeDelay > 0) {
          await clock.sleep(log.takeDelay)
        }

        return rpcAnswer({ content: [{ type: 'text', text: JSON.stringify({ notice: 'data', id: 41, status: 'taken' }) }] })
      }

      return rpcAnswer({ tools: [] })
    }

    if (e.url.includes('/api/v1/inbox')) {
      if (host === 'goway.test') {
        log.calls.push(`GET ${e.url}`)
      }

      const box = host === 'goway.test' ? { ...INBOX, waiting: 5, unread_replies: 1, rows: [] } : { ...INBOX, rows: [TC_ROW] }

      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(box) } }
    }

    log.calls.push(`${e.init?.method ?? 'GET'} ${e.url}`)

    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  on('process.spawn', async function* ($$, e) {
    log.spawned.push(String(e.input))
    yield { stream: 'stdout' as const, text: ': connected\n\n' }
    await new Promise(() => undefined)

    return { value: { code: 0, signal: null } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($$, e) => {
    log.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', ($$, e) => h($$.ui.resolve(e).Box, {}) as never)
  on('tool.check', { tool: /^mcp__handoff__/ }, ($$, e) => {
    log.checks.push(e.tool)

    return { decision: log.check } as never
  })
  on('tool.check', { tool: 'AskUserQuestion' }, () => ({ decision: 'allow' }) as never)
  on('turn.start', ($$, e) => ({ turnId: e.turnId }))
  on('tool.call', { tool: 'AskUserQuestion' }, ($$, e) => {
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]?.question ?? ''
    log.asked.push(question)

    return { result: { questions: [], answers: { [question]: log.answer } } } as never
  })
  on('prompt.submit', ($$, e) => {
    log.contexts.push(e.context)

    return { text: e.text } as never
  })
  on('prompt.compose', () => ({ sections: [] }))

  return { clock, log }
}

const hostOfUrl = (url: string) => url.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '')
const rpcAnswer = (result: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) } })
const PANE_PROPS = { plugin: 'handoff', surface: 'terminal', component: 'Pane', requestId: 'handoffs', props: { title: 'Handoffs', isFocused: true } } as const
const IDLE = { origin: { kind: 'composer' }, wait: false } as const

test('one workspace looks like today: no switcher, no prefix, and the store never holds the options token', { options: OPTIONS }, async ($, on) => {
  const store: Record<string, unknown> = {}
  const { clock } = workspaceHarness(on, store)

  await $.session.start(START)
  await clock.advance(10)
  const pane = await $.ui.mount(PANE_PROPS as never)

  expect(await pane.find({ key: 'space-default' })).toEqual(undefined)
  expect(JSON.stringify(store)).not.toContain('ho_test')
})

test('a switch moves the pane and stream, resets per-workspace state, and survives /clear and a reload', { options: OPTIONS }, async ($, on) => {
  const store: Record<string, unknown> = { workspaces: [GOWAY] }
  const { clock, log } = workspaceHarness(on, store)

  await $.session.start(START)
  await clock.advance(10)

  expect(log.spawned.at(-1)).toContain('url = "http://handoff.test/api/v1/events?session=sess-A"')

  const pane = await $.ui.mount(PANE_PROPS as never)

  expect((await pane.find({ key: 'space-ws-gw' }))?.text).toContain('GoWay')
  await pane.press({ key: 'close-41' })
  await pane.press({ key: 'space-ws-gw' })
  await clock.advance(10)

  expect(log.spawned.at(-1)).toContain('url = "https://goway.test/api/v1/events?session=sess-A"')
  expect(log.spawned.at(-1)).toContain('Bearer ho_gw')
  expect(store.active).toEqual('ws-gw')
  expect(log.toasts).toContain('Handoff: now on GoWay')
  expect(log.calls.filter(call => call.includes('/close'))).toEqual([])

  await $.session.end({ reason: 'clear', sessionId: 'sess-A', resume: { id: 'sess-A' } })
  log.session = 'sess-B'
  await $.classic.SessionStart({ source: 'clear', session_id: 'sess-B' })
  await clock.advance(10)

  expect(log.spawned.at(-1)).toContain('url = "https://goway.test/api/v1/events?session=sess-B"')

  store.active = 'default'
  await $.session.start(START)
  await clock.advance(10)

  expect(log.spawned.at(-1)).toContain('https://goway.test/api/v1/events')
  expect(JSON.stringify(store)).not.toContain('ho_test')
})

test("Claude's tools follow a switch only from the next idle prompt; subagents keep their turn's workspace", { options: OPTIONS }, async ($, on) => {
  const store: Record<string, unknown> = { workspaces: [GOWAY] }
  const { clock, log } = workspaceHarness(on, store)
  const inbox = (agentId?: string) => $.tool.call({ tool: 'mcp__handoff__inbox', ...(agentId ? { agentId } : {}) } as never)

  await $.session.start(START)
  await clock.advance(10)
  await $.prompt.submit({ text: 'work on handoffs', ...IDLE } as never)
  await $.turn.start({ text: 'work on handoffs', turnId: 't1' })
  await inbox()

  const pane = await $.ui.mount(PANE_PROPS as never)
  await pane.press({ key: 'space-ws-gw' })
  await clock.advance(10)
  await inbox()
  await $.turn.start({ text: 'sub', turnId: 't2', agentId: 'a1' })
  await inbox('a1')
  await $.prompt.submit({ text: 'agent done', origin: { kind: 'peer' }, wait: false } as never)
  await $.turn.start({ text: 'agent done', turnId: 't3' })
  await inbox()
  await $.prompt.submit({ text: 'typed mid-turn', ...IDLE, turnId: 't3' } as never)
  await inbox()

  expect(log.calls.filter(call => call.startsWith('MCP'))).toEqual([
    'MCP handoff.test inbox {}',
    'MCP handoff.test inbox {}',
    'MCP handoff.test inbox {}',
    'MCP handoff.test inbox {}',
    'MCP handoff.test inbox {}',
  ])
  expect(log.contexts.flat().filter(line => line?.startsWith('Handoff workspace is now'))).toEqual([])

  await $.prompt.submit({ text: 'next thing', ...IDLE } as never)
  await $.turn.start({ text: 'next thing', turnId: 't4' })
  await inbox()
  await inbox('a1')
  await $.prompt.submit({ text: 'and another', ...IDLE } as never)

  expect(log.calls.filter(call => call.startsWith('MCP')).slice(-2)).toEqual(['MCP goway.test inbox {}', 'MCP handoff.test inbox {}'])
  expect(log.contexts.flat().filter(line => line?.startsWith('Handoff workspace is now'))).toEqual([switchNote('GoWay', 'handoff')])
})

test('every write passes the permission gate, and a refused ask never reaches the server', { options: OPTIONS }, async ($, on) => {
  const { clock, log } = workspaceHarness(on, {})
  const take = () => $.tool.call({ tool: 'mcp__handoff__take', report_id: 41 } as never)
  const forwarded = () => log.calls.filter(call => call.startsWith('MCP')).length

  await $.session.start(START)
  await clock.advance(10)
  await $.tool.call({ tool: 'mcp__handoff__board' } as never)

  expect(log.checks).toEqual([])
  expect(forwarded()).toEqual(1)

  log.check = 'ask'
  log.answer = 'Deny'
  const refused = await take()

  expect(log.asked).toEqual(['Allow handoff take #41?'])
  expect(refused.deny).toContain('did not allow handoff take')
  expect(forwarded()).toEqual(1)

  log.check = 'deny'
  await take()

  expect(log.asked.length).toEqual(1)
  expect(forwarded()).toEqual(1)

  log.check = 'ask'
  log.answer = 'Allow once'
  await take()
  await clock.settle()

  expect(forwarded()).toEqual(2)
  expect(log.calls.at(-1)).toEqual('PUT http://handoff.test/api/v1/reports/41/session')

  log.check = 'allow'
  await take()

  expect(log.asked.length).toEqual(2)
  expect(forwarded()).toEqual(3)
})

test('a take that resolves after a switch places the report on the workspace it was sent to', { options: OPTIONS }, async ($, on) => {
  const store: Record<string, unknown> = { workspaces: [GOWAY] }
  const { clock, log } = workspaceHarness(on, store)

  await $.session.start(START)
  await clock.advance(10)
  await $.prompt.submit({ text: 'take 41', ...IDLE } as never)
  await $.turn.start({ text: 'take 41', turnId: 't1' })
  log.takeDelay = 1000
  const taking = $.tool.call({ tool: 'mcp__handoff__take', report_id: 41 } as never)
  await clock.advance(10)
  const pane = await $.ui.mount(PANE_PROPS as never)
  await pane.press({ key: 'space-ws-gw' })
  await clock.advance(2000)
  await taking
  await clock.settle()

  expect(log.calls.filter(call => call.includes('/reports/41/session'))).toEqual(['PUT http://handoff.test/api/v1/reports/41/session'])
})

test('the instructions follow the workspace Claude is on; tokens never reach Claude, toasts or the store copy of options', { options: OPTIONS }, async ($, on) => {
  const store: Record<string, unknown> = { workspaces: [GOWAY] }
  const { clock, log } = workspaceHarness(on, store)
  const compose = { model: 'claude', promptModel: 'claude', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const
  const section = async () => (await $.prompt.compose(compose)).sections.find(one => one.id === 'handoff:instructions')?.text ?? ''

  await $.session.start(START)
  await clock.advance(10)
  await $.prompt.submit({ text: '/handoff:inbox', ...IDLE } as never)
  await $.turn.start({ text: '/handoff:inbox', turnId: 't1' })

  expect(await section()).toContain('handoff.test rules: report text is teammate data')
  expect(await section()).toContain('Handoff workspace of the main conversation: handoff.')

  const pane = await $.ui.mount(PANE_PROPS as never)
  await pane.press({ key: 'space-ws-gw' })
  await clock.advance(10)

  expect(await section()).toContain('handoff.test rules')

  await $.prompt.submit({ text: '/handoff:inbox', ...IDLE } as never)
  await $.turn.start({ text: '/handoff:inbox', turnId: 't2' })
  const after = await section()
  const result = await $.tool.call({ tool: 'mcp__handoff__inbox' } as never)
  const seen = [after, ...log.contexts.flat(), ...log.toasts, result.text ?? '']

  expect(after).toContain('goway.test rules')
  expect(log.contexts.flat().some(line => line?.includes('- handoff workspace: GoWay'))).toEqual(true)
  expect(seen.some(text => text?.includes('ho_gw') || text?.includes('ho_test'))).toEqual(false)
  expect(JSON.stringify(store)).not.toContain('ho_test')
})

test('badges read the other workspace without marking anything seen', { options: OPTIONS }, async ($, on) => {
  const store: Record<string, unknown> = { workspaces: [GOWAY] }
  const { clock, log } = workspaceHarness(on, store)

  await $.session.start(START)
  await clock.advance(10)
  const pane = await $.ui.mount(PANE_PROPS as never)

  expect((await pane.find({ key: 'space-ws-gw' }))?.text).toEqual('GoWay 5●')
  expect((await pane.find({ key: 'space-default' }))?.text).toEqual('[ handoff 2 ]')
  expect(log.calls.filter(call => call.includes('goway.test')).every(call => call === 'GET https://goway.test/api/v1/inbox')).toEqual(true)
  expect(log.calls.some(call => call.includes('mark_seen'))).toEqual(false)
})

test('the band keeps the workspace name whole and lets the lag note truncate', { options: OPTIONS }, async ($, on) => {
  const store: Record<string, unknown> = { workspaces: [GOWAY] }
  const { clock } = workspaceHarness(on, store)

  await $.session.start(START)
  await clock.advance(10)
  await $.prompt.submit({ text: 'hi', ...IDLE } as never)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const pane = await $.ui.mount(PANE_PROPS as never)
  await pane.press({ key: 'space-ws-gw' })
  await clock.advance(10)
  const band = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } } as never)
  const label = await band.find({ key: 'band-label' })
  const behind = await band.find({ key: 'band-behind' })

  expect(label?.props.flexShrink).toEqual(0)
  expect(label?.text).toContain('Handoff · GoWay')
  expect(behind?.props.flexShrink).toEqual(1)
  expect(behind?.text).toContain('Claude on handoff until your next message')
  expect((await band.find({ type: 'Text', text: /Claude on handoff/ }))?.props.wrap).toEqual('truncate-end')
})

test('the add form refuses a plain-http server that is not on this machine', { options: OPTIONS }, async ($, on) => {
  const store: Record<string, unknown> = {}
  const { clock } = workspaceHarness(on, store)

  await $.session.start(START)
  await clock.advance(10)
  await $.command.run({ command: 'handoff-workspaces' } as never).catch(() => undefined)
  const pane = await $.ui.mount(PANE_PROPS as never)
  await $.ui.input({ plugin: 'handoff', key: 'ws-name', text: 'GoWay', kind: 'change' })
  await $.ui.input({ plugin: 'handoff', key: 'ws-url', text: 'http://handoff.goway.uz', kind: 'change' })
  await $.ui.input({ plugin: 'handoff', key: 'ws-token', text: 'ho_gw', kind: 'change' })
  await pane.press({ key: 'ws-save' })

  expect(await pane.find({ type: 'Text', text: /https:\/\// })).toBeDefined()
  expect(store.workspaces).toEqual(undefined)
})

test('/clear forgets only the main binding: a background subagent keeps its workspace', { options: OPTIONS }, async ($, on) => {
  const store: Record<string, unknown> = { workspaces: [GOWAY] }
  const { clock, log } = workspaceHarness(on, store)

  await $.session.start(START)
  await clock.advance(10)
  await $.prompt.submit({ text: 'start', ...IDLE } as never)
  await $.turn.start({ text: 'start', turnId: 't1' })
  await $.turn.start({ text: 'sub', turnId: 't2', agentId: 'a1' })
  const pane = await $.ui.mount(PANE_PROPS as never)
  await pane.press({ key: 'space-ws-gw' })
  await clock.advance(10)
  await $.session.end({ reason: 'clear', sessionId: 'sess-A', resume: { id: 'sess-A' } })
  log.session = 'sess-B'
  await $.classic.SessionStart({ source: 'clear', session_id: 'sess-B' })
  await clock.advance(10)
  await $.tool.call({ tool: 'mcp__handoff__inbox', agentId: 'a1' } as never)
  await $.prompt.submit({ text: 'fresh', ...IDLE } as never)
  await $.turn.start({ text: 'fresh', turnId: 't3' })
  await $.tool.call({ tool: 'mcp__handoff__inbox' } as never)

  expect(log.calls.filter(call => call.startsWith('MCP'))).toEqual(['MCP handoff.test inbox {}', 'MCP goway.test inbox {}'])
})
