/**
 * dsh-session-todos — Host half.
 *
 * Durable per-session todos for the DeepSeek Harness Web UI. Every session row
 * gets a checkbox in the browser half; the state (done, note, priority, due
 * date) lives in one JSON file under the DSH home, so it survives restarts,
 * window reloads, and web-server port changes.
 *
 *  - GET  /session-todos         returns the whole todo map;
 *  - POST /session-todos         applies one mutation and returns the map;
 *  - GET  /session-todos/events  pushes each committed map (Server-Sent Events);
 *  - the session_todos tool exposes the same data to agents.
 *
 * @module dsh-session-todos
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-session-todos'

/** Required Host services; the web route additionally waits for 'webServer'. */
export const inject = ['tools']

/** Same-origin route the browser half talks to. */
const ROUTE = '/session-todos'
/** Server-Sent Events route that pushes todo changes to every window. */
const EVENTS_ROUTE = '/session-todos/events'
/** SSE heartbeat interval; keeps idle proxies and sockets alive. */
const SSE_HEARTBEAT_MS = 20_000
/** Todo file format version; 2 added autoWatch and autoWatched. */
const FILE_VERSION = 2
/** Browser route that reads and writes the auto-watch preference. */
const SETTINGS_ROUTE = '/session-todos/settings'
/** Tiny read-only route used by the plugin detail self-test. */
const HEALTH_ROUTE = '/session-todos/health'
/** dsh-session-notify's watch route; absent peers degrade silently. */
const NOTIFY_WATCH_ROUTE = '/session-notify/watch'
/** Watch call timeout; a slow peer must not hold the todo mutation. */
const WATCH_TIMEOUT_MS = 1500
/** Request-body ceiling for the browser route. */
const MAX_BODY_BYTES = 64 * 1024
/** Longest session id accepted (session ids are UUIDs, far shorter). */
const MAX_SESSION_ID_LENGTH = 200
/** Longest stored note. */
const MAX_NOTE_LENGTH = 2000
/** Longest cached session title. */
const MAX_TITLE_LENGTH = 200
/** Accepted priority values, lowest first. */
const PRIORITIES = ['low', 'normal', 'high']
/** Priority of a todo the user never touched. */
const DEFAULT_PRIORITY = 'normal'

/** One warning sink that reports each distinct failure once. */
function createLogger() {
  const seen = new Set()
  return (message, error) => {
    const key = error === undefined ? message : message + ': ' + (error?.code ?? error?.message ?? String(error))
    if (seen.has(key)) return
    seen.add(key)
    if (error !== undefined) console.warn('[session-todos] ' + message, error)
    else console.warn('[session-todos] ' + message)
  }
}

/** A non-negative integer timestamp, or 0 when the value is unusable. */
function toTimestamp(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.floor(number)
}

/** Trim and bound one note. */
function normalizeNote(value) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, MAX_NOTE_LENGTH)
}

/** Trim and bound one cached title. */
function normalizeTitle(value) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, MAX_TITLE_LENGTH)
}

/**
 * Validate one stored todo. Entries that only repeat the default state are
 * dropped, so the file stays small: an untouched session has no entry.
 */
function normalizeEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const done = value.done === true
  const note = normalizeNote(value.note)
  const priority = PRIORITIES.includes(value.priority) ? value.priority : DEFAULT_PRIORITY
  const dueAt = toTimestamp(value.dueAt)
  const title = normalizeTitle(value.title)
  const updatedAt = toTimestamp(value.updatedAt)
  const createdAt = toTimestamp(value.createdAt) || updatedAt
  const doneAt = done ? toTimestamp(value.doneAt) || updatedAt : 0
  const reopenedByRun = !done && value.reopenedByRun === true
  const reopenedAt = reopenedByRun ? toTimestamp(value.reopenedAt) || updatedAt : 0
  if (!done && !reopenedByRun && note === '' && priority === DEFAULT_PRIORITY && dueAt === 0) return null
  return { done, note, priority, dueAt, title, createdAt, updatedAt, doneAt, reopenedByRun, reopenedAt }
}

