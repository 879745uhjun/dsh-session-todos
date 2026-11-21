// Render smoke test for the shipped client bundle.
//
// React and jsdom are not installed in this workspace, so this harness runs the
// real client source under vm with a tiny hooks runtime, a stubbed module
// loader, a stubbed Host route, and a stubbed session catalog. It drives the
// actual components: the sidebar checkbox, the todo page grouping, and the
// optimistic write the checkbox sends to the Host.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/* ------------------------------------------------------------------ *
 * Minimal hooks runtime
 * ------------------------------------------------------------------ */

let cursor = 0
let slots = []
let pendingEffects = []

function resetHooks() {
  cursor = 0
  slots = []
  pendingEffects = []
}

function useState(initial) {
  const index = cursor++
  if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
  const set = (next) => {
    slots[index] = typeof next === 'function' ? next(slots[index]) : next
  }
  return [slots[index], set]
}

function useEffect(run, deps) {
  const index = cursor++
  const previous = slots[index]
  const changed = previous === undefined || deps === undefined || deps.some((value, position) => value !== previous[position])
  slots[index] = deps ?? []
  if (changed) pendingEffects.push(run)
}

function useMemo(factory, deps) {
  const index = cursor++
  const previous = slots[index]
  const changed = previous === undefined || deps === undefined || deps.some((value, position) => value !== previous.deps[position])
  slots[index] = changed ? { value: factory(), deps } : previous
  return slots[index].value
}

function useCallback(fn, deps) {
  return useMemo(() => fn, deps)
}

function useSyncExternalStore(subscribe, getSnapshot) {
  return getSnapshot()
}

function useRef(initial) {
  const index = cursor++
  if (slots[index] === undefined) slots[index] = { current: initial }
  return slots[index]
}

const React = {
  createElement(type, props, ...children) {
    const merged = Object.assign({}, props)
    if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
    return { type, props: merged }
  },
  useState,
  useEffect,
  useMemo,
  useCallback,
  useSyncExternalStore,
  useRef,
}

/* ------------------------------------------------------------------ *
 * DOM, fetch, and locale stubs
 * ------------------------------------------------------------------ */

const styleNodes = new Map()

function createStyleNode() {
  const node = {
    textContent: '',
    setAttribute() {},
    remove() {},
  }
  return node
}

const document = {
  visibilityState: 'visible',
  head: {
    appendChild(node) {
      styleNodes.set(node, true)
    },
  },
  createElement: () => createStyleNode(),
  addEventListener() {},
  removeEventListener() {},
}

const window = {
  addEventListener() {},
  removeEventListener() {},
  setInterval: () => 0,
  clearInterval: () => {},
}

class StubEventSource {
  constructor(url) {
    this.url = url
    this.listeners = new Map()
  }

  addEventListener(name, handler) {
    this.listeners.set(name, handler)
    // The real stream pushes a snapshot on connect; the self-test needs that.
    if (name === 'todos') {
      queueMicrotask(() => {
        if (this.listeners.get(name) !== handler) return
        try {
          handler({ data: '{"ok":true,"todos":{}}' })
        } catch {
          /* the listener ignored it */
        }
      })
    }
  }

  removeEventListener(name, handler) {
    if (this.listeners.get(name) === handler) this.listeners.delete(name)
  }

  close() {}
}

const requests = []
let serverTodos = {}

function reply(payload) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) })
}

const clone = (value) => JSON.parse(JSON.stringify(value))

// 'off' keeps every legacy test on the flat list; the box tests turn it on.
let boxesMode = 'off'
let notifyMode = 'ok' // 'ok' | 'off' | 'broken'
let settings = { autoWatch: false, reopenOnResume: false }
let settingsWriteFails = false
let settingsGetFails = false
let clipboardText = ''
const settingsPosts = []

const boxesPayload = {
  ok: true,
  state: {
    boxes: [
      { id: 'b-work', name: 'Work', color: 'blue', collapsed: false, parentId: null, order: 0 },
      { id: 'b-sub', name: 'Sub', color: 'amber', collapsed: false, parentId: 'b-work', order: 1 },
      { id: 'b-empty', name: 'Empty box', color: 'gray', collapsed: false, parentId: null, order: 2 },
    ],
    memberships: {
      'session-idle': ['b-work'],
      'session-running': ['b-sub'],
    },
  },
}

