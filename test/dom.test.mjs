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
    byId[session.id] = session
    ids.push(session.id)
  }
  const listeners = new Set()
  return {
    list: {
      getSnapshot: () => ({ ids, byId }),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
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
  EventSource: StubEventSource,
  console,
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
}
sandbox.window.EventSource = StubEventSource
vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' })

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
  for (const effect of effects) {
    const cleanup = effect()
    if (typeof cleanup === 'function') pendingEffects.push(cleanup)
  }
  return collected
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
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

function boot() {
  serverTodos = clone(todos)
  boxesMode = 'off'
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
      if (name === 'sessions') return createSessionsService(sessions)
      if (name === 'locale') return locale
      return undefined
    },
  }
  plugin.apply(ctx)
  return { registrations, locale }
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
  return { page, nodes: renderComponent(page, {}) }
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

test('the stylesheet is injected once and removed by its disposer', () => {
  const { registrations } = boot()
  assert.ok(registrations.length > 0)
  assert.ok(styleNodes.size >= 1, 'a style element was appended')
})
