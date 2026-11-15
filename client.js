/**
 * dsh-session-todos — browser half.
 *
 * Adds a checkbox to every session row in the workspace browser
 * ('sidebar.session.row.trailing'), and contributes one global Todo page:
 *
 *  - one square per session row; clicking it marks the session's todo done or
 *    not done. The square is a ring while the session runs (in progress), a
 *    filled check once done, and an empty box while it is still to do;
 *  - a dedicated page in the centre column, opened from its own sidebar
 *    entry, that groups every session as 正在做 / 将要做 / 已做完, with search,
 *    notes, priority, and a due date per todo.
 *
 * Todos are durable Host data read and written through the same-origin
 * '/session-todos' JSON route; '/session-todos/events' pushes changes to every
 * open window over Server-Sent Events. Session titles and running state come
 * from the browser session catalog. Visible copy comes from the Client locale
 * service; styling uses only theme tokens.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-todos',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const NS = 'session-todos'
    const PANEL_ID = 'session-todos'
    const ENDPOINT = '/session-todos'
    const EVENTS = '/session-todos/events'
    const MAX_ROWS = 300
    const PRIORITIES = ['low', 'normal', 'high']
    const PRIORITY_RANK = { low: 0, normal: 1, high: 2 }

    /* ------------------------------------------------------------------ *
     * Dictionaries (English is the key-set source of truth)
     * ------------------------------------------------------------------ */

    const EN = {
      'panel': 'Todos',
      'box.todo': 'Mark done',
      'box.doing': 'In progress — click to mark done',
      'box.done': 'Done — click to reopen',
      'menu.done': 'Mark as done',
      'menu.undone': 'Mark as not done',
      'page.title': 'Todos',
      'page.subtitle': 'Every session as one task: in progress, to do, done',
      'page.search': 'Search sessions and notes',
      'page.showArchived': 'Show archived',
      'page.hideArchived': 'Hide archived',
      'page.live': 'Live updates on',
      'page.updated': 'Updated {time}',
      'page.count': '{shown} of {total} sessions',
      'summary.doing': 'In progress',
      'summary.todo': 'To do',
      'summary.done': 'Done',
      'summary.share': 'of all sessions',
      'section.doing': 'In progress',
      'section.todo': 'To do',
      'section.done': 'Done',
      'row.untitled': 'Untitled session',
      'row.open': 'Open session',
      'row.missing': 'Session is not in the current workspace list',
      'row.overdue': 'Overdue',
      'row.reset': 'Reset this todo',
      'row.clearNote': 'Remove note',
      'note.empty': 'Add a note',
      'note.placeholder': 'What is still missing?',
      'note.save': 'Save',
      'note.cancel': 'Cancel',
      'priority.label': 'Priority',
      'priority.low': 'Low',
      'priority.normal': 'Normal',
      'priority.high': 'High',
      'due.label': 'Due',
      'state.doing': 'Running',
      'empty.doing': 'No session is running right now',
      'empty.todo': 'Nothing queued',
      'empty.done': 'Nothing done yet',
      'empty.search': 'No todo matches this search',
      'error.load': 'Todos are unavailable — the host route did not answer',
      'error.save': 'Could not save the todo',
      'time.now': 'just now',
      'time.minutes': '{n} min ago',
      'time.hours': '{n} h ago',
      'time.days': '{n} d ago',
    }

    const ZH = {
      'panel': '待办',
      'box.todo': '标记为已完成',
      'box.doing': '正在做，点击标记完成',
      'box.done': '已完成，点击取消',
      'menu.done': '标记为已完成',
      'menu.undone': '标记为未完成',
      'page.title': '待办',
      'page.subtitle': '每个会话就是一条待办：正在做、将要做、已做完',
      'page.search': '搜索会话或备注',
      'page.showArchived': '显示已归档',
      'page.hideArchived': '隐藏已归档',
      'page.live': '实时同步已开启',
      'page.updated': '更新于 {time}',
      'page.count': '共 {total} 个会话，显示 {shown} 个',
      'summary.doing': '正在做',
      'summary.todo': '将要做',
      'summary.done': '已做完',
      'summary.share': '占全部会话',
      'section.doing': '正在做',
      'section.todo': '将要做',
      'section.done': '已做完',
      'row.untitled': '未命名会话',
      'row.open': '打开会话',
      'row.missing': '该会话不在当前会话列表中',
      'row.overdue': '已逾期',
      'row.reset': '重置这条待办',
      'row.clearNote': '清除备注',
      'note.empty': '添加备注',
      'note.placeholder': '这条待办还差什么？',
      'note.save': '保存',
      'note.cancel': '取消',
      'priority.label': '优先级',
      'priority.low': '低',
      'priority.normal': '普通',
      'priority.high': '高',
      'due.label': '截止',
      'state.doing': '运行中',
      'empty.doing': '当前没有正在运行的会话',
      'empty.todo': '没有待做的事项',
      'empty.done': '还没有完成的事项',
      'empty.search': '没有匹配的待办',
      'error.load': '待办暂时不可用：宿主路由没有响应',
      'error.save': '待办保存失败',
      'time.now': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.days': '{n} 天前',
    }

    const LOCALES = { zh: ZH, en: EN, ja: EN, es: EN, fr: EN, de: EN, ru: EN, pt: EN }

    /* ------------------------------------------------------------------ *
     * Styles — theme tokens only
     * ------------------------------------------------------------------ */

    const CSS = [
      '.st-boxwrap{display:inline-flex;align-items:center;flex:none;margin-left:2px}',
      '.st-box{appearance:none;box-sizing:border-box;width:14px;height:14px;padding:0;margin:0;flex:none;',
      'border-radius:4px;border:1.4px solid var(--dsw-alias-border-l2);background:transparent;color:transparent;',
      'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;',
      'transition:background .12s ease,border-color .12s ease,color .12s ease,box-shadow .12s ease}',
      '.st-box:hover{border-color:var(--dsw-alias-state-business-primary);',
      'background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent)}',
      '.st-box[data-state=doing]{border-color:var(--dsw-alias-state-business-primary);',
      'box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent)}',
      '.st-box[data-state=done]{border-color:transparent;background:var(--dsw-alias-state-success-primary);color:#fff}',
      '.st-box[data-state=done]:hover{background:var(--dsw-alias-state-success-primary);opacity:.86}',
      '.st-box:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
      '.st-box svg{width:10px;height:10px;display:block}',
      '.st-face{pointer-events:none;box-sizing:border-box;width:15px;height:15px;border-radius:4px;',
      'border:1.4px solid var(--dsw-alias-border-l2);display:inline-flex;align-items:center;justify-content:center;',
      'color:transparent}',
      '.st-face[data-state=doing]{border-color:var(--dsw-alias-state-business-primary);',
      'box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent)}',
      '.st-face[data-state=done]{border-color:transparent;background:var(--dsw-alias-state-success-primary);color:#fff}',
      '.st-face svg{width:11px;height:11px;display:block}',
      '.st-menu-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 10px;',
      'border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;',
      'text-align:left;border-radius:var(--dsw-radius-sm,6px);cursor:pointer}',
      '.st-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.st-menu-item:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
      '.st-menu-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px}',
      '.st-menu-icon .st-face{width:14px;height:14px}',
      '.st-menu-icon .st-face svg{width:10px;height:10px}',
      '.st-menu-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.st-menu-meta{flex:none;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}',
      '.st-page{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;',
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;',
      'padding-top:var(--dsh-frame-top-clearance,0px)}',
      '.st-page *,.st-page *:before,.st-page *:after{box-sizing:border-box}',
      '.st-head{flex:none;display:flex;align-items:flex-start;gap:16px;padding:18px 28px 12px}',
      '.st-head-main{flex:1;min-width:0}',
      '.st-title{margin:0;font-size:20px;line-height:28px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.st-sub{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.st-tools{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}',
      '.st-search{font:inherit;font-size:12px;line-height:18px;height:30px;width:220px;max-width:44vw;padding:0 10px;',
      'border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);outline:none}',
      '.st-search::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.st-search:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.st-btn{appearance:none;font:inherit;font-size:12px;line-height:18px;height:30px;padding:0 12px;',
      'border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l2);background:transparent;',
      'color:var(--dsw-alias-label-primary);cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}',
      '.st-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.st-btn[data-active=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.st-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.st-scroll{flex:1;min-height:0;overflow:auto;padding:0 28px 36px;overscroll-behavior:contain}',
      '.st-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px;margin:4px 0 18px}',
      '.st-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);',
      'background:var(--dsw-alias-bg-layer-1);padding:12px 14px;min-width:0}',
      '.st-card-label{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap;',
      'overflow:hidden;text-overflow:ellipsis}',
      '.st-card-value{margin-top:4px;font-size:22px;line-height:28px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.st-card-value[data-kind=doing]{color:var(--dsw-alias-state-business-primary)}',
      '.st-card-value[data-kind=done]{color:var(--dsw-alias-state-success-primary)}',
      '.st-card-sub{margin-top:2px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;',
      'overflow:hidden;text-overflow:ellipsis}',
      '.st-section{margin:0 0 16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);',
      'background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.st-section-head{display:flex;align-items:center;gap:8px;width:100%;padding:10px 14px;background:transparent;',
      'border:0;font:inherit;color:inherit;cursor:pointer;text-align:left}',
      '.st-section-head:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.st-section-head:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
      '.st-chev{width:12px;height:12px;flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}',
      '.st-section[data-collapsed=true] .st-chev{transform:rotate(-90deg)}',
      '.st-section-name{font-weight:600;font-size:13px}',
      '.st-section[data-kind=doing] .st-section-name{color:var(--dsw-alias-state-business-primary)}',
      '.st-section[data-kind=done] .st-section-name{color:var(--dsw-alias-label-secondary)}',
      '.st-count{font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.st-row{display:grid;grid-template-columns:18px minmax(0,1fr) auto auto;gap:12px;align-items:start;',
      'padding:10px 14px;border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.st-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.st-row-main{min-width:0}',
      '.st-row-title{appearance:none;border:0;background:transparent;font:inherit;font-size:13px;line-height:20px;',
      'color:var(--dsw-alias-label-primary);font-weight:500;padding:0;margin:0;cursor:pointer;text-align:left;',
      'max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}',
      '.st-row-title:hover{color:var(--dsw-alias-state-business-primary)}',
      '.st-row-title[data-missing=true]{cursor:default;color:var(--dsw-alias-label-secondary)}',
      '.st-row[data-state=done] .st-row-title{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}',
      '.st-row-meta{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:11px;line-height:16px;',
      'color:var(--dsw-alias-label-tertiary);margin-top:3px}',
      '.st-live{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-state-business-primary)}',
      '.st-live:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}',
      '.st-overdue{color:var(--dsw-alias-state-error-primary)}',
      '.st-note-btn{appearance:none;border:0;background:transparent;font:inherit;font-size:12px;line-height:18px;',
      'padding:2px 0;margin-top:4px;cursor:pointer;text-align:left;color:var(--dsw-alias-label-secondary);',
      'max-width:100%;display:block}',
      '.st-note-btn:hover{color:var(--dsw-alias-label-primary)}',
      '.st-note-btn[data-empty=true]{color:var(--dsw-alias-label-tertiary)}',
      '.st-note-edit{margin-top:6px;display:flex;flex-direction:column;gap:6px;max-width:560px}',
      '.st-textarea{font:inherit;font-size:12px;line-height:18px;width:100%;min-height:52px;resize:vertical;',
      'padding:6px 8px;border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);outline:none}',
      '.st-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.st-note-actions{display:flex;align-items:center;gap:8px}',
      '.st-mini{appearance:none;font:inherit;font-size:12px;line-height:18px;height:26px;padding:0 10px;',
      'border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;',
      'color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.st-mini:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.st-mini[data-primary=true]{border-color:var(--dsw-alias-state-business-primary);',
      'color:var(--dsw-alias-state-business-primary)}',
      '.st-mini:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.st-side{display:flex;align-items:center;gap:8px;padding-top:1px}',
      '.st-priority,.st-due{font:inherit;font-size:11px;line-height:16px;height:24px;padding:0 6px;',
      'border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;',
      'color:var(--dsw-alias-label-secondary);cursor:pointer;max-width:118px;color-scheme:inherit}',
      '.st-priority:hover,.st-due:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover)}',
      '.st-priority:focus-visible,.st-due:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.st-priority[data-priority=high]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
      '.st-due[data-overdue=true]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.st-reset{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);',
      'width:22px;height:22px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;',
      'cursor:pointer;font:inherit;font-size:14px;line-height:1;padding:0;opacity:0;transition:opacity .12s ease}',
      '.st-row:hover .st-reset,.st-reset:focus-visible{opacity:1}',
      '.st-reset:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.st-empty{padding:16px 14px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.st-notice{margin:10px 0;padding:10px 12px;border-radius:var(--dsw-radius-md,8px);font-size:12px;',
      'background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);',
      'color:var(--dsw-alias-state-warn-primary)}',
      '.st-note-line{margin-top:10px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '@media (max-width:720px){.st-head{padding:14px 16px 10px;flex-wrap:wrap}',
      '.st-scroll{padding:0 16px 28px}.st-search{width:100%;max-width:none}',
      '.st-row{grid-template-columns:18px minmax(0,1fr);row-gap:8px}.st-side{grid-column:2;justify-content:flex-start}}',
    ].join('\n')

    /* ------------------------------------------------------------------ *
     * Locale helpers
     * ------------------------------------------------------------------ */

    /** Subscribe to locale revisions so translated copy re-renders on switch. */
    function useLocaleRevision(locale) {
      const [revision, setRevision] = useState(0)
      useEffect(() => {
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => setRevision((value) => value + 1))
      }, [locale])
      return revision
    }

    /** A clock for relative timestamps. */
    function useNow(intervalMs) {
      const [now, setNow] = useState(() => Date.now())
      useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
        return () => window.clearInterval(timer)
      }, [intervalMs])
      return now
    }

    /* ------------------------------------------------------------------ *
     * Small helpers
     * ------------------------------------------------------------------ */

    /** Look a service up without letting a missing one break rendering. */
    function readService(ctx, name) {
      try {
        return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
      } catch {
        return undefined
      }
    }

    /** The browser session catalog, when the host composition exposes it. */
    function sessionCatalog(ctx) {
      const sessions = readService(ctx, 'sessions')
      const list = sessions === undefined || sessions === null ? undefined : sessions.list
      if (list === undefined || list === null) return undefined
      if (typeof list.getSnapshot !== 'function') return undefined
      return list
    }

    /** Normalize one catalog snapshot into ids plus a byId map. */
    function catalogSnapshot(list) {
      let raw
      try {
        raw = list?.getSnapshot?.()
      } catch {
        raw = undefined
      }
      if (raw === null || typeof raw !== 'object') return { ids: [], byId: {} }
      const byId = raw.byId !== null && typeof raw.byId === 'object' ? raw.byId : {}
      const ids = Array.isArray(raw.ids) ? raw.ids : Object.keys(byId)
      return { ids, byId }
    }

    /** One session summary, or undefined when the catalog does not know it. */
    function summaryOf(ctx, sessionId) {
      const list = sessionCatalog(ctx)
      if (list === undefined) return undefined
      return catalogSnapshot(list).byId[sessionId]
    }

    /** The session title, or an empty string. */
    function titleOf(ctx, sessionId) {
      const summary = summaryOf(ctx, sessionId)
      return summary !== undefined && typeof summary.title === 'string' ? summary.title.trim() : ''
    }

    /** Whether the session is running right now. */
    function runningOf(ctx, sessionId) {
      const summary = summaryOf(ctx, sessionId)
      return summary !== undefined && summary.running === true
    }

    /** Trailing path segment of a working directory. */
    function baseName(path) {
      if (typeof path !== 'string' || path.length === 0) return ''
      const parts = path.split(/[\\/]+/).filter((part) => part.length > 0)
      return parts.length === 0 ? path : parts[parts.length - 1]
    }

    /** yyyy-mm-dd in local time. */
    function dateValue(timestamp) {
      if (!timestamp) return ''
      const date = new Date(timestamp)
      if (!Number.isFinite(date.getTime())) return ''
      const pad = (value) => String(value).padStart(2, '0')
      return String(date.getFullYear()) + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    }

    /** Local end-of-day for one yyyy-mm-dd input value, or 0. */
    function parseDateValue(value) {
      if (typeof value !== 'string' || value.length === 0) return 0
      const parts = value.split('-').map(Number)
      if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return 0
      const date = new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59, 999)
      const time = date.getTime()
      return Number.isFinite(time) && time > 0 ? time : 0
    }

    /** Localized relative time for one timestamp. */
    function relativeTime(timestamp, now, t) {
      if (!timestamp) return ''
      const delta = Math.max(0, now - timestamp)
      const minute = 60000
      const hour = 3600000
      const day = 86400000
      if (delta < minute) return t('time.now')
      if (delta < hour) return t('time.minutes', { n: Math.floor(delta / minute) })
      if (delta < day) return t('time.hours', { n: Math.floor(delta / hour) })
      if (delta < day * 7) return t('time.days', { n: Math.floor(delta / day) })
      return dateValue(timestamp)
    }

    /* ------------------------------------------------------------------ *
     * Todo store (Host-backed, optimistic writes, live server pushes)
     * ------------------------------------------------------------------ */

    function normalizeTodos(value) {
      const todos = {}
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return todos
      for (const [sessionId, entry] of Object.entries(value)) {
        if (typeof sessionId !== 'string' || sessionId.length === 0) continue
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
        const priority = PRIORITIES.includes(entry.priority) ? entry.priority : 'normal'
        const dueAt = Number(entry.dueAt)
        todos[sessionId] = {
          done: entry.done === true,
          note: typeof entry.note === 'string' ? entry.note : '',
          priority,
          dueAt: Number.isFinite(dueAt) && dueAt > 0 ? Math.floor(dueAt) : 0,
          title: typeof entry.title === 'string' ? entry.title : '',
          createdAt: Number(entry.createdAt) || 0,
          updatedAt: Number(entry.updatedAt) || 0,
          doneAt: Number(entry.doneAt) || 0,
        }
      }
      return todos
    }

    function createTodosStore() {
      let state = { status: 'loading', todos: {}, error: null }
      const listeners = new Set()
      let inflight = null
      let pending = 0
      let chain = Promise.resolve()
      let warned = false

      function publish(next) {
        state = next
        for (const listener of listeners) listener()
      }

      function report(error) {
        if (warned) return
        warned = true
        console.warn('[session-todos] the todo route failed:', error)
      }

      /** Apply a server push unless a local write is still in flight. */
      function applyServer(raw) {
        if (pending > 0) return
        publish({ status: 'ready', todos: normalizeTodos(raw), error: null })
      }

      function refresh() {
        if (inflight !== null) return inflight
        inflight = (async () => {
          try {
            const response = await fetch(ENDPOINT, { headers: { accept: 'application/json' }, cache: 'no-store' })
            if (!response.ok) throw new Error('HTTP ' + response.status)
            const payload = await response.json()
            if (payload?.ok !== true) throw new Error(payload?.error ?? 'invalid response')
            if (pending === 0) publish({ status: 'ready', todos: normalizeTodos(payload.todos), error: null })
            warned = false
          } catch (error) {
            report(error)
            publish({ status: state.status === 'ready' ? 'ready' : 'error', todos: state.todos, error })
          } finally {
            inflight = null
          }
        })()
        return inflight
      }

      /** One optimistic mutation; the server map replaces the guess on success. */
      async function write(sessionId, patch) {
        pending += 1
        const previous = state.todos
        const optimistic = { ...previous }
        const base = optimistic[sessionId] ?? {
          done: false, note: '', priority: 'normal', dueAt: 0, title: '',
          createdAt: Date.now(), updatedAt: 0, doneAt: 0,
        }
        const next = { ...base }
        if (patch.done !== undefined) {
          next.done = patch.done === true
          next.doneAt = next.done ? Date.now() : 0
        }
        if (patch.note !== undefined) next.note = typeof patch.note === 'string' ? patch.note : ''
        if (patch.priority !== undefined && PRIORITIES.includes(patch.priority)) next.priority = patch.priority
        if (patch.dueAt !== undefined) next.dueAt = Number(patch.dueAt) > 0 ? Math.floor(Number(patch.dueAt)) : 0
        if (typeof patch.title === 'string' && patch.title.length > 0) next.title = patch.title
        next.updatedAt = Date.now()
        if (!next.done && next.note === '' && next.priority === 'normal' && next.dueAt === 0) delete optimistic[sessionId]
        else optimistic[sessionId] = next
        publish({ status: 'ready', todos: optimistic, error: null })
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(Object.assign({ sessionId, action: 'set' }, patch)),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? 'HTTP ' + response.status)
          publish({ status: 'ready', todos: normalizeTodos(payload.todos), error: null })
          warned = false
          return { ok: true }
        } catch (error) {
          publish({ status: state.status === 'ready' ? 'ready' : 'error', todos: previous, error })
          report(error)
          return { ok: false, error }
        } finally {
          pending -= 1
        }
      }

      /** Remove one session's todo entirely. */
      async function drop(sessionId) {
        pending += 1
        const previous = state.todos
        const optimistic = { ...previous }
        delete optimistic[sessionId]
        publish({ status: 'ready', todos: optimistic, error: null })
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ sessionId, action: 'clear' }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? 'HTTP ' + response.status)
          publish({ status: 'ready', todos: normalizeTodos(payload.todos), error: null })
          return { ok: true }
        } catch (error) {
          publish({ status: state.status === 'ready' ? 'ready' : 'error', todos: previous, error })
          report(error)
          return { ok: false, error }
        } finally {
          pending -= 1
        }
      }

      /** Serialize writes so rapid clicks cannot reorder their responses. */
      function enqueue(run) {
        const queued = chain.then(run)
        chain = queued.then(() => undefined, () => undefined)
        return queued
      }

      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        refresh,
        applyServer,
        set: (sessionId, patch) => enqueue(() => write(sessionId, patch)),
        clear: (sessionId) => enqueue(() => drop(sessionId)),
      }
    }

    const todosStore = createTodosStore()

    function useTodosState() {
      const state = React.useSyncExternalStore(todosStore.subscribe, todosStore.getSnapshot, todosStore.getSnapshot)
      useEffect(() => {
        if (state.status === 'loading') void todosStore.refresh()
      }, [state.status])
      return state
    }

    /* ------------------------------------------------------------------ *
     * Session catalog hooks
     * ------------------------------------------------------------------ */

    /** Subscribe to the whole session catalog for the page. */
    function useCatalog(ctx) {
      const list = sessionCatalog(ctx)
      const [snapshot, setSnapshot] = useState(() => catalogSnapshot(list))
      useEffect(() => {
        if (list === undefined) return undefined
        const read = () => setSnapshot(catalogSnapshot(list))
        read()
        if (typeof list.subscribe !== 'function') return undefined
        const off = list.subscribe(read)
        return typeof off === 'function' ? off : undefined
      }, [list])
      return snapshot
    }

    /** Whether one session is running, kept live for a sidebar row. */
    function useRunning(ctx, sessionId) {
      const list = sessionCatalog(ctx)
      const [running, setRunning] = useState(() => runningOf(ctx, sessionId))
      useEffect(() => {
        if (list === undefined) return undefined
        const read = () => setRunning(runningOf(ctx, sessionId))
        read()
        if (typeof list.subscribe !== 'function') return undefined
        const off = list.subscribe(read)
        return typeof off === 'function' ? off : undefined
      }, [list, ctx, sessionId])
      return running
    }

    /* ------------------------------------------------------------------ *
     * Icons
     * ------------------------------------------------------------------ */

    function CheckIcon() {
      return h('svg', { viewBox: '0 0 10 10', 'aria-hidden': 'true' },
        h('path', {
          d: 'M1.6 5.1 4 7.5 8.4 2.7',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }))
    }

    function Chevron({ className }) {
      return h('svg', { className, viewBox: '0 0 12 12', 'aria-hidden': 'true' },
        h('path', {
          d: 'M2.5 4.2 6 7.7 9.5 4.2',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }))
    }

    /** Sidebar glyph: a checked line above an open box. */
    function PanelIcon({ size = 18 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M2.4 3.6l1.1 1.1 2-2.1', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      h('path', { d: 'M8.6 3.5h5.1', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      h('rect', { x: 2.2, y: 8.1, width: 3.3, height: 3.3, rx: 0.9, stroke: 'currentColor', strokeWidth: 1.2 }),
      h('path', { d: 'M8.6 9.7h5.1', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
    }

    /* ------------------------------------------------------------------ *
     * Sidebar checkbox
     * ------------------------------------------------------------------ */

    /** Everything one square needs: state, labels, and the toggle write. */
    function useTodoSquare(ctx, sessionId) {
      const locale = ctx.locale ?? readService(ctx, 'locale')
      useLocaleRevision(locale)
      const t = locale.bind(NS)
      const state = useTodosState()
      const running = useRunning(ctx, sessionId)
      const entry = state.todos[sessionId]
      const done = entry !== undefined && entry.done === true
      const visual = done ? 'done' : running ? 'doing' : 'todo'
      const label = done ? t('box.done') : running ? t('box.doing') : t('box.todo')
      return {
        t,
        entry,
        done,
        running,
        visual,
        label,
        toggle: (event) => {
          if (event !== undefined) {
            event.preventDefault()
            event.stopPropagation()
          }
          void todosStore.set(sessionId, {
            done: !done,
            title: titleOf(ctx, sessionId),
          })
        },
      }
    }

    /** The square glyph itself; interactive only when it is the row button. */
    function SquareFace({ visual, priority, done }) {
      return h('span', {
        className: 'st-face',
        'data-state': visual,
        'data-priority': priority,
        'aria-hidden': 'true',
      }, done ? h(CheckIcon) : null)
    }

    /**
     * The resting square in the trailing seat. The row hides that whole seat
     * while it is hovered, so the same state is mirrored in the hover actions.
     */
    function SessionTodoBox({ ctx, sessionId }) {
      const square = useTodoSquare(ctx, sessionId)
      return h('span', { className: 'st-boxwrap' }, h('button', {
        type: 'button',
        className: 'st-box',
        'data-state': square.visual,
        'data-priority': square.entry === undefined ? undefined : square.entry.priority,
        'aria-pressed': square.done,
        'aria-label': square.label,
        title: square.label,
        onClick: square.toggle,
        onPointerDown: (event) => event.stopPropagation(),
        onDoubleClick: (event) => event.stopPropagation(),
      }, square.done ? h(CheckIcon) : null))
    }

    /**
     * The row's "…" menu entry: the same toggle, for the menu the row collapses
     * into. 'useMenuOpenState' is the menu's own open-state hook, so a click
     * closes it before the write lands.
     */
    function SessionTodoMenuItem({ ctx, sessionId, useMenuOpenState }) {
      const square = useTodoSquare(ctx, sessionId)
      const useMenu = typeof useMenuOpenState === 'function' ? useMenuOpenState : () => [false, () => {}]
      const menu = useMenu()
      const setMenuOpen = Array.isArray(menu) ? menu[1] : () => {}
      const label = square.done ? square.t('menu.undone') : square.t('menu.done')
      const entry = square.entry
      const meta = entry !== undefined && entry.dueAt > 0
        ? dateValue(entry.dueAt)
        : (entry !== undefined && entry.priority === 'high' ? square.t('priority.high') : '')
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'st-menu-item',
        title: label,
        onClick: (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (typeof setMenuOpen === 'function') setMenuOpen(false)
          square.toggle()
        },
      },
        h('span', { className: 'st-menu-icon' }, h(SquareFace, {
          visual: square.visual,
          priority: entry === undefined ? undefined : entry.priority,
          done: square.done,
        })),
        h('span', { className: 'st-menu-label' }, label),
        meta === '' ? null : h('span', { className: 'st-menu-meta' }, meta))
    }

    /* ------------------------------------------------------------------ *
     * Todo page
     * ------------------------------------------------------------------ */

    /** One priority control. */
    function PrioritySelect({ value, onChange, t }) {
      return h('select', {
        className: 'st-priority',
        'data-priority': value,
        'aria-label': t('priority.label'),
        title: t('priority.label'),
        value,
        onChange: (event) => onChange(event.target.value),
        onClick: (event) => event.stopPropagation(),
      }, PRIORITIES.map((priority) => h('option', { key: priority, value }, t('priority.' + priority))))
    }

    /** One due-date control. */
    function DueInput({ value, overdue, onChange, t }) {
      return h('input', {
        className: 'st-due',
        'data-overdue': overdue ? 'true' : undefined,
        type: 'date',
        value: dateValue(value),
        'aria-label': t('due.label'),
        title: overdue ? t('row.overdue') : t('due.label'),
        onChange: (event) => onChange(parseDateValue(event.target.value)),
        onClick: (event) => event.stopPropagation(),
      })
    }

    /** One session row on the page. */
    function TodoRow({ row, t, now, onOpen, onPatch, onClear }) {
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState(row.note)

      useEffect(() => {
        if (!editing) setDraft(row.note)
      }, [row.note, editing])

      const save = () => {
        setEditing(false)
        if (draft.trim() === row.note) return
        onPatch(row.id, { note: draft.trim(), title: row.title })
      }

      const meta = [
        row.running ? h('span', { key: 'live', className: 'st-live' }, t('state.doing')) : null,
        row.cwd ? h('span', { key: 'cwd' }, baseName(row.cwd)) : null,
        row.updatedAt ? h('span', { key: 'time' }, relativeTime(row.updatedAt, now, t)) : null,
        row.overdue ? h('span', { key: 'overdue', className: 'st-overdue' }, t('row.overdue')) : null,
        row.missing ? h('span', { key: 'missing' }, t('row.missing')) : null,
      ].filter((part) => part !== null)

      const noteArea = editing
        ? h('div', { className: 'st-note-edit' },
          h('textarea', {
            className: 'st-textarea',
            value: draft,
            placeholder: t('note.placeholder'),
            autoFocus: true,
            rows: 2,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setEditing(false)
                setDraft(row.note)
              } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                save()
              }
            },
          }),
          h('div', { className: 'st-note-actions' },
            h('button', { type: 'button', className: 'st-mini', 'data-primary': 'true', onClick: save }, t('note.save')),
            h('button', {
              type: 'button',
              className: 'st-mini',
              onClick: () => {
                setEditing(false)
                setDraft(row.note)
              },
            }, t('note.cancel')),
            row.note !== ''
              ? h('button', {
                type: 'button',
                className: 'st-mini',
                onClick: () => {
                  setDraft('')
                  setEditing(false)
                  onPatch(row.id, { note: '', title: row.title })
                },
              }, t('row.clearNote'))
              : null))
        : (row.note !== ''
          ? h('button', {
            type: 'button',
            className: 'st-note-btn',
            title: t('note.empty'),
            onClick: () => setEditing(true),
          }, row.note)
          : (row.done
            ? null
            : h('button', {
              type: 'button',
              className: 'st-note-btn',
              'data-empty': 'true',
              onClick: () => setEditing(true),
            }, t('note.empty'))))

      return h('div', {
        className: 'st-row',
        'data-state': row.state,
      },
      h('button', {
        type: 'button',
        className: 'st-box',
        'data-state': row.done ? 'done' : row.running ? 'doing' : 'todo',
        'data-priority': row.priority,
        'aria-pressed': row.done,
        'aria-label': row.done ? t('box.done') : t('box.todo'),
        title: row.done ? t('box.done') : t('box.todo'),
        onClick: () => onPatch(row.id, { done: !row.done, title: row.title }),
      }, row.done ? h(CheckIcon) : null),
      h('div', { className: 'st-row-main' },
        h('button', {
          type: 'button',
          className: 'st-row-title',
          'data-missing': row.missing ? 'true' : undefined,
          title: row.missing ? t('row.missing') : t('row.open'),
          onClick: () => {
            if (!row.missing) onOpen(row.id)
          },
          disabled: row.missing,
        }, row.title === '' ? t('row.untitled') : row.title),
        meta.length === 0 ? null : h('div', { className: 'st-row-meta' }, meta),
        noteArea),
      h('div', { className: 'st-side' },
        h(DueInput, {
          value: row.dueAt,
          overdue: row.overdue,
          onChange: (dueAt) => onPatch(row.id, { dueAt, title: row.title }),
          t,
        }),
        h(PrioritySelect, {
          value: row.priority,
          onChange: (priority) => onPatch(row.id, { priority, title: row.title }),
          t,
        }),
        h('button', {
          type: 'button',
          className: 'st-reset',
          title: t('row.reset'),
          'aria-label': t('row.reset'),
          onClick: () => onClear(row.id),
        }, '\u00d7')))
    }

    /** One collapsible group of rows. */
    function Section({ kind, title, count, collapsed, onToggle, empty, children, t }) {
      return h('section', {
        className: 'st-section',
        'data-kind': kind,
        'data-collapsed': collapsed ? 'true' : undefined,
      },
      h('button', {
        type: 'button',
        className: 'st-section-head',
        'aria-expanded': !collapsed,
        onClick: onToggle,
      },
        h(Chevron, { className: 'st-chev' }),
        h('span', { className: 'st-section-name' }, title),
        h('span', { className: 'st-count' }, String(count))),
      collapsed ? null : h('div', { className: 'st-section-body' },
        count === 0 ? h('div', { className: 'st-empty' }, empty) : children))
    }

    /** Build one page row from a catalog summary and its stored todo. */
    function buildRow(sessionId, summary, entry, now) {
      const done = entry !== undefined && entry.done === true
      const running = summary !== undefined && summary.running === true
      const dueAt = entry === undefined ? 0 : entry.dueAt
      const title = summary !== undefined && typeof summary.title === 'string' && summary.title.trim() !== ''
        ? summary.title.trim()
        : (entry !== undefined && entry.title !== '' ? entry.title : '')
      return {
        id: sessionId,
        title,
        done,
        running,
        missing: summary === undefined,
        archived: summary !== undefined && summary.archived === true,
        cwd: summary !== undefined && typeof summary.cwd === 'string' ? summary.cwd : '',
        updatedAt: summary !== undefined && Number(summary.updatedAt) > 0 ? Number(summary.updatedAt) : (entry === undefined ? 0 : entry.updatedAt),
        doneAt: entry === undefined ? 0 : entry.doneAt,
        note: entry === undefined ? '' : entry.note,
        priority: entry === undefined ? 'normal' : entry.priority,
        dueAt,
        overdue: !done && dueAt > 0 && dueAt < now,
        state: done ? 'done' : running ? 'doing' : 'todo',
      }
    }

    /** The Todo page itself. */
    function TodoPage({ ctx }) {
      const locale = ctx.locale ?? readService(ctx, 'locale')
      useLocaleRevision(locale)
      const t = locale.bind(NS)
      const todosState = useTodosState()
      const catalog = useCatalog(ctx)
      const now = useNow(30000)
      const [query, setQuery] = useState('')
      const [showArchived, setShowArchived] = useState(false)
      const [collapsed, setCollapsed] = useState({ doing: false, todo: false, done: true })

      const rows = useMemo(() => {
        const todos = todosState.todos
        const built = []
        const seen = new Set()
        for (const sessionId of catalog.ids) {
          seen.add(sessionId)
          const summary = catalog.byId[sessionId]
          if (summary === undefined || summary === null) continue
          if (summary.blank === true) continue
          if (summary.archived === true && !showArchived) continue
          built.push(buildRow(sessionId, summary, todos[sessionId], now))
        }
        for (const [sessionId, entry] of Object.entries(todos)) {
          if (seen.has(sessionId)) continue
          built.push(buildRow(sessionId, undefined, entry, now))
        }
        return built
      }, [catalog, todosState.todos, showArchived, now])

      const needle = query.trim().toLowerCase()
      const matched = useMemo(() => {
        if (needle === '') return rows
        return rows.filter((row) =>
          row.title.toLowerCase().includes(needle)
          || row.note.toLowerCase().includes(needle)
          || row.cwd.toLowerCase().includes(needle))
      }, [rows, needle])

      const groups = useMemo(() => {
        const doing = []
        const todo = []
        const done = []
        for (const row of matched) {
          if (row.state === 'doing') doing.push(row)
          else if (row.state === 'done') done.push(row)
          else todo.push(row)
        }
        doing.sort((left, right) => right.updatedAt - left.updatedAt)
        todo.sort((left, right) =>
          PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority]
          || (left.dueAt || Number.MAX_SAFE_INTEGER) - (right.dueAt || Number.MAX_SAFE_INTEGER)
          || right.updatedAt - left.updatedAt)
        done.sort((left, right) => (right.doneAt || right.updatedAt) - (left.doneAt || left.updatedAt))
        return { doing, todo, done }
      }, [matched])

      const patch = useCallback((sessionId, changes) => {
        void todosStore.set(sessionId, changes)
      }, [])

      const clear = useCallback((sessionId) => {
        void todosStore.clear(sessionId)
      }, [])

      const openSession = useCallback((sessionId) => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return
        const workspace = readService(ctx, 'uiWorkspace')
        if (workspace === undefined || workspace === null) return
        if (typeof workspace.openSession !== 'function') return
        try {
          workspace.openSession(sessionId)
        } catch (error) {
          console.warn('[session-todos] could not open session:', error)
        }
      }, [ctx])

      const toggleSection = (kind) => {
        setCollapsed((previous) => Object.assign({}, previous, { [kind]: previous[kind] !== true }))
      }

      const total = rows.length
      const shown = matched.length
      const percent = (value) => (total === 0 ? '' : Math.round((value / total) * 100) + '%')
      const anyArchived = catalog.ids.some((sessionId) => catalog.byId[sessionId]?.archived === true)
      const renderRows = (list) => {
        const visible = list.length > MAX_ROWS ? list.slice(0, MAX_ROWS) : list
        return [
          ...visible.map((row) => h(TodoRow, {
            key: row.id,
            row,
            t,
            now,
            onOpen: openSession,
            onPatch: patch,
            onClear: clear,
          })),
          list.length > visible.length
            ? h('div', { key: 'more', className: 'st-empty' }, t('page.count', { shown: visible.length, total: list.length }))
            : null,
        ]
      }

      return h('div', { className: 'st-page' },
        h('header', { className: 'st-head' },
          h('div', { className: 'st-head-main' },
            h('h1', { className: 'st-title' }, t('page.title')),
            h('div', { className: 'st-sub' },
              t('page.subtitle'),
              total === 0 ? '' : ' \u00b7 ' + t('page.count', { shown: shown === total ? total : shown, total }))),
          h('div', { className: 'st-tools' },
            h('input', {
              className: 'st-search',
              type: 'search',
              value: query,
              placeholder: t('page.search'),
              'aria-label': t('page.search'),
              onChange: (event) => setQuery(event.target.value),
            }),
            anyArchived
              ? h('button', {
                type: 'button',
                className: 'st-btn',
                'data-active': showArchived ? 'true' : undefined,
                'aria-pressed': showArchived,
                onClick: () => setShowArchived((value) => !value),
              }, showArchived ? t('page.hideArchived') : t('page.showArchived'))
              : null)),
        h('div', { className: 'st-scroll' },
          todosState.status === 'error'
            ? h('div', { className: 'st-notice' }, t('error.load'))
            : null,
          h('div', { className: 'st-summary' },
            h('div', { className: 'st-card' },
              h('div', { className: 'st-card-label' }, t('summary.doing')),
              h('div', { className: 'st-card-value', 'data-kind': 'doing' }, String(groups.doing.length)),
              h('div', { className: 'st-card-sub' }, percent(groups.doing.length))),
            h('div', { className: 'st-card' },
              h('div', { className: 'st-card-label' }, t('summary.todo')),
              h('div', { className: 'st-card-value' }, String(groups.todo.length)),
              h('div', { className: 'st-card-sub' }, percent(groups.todo.length))),
            h('div', { className: 'st-card' },
              h('div', { className: 'st-card-label' }, t('summary.done')),
              h('div', { className: 'st-card-value', 'data-kind': 'done' }, String(groups.done.length)),
              h('div', { className: 'st-card-sub' }, percent(groups.done.length)))),
          needle !== '' && shown === 0
            ? h('div', { className: 'st-notice' }, t('empty.search'))
            : null,
          h(Section, {
            kind: 'doing',
            title: t('section.doing'),
            count: groups.doing.length,
            collapsed: collapsed.doing === true,
            onToggle: () => toggleSection('doing'),
            empty: t('empty.doing'),
            t,
          }, renderRows(groups.doing)),
          h(Section, {
            kind: 'todo',
            title: t('section.todo'),
            count: groups.todo.length,
            collapsed: collapsed.todo === true,
            onToggle: () => toggleSection('todo'),
            empty: t('empty.todo'),
            t,
          }, renderRows(groups.todo)),
          h(Section, {
            kind: 'done',
            title: t('section.done'),
            count: groups.done.length,
            collapsed: collapsed.done === true,
            onToggle: () => toggleSection('done'),
            empty: t('empty.done'),
            t,
          }, renderRows(groups.done)),
          h('div', { className: 'st-note-line' }, t('page.live'))))
    }

    /* ------------------------------------------------------------------ *
     * Client plugin
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin-css', 'dsh-session-todos/SessionTodos.css')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'session-todos: styles')

        ctx.effect(
          () => ctx.locale.register(NS, LOCALES),
          'session-todos: dictionaries',
        )

        ctx.effect(() => {
          const refresh = () => {
            if (document.visibilityState === 'hidden') return
            void todosStore.refresh()
          }
          window.addEventListener('focus', refresh)
          document.addEventListener('visibilitychange', refresh)
          void todosStore.refresh()
          return () => {
            window.removeEventListener('focus', refresh)
            document.removeEventListener('visibilitychange', refresh)
          }
        }, 'session-todos: todo sync')

        ctx.effect(() => {
          if (typeof EventSource !== 'function') return undefined
          const source = new EventSource(EVENTS)
          const onTodos = (event) => {
            try {
              const payload = JSON.parse(event.data)
              if (payload?.ok === true) todosStore.applyServer(payload.todos)
            } catch {
              /* a malformed push is ignored; the next one or a focus refresh repairs it */
            }
          }
          const onError = () => {
            void todosStore.refresh()
          }
          source.addEventListener('todos', onTodos)
          source.addEventListener('error', onError)
          return () => {
            source.removeEventListener('todos', onTodos)
            source.removeEventListener('error', onError)
            source.close()
          }
        }, 'session-todos: live sync')

        const Box = (props) => h(SessionTodoBox, Object.assign({}, props, { ctx }))
        const MenuItem = (props) => h(SessionTodoMenuItem, Object.assign({}, props, { ctx }))
        const Page = (props) => h(TodoPage, Object.assign({}, props, { ctx }))
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
          name: 'sidebar.session.row.trailing',
          id: 'session-todos',
          order: 80,
          locale: NS,
        }, Box))

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-todos-menu',
          order: 105,
          locale: NS,
        }, MenuItem))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, Page))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 6,
          label: () => t('panel'),
          locale: NS,
        }, PanelIcon))
      },
    }
  },
})