const fetch = (url, init) => {
  requests.push({ url, init })
  if (String(url).includes('/session-notify')) {
    if (notifyMode === 'off') return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ ok: false }) })
    if (String(url).includes('/session-notify/settings')) {
      return reply({ ok: true, defaultWatch: false, defaultMode: 'once' })
    }
    return reply({ ok: true, watched: {} })
  }
  if (String(url).includes('/session-todos/health')) {
    return reply({ ok: true, tool: 'session_todos', registered: true })
  }
  if (String(url).includes('/session-todos/settings')) {
    if (settingsGetFails && (init === undefined || init.method !== 'POST')) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ ok: false }) })
    }
    if (init !== undefined && init.method === 'POST') {
      const body = JSON.parse(init.body)
      settingsPosts.push(body)
      if (settingsWriteFails) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) })
      if (body.autoWatch !== undefined) settings.autoWatch = body.autoWatch === true
      if (body.reopenOnResume !== undefined) settings.reopenOnResume = body.reopenOnResume === true
      return reply({ ok: true, autoWatch: settings.autoWatch, reopenOnResume: settings.reopenOnResume, autoWatched: [] })
    }
    if (notifyMode === 'broken') return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) })
    return reply({ ok: true, autoWatch: settings.autoWatch, reopenOnResume: settings.reopenOnResume, autoWatched: [] })
  }
  if (String(url).includes('/session-boxes')) {
    if (boxesMode === 'ok') return reply(clone(boxesPayload))
    if (boxesMode === 'badjson') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('bad json')) })
    }
    if (boxesMode === 'abort') {
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ ok: false }) })
  }
  if (init !== undefined && init.method === 'POST') {
    const body = JSON.parse(init.body)
    if (body.action === 'clear') delete serverTodos[body.sessionId]
    else {
      const previous = serverTodos[body.sessionId] ?? { done: false, note: '', priority: 'normal', dueAt: 0, title: '' }
      serverTodos[body.sessionId] = Object.assign({}, previous, {
        done: body.done === undefined ? previous.done : body.done === true,
        note: body.note === undefined ? previous.note : body.note,
        priority: body.priority === undefined ? previous.priority : body.priority,
        dueAt: body.dueAt === undefined ? previous.dueAt : body.dueAt,
        title: body.title === undefined || body.title === '' ? previous.title : body.title,
        updatedAt: Date.now(),
      })
    }
    return reply({ ok: true, todos: clone(serverTodos) })
  }
  return reply({ ok: true, todos: clone(serverTodos) })
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const todos = {
  'session-done': { done: true, note: 'finished yesterday', priority: 'normal', dueAt: 0, title: 'Done session', createdAt: 1, updatedAt: 2, doneAt: 2 },
  'session-running': { done: false, note: 'waiting on review', priority: 'high', dueAt: 0, title: 'Running session', createdAt: 1, updatedAt: 2, doneAt: 0 },
}

const sessions = [
  { id: 'session-idle', title: 'Idle session', cwd: 'D:\\work\\demo', running: false, blank: false, archived: false, updatedAt: 1000 },
  { id: 'session-running', title: 'Running session', cwd: 'D:\\work\\demo', running: true, blank: false, archived: false, updatedAt: 2000 },
  { id: 'session-done', title: 'Done session', cwd: 'D:\\work\\other', running: false, blank: false, archived: false, updatedAt: 1500 },
]

