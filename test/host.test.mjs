import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import { apply, name } from '../index.js'

/** A Host context stub that captures the agent tool and the web routes. */
function createHost(file) {
  const tools = []
  const routes = new Map()
  const handlers = new Map()
  const ctx = {
    get: (key) => (key === 'dshHomePath' ? (suffix) => join(file.dir, suffix) : undefined),
    effect: (factory) => {
      factory()
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    inject: (services, run) => {
      const scope = {
        webServer: {
          register(route) {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        },
        effect: (factory) => {
          factory()
        },
      }
      run(scope)
    },
  }
  apply(ctx)
  return {
    tools,
    routes,
    emit(event, session, payload) {
      for (const handler of handlers.get(event) ?? []) handler(session, payload)
    },
  }
}

/** Write one todo through the Host route and return the stored map. */
async function setTodo(host, sessionId, patch) {
  const response = await call(host.routes.get('/session-todos'), 'POST', Object.assign({ action: 'set', sessionId }, patch))
  assert.equal(response.status, 200, JSON.stringify(response.json))
  return response.json.todos
}

/** Read one stored todo back through the Host route. */
async function readTodo(host, sessionId) {
  const response = await call(host.routes.get('/session-todos'), 'GET')
  return response.json.todos[sessionId]
}

/** Deliver one durable turn end and let the handler finish. */
async function emitTurnEnd(host, sessionId, kind) {
  host.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { reason: { kind } } })
  await new Promise((resolve) => setImmediate(resolve))
}

/** One response stub that keeps the status, headers, and body. */
function createResponse() {
  const chunks = []
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      response.statusCode = status
      Object.assign(response.headers, headers ?? {})
      return response
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk))
      response.body = Buffer.concat(chunks).toString('utf8')
    },
    destroy() {},
    on() {},
  }
  return response
}

/** One request stub carrying a JSON body. */
function createRequest(method, body, headers = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  request.method = method
  request.headers = { host: '127.0.0.1:64133', ...headers }
  return request
}

/** Call one route handler and return its decoded response. */
async function call(handler, method, body, headers) {
  const response = createResponse()
  await handler(createRequest(method, body === undefined ? undefined : JSON.stringify(body), headers), response)
  return { status: response.statusCode, headers: response.headers, json: response.body === '' ? null : JSON.parse(response.body) }
}

/** A fresh temporary home directory per test. */
function createHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'session-todos-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, file: join(dir, 'session-todos.json') }
}

test('exports the plugin name', () => {
  assert.equal(name, 'dsh-session-todos')
})

test('session_todos ships a JSON Schema object root, not a bare property table', (t) => {
  const host = createHost(createHome(t))
  const tool = host.tools.find((candidate) => candidate.name === 'session_todos')
  assert.ok(tool, 'session_todos tool is registered')
  const parameters = tool.parameters

  // A bare table would put property names at the top level; then a property
  // named `title` is read as the JSON Schema `title` keyword and the whole
  // request fails with 400. Pin the root shape so that cannot come back.
  assert.deepEqual(Object.keys(parameters).sort(), ['properties', 'required', 'type'])
  assert.equal(parameters.type, 'object')
  assert.ok(parameters.properties !== null && typeof parameters.properties === 'object' && !Array.isArray(parameters.properties))

  assert.ok(Array.isArray(parameters.required))
  for (const name of parameters.required) {
    assert.ok(Object.hasOwn(parameters.properties, name), 'required entry ' + name + ' must exist in properties')
  }

  for (const [name, spec] of Object.entries(parameters.properties)) {
    assert.ok(spec !== null && typeof spec === 'object' && !Array.isArray(spec), name + ' must be a schema object')
    assert.equal(Object.hasOwn(spec, 'required'), false, name + ' must not carry a property-level required')
    assert.equal(typeof spec.type, 'string', name + ' must declare a single string type')
    assert.notEqual(Array.isArray(spec.type), true, name + ' must not use an array type')
    if (Object.hasOwn(spec, 'enum')) {
      assert.ok(Array.isArray(spec.enum) && spec.enum.length > 0, name + ' enum must be a non-empty array')
      for (const value of spec.enum) assert.equal(typeof value, 'string', name + ' enum values must be strings')
    }
  }

  // The result schema has the same constraint.
  assert.deepEqual(tool.output.schema, { type: 'object' })
})