/** Copy and validate the sessions this plugin watched on the user's behalf. */
function normalizeWatchList(raw) {
  const list = []
  const seen = new Set()
  if (!Array.isArray(raw)) return list
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const sessionId = value.trim()
    if (sessionId === '' || sessionId.length > MAX_SESSION_ID_LENGTH || seen.has(sessionId)) continue
    seen.add(sessionId)
    list.push(sessionId)
  }
  return list
}

/** Copy and validate the stored todo map, dropping anything unexpected. */
function normalizeTodos(raw) {
  const todos = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return todos
  for (const [sessionId, value] of Object.entries(raw)) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue
    if (sessionId.length > MAX_SESSION_ID_LENGTH) continue
    const entry = normalizeEntry(value)
    if (entry !== null) todos[sessionId] = entry
  }
  return todos
}

/** A frozen, caller-owned copy of the current todos. */
function snapshotTodos(todos) {
  const copy = {}
  for (const [sessionId, value] of Object.entries(todos)) {
    copy[sessionId] = {
      done: value.done,
      note: value.note,
      priority: value.priority,
      dueAt: value.dueAt,
      title: value.title,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      doneAt: value.doneAt,
      reopenedByRun: value.reopenedByRun === true,
      reopenedAt: value.reopenedAt,
    }
  }
  return copy
}

/** Rank one priority; an unknown value sorts last. */
function priorityRank(priority) {
  const index = PRIORITIES.indexOf(priority)
  return index === -1 ? -1 : index
}

/** Ordered rows for the agent tool: unfinished first, then priority and due date. */
function todoRows(todos) {
  return Object.entries(todos)
    .map(([sessionId, value]) => ({
      sessionId,
      title: value.title,
      done: value.done,
      note: value.note,
      priority: value.priority,
      dueAt: value.dueAt,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      doneAt: value.doneAt,
      reopenedByRun: value.reopenedByRun === true,
      reopenedAt: value.reopenedAt,
    }))
    .sort((left, right) =>
      Number(left.done) - Number(right.done)
      || priorityRank(right.priority) - priorityRank(left.priority)
      || (left.dueAt || Number.MAX_SAFE_INTEGER) - (right.dueAt || Number.MAX_SAFE_INTEGER)
      || right.updatedAt - left.updatedAt)
}

/**
 * One durable todo map backed by a single JSON file.
 * Reads are served from memory after the first load; writes are serialized
 * and published atomically (temporary file, then rename).
 */
