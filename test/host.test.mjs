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
  return { tools, routes }
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
  assert.equal(stored.version, 1)
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

test('the events route is registered', (t) => {
  const home = createHome(t)
  const host = createHost(home)
  assert.equal(typeof host.routes.get('/session-todos/events'), 'function')
})