test('the agent tool marks a session done and lists it', async (t) => {
  const home = createHome(t)
  const host = createHost(home)
  const tool = host.tools.find((candidate) => candidate.name === 'session_todos')
  assert.ok(tool, 'session_todos tool is registered')

  const set = await tool.execute({ action: 'set', sessionId: 'session-a', done: true, title: 'Demo session' }, { agent: { id: 'session-a' } })
  assert.equal(set.ok, true)
  assert.equal(set.todo.done, true)
  assert.equal(set.todo.title, 'Demo session')
  assert.ok(set.todo.doneAt > 0)

  const listed = await tool.execute({ action: 'list' }, {})
  assert.equal(listed.count, 1)
  assert.equal(listed.todos[0].sessionId, 'session-a')

  const doneOnly = await tool.execute({ action: 'list', state: 'done' }, {})
  assert.equal(doneOnly.count, 1)
  const todoOnly = await tool.execute({ action: 'list', state: 'todo' }, {})
  assert.equal(todoOnly.count, 0)
})

test('note, priority, and due date persist to disk', async (t) => {
  const home = createHome(t)
  const host = createHost(home)
  const tool = host.tools.find((candidate) => candidate.name === 'session_todos')

  const result = await tool.execute({
    action: 'set',
    sessionId: 'session-b',
    note: '  ship the plugin  ',
    priority: 'high',
    dueAt: '2026-11-20',
  }, {})
  assert.equal(result.ok, true)
  assert.equal(result.todo.note, 'ship the plugin')
  assert.equal(result.todo.priority, 'high')
  assert.equal(result.todo.dueAt, Date.parse('2026-11-20'))

  const stored = JSON.parse(readFileSync(home.file, 'utf8'))
  assert.equal(stored.version, 2)
  assert.equal(stored.todos['session-b'].priority, 'high')
  assert.equal(stored.todos['session-b'].note, 'ship the plugin')

  // A second Host instance reads the same file back.
  const second = createHost(home)
  const secondTool = second.tools.find((candidate) => candidate.name === 'session_todos')
  const listed = await secondTool.execute({ action: 'list' }, {})
  assert.equal(listed.count, 1)
  assert.equal(listed.todos[0].sessionId, 'session-b')
})

test('an untouched session is dropped instead of stored', async (t) => {
  const home = createHome(t)
  const host = createHost(home)
  const tool = host.tools.find((candidate) => candidate.name === 'session_todos')

  await tool.execute({ action: 'set', sessionId: 'session-c', done: true }, {})
  await tool.execute({ action: 'set', sessionId: 'session-c', done: false }, {})
  const listed = await tool.execute({ action: 'list' }, {})
  assert.equal(listed.count, 0)
})

test('clear forgets one todo', async (t) => {
  const home = createHome(t)
  const host = createHost(home)
  const tool = host.tools.find((candidate) => candidate.name === 'session_todos')

  await tool.execute({ action: 'set', sessionId: 'session-d', note: 'hello' }, {})
  const cleared = await tool.execute({ action: 'clear', sessionId: 'session-d' }, {})
  assert.equal(cleared.ok, true)
  assert.equal(cleared.todos.length, 0)
})

test('set without sessionId uses the calling session', async (t) => {
  const home = createHome(t)
  const host = createHost(home)
  const tool = host.tools.find((candidate) => candidate.name === 'session_todos')

  const result = await tool.execute({ action: 'set', done: true }, { agent: { id: 'session-caller' } })
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'session-caller')
})

test('set rejects an empty change set and a bad priority', async (t) => {
  const home = createHome(t)
  const host = createHost(home)
  const tool = host.tools.find((candidate) => candidate.name === 'session_todos')

  const empty = await tool.execute({ action: 'set', sessionId: 'session-e' }, {})
  assert.equal(empty.ok, false)
  const bad = await tool.execute({ action: 'set', sessionId: 'session-e', priority: 'urgent' }, {})
  assert.equal(bad.ok, false)
  const badDate = await tool.execute({ action: 'set', sessionId: 'session-e', dueAt: 'tomorrow-ish' }, {})
  assert.equal(badDate.ok, false)
})