function createStore(file, log) {
  let todos = {}
  let autoWatch = false
  let reopenOnResume = false
  const autoWatched = new Set()
  let origin = ''
  let loaded = null
  let writeChain = Promise.resolve()
  const listeners = new Set()
  const watchers = new Map()

  function emit() {
    const snapshot = snapshotTodos(todos)
    for (const listener of listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        log('a todo listener failed', error)
      }
    }
  }

  function settingsSnapshot() {
    return { autoWatch, reopenOnResume, autoWatched: [...autoWatched].sort() }
  }

  function load() {
    if (loaded !== null) return loaded
    loaded = (async () => {
      try {
        const text = await readFile(file, 'utf8')
        const parsed = JSON.parse(text)
        todos = normalizeTodos(parsed?.todos)
        autoWatch = parsed?.autoWatch === true
        reopenOnResume = parsed?.reopenOnResume === true
        for (const sessionId of normalizeWatchList(parsed?.autoWatched)) autoWatched.add(sessionId)
      } catch (error) {
        if (error?.code !== 'ENOENT') log('could not read ' + file, error)
      }
    })()
    return loaded
  }

  function persist() {
    const body = JSON.stringify({
      version: FILE_VERSION,
      updatedAt: Date.now(),
      autoWatch,
      reopenOnResume,
      autoWatched: [...autoWatched].sort(),
      todos,
    }, null, 2)
    writeChain = writeChain
      .then(async () => {
        await mkdir(dirname(file), { recursive: true })
        const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp'
        await writeFile(temporary, body, 'utf8')
        await rename(temporary, file)
      })
      .catch((error) => {
        log('could not write ' + file, error)
      })
    return writeChain
  }

  /**
   * One watch call against dsh-session-notify. Any failure — route missing,
   * timeout, bad payload — is a silent false: the todo itself is unaffected.
   */
  async function postWatch(sessionId, on) {
    if (origin === '' || typeof fetch !== 'function') return false
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    let timer = null
    if (controller !== null) {
      timer = setTimeout(() => {
        try {
          controller.abort()
        } catch {
          /* already aborted */
        }
      }, WATCH_TIMEOUT_MS)
    }
    try {
      const response = await fetch(origin + NOTIFY_WATCH_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sessionId, on }),
        signal: controller === null ? undefined : controller.signal,
      })
      if (response.ok !== true) return false
      const payload = await response.json().catch(() => null)
      return payload !== null && payload.ok === true
    } catch {
      return false
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  /** Serialize one session's watch calls so a fast toggle settles on its last state. */
  function queueWatch(sessionId, run) {
    const previous = watchers.get(sessionId) ?? Promise.resolve()
    const next = previous
      .then(run)
      .catch((error) => log('a notify watch call failed', error))
    watchers.set(sessionId, next)
    next.finally(() => {
      if (watchers.get(sessionId) === next) watchers.delete(sessionId)
    })
    return next
  }

  /**
   * Watch while the todo is open; release it once done or gone. A plain todo
   * has no stored entry, so a done:false write passes forceOpen to say "this
   * session is open now" even though nothing is persisted for it.
   */
  function reconcile(sessionId, forceOpen) {
    if (!autoWatch) return
    queueWatch(sessionId, async () => {
      if (!autoWatch) return
      const entry = todos[sessionId]
      const shouldWatch = entry !== undefined ? entry.done !== true : forceOpen === true
      const owned = autoWatched.has(sessionId)
      if (shouldWatch && !owned) {
        if (await postWatch(sessionId, true)) {
          autoWatched.add(sessionId)
          await persist()
        }
      } else if (!shouldWatch && owned) {
        if (await postWatch(sessionId, false)) {
          autoWatched.delete(sessionId)
          await persist()
        }
      }
    })
  }

  /** Release one watch this plugin created, whatever the current toggle says. */
  function release(sessionId) {
    queueWatch(sessionId, async () => {
      if (!autoWatched.has(sessionId)) return
      if (await postWatch(sessionId, false)) {
        autoWatched.delete(sessionId)
        await persist()
      }
    })
  }

  return {
    load,
    snapshot: () => snapshotTodos(todos),
    settings: () => settingsSnapshot(),
    /** Remember the same-origin base the notify route can be reached on. */
    setOrigin(value) {
      if (typeof value !== 'string' || value === '') return
      origin = value
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** Change one or both preferences; a disabled auto-watch releases its watches. */
    async setSettings(patch) {
      await load()
      let changed = false
      if (patch.autoWatch !== undefined && patch.autoWatch !== autoWatch) {
        autoWatch = patch.autoWatch
        changed = true
      }
      if (patch.reopenOnResume !== undefined && patch.reopenOnResume !== reopenOnResume) {
        reopenOnResume = patch.reopenOnResume
        changed = true
      }
      if (!changed) return settingsSnapshot()
      await persist()
      if (!autoWatch) for (const sessionId of [...autoWatched]) release(sessionId)
      return settingsSnapshot()
    },
    /** Merge one patch into a session's todo, creating or dropping it as needed. */
    async patch(sessionId, patch) {
      await load()
      const now = Date.now()
      const previous = todos[sessionId]
      const next = previous === undefined
        ? { done: false, note: '', priority: DEFAULT_PRIORITY, dueAt: 0, title: '', createdAt: now, updatedAt: now, doneAt: 0 }
        : { ...previous }
      if (patch.done !== undefined) {
        next.done = patch.done
        next.doneAt = patch.done ? now : 0
        if (patch.done === true) {
          // An explicit check wins over any pending resume marker.
          next.reopenedByRun = false
          next.reopenedAt = 0
        } else if (patch.source === 'resume' && reopenOnResume) {
          // Only the resume watcher sets this, so a manual uncheck never comes back.
          next.reopenedByRun = true
          next.reopenedAt = now
        }
      }
      if (patch.note !== undefined) next.note = normalizeNote(patch.note)
      if (patch.priority !== undefined && PRIORITIES.includes(patch.priority)) next.priority = patch.priority
      if (patch.dueAt !== undefined) next.dueAt = toTimestamp(patch.dueAt)
      const title = normalizeTitle(patch.title)
      if (title !== '') next.title = title
      next.updatedAt = now
      const entry = normalizeEntry(next)
      if (entry === null) delete todos[sessionId]
      else todos[sessionId] = entry
      await persist()
      emit()
      reconcile(sessionId, patch.done === false)
      return snapshotTodos(todos)
    },
    /** Put back the check a resume removed, once that turn completed normally. */
    async completeReopened(sessionId) {
      await load()
      const entry = todos[sessionId]
      if (entry === undefined || entry.reopenedByRun !== true || entry.done === true) return false
      const now = Date.now()
      const next = normalizeEntry({ ...entry, done: true, doneAt: now, reopenedByRun: false, reopenedAt: 0, updatedAt: now })
      if (next === null) return false
      todos[sessionId] = next
      await persist()
      emit()
      reconcile(sessionId)
      return true
    },
    /** Forget one session's todo entirely. */
    async clear(sessionId) {
      await load()
      if (todos[sessionId] === undefined) return snapshotTodos(todos)
      delete todos[sessionId]
      await persist()
      emit()
      reconcile(sessionId)
      return snapshotTodos(todos)
    },
  }
}

/** Answer one JSON response with no-store caching. */
function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Read a bounded UTF-8 request body. */
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', reject)
  })
}

