import { expect, mock, test } from 'claude-code/testing'

import {
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
  parseInstall,
  projectOf,
  projectsOf,
  summarize,
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

test('a non-interactive session makes no request and starts no listener', { options: OPTIONS }, async ($, on) => {
  mock.clock(on)
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  let calls = 0

  on('http.fetch', () => {
    calls += 1

    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(INBOX) } }
  })
  on('process.spawn', async function* () {
    calls += 1

    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ ...START, isInteractive: false })

  expect(calls).toEqual(0)
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
  on('http.fetch', async () => {
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
  on('tool.call', () => ({ result: {}, text: '{"notice": "data", "id": 31, "status": "taken"}' }) as never)

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

  await $.tool.call({ tool: 'mcp__plugin_handoff_handoff__take', tool_input: { report_id: 31 } } as never)
  await clock.settle()
  expect(calls.at(-1)).toEqual('PUT http://handoff.test/api/v1/reports/31/session {"session":"sess-A","label":"thecargo-frontend"}')

  const state = { ...box, user: 'ali', team: 'frontend', projects: ['thecargo-frontend'], session: 'sess-A', threads: [], takenByMe: 4 }

  expect(heldHere(state as never)).toEqual(3)
  expect(describeContext(state as never)).toContain('held by ali, for this session: #21 "AI chat" (thecargo-frontend); #23')
  expect(describeContext(state as never)).toContain('in their other open sessions (leave these to those sessions unless the user names one): #22')
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