test('the browser route reads and writes the same todos', async (t) => {
  const home = createHome(t)
  const host = createHost(home)
  const handler = host.routes.get('/session-todos')
  assert.equal(typeof handler, 'function')

  const empty = await call(handler, 'GET')
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json, { ok: true, todos: {} })

  const created = await call(handler, 'POST', { sessionId: 'session-route', done: true, title: 'Route session' })
  assert.equal(created.status, 200)
  assert.equal(created.json.todos['session-route'].done, true)
  assert.equal(created.json.todos['session-route'].title, 'Route session')

  const read = await call(handler, 'GET')
  assert.equal(read.json.todos['session-route'].done, true)

  const cleared = await call(handler, 'POST', { sessionId: 'session-route', action: 'clear' })
  assert.equal(cleared.status, 200)
  assert.equal(Object.keys(cleared.json.todos).length, 0)
})

test('the browser route refuses invalid and cross-site payloads', async (t) => {
  const home = createHome(t)
  const host = createHost(home)
  const handler = host.routes.get('/session-todos')

  const noId = await call(handler, 'POST', { done: true })
  assert.equal(noId.status, 400)

  const badJson = await call(handler, 'POST', 'not an object')
  assert.equal(badJson.status, 400)

  const crossSite = await call(handler, 'POST', { sessionId: 'x', done: true }, { origin: 'https://evil.example' })
  assert.equal(crossSite.status, 403)

  const wrongMethod = await call(handler, 'DELETE')
  assert.equal(wrongMethod.status, 405)
})

test('a completed turn puts back the check a resume removed', async (t) => {
  const host = createHost(createHome(t))
  await call(host.routes.get('/session-todos/settings'), 'POST', { reopenOnResume: true })
  const settingsAfter = await call(host.routes.get('/session-todos/settings'), 'GET')
  assert.equal(settingsAfter.json.reopenOnResume, true, 'the switch persists')
  await setTodo(host, 'session-a', { done: true, note: 'remember' })
  await setTodo(host, 'session-a', { done: false, source: 'resume' })
  let entry = await readTodo(host, 'session-a')
  assert.equal(entry.done, false)
  assert.equal(entry.reopenedByRun, true, 'the resume marker is recorded')

  await emitTurnEnd(host, 'session-a', 'completed')
  entry = await readTodo(host, 'session-a')
  assert.equal(entry.done, true, 'the check comes back')
  assert.equal(entry.reopenedByRun, false, 'the marker is cleared')
})

test('an error turn leaves the reopened todo unchecked', async (t) => {
  const host = createHost(createHome(t))
  await call(host.routes.get('/session-todos/settings'), 'POST', { reopenOnResume: true })
  await setTodo(host, 'session-a', { done: true, note: 'remember' })
  await setTodo(host, 'session-a', { done: false, source: 'resume' })
  await emitTurnEnd(host, 'session-a', 'error')
  const entry = await readTodo(host, 'session-a')
  assert.equal(entry.done, false)
  assert.equal(entry.reopenedByRun, true)
})

test('an aborted turn leaves the reopened todo unchecked', async (t) => {
  const host = createHost(createHome(t))
  await call(host.routes.get('/session-todos/settings'), 'POST', { reopenOnResume: true })
  await setTodo(host, 'session-a', { done: true, note: 'remember' })
  await setTodo(host, 'session-a', { done: false, source: 'resume' })
  await emitTurnEnd(host, 'session-a', 'aborted')
  const entry = await readTodo(host, 'session-a')
  assert.equal(entry.done, false)
})

test('a manual uncheck is not restored by a completed turn', async (t) => {
  const host = createHost(createHome(t))
  await call(host.routes.get('/session-todos/settings'), 'POST', { reopenOnResume: true })
  await setTodo(host, 'session-a', { done: true, note: 'remember' })
  await setTodo(host, 'session-a', { done: false })
  const before = await readTodo(host, 'session-a')
  assert.equal(before.reopenedByRun, false, 'a manual uncheck carries no marker')
  await emitTurnEnd(host, 'session-a', 'completed')
  const entry = await readTodo(host, 'session-a')
  assert.equal(entry.done, false, 'the person meant it')
})

test('reopenOnResume off never records the marker', async (t) => {
  const host = createHost(createHome(t))
  await setTodo(host, 'session-a', { done: true, note: 'remember' })
  await setTodo(host, 'session-a', { done: false, source: 'resume' })
  const before = await readTodo(host, 'session-a')
  assert.equal(before.reopenedByRun, false, 'the switch is off')
  await emitTurnEnd(host, 'session-a', 'completed')
  const entry = await readTodo(host, 'session-a')
  assert.equal(entry.done, false)
})