/** Refuse a cross-site POST; same-origin requests and plain HTTP clients pass. */
function isAcceptableOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined) return true
  if (origin === 'null') return false
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

/** Validate the shared session id of one mutation payload. */
function readSessionId(payload) {
  const raw = payload?.sessionId
  if (typeof raw !== 'string' || raw.trim().length === 0) return { ok: false, error: 'sessionId must be a non-empty string' }
  const sessionId = raw.trim()
  if (sessionId.length > MAX_SESSION_ID_LENGTH) {
    return { ok: false, error: 'sessionId must be at most ' + MAX_SESSION_ID_LENGTH + ' characters' }
  }
  return { ok: true, sessionId }
}

/** Validate one todo mutation payload. */
function readMutation(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const session = readSessionId(payload)
  if (!session.ok) return session
  const action = payload.action ?? 'set'
  if (action === 'clear') return { ok: true, sessionId: session.sessionId, action: 'clear' }
  if (action !== 'set') return { ok: false, error: 'unknown action "' + String(action) + '"' }
  const patch = {}
  if (Object.hasOwn(payload, 'done')) {
    if (typeof payload.done !== 'boolean') return { ok: false, error: 'done must be a boolean' }
    patch.done = payload.done
  }
  if (Object.hasOwn(payload, 'note')) {
    if (typeof payload.note !== 'string') return { ok: false, error: 'note must be a string' }
    if (payload.note.length > MAX_NOTE_LENGTH) return { ok: false, error: 'note must be at most ' + MAX_NOTE_LENGTH + ' characters' }
    patch.note = payload.note
  }
  if (Object.hasOwn(payload, 'priority')) {
    if (!PRIORITIES.includes(payload.priority)) return { ok: false, error: 'priority must be one of ' + PRIORITIES.join(', ') }
    patch.priority = payload.priority
  }
  if (Object.hasOwn(payload, 'dueAt')) {
    if (payload.dueAt !== null && payload.dueAt !== 0 && typeof payload.dueAt !== 'number') {
      return { ok: false, error: 'dueAt must be epoch milliseconds or null' }
    }
    if (typeof payload.dueAt === 'number' && (!Number.isFinite(payload.dueAt) || payload.dueAt < 0)) {
      return { ok: false, error: 'dueAt must be a non-negative timestamp' }
    }
    patch.dueAt = payload.dueAt ?? 0
  }
  if (Object.hasOwn(payload, 'title')) {
    if (typeof payload.title !== 'string') return { ok: false, error: 'title must be a string' }
    if (payload.title.length > MAX_TITLE_LENGTH) return { ok: false, error: 'title must be at most ' + MAX_TITLE_LENGTH + ' characters' }
    patch.title = payload.title
  }
  // Only the resume watcher sends this; the agent tool never does.
  if (payload.source === 'resume') patch.source = 'resume'
  if (Object.keys(patch).length === 0) return { ok: false, error: 'nothing to change' }
  return { ok: true, sessionId: session.sessionId, action: 'set', patch }
}