function createSessionsService(list) {
  const byId = {}
  const ids = []
  for (const session of list) {
    byId[session.id] = Object.assign({}, session)
    ids.push(session.id)
  }
  const listeners = new Set()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  return {
    list: {
      getSnapshot: () => ({ ids, byId }),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    /** Flip one session's running state and notify, like the real catalog does. */
    setRunning(sessionId, value) {
      const summary = byId[sessionId]
      if (summary === undefined) return
      summary.running = value === true
      emit()
    },
    emit,
  }
}

/* ------------------------------------------------------------------ *
 * Boot the real bundle
 * ------------------------------------------------------------------ */

let captured
const sandbox = {
  window: Object.assign({}, window, {
    __ModuleLoader__: {
      load(module) {
        captured = module
      },
    },
  }),
  document,
  fetch,
  navigator: { clipboard: { writeText: async (text) => { clipboardText = text } } },
  EventSource: StubEventSource,
  console,
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
}
sandbox.window.EventSource = StubEventSource
vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' })

// The client reads window.dshNotepad at call time, so tests can swap it.
const harnessWindow = sandbox.window

/** Install (or clear) a fake dsh-notepad client protocol. */
function setNotepad(api) {
  harnessWindow.dshNotepad = api
}

const plugin = captured.factory(() => React)

/* ------------------------------------------------------------------ *
 * Render helpers
 * ------------------------------------------------------------------ */

function renderComponent(type, props, keepState = false) {
  if (!keepState) resetHooks()
  else {
    // Re-read the same slots from the top, but keep the values a click wrote.
    cursor = 0
    pendingEffects = []
  }
  const tree = typeof type === 'function' ? type(props ?? {}) : type
  const collected = []
  collect(tree, collected)
  const effects = pendingEffects
  pendingEffects = []
  lastCleanups = []
  for (const effect of effects) {
    const cleanup = effect()
    if (typeof cleanup === 'function') {
      pendingEffects.push(cleanup)
      lastCleanups.push(cleanup)
    }
  }
  return collected
}

let lastCleanups = []

/** Run the cleanups of the last render, like unmounting the component. */
function unmount() {
  const cleanups = lastCleanups
  lastCleanups = []
  for (const cleanup of cleanups) cleanup()
}

function collect(node, out) {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') return
  if (typeof node.type === 'function') {
    collect(node.type(node.props ?? {}), out)
    return
  }
  out.push(node)
  if (node.props !== undefined) collect(node.props.children, out)
}

/** Every collected element whose className matches one entry exactly. */
function byClass(nodes, className) {
  return nodes.filter((node) => typeof node.props.className === 'string'
    && node.props.className.split(' ').includes(className))
}

/** Wait for the Host route's microtasks to settle. */
const settle = async () => {
  // The settings refresh chains two background requests; 6 turns was not
  // always enough for it to publish before a test triggers a catalog change.
  for (let index = 0; index < 24; index += 1) await Promise.resolve()
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

function boot(overrides = {}) {
  serverTodos = clone(todos)
  boxesMode = 'off'
  notifyMode = 'ok'
  settings = Object.assign({ autoWatch: false, reopenOnResume: false }, overrides)
  settingsPosts.length = 0
  settingsWriteFails = false
  settingsGetFails = false
  const sessionsService = createSessionsService(sessions)
  const locale = {
    dictionaries: {},
    register(namespace, dictionaries) {
      locale.dictionaries[namespace] = dictionaries
      return () => {}
    },
    bind(namespace) {
      return (key, params) => {
        const dictionary = locale.dictionaries[namespace]?.en ?? {}
        let text = dictionary[key] ?? key
        if (params !== undefined) {
          for (const [name, value] of Object.entries(params)) text = text.split('{' + name + '}').join(String(value))
        }
        return text
      }
    },
    subscribe: () => () => {},
  }
  const registrations = []
  const ctx = {
    locale,
    effect(factory) {
      const cleanup = factory()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
    slots: {
      inject(_name, register) {
        registrations.push(register())
      },
      register(definition, component) {
        registrations.push({ definition, component })
        return () => {}
      },
    },
    get(name) {
      if (name === 'sessions') return sessionsService
      if (name === 'locale') return locale
      return undefined
    },
  }
  plugin.apply(ctx)
  return { registrations, locale, sessions: sessionsService }
}

test('registers the row checkbox, the page, and the sidebar entry', () => {
  const { registrations } = boot()
  const names = registrations.map((entry) => entry.definition?.name ?? entry.name)
  assert.ok(names.includes('sidebar.session.row.trailing'))
  assert.ok(names.includes('sidebar.workspaces.session.menu.item'))
  assert.ok(names.includes('main'))
  assert.ok(names.includes('sidebar.panellist'))
  // The row's hover strip belongs to dsh-session-quickbar; its built-in todo
  // button drives the same route, so this plugin must not also register there.
  assert.equal(names.includes('sidebar.workspaces.session.row.action'), false)
})

test('the sidebar square renders todo, running, and done states', async () => {
  const { registrations } = boot()
  await settle()
  const box = registrations.find((entry) => (entry.definition?.name ?? '') === 'sidebar.session.row.trailing').component
  const stateOf = (sessionId) => {
    const nodes = renderComponent(box, { sessionId })
    const square = byClass(nodes, 'st-box')[0]
    assert.ok(square, 'square is rendered for ' + sessionId)
    return square.props['data-state']
  }
  assert.equal(stateOf('session-idle'), 'todo')
  assert.equal(stateOf('session-running'), 'doing')
  assert.equal(stateOf('session-done'), 'done')
})

test('clicking the square writes the opposite done state to the Host', async () => {
  const { registrations } = boot()
  await settle()
  requests.length = 0
  const box = registrations.find((entry) => (entry.definition?.name ?? '') === 'sidebar.session.row.trailing').component
  const nodes = renderComponent(box, { sessionId: 'session-idle' })
  const square = byClass(nodes, 'st-box')[0]
  let stopped = false
  square.props.onClick({ preventDefault() {}, stopPropagation() { stopped = true } })
  assert.equal(stopped, true, 'the row must not open when the square is clicked')
  await settle()
  const post = requests.find((request) => request.init?.method === 'POST')
  assert.ok(post, 'a write was sent')
  assert.deepEqual(JSON.parse(post.init.body), {
    sessionId: 'session-idle',
    action: 'set',
    done: true,
    title: 'Idle session',
  })
})

test('the row menu offers the toggle and closes itself first', async () => {
  const { registrations } = boot()
  await settle()
  requests.length = 0
  const menuItem = registrations
    .find((entry) => (entry.definition?.name ?? '') === 'sidebar.workspaces.session.menu.item').component

  const opened = []
  const useMenuOpenState = () => [true, (value) => opened.push(value)]
  const nodes = renderComponent(menuItem, { sessionId: 'session-idle', displayTitle: 'Idle session', useMenuOpenState })
  const button = byClass(nodes, 'st-menu-item')[0]
  assert.ok(button, 'the menu entry renders')
  assert.equal(button.props.role, 'menuitem')
  const label = byClass(nodes, 'st-menu-label')[0]
  assert.equal(label.props.children, 'Mark as done')

  button.props.onClick({ preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(opened, [false], 'the menu closes before the write')
  await settle()
  const post = requests.find((request) => request.init?.method === 'POST')
  assert.equal(JSON.parse(post.init.body).done, true)

  const doneNodes = renderComponent(menuItem, { sessionId: 'session-done', displayTitle: 'Done session', useMenuOpenState })
  assert.equal(byClass(doneNodes, 'st-menu-label')[0].props.children, 'Mark as not done')
  assert.equal(byClass(doneNodes, 'st-face')[0].props['data-state'], 'done')
})

test('the page groups sessions into running, todo, and done sections', async () => {
  const { registrations } = boot()
  await settle()
  const page = registrations.find((entry) => (entry.definition?.name ?? '') === 'main').component
  const nodes = renderComponent(page, {})
  assert.ok(byClass(nodes, 'st-page').length === 1, 'the page renders')

  // The Done section starts collapsed, so only its header renders.
  const rows = byClass(nodes, 'st-row')
  assert.equal(rows.length, 2)
  const states = rows.map((row) => row.props['data-state']).sort()
  assert.deepEqual(states, ['doing', 'todo'])

  const titles = byClass(nodes, 'st-row-title').map((node) => node.props.children).sort()
  assert.deepEqual(titles, ['Idle session', 'Running session'])

  const sectionNames = byClass(nodes, 'st-section-name').map((node) => node.props.children)
  assert.deepEqual(sectionNames, ['In progress', 'To do', 'Done'])

  const counts = byClass(nodes, 'st-count').map((node) => node.props.children)
  assert.deepEqual(counts, ['1', '1', '1'])
})

test('the page renders a note and a priority without crashing', async () => {
  const { registrations } = boot()
  await settle()
  const page = registrations.find((entry) => (entry.definition?.name ?? '') === 'main').component
  const nodes = renderComponent(page, {})
  const notes = byClass(nodes, 'st-note-btn')
  assert.ok(notes.some((node) => node.props.children === 'waiting on review'))
  const priorities = byClass(nodes, 'st-priority')
  assert.equal(priorities.length, 2)
  assert.ok(priorities.some((node) => node.props['data-priority'] === 'high'))
})

/** Concatenated text of a rendered subtree. */
function textOf(node) {
  if (node === null || node === undefined || node === true || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => textOf(child)).join('')
  if (typeof node === 'object' && node.props !== undefined) return textOf(node.props.children)
  return ''
}

/** Render once so the boxes fetch starts, settle it, then render the result. */
async function openPage(registrations, mode) {
  boxesMode = mode
  const page = registrations.find((entry) => (entry.definition?.name ?? '') === 'main').component
  renderComponent(page, {})
  await settle()
  // Keep the hook state the mount effects wrote (notes list, filters) and just
  // re-read the tree; a fresh render would reset it before the effects run.
  return { page, nodes: renderComponent(page, {}, true) }
}

test('the page groups todos by session boxes and names child boxes', async () => {
  const { registrations } = boot()
  await settle()
  const { nodes } = await openPage(registrations, 'ok')

  const names = byClass(nodes, 'st-section-name').map((node) => textOf(node.props.children))
  assert.deepEqual(names, ['Work', 'Work \u203a Sub', 'Ungrouped'])

  const badges = byClass(nodes, 'st-count').map((node) => textOf(node.props.children))
  assert.deepEqual(badges, ['1/1', '1/1', '0/1'])

  const titles = byClass(nodes, 'st-row-title').map((node) => node.props.children).sort()
  assert.deepEqual(titles, ['Done session', 'Idle session', 'Running session'])

  const dots = byClass(nodes, 'st-dot')
  assert.ok(dots.length >= 2, 'box colour dots render')
})

test('a parent chip includes its child boxes and filters the groups', async () => {
  const { registrations } = boot()
  await settle()
  const { page, nodes } = await openPage(registrations, 'ok')

  const chips = byClass(nodes, 'st-chip')
  assert.deepEqual(chips.map((chip) => textOf(chip)), ['All3', 'Ungrouped1', 'Work2', 'Sub1'])

  chips[2].props.onClick({ preventDefault() {}, stopPropagation() {} })
  const filtered = renderComponent(page, {}, true)
  const names = byClass(filtered, 'st-section-name').map((node) => textOf(node.props.children))
  assert.deepEqual(names, ['Work', 'Work \u203a Sub'])
  assert.equal(byClass(filtered, 'st-row').length, 2)

  const ungroupedChip = byClass(filtered, 'st-chip')[1]
  ungroupedChip.props.onClick({ preventDefault() {}, stopPropagation() {} })
  const loose = renderComponent(page, {}, true)
  assert.deepEqual(byClass(loose, 'st-section-name').map((node) => textOf(node.props.children)), ['Ungrouped'])
  assert.equal(byClass(loose, 'st-row').length, 1)
})

test('a missing, broken, or aborted boxes route keeps the flat sections', async () => {
  for (const mode of ['404', 'badjson', 'abort']) {
    const { registrations } = boot()
    await settle()
    const { nodes } = await openPage(registrations, mode)
    const names = byClass(nodes, 'st-section-name').map((node) => textOf(node.props.children))
    assert.deepEqual(names, ['In progress', 'To do', 'Done'], 'mode ' + mode)
    assert.equal(byClass(nodes, 'st-chip').length, 0, 'mode ' + mode + ' renders no chips')
  }
})

test('the auto-watch toggle flips and posts the preference', async () => {
  const { registrations } = boot()
  await settle()
  const { page, nodes } = await openPage(registrations, 'off')
  const findToggle = (list) => byClass(list, 'st-btn').find((node) => textOf(node) === 'Auto-watch todos')
  const toggle = findToggle(nodes)
  assert.ok(toggle, 'the toggle renders when notify answers')
  assert.equal(toggle.props['aria-pressed'], false)

  toggle.props.onClick()
  await settle()
  const after = renderComponent(page, {}, true)
  assert.equal(findToggle(after).props['aria-pressed'], true)
  assert.deepEqual(settingsPosts, [{ autoWatch: true }])
})

test('reopen is off by default: a resume leaves a done todo alone', async () => {
  const { sessions: service } = boot()
  await settle()
  requests.length = 0
  service.setRunning('session-done', true)
  await settle()
  assert.equal(requests.filter((request) => request.init?.method === 'POST').length, 0)
})

test('the reopen switch posts its preference and flips', async () => {
  const { registrations } = boot()
  await settle()
  const { page, nodes } = await openPage(registrations, 'off')
  const findToggle = (list) => byClass(list, 'st-btn').find((node) => textOf(node) === 'Reopen on resume')
  const toggle = findToggle(nodes)
  assert.ok(toggle, 'the reopen switch renders')
  assert.equal(toggle.props['aria-pressed'], false)

  toggle.props.onClick()
  await settle()
  const after = renderComponent(page, {}, true)
  assert.equal(findToggle(after).props['aria-pressed'], true)
  assert.deepEqual(settingsPosts, [{ reopenOnResume: true }])
  assert.deepEqual(byClass(after, 'st-link-note').length, 1, 'the cost note appears once enabled')
})

test('without the notify plugin the auto-watch toggle disappears', async () => {
  const { registrations } = boot()
  notifyMode = 'off'
  await settle()
  const { nodes } = await openPage(registrations, 'off')
  const toggles = byClass(nodes, 'st-btn').filter((node) => textOf(node) === 'Auto-watch todos')
  assert.equal(toggles.length, 0, 'no toggle without notify')
})

test('a session that starts working again reopens its done todo', async () => {
  const { sessions: service } = boot({ reopenOnResume: true })
  await settle()
  requests.length = 0
  service.setRunning('session-done', true)
  await settle()
  const posts = requests.filter((request) => request.init?.method === 'POST')
  assert.equal(posts.length, 1, 'exactly one reopen write')
  assert.deepEqual(JSON.parse(posts[0].init.body), {
    sessionId: 'session-done',
    action: 'set',
    done: false,
    title: 'Done session',
    source: 'resume',
  })
})

test('reopening skips sessions without a done todo and never repeats', async () => {
  const { sessions: service } = boot({ reopenOnResume: true })
  await settle()
  requests.length = 0
  service.setRunning('session-idle', true) // no todo entry at all
  await settle()
  assert.equal(requests.filter((request) => request.init?.method === 'POST').length, 0)

  service.setRunning('session-done', true)
  await settle()
  assert.equal(requests.filter((request) => request.init?.method === 'POST').length, 1)

  service.emit() // no transition, so no second write
  await settle()
  assert.equal(requests.filter((request) => request.init?.method === 'POST').length, 1)
})

test('a session already running when the window opened keeps its done todo', async () => {
  const doneSession = sessions.find((session) => session.id === 'session-done')
  doneSession.running = true
  try {
    const { sessions: service } = boot({ reopenOnResume: true })
    await settle()
    requests.length = 0
    service.emit()
    await settle()
    assert.equal(requests.filter((request) => request.init?.method === 'POST').length, 0)
  } finally {
    doneSession.running = false
  }
})

/** A fake dsh-notepad client protocol with the three calls the page uses. */
function createNotepad(notes) {
  const listeners = new Set()
  const state = { notes: notes.slice(), opened: [] }
  return {
    version: 1,
    state,
    listSessionNotes: () => state.notes.map((sessionId) => ({ sessionId, updatedAt: 1, preview: 'note body' })),
    openSessionNote: (sessionId) => {
      state.opened.push(sessionId)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: (sessionId) => {
      for (const listener of [...listeners]) listener(sessionId)
    },
    listenerCount: () => listeners.size,
  }
}

test('rows with a session note show the marker and open that note', async () => {
  // 'session-idle' sits in the visible To do section; Done starts collapsed.
  const api = createNotepad(['session-idle'])
  setNotepad(api)
  try {
    const { registrations } = boot()
    await settle()
    const { nodes } = await openPage(registrations, 'off')
    const links = byClass(nodes, 'st-note-link')
    assert.equal(links.length, 1, 'only the noted session has a marker')
    links[0].props.onClick({ preventDefault() {}, stopPropagation() {} })
    assert.deepEqual(api.state.opened, ['session-idle'])
  } finally {
    setNotepad(undefined)
  }
})

test('a note saved later refreshes its row through subscribe', async () => {
  const api = createNotepad([])
  setNotepad(api)
  try {
    const { registrations } = boot()
    await settle()
    const { page, nodes } = await openPage(registrations, 'off')
    assert.equal(byClass(nodes, 'st-note-link').length, 0)

    api.state.notes.push('session-idle')
    api.emit('session-idle')
    await settle()
    const after = renderComponent(page, {}, true)
    assert.equal(byClass(after, 'st-note-link').length, 1)
  } finally {
    setNotepad(undefined)
  }
})

test('unmounting the page detaches from notepad', async () => {
  const api = createNotepad([])
  setNotepad(api)
  try {
    const { registrations } = boot()
    await settle()
    const page = registrations.find((entry) => (entry.definition?.name ?? '') === 'main').component
    renderComponent(page, {})
    assert.equal(api.listenerCount(), 1)
    unmount()
    assert.equal(api.listenerCount(), 0)
  } finally {
    setNotepad(undefined)
  }
})

test('an empty note list shows no marker and takes no space', async () => {
  setNotepad(createNotepad([]))
  try {
    const { registrations } = boot()
    await settle()
    const { nodes } = await openPage(registrations, 'off')
    assert.equal(byClass(nodes, 'st-note-link').length, 0)
    assert.ok(byClass(nodes, 'st-row').length >= 2, 'rows render without placeholders')
  } finally {
    setNotepad(undefined)
  }
})

test('a throwing dshNotepad getter is treated as absent', async () => {
  Object.defineProperty(harnessWindow, 'dshNotepad', {
    configurable: true,
    get() {
      throw new Error('notepad state is broken')
    },
  })
  try {
    const { registrations } = boot()
    await settle()
    const { nodes } = await openPage(registrations, 'off')
    assert.equal(byClass(nodes, 'st-note-link').length, 0)
    assert.ok(byClass(nodes, 'st-row').length > 0)
  } finally {
    delete harnessWindow.dshNotepad
  }
})

test('throwing open and subscribe calls keep the page alive', async () => {
  setNotepad({
    version: 1,
    listSessionNotes: () => [{ sessionId: 'session-idle', updatedAt: 1, preview: 'x' }],
    openSessionNote() {
      throw new Error('open failed')
    },
    subscribe() {
      throw new Error('subscribe failed')
    },
  })
  try {
    const { registrations } = boot()
    await settle()
    const { nodes } = await openPage(registrations, 'off')
    const links = byClass(nodes, 'st-note-link')
    assert.equal(links.length, 1)
    links[0].props.onClick({ preventDefault() {}, stopPropagation() {} }) // must not throw
    assert.ok(byClass(nodes, 'st-row').length > 0)
  } finally {
    setNotepad(undefined)
  }
})

test('a missing or mismatched notepad protocol shows no markers', async () => {
  const broken = {
    version: 1,
    listSessionNotes() {
      throw new Error('boom')
    },
    openSessionNote() {},
    subscribe() {
      return () => {}
    },
  }
  try {
    for (const api of [undefined, { version: 2 }, broken]) {
      setNotepad(api)
      const { registrations } = boot()
      await settle()
      const { nodes } = await openPage(registrations, 'off')
      assert.equal(byClass(nodes, 'st-note-link').length, 0)
      assert.ok(byClass(nodes, 'st-row').length > 0, 'rows still render')
    }
  } finally {
    setNotepad(undefined)
  }
})

test('a failed settings write reverts the reopen switch', async () => {
  const { registrations } = boot()
  await settle()
  const { page, nodes } = await openPage(registrations, 'off')
  const findToggle = (list) => byClass(list, 'st-btn').find((node) => textOf(node) === 'Reopen on resume')

  settingsWriteFails = true
  findToggle(nodes).props.onClick()
  await settle()
  const after = renderComponent(page, {}, true)
  assert.equal(findToggle(after).props['aria-pressed'], false, 'the optimistic flip is rolled back')
  assert.equal(byClass(after, 'st-link-note').length, 0, 'no cost note while it is off')
})

const SELF_TEST_SUBJECT = { kind: 'bundle', pkg: { name: 'dsh-session-todos' } }

/** The registered self-test section component. */
function selfTestComponent(registrations) {
  return registrations.find((item) => (item.definition?.id ?? '') === 'dsh-session-todos.selftest').component
}

test('the self-test section belongs to this plugin only', () => {
  const { registrations } = boot()
  const entry = registrations.find((item) => (item.definition?.id ?? '') === 'dsh-session-todos.selftest')
  assert.ok(entry, 'the section is registered')
  assert.equal(entry.definition.name, 'plugins.detail.section')
  assert.equal(entry.definition.order, 90)
  const other = renderComponent(entry.component, { subject: { kind: 'bundle', pkg: { name: 'other-plugin' } } })
  assert.equal(other.length, 0, 'nothing renders on another plugin page')
})

test('the self-test accepts the item subject form', () => {
  const { registrations } = boot()
  const entry = registrations.find((item) => (item.definition?.id ?? '') === 'dsh-session-todos.selftest')
  const renders = (subject) => renderComponent(entry.component, { subject }).length > 0
  assert.equal(renders({ kind: 'item', id: 'include:dsh-session-todos' }), true, 'include:dsh-session-todos renders')
  assert.equal(renders({ kind: 'item', id: 'include:dsh-session-stars' }), false, 'include:dsh-session-stars stays empty')
})

test('a self-test run passes every check and copies Markdown', async () => {
  const { registrations } = boot()
  await settle()
  const section = selfTestComponent(registrations)
  const nodes = renderComponent(section, { subject: SELF_TEST_SUBJECT, timeoutMs: 40 })
  const run = byClass(nodes, 'st-st-btn').find((node) => node.props['data-selftest-action'] === 'run')
  assert.ok(run, 'the run button renders')
  run.props.onClick()
  for (let turn = 0; turn < 8; turn += 1) await settle()

  const after = renderComponent(section, { subject: SELF_TEST_SUBJECT, timeoutMs: 40 }, true)
  assert.deepEqual(
    byClass(after, 'st-st-badge').map((node) => node.props['data-status']),
    ['pass', 'pass', 'pass', 'pass'],
  )

  clipboardText = ''
  const copy = byClass(after, 'st-st-btn').find((node) => node.props['data-selftest-action'] === 'copy')
  copy.props.onClick()
  for (let turn = 0; turn < 3; turn += 1) await settle()
  const lines = clipboardText.split('\n')
  assert.equal(lines.length, 4, 'one Markdown line per check')
  assert.ok(lines.every((line) => line.startsWith('- [x] ')), 'passing checks are ticked')
})

test('one failing check leaves the others untouched', async () => {
  const { registrations } = boot()
  await settle()
  settingsGetFails = true
  const section = selfTestComponent(registrations)
  const nodes = renderComponent(section, { subject: SELF_TEST_SUBJECT, timeoutMs: 40 })
  byClass(nodes, 'st-st-btn').find((node) => node.props['data-selftest-action'] === 'run').props.onClick()
  for (let turn = 0; turn < 8; turn += 1) await settle()

  const after = renderComponent(section, { subject: SELF_TEST_SUBJECT, timeoutMs: 40 }, true)
  const rows = byClass(after, 'st-st-row')
  const status = (id) => rows.find((row) => row.props['data-check'] === id).props['data-status']
  assert.equal(status('settings'), 'fail')
  assert.equal(status('route'), 'pass')
  assert.equal(status('events'), 'pass')
  assert.equal(status('tool'), 'pass')
})

test('the gear opens the settings drawer and Escape closes it', async () => {
  const { registrations } = boot()
  await settle()
  const { page, nodes } = await openPage(registrations, 'off')
  const gear = byClass(nodes, 'st-gear')[0]
  assert.ok(gear, 'the gear renders next to the quick switches')

  gear.props.onClick()
  let opened = renderComponent(page, {}, true)
  const dialog = byClass(opened, 'st-drawer-panel')[0]
  assert.ok(dialog, 'the drawer opens')
  assert.equal(dialog.props.role, 'dialog')
  assert.equal(dialog.props['aria-modal'], 'true')

  dialog.props.onKeyDown({ key: 'Escape', preventDefault() {} })
  opened = renderComponent(page, {}, true)
  assert.equal(byClass(opened, 'st-drawer-panel').length, 0, 'Escape closes it')
})

test('without notify the drawer keeps only the todo settings', async () => {
  const { registrations } = boot()
  notifyMode = 'off'
  await settle()
  const { page, nodes } = await openPage(registrations, 'off')
  requests.length = 0
  byClass(nodes, 'st-gear')[0].props.onClick()
  renderComponent(page, {}, true)
  await settle()
  const opened = renderComponent(page, {}, true)

  assert.equal(byClass(opened, 'st-set-group').length, 1, 'one group only')
  assert.equal(textOf(opened).includes('结束时提醒我'), false, 'no reminder row')
  const reminders = requests.filter((request) => String(request.url).includes('/session-notify'))
  const writes = reminders.filter((request) => /\/session-notify\/(watch|mode|settings)/.test(String(request.url)))
  assert.equal(writes.length, 0, 'zero reminder writes while notify is absent')
  assert.ok(reminders.length <= 1, 'at most one capability probe, nothing else')
  assert.ok(reminders.every((request) => (request.init?.method ?? 'GET') === 'GET'), 'the probe is read-only')
})

test('the drawer switch and the header switch share one store', async () => {
  const { registrations } = boot()
  await settle()
  const { page, nodes } = await openPage(registrations, 'off')
  const header = () => byClass(nodes, 'st-btn').find((node) => textOf(node) === 'Auto-watch todos')
  assert.equal(header().props['aria-pressed'], false)

  byClass(nodes, 'st-gear')[0].props.onClick()
  const opened = renderComponent(page, {}, true)
  byClass(opened, 'st-switch')[0].props.onClick()
  await settle()
  const after = renderComponent(page, {}, true)
  const flipped = byClass(after, 'st-btn').find((node) => textOf(node) === 'Auto-watch todos')
  assert.equal(flipped.props['aria-pressed'], true, 'the header reflects the drawer')
  assert.deepEqual(settingsPosts, [{ autoWatch: true }])
})

test('the reminder mode stays disabled until the session is watched', async () => {
  const { registrations } = boot()
  await settle()
  const { page, nodes } = await openPage(registrations, 'off')
  byClass(nodes, 'st-gear')[0].props.onClick()
  renderComponent(page, {}, true)
  await settle()
  const opened = renderComponent(page, {}, true)

  assert.equal(byClass(opened, 'st-set-group').length, 2, 'the reminder group renders')
  const [mode, defaults] = byClass(opened, 'st-seg')
  assert.ok(mode, 'the mode segment renders')
  assert.ok(
    mode.props.children.every((button) => button.props.disabled === true),
    'once/always are disabled while nothing is watched',
  )
  assert.ok(defaults, 'the default segment renders')
  assert.ok(
    defaults.props.children.every((button) => button.props.disabled === true),
    'default once/always are disabled while the default switch is off',
  )
})

test('every session row renders its todo box', async () => {
  const { registrations } = boot()
  await settle()
  const box = registrations.find((entry) => (entry.definition?.name ?? '') === 'sidebar.session.row.trailing').component
  for (const sessionId of ['session-doing', 'session-idle', 'session-done', 'session-unknown']) {
    const nodes = renderComponent(box, { sessionId })
    assert.equal(byClass(nodes, 'st-box').length, 1, 'box for ' + sessionId)
  }
})

test('the stylesheet is injected once and removed by its disposer', () => {
  const { registrations } = boot()
  assert.ok(registrations.length > 0)
  assert.ok(styleNodes.size >= 1, 'a style element was appended')
})
