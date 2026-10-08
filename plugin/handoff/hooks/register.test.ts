import { expect, mock, test } from 'claude-code/testing'

import { configProblem, describeAge, describeDue, describeEvent, projectOf, summarize } from './register'

const OPTIONS = { url: 'http://handoff.test', token: 'ho_test' }
const START = { cwd: '/work/thecargo-frontend', surface: 'terminal', isInteractive: true } as const
const INBOX = {
  user: 'ali',
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

test('summary is empty when nothing needs attention', () => {
  const empty = { isLoaded: true, isOffline: false, user: 'ali', project: 'p', waitingForProject: 0, overdue: 0, rows: [], returnedRows: [] }

  expect(summarize({ ...empty, waiting: 0, takenByMe: 0, returned: 0 })).toEqual(undefined)
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

test('deadlines read as time left or time overdue', () => {
  const now = Date.parse('2026-10-08T10:00:00Z')

  expect(describeDue(null, now)).toEqual('')
  expect(describeDue('2026-10-08T10:45:00Z', now)).toEqual('due in 45m')
  expect(describeDue('2026-10-08T15:00:00Z', now)).toEqual('due in 5h')
  expect(describeDue('2026-10-11T10:00:00Z', now)).toEqual('due in 3d')
  expect(describeDue('2026-10-08T07:00:00Z', now)).toEqual('overdue by 3h')
  expect(describeAge('2026-10-08T09:59:50Z', now)).toEqual('just now')
  expect(describeAge('2026-10-08T08:00:00Z', now)).toEqual('2h ago')
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

      return fetched(e.url)
    })
    const fetched = (url: string) => ({
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: url.includes('/reports/12')
          ? JSON.stringify({ ...ROW, text: '## Paging\nUse `?page` and `?size`.', note: null, replies: [] })
          : JSON.stringify({ ...INBOX, waiting: 1, taken_by_me: 0, overdue: 0, rows: [ROW] }),
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

    expect(await pane.find({ type: 'Text', text: /This project · thecargo-frontend/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /from backend\/asliddin · 2 replies/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^●$/ })).toBeDefined()
    await pane.press({ key: 'take-12' })
    expect(prompts).toEqual(['/handoff:take 12 ', '/handoff:take 12 '])

    await pane.press({ key: 'read-12' })
    expect(await pane.find({ type: 'Text', text: /^backend\/asliddin$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^ URGENT $/ })).toBeDefined()
    expect((await pane.find({ type: 'Markdown' }))?.text).toContain('Use `?page` and `?size`.')
    await pane.press({ key: 'reply' })
    expect(prompts.at(-1)).toEqual('/handoff:reply 12 ')

    draft = 'half-written question'
    await pane.press({ key: 'reply' })
    expect(prompts.length).toEqual(3)
    draft = ''
    await pane.press({ key: 'back' })
    expect(await pane.find({ key: 'read-12' })).toBeDefined()

    await pane.press({ key: 'close-12' })
    expect(closes).toEqual([])
    expect((await pane.find({ key: 'close-12' }))?.text).toEqual('Close? again')
    await pane.press({ key: 'close-12' })
    expect(closes).toEqual(['http://handoff.test/api/v1/reports/12/close'])
  })
}