/** The browser-facing JSON route: GET the todos, POST one mutation. */
function createRouteHandler(store, log) {
  return async function handleSessionTodos(request, response) {
    try {
      // The browser half is same-origin by construction; refuse any cross-site
      // caller that a browser marks with an Origin header.
      if (!isAcceptableOrigin(request)) {
        sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
        return
      }
      // Remember this origin so a todo mutation can reach the notify route on
      // the same server, without baking a port into the plugin.
      const host = request.headers.host
      if (typeof host === 'string' && host !== '') store.setOrigin('http://' + host)
      if (request.method === 'GET') {
        await store.load()
        sendJson(response, 200, { ok: true, todos: store.snapshot() })
        return
      }
      if (request.method === 'POST') {
        let payload
        try {
          payload = JSON.parse(await readBody(request, MAX_BODY_BYTES))
        } catch (error) {
          sendJson(response, 400, { ok: false, error: error.message === 'request body is too large' ? error.message : 'invalid JSON body' })
          return
        }
        const mutation = readMutation(payload)
        if (!mutation.ok) {
          sendJson(response, 400, { ok: false, error: mutation.error })
          return
        }
        const todos = mutation.action === 'clear'
          ? await store.clear(mutation.sessionId)
          : await store.patch(mutation.sessionId, mutation.patch)
        sendJson(response, 200, { ok: true, todos })
        return
      }
      response.writeHead(405, { allow: 'GET, POST', 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
    } catch (error) {
      log('request failed', error)
      try {
        sendJson(response, 500, { ok: false, error: 'internal error' })
      } catch {
        response.destroy()
      }
    }
  }
}

/** Read-only health probe: which tool this plugin registered, and whether it did. */
function createHealthHandler(isToolRegistered) {
  return function handleSessionTodoHealth(request, response) {
    if (!isAcceptableOrigin(request)) {
      sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET', 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
      return
    }
    sendJson(response, 200, {
      ok: true,
      tool: 'session_todos',
      registered: isToolRegistered() === true,
    })
  }
}

/** Browser route for the auto-watch preference: GET reads it, POST changes it. */
function createSettingsHandler(store, log) {
  return async function handleSessionTodoSettings(request, response) {
    try {
      if (!isAcceptableOrigin(request)) {
        sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
        return
      }
      const host = request.headers.host
      if (typeof host === 'string' && host !== '') store.setOrigin('http://' + host)
      if (request.method === 'GET') {
        await store.load()
        sendJson(response, 200, Object.assign({ ok: true }, store.settings()))
        return
      }
      if (request.method === 'POST') {
        let payload
        try {
          payload = JSON.parse(await readBody(request, MAX_BODY_BYTES))
        } catch (error) {
          sendJson(response, 400, { ok: false, error: error.message === 'request body is too large' ? error.message : 'invalid JSON body' })
          return
        }
        const patch = {}
        if (payload !== null && typeof payload === 'object') {
          if (Object.hasOwn(payload, 'on')) {
            if (typeof payload.on !== 'boolean') {
              sendJson(response, 400, { ok: false, error: 'on must be a boolean' })
              return
            }
            patch.autoWatch = payload.on
          }
          if (Object.hasOwn(payload, 'autoWatch')) {
            if (typeof payload.autoWatch !== 'boolean') {
              sendJson(response, 400, { ok: false, error: 'autoWatch must be a boolean' })
              return
            }
            patch.autoWatch = payload.autoWatch
          }
          if (Object.hasOwn(payload, 'reopenOnResume')) {
            if (typeof payload.reopenOnResume !== 'boolean') {
              sendJson(response, 400, { ok: false, error: 'reopenOnResume must be a boolean' })
              return
            }
            patch.reopenOnResume = payload.reopenOnResume
          }
        }
        if (patch.autoWatch === undefined && patch.reopenOnResume === undefined) {
          sendJson(response, 400, { ok: false, error: 'send autoWatch and/or reopenOnResume' })
          return
        }
        const settings = await store.setSettings(patch)
        sendJson(response, 200, Object.assign({ ok: true }, settings))
        return
      }
      response.writeHead(405, { allow: 'GET, POST', 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
    } catch (error) {
      log('settings request failed', error)
      try {
        sendJson(response, 500, { ok: false, error: 'internal error' })
      } catch {
        response.destroy()
      }
    }
  }
}

/** Server-Sent Events hub: pushes each committed todo map to every open window. */
function createEventHub(store, log) {
  const clients = new Set()
  let closed = false
  let unsubscribe = null

  unsubscribe = store.subscribe((todos) => {
    if (closed) return
    const frame = 'event: todos\ndata: ' + JSON.stringify({ ok: true, todos }) + '\n\n'
    for (const client of clients) {
      try {
        client.write(frame)
      } catch {
        clients.delete(client)
      }
    }
  })

  function attach(request, response) {
    if (closed) {
      sendJson(response, 503, { ok: false, error: 'event stream is shutting down' })
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET', 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
      return
    }
    if (!isAcceptableOrigin(request)) {
      sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
      return
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write('retry: 3000\n\n')

    let heartbeat = null
    let detached = false
    const cleanup = () => {
      if (detached) return
      detached = true
      if (heartbeat !== null) clearInterval(heartbeat)
      clients.delete(response)
    }
    request.on('close', cleanup)
    response.on('close', cleanup)
    heartbeat = setInterval(() => {
      try {
        response.write(': ping\n\n')
      } catch {
        cleanup()
      }
    }, SSE_HEARTBEAT_MS)
    heartbeat.unref?.()

    void store.load().then(() => {
      if (detached) return
      clients.add(response)
      try {
        response.write('event: todos\ndata: ' + JSON.stringify({ ok: true, todos: store.snapshot() }) + '\n\n')
      } catch {
        cleanup()
      }
    }, (error) => {
      log('could not start the event stream', error)
      cleanup()
      try {
        response.end()
      } catch {
        /* the socket is already gone */
      }
    })
  }

  return {
    attach,
    close() {
      if (closed) return
      closed = true
      if (unsubscribe !== null) unsubscribe()
      for (const client of clients) {
        try {
          client.end()
        } catch {
          /* the client disconnected first */
        }
      }
      clients.clear()
    },
  }
}

/** Parse an agent-supplied due date: epoch milliseconds, ISO date, or empty. */
function parseDueAt(value) {
  if (value === undefined || value === null || value === '') return { ok: true, dueAt: 0 }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return { ok: false, error: 'dueAt must be a non-negative timestamp' }
    return { ok: true, dueAt: Math.floor(value) }
  }
  if (typeof value !== 'string') return { ok: false, error: 'dueAt must be a timestamp, an ISO date string, or null' }
  const text = value.trim()
  if (text === '' || text === 'null') return { ok: true, dueAt: 0 }
  const numeric = Number(text)
  if (Number.isFinite(numeric) && !text.includes('-')) return { ok: true, dueAt: Math.floor(numeric) }
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed) || parsed < 0) return { ok: false, error: 'could not parse dueAt "' + text + '"' }
  return { ok: true, dueAt: parsed }
}

/** The session_todos agent tool over the same store. */
function createTool(store) {
  return {
    name: 'session_todos',
    description: 'Read or change the per-session todos shown in the DeepSeek Harness sidebar and Todo page. Every session row has one todo: unchecked means "to do", checked means "done"; the page also groups a todo as "in progress" while its session is running. Use action "list" to read todos, "set" to change done/note/priority/dueAt, and "clear" to remove one. Omit sessionId for set and clear to use the calling session.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'set', 'clear'],
          description: 'Operation to perform.',
        },
        sessionId: {
          type: 'string',
          description: 'Target session id. When omitted, set and clear use the calling session.',
        },
        done: {
          type: 'boolean',
          description: 'Mark the todo done (true) or not done (false); used by action "set".',
        },
        note: {
          type: 'string',
          description: 'Free-form note, up to 2000 characters; used by action "set". An empty string clears it.',
        },
        priority: {
          type: 'string',
          enum: PRIORITIES,
          description: 'Priority level; used by action "set".',
        },
        dueAt: {
          type: 'string',
          description: 'Due date as epoch milliseconds, an ISO date string such as "2026-11-20", or null to clear; used by action "set".',
        },
        title: {
          type: 'string',
          description: 'Cached session title, so the page can still name a session that is not loaded; used by action "set".',
        },
        state: {
          type: 'string',
          enum: ['all', 'done', 'todo'],
          description: 'Row filter for action "list"; defaults to "all".',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const action = args?.action
      await store.load()
      if (action === 'list') {
        const state = args?.state ?? 'all'
        const rows = todoRows(store.snapshot())
        const filtered = state === 'done'
          ? rows.filter((row) => row.done)
          : state === 'todo' ? rows.filter((row) => !row.done) : rows
        return { ok: true, action: 'list', state, count: filtered.length, todos: filtered }
      }
      const requested = typeof args?.sessionId === 'string' && args.sessionId.trim().length > 0
        ? args.sessionId.trim()
        : exec.agent?.id
      if (typeof requested !== 'string' || requested.length === 0) {
        return { ok: false, error: 'sessionId is required when no calling session exists' }
      }
      if (requested.length > MAX_SESSION_ID_LENGTH) {
        return { ok: false, error: 'sessionId must be at most ' + MAX_SESSION_ID_LENGTH + ' characters' }
      }
      if (action === 'clear') {
        await store.clear(requested)
        return { ok: true, action: 'clear', sessionId: requested, todos: todoRows(store.snapshot()) }
      }
      if (action === 'set') {
        const patch = {}
        if (args?.done !== undefined) {
          if (typeof args.done !== 'boolean') return { ok: false, error: 'done must be a boolean' }
          patch.done = args.done
        }
        if (args?.note !== undefined) {
          if (typeof args.note !== 'string') return { ok: false, error: 'note must be a string' }
          patch.note = args.note
        }
        if (args?.priority !== undefined) {
          if (!PRIORITIES.includes(args.priority)) return { ok: false, error: 'priority must be one of ' + PRIORITIES.join(', ') }
          patch.priority = args.priority
        }
        if (args?.dueAt !== undefined) {
          const due = parseDueAt(args.dueAt)
          if (!due.ok) return { ok: false, error: due.error }
          patch.dueAt = due.dueAt
        }
        if (args?.title !== undefined) {
          if (typeof args.title !== 'string') return { ok: false, error: 'title must be a string' }
          patch.title = args.title
        }
        if (Object.keys(patch).length === 0) {
          return { ok: false, error: 'set needs at least one of done, note, priority, dueAt, title' }
        }
        const todos = await store.patch(requested, patch)
        return { ok: true, action: 'set', sessionId: requested, todo: todos[requested] ?? null, todos: todoRows(todos) }
      }
      return { ok: false, error: 'unknown action "' + String(action) + '"' }
    },
  }
}

/**
 * Register the durable todo file, its browser routes, and the agent tool.
 * @param ctx - Host context carrying the tool registry.
 */
export function apply(ctx) {
  const homePath = ctx.get('dshHomePath')
  const file = typeof homePath === 'function'
    ? homePath('session-todos.json')
    : join(homedir(), '.dsh', 'session-todos.json')
  const log = createLogger()
  const store = createStore(file, log)
  const events = createEventHub(store, log)

  ctx.effect(() => () => events.close(), 'session-todos: event stream')

  let toolRegistered = false
  ctx.effect(() => {
    const dispose = ctx.tools.register(createTool(store))
    toolRegistered = true
    return dispose
  }, 'session-todos: agent tool')

  // A turn that completes normally puts back the check that reopening removed;
  // error, aborted, or interrupted turns leave the state alone.
  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return undefined
    return ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end') return
      const reason = event.data?.reason
      const kind = typeof reason?.kind === 'string' ? reason.kind : 'completed'
      if (kind !== 'completed') return
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || sessionId === '') return
      void store.completeReopened(sessionId)
    })
  }, 'session-todos: completed turns')

  // The browser and desktop compositions mount a web server; other surfaces
  // still get the file-backed tool without an HTTP route.
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const removeTodos = scope.webServer.register({ kind: 'exact', path: ROUTE, handler: createRouteHandler(store, log) })
      const removeSettings = scope.webServer.register({ kind: 'exact', path: SETTINGS_ROUTE, handler: createSettingsHandler(store, log) })
      const removeHealth = scope.webServer.register({ kind: 'exact', path: HEALTH_ROUTE, handler: createHealthHandler(() => toolRegistered) })
      const removeEvents = scope.webServer.register({ kind: 'exact', path: EVENTS_ROUTE, handler: events.attach })
      return () => {
        removeEvents()
        removeHealth()
        removeSettings()
        removeTodos()
      }
    }, 'session-todos: browser routes')
  })
}
