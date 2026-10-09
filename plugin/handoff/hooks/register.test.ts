import { expect, mock, test } from 'claude-code/testing'

import {
  configProblem,
  describeAge,
  describeDue,
  describeEvent,
  describeContext,
  describeReadiness,
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
  readiness: 'after-deploy',
  readiness_note: 'after crm#39',
  items_total: 2,
  items_done: 0,
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
      await pane.find({ type: 'Text', text: /from backend\/asliddin · 0\/2 done · not live yet: after crm#39 · 2 replies/ }),
    ).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^●$/ })).toBeDefined()
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
    expect((await pane.find({ key: 'close-12' }))?.text).toEqual('Close? again')
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