test('a repeated turn end only restores once', async (t) => {
  const host = createHost(createHome(t))
  await call(host.routes.get('/session-todos/settings'), 'POST', { reopenOnResume: true })
  await setTodo(host, 'session-a', { done: true, note: 'remember' })
  await setTodo(host, 'session-a', { done: false, source: 'resume' })
  await emitTurnEnd(host, 'session-a', 'completed')
  assert.equal((await readTodo(host, 'session-a')).done, true)

  // A second copy of the same event finds no marker, so a later manual uncheck
  // is not undone by it either.
  await setTodo(host, 'session-a', { done: false })
  await emitTurnEnd(host, 'session-a', 'completed')
  const entry = await readTodo(host, 'session-a')
  assert.equal(entry.done, false, 'the duplicate event does nothing')
})

test('the health route reports the registered tool', async (t) => {
  const home = createHome(t)
  const host = createHost(home)
  const health = host.routes.get('/session-todos/health')
  assert.equal(typeof health, 'function')

  const ok = await call(health, 'GET')
  assert.deepEqual(ok.json, { ok: true, tool: 'session_todos', registered: true })

  assert.equal((await call(health, 'POST')).status, 405)
  assert.equal((await call(health, 'GET', undefined, { origin: 'https://evil.example' })).status, 403)
})

test('the events route is registered', (t) => {
  const home = createHome(t)
  const host = createHost(home)
  assert.equal(typeof host.routes.get('/session-todos/events'), 'function')
})

/* ------------------------------------------------------------------ *
 * Auto-watch linkage with dsh-session-notify
 * ------------------------------------------------------------------ */

const watchCalls = []
let watchMode = 'ok'

/** Replace global fetch with a recorder for the notify watch route. */
function installWatchStub() {
  watchCalls.length = 0
  watchMode = 'ok'
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (!target.includes('/session-notify/watch')) throw new Error('unexpected fetch ' + target)
    const body = JSON.parse(init.body)
    watchCalls.push({ url: target, body })
    if (watchMode === '404') return { ok: false, status: 404, json: async () => ({ ok: false }) }
    if (watchMode === 'badjson') return { ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } }
    if (watchMode === 'abort') throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: body.sessionId, watching: body.on === true }) }
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The persisted ownership list, read straight from the todo file. */
const storedWatches = (file) => JSON.parse(readFileSync(file, 'utf8')).autoWatched

/** Poll until the predicate holds; the store fires watch calls in the background. */
async function waitFor(predicate, label, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error('timeout waiting for ' + label)
}

test('auto-watch is off by default and watches an open todo once enabled', async (t) => {
  const home = createHome(t)
  installWatchStub()
  const host = createHost(home)
  const handler = host.routes.get('/session-todos')
  const settings = host.routes.get('/session-todos/settings')
  assert.equal(typeof settings, 'function', 'settings route is registered')

  const before = await call(settings, 'GET')
  assert.deepEqual(before.json, { ok: true, autoWatch: false, reopenOnResume: false, autoWatched: [] })

  await call(handler, 'POST', { sessionId: 'session-watch', done: false, note: 'open' })
  await delay(40)
  assert.equal(watchCalls.length, 0, 'no watch while the toggle is off')

  const enabled = await call(settings, 'POST', { on: true })
  assert.equal(enabled.status, 200)
  assert.equal(enabled.json.autoWatch, true)

  await call(handler, 'POST', { sessionId: 'session-watch', done: false, note: 'open again' })
  await waitFor(() => watchCalls.length === 1, 'the first watch call')
  assert.deepEqual(watchCalls[0].body, { sessionId: 'session-watch', on: true })

  // A second patch on the same open todo must not watch again.
  await call(handler, 'POST', { sessionId: 'session-watch', done: false, note: 'third' })
  await delay(60)
  assert.equal(watchCalls.length, 1, 'watch is idempotent')

  await waitFor(() => storedWatches(home.file).length === 1, 'ownership recorded')
  const stored = JSON.parse(readFileSync(home.file, 'utf8'))
  assert.deepEqual(stored.autoWatched, ['session-watch'])
  assert.equal(stored.autoWatch, true)

  // Marking it done releases the watch and the ownership record.
  await call(handler, 'POST', { sessionId: 'session-watch', done: true })
  await waitFor(() => watchCalls.length === 2, 'the release call')
  assert.deepEqual(watchCalls[1].body, { sessionId: 'session-watch', on: false })
  await waitFor(() => storedWatches(home.file).length === 0, 'ownership released')
})

test('clearing a todo releases only the watch this plugin created', async (t) => {
  const home = createHome(t)
  installWatchStub()
  const host = createHost(home)
  const handler = host.routes.get('/session-todos')
  const settings = host.routes.get('/session-todos/settings')
  await call(settings, 'POST', { on: true })
  await call(handler, 'POST', { sessionId: 'session-owned', done: false, note: 'x' })
  await waitFor(() => watchCalls.length === 1, 'watch on')

  await call(handler, 'POST', { sessionId: 'session-owned', action: 'clear' })
  await waitFor(() => watchCalls.length === 2, 'watch off')
  assert.deepEqual(watchCalls[1].body, { sessionId: 'session-owned', on: false })
  await waitFor(() => storedWatches(home.file).length === 0, 'ownership released')
})

test('turning auto-watch off releases the watches it created', async (t) => {
  const home = createHome(t)
  installWatchStub()
  const host = createHost(home)
  const handler = host.routes.get('/session-todos')
  const settings = host.routes.get('/session-todos/settings')
  await call(settings, 'POST', { on: true })
  await call(handler, 'POST', { sessionId: 'session-off', done: false, note: 'x' })
  await waitFor(() => watchCalls.length === 1, 'watch on')

  await call(settings, 'POST', { on: false })
  await waitFor(() => watchCalls.length === 2, 'release on disable')
  assert.deepEqual(watchCalls[1].body, { sessionId: 'session-off', on: false })
  await waitFor(() => storedWatches(home.file).length === 0, 'ownership released')
})

test('a missing or broken notify route never blocks the todo', async (t) => {
  for (const mode of ['404', 'badjson', 'abort']) {
    const home = createHome(t)
    installWatchStub()
    watchMode = mode
    const host = createHost(home)
    const handler = host.routes.get('/session-todos')
    const settings = host.routes.get('/session-todos/settings')
    await call(settings, 'POST', { on: true })

    const saved = await call(handler, 'POST', { sessionId: 'session-degraded', done: false, note: 'still saved' })
    assert.equal(saved.status, 200, 'mode ' + mode)
    assert.equal(saved.json.todos['session-degraded'].note, 'still saved', 'mode ' + mode)
    await delay(80)
    assert.deepEqual(JSON.parse(readFileSync(home.file, 'utf8')).autoWatched, [], 'mode ' + mode + ' records no ownership')
  }
})

test('the reopen preference persists and validates', async (t) => {
  const home = createHome(t)
  const host = createHost(home)
  const settings = host.routes.get('/session-todos/settings')

  const saved = await call(settings, 'POST', { reopenOnResume: true })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.reopenOnResume, true)
  assert.equal(saved.json.autoWatch, false)

  const read = await call(settings, 'GET')
  assert.equal(read.json.reopenOnResume, true)
  assert.equal(JSON.parse(readFileSync(home.file, 'utf8')).reopenOnResume, true)

  const both = await call(settings, 'POST', { autoWatch: true, reopenOnResume: false })
  assert.equal(both.json.autoWatch, true)
  assert.equal(both.json.reopenOnResume, false)

  assert.equal((await call(settings, 'POST', { reopenOnResume: 'yes' })).status, 400)
  assert.equal((await call(settings, 'POST', {})).status, 400)
})

test('with auto-watch on, reopening a done todo watches the session', async (t) => {
  const home = createHome(t)
  installWatchStub()
  const host = createHost(home)
  const handler = host.routes.get('/session-todos')
  const settings = host.routes.get('/session-todos/settings')
  await call(settings, 'POST', { autoWatch: true, reopenOnResume: true })

  await call(handler, 'POST', { sessionId: 'session-reopen', done: true })
  await delay(40)
  const before = watchCalls.length

  // This is exactly what the client writes when a session resumes.
  await call(handler, 'POST', { sessionId: 'session-reopen', done: false })
  await waitFor(() => watchCalls.length === before + 1, 'the reopen watch')
  assert.deepEqual(watchCalls[before].body, { sessionId: 'session-reopen', on: true })
})

test('the settings route validates its payload', async (t) => {
  const home = createHome(t)
  const host = createHost(home)
  const settings = host.routes.get('/session-todos/settings')
  const bad = await call(settings, 'POST', { on: 'yes' })
  assert.equal(bad.status, 400)
  const wrong = await call(settings, 'DELETE')
  assert.equal(wrong.status, 405)
  const crossSite = await call(settings, 'POST', { on: true }, { origin: 'https://evil.example' })
  assert.equal(crossSite.status, 403)
})
