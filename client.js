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
    const BOXES_ENDPOINT = '/session-boxes'
    const BOX_TIMEOUT_MS = 1500
    const SETTINGS_ENDPOINT = '/session-todos/settings'
    const NOTIFY_ENDPOINT = '/session-notify'
    const LINK_TIMEOUT_MS = 1500
    const STATE_RANK = { doing: 0, todo: 1, done: 2 }
    const BOX_COLORS = {
      blue: 'var(--dsw-alias-state-business-primary)',
      cyan: 'var(--dsw-alias-state-business-primary)',
      teal: 'var(--dsw-alias-state-success-primary)',
      green: 'var(--dsw-alias-state-success-primary)',
      amber: 'var(--dsw-alias-state-warn-primary)',
      yellow: 'var(--dsw-alias-state-warn-primary)',
      red: 'var(--dsw-alias-state-error-primary)',
      pink: 'var(--dsw-alias-state-error-primary)',
      purple: 'var(--dsw-alias-brand-primary)',
      gray: 'var(--dsw-alias-label-secondary)',
    }

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
      'chips.all': 'All',
      'chips.unassigned': 'Ungrouped',
      'group.unassigned': 'Ungrouped',
      'group.joint': ' \u203a ',
      'group.badge': '{open} open of {total}',
      'noteLink.title': 'Session note',
      'link.toggle': 'Auto-watch todos',
      'link.hint': 'Watch a session when its todo is opened; finishing or clearing it only releases watches this plugin created.',
      'reopen.toggle': 'Reopen on resume',
      'drawer.open': 'Settings',
      'drawer.title': 'Todo settings',
      'drawer.reminderTitle': 'Reminders & todos',
      'drawer.close': 'Close',
      'drawer.todoTitle': 'Todos',
      'drawer.autoWatch': 'Auto-watch todos',
      'drawer.autoWatchHint': 'Watch a session when its todo is opened; finishing or clearing it only releases watches this plugin created.',
      'drawer.reopen': 'Reopen on resume',
      'drawer.reopenHint': 'Checked todos reset to to-do when their session starts working again, which also re-watches them.',
      'drawer.watch': 'Remind me when it finishes',
      'drawer.watchHint': 'Ping me when this session finishes a turn.',
      'drawer.noSession': 'Open a session first',
      'drawer.mode': 'Reminder mode',
      'drawer.once': 'Once',
      'drawer.always': 'Every time',
      'drawer.modeNeedsWatch': 'Turn the reminder on first',
      'drawer.modeOld': 'Needs dsh-session-notify 0.5.0',
      'drawer.defaults': 'New session default',
      'drawer.defaultsHint': 'Used when a new session starts; existing sessions keep their own settings.',
      'drawer.note': 'The reminder block only appears when dsh-session-notify answers the probe.',
      'scope.global': 'Global default',
      'scope.session': 'This session',
      'selftest.title': 'Self-test',
      'selftest.run': 'Run self-test',
      'selftest.running': 'Running…',
      'selftest.idle': 'Not run yet',
      'selftest.summary': '{pass} passed · {fail} failed · {skip} skipped',
      'selftest.pass': 'Passed',
      'selftest.fail': 'Failed',
      'selftest.skip': 'Skipped',
      'selftest.copy': 'Copy results',
      'selftest.copied': 'Copied',
      'selftest.copyFailed': 'Could not copy',
      'selftest.colon': ': ',
      'selftest.timeout': 'timed out',
      'selftest.noAnswer': 'no answer',
      'selftest.http': 'HTTP {status}',
      'selftest.route': 'GET /session-todos',
      'selftest.routeBad': 'response has no todos map',
      'selftest.routeOk': '{count} todos',
      'selftest.settings': 'GET /session-todos/settings',
      'selftest.settingsBad': 'autoWatch / reopenOnResume missing',
      'selftest.events': 'SSE /session-todos/events',
      'selftest.eventsUnavailable': 'event stream unavailable — skipped',
      'selftest.eventsSilent': 'no event within the budget — skipped',
      'selftest.noEventSource': 'EventSource is unavailable — skipped',
      'selftest.tool': 'Tool session_todos',
      'selftest.toolBad': 'the host reports the tool is not registered',
      'reopen.hint': 'When on, a checked todo is unchecked the moment its session starts working again. With auto-watch on, that reopen watches the session again.',
      'reopen.note': 'Reopen on resume is on: checked todos are reset to to-do when their session starts working again, which also re-watches those sessions while auto-watch is enabled.',
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
      'chips.all': '全部',
      'chips.unassigned': '未分组',
      'group.unassigned': '未分组',
      'group.joint': ' \u203a ',
      'group.badge': '未完成 {open}/{total}',
      'noteLink.title': '有会话笔记',
      'link.toggle': '待办自动关注',
      'link.hint': '勾成待办时自动关注该会话；完成或清除时只取消本插件建立的关注。',
      'reopen.toggle': '会话重新开工时取消完成',
      'drawer.open': '设置',
      'drawer.title': '待办设置',
      'drawer.reminderTitle': '提醒与待办',
      'drawer.close': '关闭',
      'drawer.todoTitle': '待办',
      'drawer.autoWatch': '待办自动关注',
      'drawer.autoWatchHint': '勾成待办时自动关注该会话；完成或清除时只取消本插件建立的关注。',
      'drawer.reopen': '会话重新开工时取消完成',
      'drawer.reopenHint': '会话重新开工时把已勾选的待办重置为待办，并因此重新触发关注。',
      'drawer.watch': '结束时提醒我',
      'drawer.watchHint': '这个会话跑完一轮就提醒。',
      'drawer.noSession': '先在侧边栏打开一个会话',
      'drawer.mode': '提醒方式',
      'drawer.once': '一次',
      'drawer.always': '每次',
      'drawer.modeNeedsWatch': '先开启结束提醒',
      'drawer.modeOld': '需要 dsh-session-notify 0.5.0',
      'drawer.defaults': '新会话默认值',
      'drawer.defaultsHint': '新建会话时使用；已有会话保持各自设置。',
      'drawer.note': '提醒区块只在检测到 dsh-session-notify 时出现。',
      'scope.global': '全局默认',
      'scope.session': '当前会话',
      'selftest.title': '自检',
      'selftest.run': '运行自检',
      'selftest.running': '运行中…',
      'selftest.idle': '未运行',
      'selftest.summary': '{pass} 通过 · {fail} 失败 · {skip} 跳过',
      'selftest.pass': '通过',
      'selftest.fail': '失败',
      'selftest.skip': '跳过',
      'selftest.copy': '复制结果',
      'selftest.copied': '已复制',
      'selftest.copyFailed': '复制失败',
      'selftest.colon': '：',
      'selftest.timeout': '超时',
      'selftest.noAnswer': '没有响应',
      'selftest.http': 'HTTP {status}',
      'selftest.route': '接口 GET /session-todos',
      'selftest.routeBad': '响应里没有 todos 对象',
      'selftest.routeOk': '{count} 条待办',
      'selftest.settings': '设置接口 /session-todos/settings',
      'selftest.settingsBad': '缺少 autoWatch / reopenOnResume',
      'selftest.events': '实时通道 /session-todos/events',
      'selftest.eventsUnavailable': '实时通道不可用，已跳过',
      'selftest.eventsSilent': '超时内没有事件，已跳过',
      'selftest.noEventSource': '浏览器不支持 EventSource，已跳过',
      'selftest.tool': '工具 session_todos',
      'selftest.toolBad': '宿主报告工具未注册',
      'reopen.hint': '开启后，已勾选的待办会在该会话重新开工时自动取消；若同时开着「待办自动关注」，还会重新触发一次关注。',
      'reopen.note': '已开启「会话重新开工时取消完成」：勾选的待办会在会话重新开工时重置为待办，并因此重新触发自动关注。',
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
      '.st-btn[disabled]{opacity:.5;cursor:default}',
      '.st-gear{appearance:none;box-sizing:border-box;width:28px;height:28px;padding:0;border-radius:8px;',
      'border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);',
      'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none}',
      '.st-gear:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.st-gear:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.st-gear svg{width:15px;height:15px;display:block}',
      '.st-drawer{position:fixed;inset:0;z-index:80;display:flex;justify-content:flex-end}',
      '.st-drawer-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.42)}',
      '.st-drawer-panel{position:relative;width:360px;max-width:92vw;height:100%;display:flex;flex-direction:column;',
      'background:var(--dsw-alias-bg-layer-1);border-left:.5px solid var(--dsw-alias-border-l2);',
      'box-shadow:-12px 0 32px rgba(0,0,0,.24);outline:none}',
      '.st-drawer-head{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.st-drawer-title{flex:1;min-width:0;font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.st-drawer-close{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);',
      'font-size:18px;line-height:20px;width:28px;height:28px;border-radius:8px;cursor:pointer}',
      '.st-drawer-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.st-drawer-body{flex:1;overflow:auto;padding:6px 16px 24px}',
      '.st-set-group{padding:10px 0 6px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.st-set-group:last-of-type{border-bottom:0}',
      '.st-set-group-title{margin:0 0 4px;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.st-set-row{display:flex;gap:12px;align-items:flex-start;padding:9px 0}',
      '.st-set-row+.st-set-row{border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.st-set-main{flex:1;min-width:0}',
      '.st-set-label{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}',
      '.st-set-hint{margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.st-set-store{margin-top:3px;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary);font-family:Consolas,"Cascadia Mono",monospace}',
      '.st-set-actions{flex:none;display:flex;align-items:center;gap:8px;padding-top:1px}',
      '.st-scope{font-size:10.5px;line-height:16px;padding:1px 7px;border-radius:999px;',
      'border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.st-scope[data-scope=session]{color:var(--dsw-alias-state-business-primary);',
      'border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent)}',
      '.st-switch{appearance:none;position:relative;width:36px;height:20px;padding:0;border:0;border-radius:999px;',
      'background:var(--dsw-alias-border-l2);cursor:pointer;flex:none;transition:background .14s ease}',
      '.st-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;',
      'background:#fff;transition:left .14s ease;box-shadow:0 1px 2px rgba(0,0,0,.35)}',
      '.st-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}',
      '.st-switch[aria-checked=true]::after{left:18px}',
      '.st-switch:disabled{opacity:.45;cursor:default}',
      '.st-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.st-seg{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.st-seg button{appearance:none;border:0;background:transparent;font:inherit;font-size:11.5px;line-height:18px;',
      'height:22px;padding:0 8px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-secondary)}',
      '.st-seg button[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);',
      'color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.st-seg button:disabled{opacity:.45;cursor:default}',
      '.st-drawer-note{margin:14px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.st-link-note{margin:0 0 12px;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);',
      'background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.st-st{margin-top:18px;display:flex;flex-direction:column;gap:10px}',
      '.st-st-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.st-st-title{margin:0 auto 0 0;font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.st-st-btn{appearance:none;box-sizing:border-box;font:inherit;font-size:12px;line-height:18px;height:28px;padding:0 12px;',
      'border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;',
      'display:inline-flex;align-items:center;gap:6px;white-space:nowrap}',
      '.st-st-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.st-st-btn[data-primary=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.st-st-btn:disabled{opacity:.55;cursor:default}',
      '.st-st-btn:disabled:hover{background:transparent}',
      '.st-st-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.st-st-sum{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.st-st-list{display:flex;flex-direction:column;gap:2px}',
      '.st-st-row{display:flex;align-items:flex-start;gap:10px;padding:7px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.st-st-label{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}',
      '.st-st-detail{margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.st-st-badge{flex:none;font-size:11px;line-height:16px;padding:2px 8px;border-radius:999px;',
      'border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.st-st-badge[data-status=pass]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.st-st-badge[data-status=fail]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.st-st-badge[data-status=run]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.st-st-badge[data-status=skip]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
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
      '.st-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}',
      '.st-chip{appearance:none;font:inherit;font-size:12px;line-height:18px;height:26px;padding:0 10px;',
      'border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;',
      'color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}',
      '.st-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.st-chip[data-active=true]{border-color:var(--dsw-alias-state-business-primary);',
      'color:var(--dsw-alias-state-business-primary);',
      'background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}',
      '.st-chip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.st-chip-count{font-variant-numeric:tabular-nums;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.st-chip[data-active=true] .st-chip-count{color:inherit}',
      '.st-dot{width:7px;height:7px;border-radius:50%;flex:none;display:inline-block}',
      '.st-section-head .st-dot{margin-left:2px}',
      '.st-row-head{display:flex;align-items:center;gap:6px;min-width:0}',
      '.st-row-head .st-row-title{flex:0 1 auto;min-width:0}',
      '.st-note-link{appearance:none;border:0;background:transparent;padding:0;width:18px;height:18px;',
      'border-radius:4px;display:inline-flex;align-items:center;justify-content:center;flex:none;',
      'cursor:pointer;color:var(--dsw-alias-label-tertiary)}',
      '.st-note-link:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.st-note-link:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.st-note-link svg{width:13px;height:13px;display:block}',
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
     * Session boxes (read-only, optional)
     * ------------------------------------------------------------------ */

    /** Validate one /session-boxes payload; null means "treat as unavailable". */
    function normalizeBoxesPayload(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
      if (payload.ok !== true) return null
      const state = payload.state
      if (state === null || typeof state !== 'object' || Array.isArray(state)) return null
      const boxes = []
      const seen = new Set()
      for (const raw of Array.isArray(state.boxes) ? state.boxes : []) {
        if (raw === null || typeof raw !== 'object') continue
        const id = typeof raw.id === 'string' ? raw.id : ''
        const name = typeof raw.name === 'string' ? raw.name.trim() : ''
        if (id === '' || name === '' || seen.has(id)) continue
        seen.add(id)
        boxes.push({
          id,
          name,
          color: typeof raw.color === 'string' ? raw.color : '',
          parentId: typeof raw.parentId === 'string' && raw.parentId !== '' ? raw.parentId : null,
          order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 0,
        })
      }
      const memberships = {}
      const rawMemberships = state.memberships
      if (rawMemberships !== null && typeof rawMemberships === 'object' && !Array.isArray(rawMemberships)) {
        for (const [sessionId, list] of Object.entries(rawMemberships)) {
          if (typeof sessionId !== 'string' || sessionId === '' || !Array.isArray(list)) continue
          const ids = list.filter((value) => typeof value === 'string' && value !== '')
          if (ids.length > 0) memberships[sessionId] = ids
        }
      }
      return { boxes, memberships }
    }

    /**
     * Read-only view of dsh-session-boxes. A missing route, a timeout, or a bad
     * payload all collapse to 'available: false', so the page keeps its flat
     * list instead of failing.
     */
    function createBoxesStore() {
      let state = { status: 'idle', available: false, boxes: [], memberships: {} }
      const listeners = new Set()
      let inflight = null

      function publish(next) {
        state = next
        for (const listener of listeners) listener()
      }

      function refresh() {
        if (inflight !== null) return inflight
        inflight = (async () => {
          let timer = null
          const controller = typeof AbortController === 'function' ? new AbortController() : null
          if (controller !== null) {
            timer = setTimeout(() => {
              try {
                controller.abort()
              } catch {
                /* already aborted */
              }
            }, BOX_TIMEOUT_MS)
          }
          try {
            const response = await fetch(BOXES_ENDPOINT, {
              headers: { accept: 'application/json' },
              cache: 'no-store',
              signal: controller === null ? undefined : controller.signal,
            })
            if (response.ok !== true) throw new Error('HTTP ' + response.status)
            const payload = await response.json()
            const parsed = normalizeBoxesPayload(payload)
            if (parsed === null) throw new Error('invalid boxes payload')
            publish({ status: 'ready', available: true, boxes: parsed.boxes, memberships: parsed.memberships })
          } catch {
            publish({ status: 'ready', available: false, boxes: [], memberships: {} })
          } finally {
            if (timer !== null) clearTimeout(timer)
            inflight = null
          }
        })()
        return inflight
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
      }
    }

    const boxesStore = createBoxesStore()

    function useBoxesState() {
      const state = React.useSyncExternalStore(boxesStore.subscribe, boxesStore.getSnapshot, boxesStore.getSnapshot)
      // Refresh whenever the page mounts, so a boxes plugin installed later is
      // picked up without a DSH restart.
      useEffect(() => {
        void boxesStore.refresh()
      }, [])
      return state
    }

    /** Identity index over the box list: lookup, display order, children. */
    function buildBoxIndex(boxes) {
      const byId = new Map()
      for (const box of boxes) byId.set(box.id, box)
      const ordered = boxes.slice().sort((left, right) => (left.order - right.order) || left.name.localeCompare(right.name))
      const rank = new Map()
      ordered.forEach((box, index) => rank.set(box.id, index))
      const children = new Map()
      for (const box of boxes) {
        const key = box.parentId !== null && byId.has(box.parentId) ? box.parentId : ''
        if (!children.has(key)) children.set(key, [])
        children.get(key).push(box)
      }
      return { byId, ordered, rank, children }
    }

    /** 'parent > child' for a child box, the name itself for a root box. */
    function boxDisplayName(box, index, joint) {
      const parent = box.parentId === null ? null : index.byId.get(box.parentId)
      return parent === undefined || parent === null ? box.name : parent.name + joint + box.name
    }

    /** Every box in one subtree, the box itself included. */
    function boxScope(boxId, index) {
      const ids = new Set([boxId])
      const stack = [boxId]
      while (stack.length > 0) {
        const current = stack.pop()
        for (const child of index.children.get(current) ?? []) {
          if (ids.has(child.id)) continue
          ids.add(child.id)
          stack.push(child.id)
        }
      }
      return ids
    }

    /** The box a row is grouped under: the earliest-ordered membership, or null. */
    function primaryBoxOf(sessionId, memberships, index) {
      const list = memberships[sessionId]
      if (!Array.isArray(list) || list.length === 0) return null
      let best = null
      let bestRank = Number.POSITIVE_INFINITY
      for (const id of list) {
        if (!index.byId.has(id)) continue
        const rank = index.rank.get(id)
        if (rank === undefined || rank >= bestRank) continue
        bestRank = rank
        best = id
      }
      return best
    }

    /** The existing page ordering, applied inside one box group. */
    function comparePageRows(left, right) {
      if (left.state !== right.state) return STATE_RANK[left.state] - STATE_RANK[right.state]
      if (left.state === 'doing') return right.updatedAt - left.updatedAt
      if (left.state === 'done') return (right.doneAt || right.updatedAt) - (left.doneAt || left.updatedAt)
      return PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority]
        || (left.dueAt || Number.MAX_SAFE_INTEGER) - (right.dueAt || Number.MAX_SAFE_INTEGER)
        || right.updatedAt - left.updatedAt
    }

    /** A box palette name as a theme colour. */
    function boxColorValue(color) {
      return BOX_COLORS[color] ?? 'var(--dsw-alias-label-tertiary)'
    }

    /* ------------------------------------------------------------------ *
     * Optional linkage with dsh-session-notify (auto-watch)
     * ------------------------------------------------------------------ */

    function createLinkStore() {
      let state = {
        status: 'idle',
        settingsAvailable: false,
        notifyAvailable: false,
        autoWatch: false,
        reopenOnResume: false,
        saving: null,
      }
      const listeners = new Set()
      let inflight = null

      function publish(next) {
        state = next
        for (const listener of listeners) listener()
      }

      async function request(url, options) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        let timer = null
        if (controller !== null) {
          timer = setTimeout(() => {
            try {
              controller.abort()
            } catch {
              /* already aborted */
            }
          }, LINK_TIMEOUT_MS)
        }
        try {
          const response = await fetch(url, Object.assign({ cache: 'no-store' }, options, {
            signal: controller === null ? undefined : controller.signal,
          }))
          const payload = await response.json().catch(() => null)
          if (response.ok !== true || payload === null || payload.ok !== true) return null
          return payload
        } catch {
          return null
        } finally {
          if (timer !== null) clearTimeout(timer)
        }
      }

      /** Read the stored preferences, then probe the optional notify route. */
      function refresh() {
        if (inflight !== null) return inflight
        inflight = (async () => {
          try {
            const settings = await request(SETTINGS_ENDPOINT, { headers: { accept: 'application/json' } })
            if (settings === null) {
              publish({
                status: 'ready',
                settingsAvailable: false,
                notifyAvailable: false,
                autoWatch: false,
                reopenOnResume: false,
                saving: null,
              })
              return
            }
            const probe = await request(NOTIFY_ENDPOINT, { headers: { accept: 'application/json' } })
            publish({
              status: 'ready',
              settingsAvailable: true,
              notifyAvailable: probe !== null,
              autoWatch: settings.autoWatch === true,
              reopenOnResume: settings.reopenOnResume === true,
              saving: null,
            })
          } finally {
            inflight = null
          }
        })()
        return inflight
      }

      async function write(patch, saving) {
        if (state.settingsAvailable !== true || state.saving !== null) return
        const previous = state
        const optimistic = Object.assign({}, state, { saving })
        if (patch.autoWatch !== undefined) optimistic.autoWatch = patch.autoWatch
        if (patch.reopenOnResume !== undefined) optimistic.reopenOnResume = patch.reopenOnResume
        publish(optimistic)
        const result = await request(SETTINGS_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(patch),
        })
        if (result === null) {
          publish(previous)
          return
        }
        publish({
          status: 'ready',
          settingsAvailable: true,
          notifyAvailable: state.notifyAvailable,
          autoWatch: result.autoWatch === true,
          reopenOnResume: result.reopenOnResume === true,
          saving: null,
        })
      }

      function toggleAutoWatch() {
        return write({ autoWatch: state.autoWatch !== true }, 'autoWatch')
      }

      function toggleReopen() {
        return write({ reopenOnResume: state.reopenOnResume !== true }, 'reopenOnResume')
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
        toggleAutoWatch,
        toggleReopen,
      }
    }

    const linkStore = createLinkStore()

    /**
     * A session that starts working again reopens its done todo. The catalog is
     * the source of truth for "working", and only a false -> true transition
     * counts: a session that is already running when the window opens keeps the
     * state the user left it in.
     */
    function watchRunningSessions(ctx) {
      const list = sessionCatalog(ctx)
      if (list === undefined || typeof list.subscribe !== 'function') return undefined
      const running = new Map()
      let seeded = false
      let stopped = false

      const read = () => {
        if (stopped) return
        const snapshot = catalogSnapshot(list)
        const current = new Map()
        for (const sessionId of snapshot.ids) {
          const summary = snapshot.byId[sessionId]
          if (summary === undefined || summary === null) continue
          const isRunning = summary.running === true
          current.set(sessionId, isRunning)
          if (!seeded || !isRunning) continue
          if (!running.has(sessionId) || running.get(sessionId) === true) continue
          const entry = todosStore.getSnapshot().todos[sessionId]
          if (entry === undefined || entry.done !== true) continue
          void todosStore.set(sessionId, { done: false, title: titleOf(ctx, sessionId) })
        }
        for (const [sessionId, isRunning] of current) running.set(sessionId, isRunning)
        for (const sessionId of [...running.keys()]) {
          if (!current.has(sessionId)) running.delete(sessionId)
        }
        seeded = true
      }

      read()
      const off = list.subscribe(read)
      const stop = typeof off === 'function' ? off : () => {}
      return () => {
        stopped = true
        stop()
      }
    }

    function useLinkState() {
      const state = React.useSyncExternalStore(linkStore.subscribe, linkStore.getSnapshot, linkStore.getSnapshot)
      useEffect(() => {
        void linkStore.refresh()
      }, [])
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
     * Optional linkage with dsh-notepad (session notes)
     * ------------------------------------------------------------------ */

    /**
     * dsh-notepad's client protocol, when it is present and usable. Any
     * mismatch — missing object, another version, a throwing getter — means
     * "no notes": the todo page keeps working without icons.
     */
    function readNotepadProtocol() {
      try {
        const api = typeof window === 'undefined' ? undefined : window.dshNotepad
        if (api === null || typeof api !== 'object') return null
        if (api.version !== 1) return null
        if (typeof api.listSessionNotes !== 'function') return null
        if (typeof api.openSessionNote !== 'function') return null
        if (typeof api.subscribe !== 'function') return null
        return api
      } catch {
        return null
      }
    }

    /** True when both sets hold the same session ids. */
    function sameSessionSet(left, right) {
      if (left.size !== right.size) return false
      for (const value of left) if (!right.has(value)) return false
      return true
    }

    /**
     * The session ids that currently have a note. Subscribes while the page is
     * mounted and detaches on unmount; a note landing later re-reads the list.
     */
    function useNotepadNotes() {
      const [notes, setNotes] = useState(() => new Set())
      useEffect(() => {
        const api = readNotepadProtocol()
        if (api === null) {
          setNotes(new Set())
          return undefined
        }
        let disposed = false
        const read = () => {
          if (disposed) return
          try {
            const list = api.listSessionNotes()
            const next = new Set()
            if (Array.isArray(list)) {
              for (const item of list) {
                if (item === null || typeof item !== 'object') continue
                if (typeof item.sessionId === 'string' && item.sessionId !== '') next.add(item.sessionId)
              }
            }
            setNotes((previous) => (sameSessionSet(previous, next) ? previous : next))
          } catch {
            setNotes((previous) => (previous.size === 0 ? previous : new Set()))
          }
        }
        read()
        let detach = null
        try {
          detach = api.subscribe(() => read())
        } catch {
          detach = null
        }
        return () => {
          disposed = true
          if (typeof detach !== 'function') return
          try {
            detach()
          } catch {
            /* the notepad already detached */
          }
        }
      }, [])
      return notes
    }

    /** Gear glyph for the settings drawer. */
    function GearIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('circle', { cx: 8, cy: 8, r: 2.4, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', {
          d: 'M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }))
    }

    /** Gear glyph for the settings drawer. */
    function GearIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('circle', { cx: 8, cy: 8, r: 2.4, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', {
          d: 'M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }))
    }

    /** Small document glyph for the "has a session note" marker. */
    function NoteIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M4 2.6h5.2L12 5.4v8H4z',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M9 2.8v2.8h2.8', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
        h('path', { d: 'M5.9 8.2h4.2M5.9 10.6h4.2', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }))
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
    function TodoRow({ row, t, now, onOpen, onPatch, onClear, hasNote, onOpenNote }) {
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
        h('div', { className: 'st-row-head' },
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
          hasNote
            ? h('button', {
              type: 'button',
              className: 'st-note-link',
              title: t('noteLink.title'),
              'aria-label': t('noteLink.title'),
              onClick: (event) => {
                event.preventDefault()
                event.stopPropagation()
                onOpenNote(row.id)
              },
              onPointerDown: (event) => event.stopPropagation(),
            }, h(NoteIcon))
            : null),
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
    function Section({ kind, title, count, badge, badgeTitle, color, collapsed, onToggle, empty, children, t }) {
      const label = badge === undefined ? String(count) : String(badge)
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
        color === undefined || color === '' ? null : h('span', { className: 'st-dot', style: { background: color } }),
        h('span', { className: 'st-section-name' }, title),
        h('span', { className: 'st-count', title: badgeTitle }, label)),
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
      const boxesState = useBoxesState()
      const linkState = useLinkState()
      const notepadNotes = useNotepadNotes()
      const [activeChip, setActiveChip] = useState('all')
      const [boxCollapsed, setBoxCollapsed] = useState({})
      const [drawerOpen, setDrawerOpen] = useState(false)
      const gearRef = React.useRef(null)

      const closeDrawer = useCallback(() => {
        setDrawerOpen(false)
        const gear = gearRef.current
        if (gear !== null && typeof gear.focus === 'function') gear.focus({ preventScroll: true })
      }, [])

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

      const boxIndex = useMemo(
        () => (boxesState.available ? buildBoxIndex(boxesState.boxes) : null),
        [boxesState],
      )

      const primaryBoxes = useMemo(() => {
        if (boxIndex === null) return null
        const map = new Map()
        for (const row of matched) map.set(row.id, primaryBoxOf(row.id, boxesState.memberships, boxIndex))
        return map
      }, [boxIndex, boxesState.memberships, matched])

      // A box can disappear between refreshes; drop a chip that no longer exists.
      useEffect(() => {
        if (boxIndex === null) return
        if (activeChip === 'all' || activeChip === 'unassigned') return
        if (!boxIndex.byId.has(activeChip)) setActiveChip('all')
      }, [boxIndex, activeChip])

      const filteredRows = useMemo(() => {
        if (boxIndex === null || primaryBoxes === null || activeChip === 'all') return matched
        if (activeChip === 'unassigned') {
          return matched.filter((row) => (primaryBoxes.get(row.id) ?? null) === null)
        }
        const scope = boxScope(activeChip, boxIndex)
        return matched.filter((row) => {
          const id = primaryBoxes.get(row.id)
          return id !== null && id !== undefined && scope.has(id)
        })
      }, [matched, boxIndex, primaryBoxes, activeChip])

      const chips = useMemo(() => {
        if (boxIndex === null || primaryBoxes === null) return null
        const list = [{ id: 'all', label: t('chips.all'), count: matched.length, color: '' }]
        let loose = 0
        for (const row of matched) if ((primaryBoxes.get(row.id) ?? null) === null) loose += 1
        list.push({ id: 'unassigned', label: t('chips.unassigned'), count: loose, color: '' })
        for (const box of boxIndex.ordered) {
          const scope = boxScope(box.id, boxIndex)
          let count = 0
          for (const row of matched) {
            const id = primaryBoxes.get(row.id)
            if (id !== null && id !== undefined && scope.has(id)) count += 1
          }
          if (count > 0) list.push({ id: box.id, label: box.name, count, color: boxColorValue(box.color) })
        }
        return list
      }, [boxIndex, primaryBoxes, matched, t])

      const boxGroups = useMemo(() => {
        if (boxIndex === null || primaryBoxes === null) return null
        const buckets = new Map()
        for (const row of filteredRows) {
          const key = primaryBoxes.get(row.id) ?? ''
          if (!buckets.has(key)) buckets.set(key, [])
          buckets.get(key).push(row)
        }
        const list = []
        for (const box of boxIndex.ordered) {
          const rows = buckets.get(box.id)
          if (rows === undefined || rows.length === 0) continue
          list.push({
            key: box.id,
            title: boxDisplayName(box, boxIndex, t('group.joint')),
            color: boxColorValue(box.color),
            rows: rows.slice().sort(comparePageRows),
          })
        }
        const loose = buckets.get('')
        if (loose !== undefined && loose.length > 0) {
          list.push({ key: 'unassigned', title: t('group.unassigned'), color: '', rows: loose.slice().sort(comparePageRows) })
        }
        return list
      }, [boxIndex, primaryBoxes, filteredRows, t])

      const groups = useMemo(() => {
        const doing = []
        const todo = []
        const done = []
        for (const row of filteredRows) {
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
      }, [filteredRows])

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

      const openNote = useCallback((sessionId) => {
        const api = readNotepadProtocol()
        if (api === null) return
        try {
          api.openSessionNote(sessionId)
        } catch (error) {
          console.warn('[session-todos] could not open the session note:', error)
        }
      }, [])

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
            hasNote: notepadNotes.has(row.id),
            onOpenNote: openNote,
          })),
          list.length > visible.length
            ? h('div', { key: 'more', className: 'st-empty' }, t('page.count', { shown: visible.length, total: list.length }))
            : null,
        ]
      }

      return h('div', { className: 'st-page' },
        drawerOpen ? h(SettingsDrawer, { ctx, onClose: closeDrawer }) : null,
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
            linkState.settingsAvailable && linkState.notifyAvailable
              ? h('button', {
                type: 'button',
                className: 'st-btn',
                'data-active': linkState.autoWatch ? 'true' : undefined,
                'aria-pressed': linkState.autoWatch,
                title: t('link.hint'),
                disabled: linkState.saving === 'autoWatch',
                onClick: () => {
                  void linkStore.toggleAutoWatch()
                },
              }, t('link.toggle'))
              : null,
            linkState.settingsAvailable
              ? h('button', {
                type: 'button',
                className: 'st-btn',
                'data-active': linkState.reopenOnResume ? 'true' : undefined,
                'aria-pressed': linkState.reopenOnResume,
                title: t('reopen.hint'),
                disabled: linkState.saving === 'reopenOnResume',
                onClick: () => {
                  void linkStore.toggleReopen()
                },
              }, t('reopen.toggle'))
              : null,
            anyArchived
              ? h('button', {
                type: 'button',
                className: 'st-btn',
                'data-active': showArchived ? 'true' : undefined,
                'aria-pressed': showArchived,
                onClick: () => setShowArchived((value) => !value),
              }, showArchived ? t('page.hideArchived') : t('page.showArchived'))
              : null,
            h('button', {
              type: 'button',
              className: 'st-gear',
              'aria-label': t('drawer.open'),
              title: t('drawer.open'),
              'aria-expanded': drawerOpen,
              ref: gearRef,
              onClick: () => setDrawerOpen(true),
            }, h(GearIcon)))),
        h('div', { className: 'st-scroll' },
          todosState.status === 'error'
            ? h('div', { className: 'st-notice' }, t('error.load'))
            : null,
          linkState.reopenOnResume
            ? h('div', { className: 'st-link-note' }, t('reopen.note'))
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
          chips === null
            ? null
            : h('div', { className: 'st-chips', role: 'group' },
              chips.map((chip) => h('button', {
                key: chip.id,
                type: 'button',
                className: 'st-chip',
                'data-active': activeChip === chip.id ? 'true' : undefined,
                'aria-pressed': activeChip === chip.id,
                onClick: () => setActiveChip(chip.id),
              },
                chip.color === '' ? null : h('span', { className: 'st-dot', style: { background: chip.color } }),
                chip.label,
                h('span', { className: 'st-chip-count' }, String(chip.count))))),
          boxGroups === null
            ? [
              h(Section, {
                key: 'doing',
                kind: 'doing',
                title: t('section.doing'),
                count: groups.doing.length,
                collapsed: collapsed.doing === true,
                onToggle: () => toggleSection('doing'),
                empty: t('empty.doing'),
                t,
              }, renderRows(groups.doing)),
              h(Section, {
                key: 'todo',
                kind: 'todo',
                title: t('section.todo'),
                count: groups.todo.length,
                collapsed: collapsed.todo === true,
                onToggle: () => toggleSection('todo'),
                empty: t('empty.todo'),
                t,
              }, renderRows(groups.todo)),
              h(Section, {
                key: 'done',
                kind: 'done',
                title: t('section.done'),
                count: groups.done.length,
                collapsed: collapsed.done === true,
                onToggle: () => toggleSection('done'),
                empty: t('empty.done'),
                t,
              }, renderRows(groups.done)),
            ]
            : boxGroups.map((group) => {
              const open = group.rows.filter((row) => !row.done).length
              return h(Section, {
                key: group.key,
                kind: 'box',
                title: group.title,
                color: group.color,
                count: group.rows.length,
                badge: String(open) + '/' + String(group.rows.length),
                badgeTitle: t('group.badge', { open, total: group.rows.length }),
                collapsed: boxCollapsed[group.key] === true,
                onToggle: () => setBoxCollapsed((previous) => Object.assign({}, previous, { [group.key]: previous[group.key] !== true })),
                empty: t('empty.todo'),
                t,
              }, renderRows(group.rows))
            }),
          h('div', { className: 'st-note-line' }, t('page.live'))))
    }

    /* ------------------------------------------------------------------ *
     * Plugin detail self-test (plugins.detail.section)
     * ------------------------------------------------------------------ */

    const PACKAGE_NAME = 'dsh-session-todos'
    const CHECK_TIMEOUT_MS = 2000
    const HEALTH_ENDPOINT = '/session-todos/health'

    /** One request under the section's budget; never throws. */
    async function probe(path, init, timeoutMs) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller === null
        ? null
        : setTimeout(() => {
          try {
            controller.abort()
          } catch {
            /* already aborted */
          }
        }, timeoutMs)
      try {
        const response = await fetch(path, Object.assign({}, init, {
          signal: controller === null ? undefined : controller.signal,
        }))
        let json
        try {
          json = await response.json()
        } catch {
          json = undefined
        }
        return { reached: true, status: response.status, json }
      } catch {
        return { reached: false, timedOut: controller !== null && controller.signal.aborted, status: 0 }
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }

    /** The four checks, each bounded by the section's budget. */
    function selfTestChecks(t, timeoutMs) {
      const missed = (result) => (result.timedOut ? t('selftest.timeout') : t('selftest.noAnswer'))
      return [
        {
          id: 'route',
          label: t('selftest.route'),
          run: async () => {
            const result = await probe(ENDPOINT, { headers: { accept: 'application/json' }, cache: 'no-store' }, timeoutMs)
            if (!result.reached) return { ok: false, detail: missed(result) }
            if (result.status !== 200) return { ok: false, detail: t('selftest.http', { status: result.status }) }
            const todos = result.json?.todos
            if (result.json?.ok !== true || todos === null || typeof todos !== 'object' || Array.isArray(todos)) {
              return { ok: false, detail: t('selftest.routeBad') }
            }
            return { ok: true, detail: t('selftest.routeOk', { count: Object.keys(todos).length }) }
          },
        },
        {
          id: 'settings',
          label: t('selftest.settings'),
          run: async () => {
            const result = await probe(SETTINGS_ENDPOINT, { headers: { accept: 'application/json' }, cache: 'no-store' }, timeoutMs)
            if (!result.reached) return { ok: false, detail: missed(result) }
            if (result.status !== 200) return { ok: false, detail: t('selftest.http', { status: result.status }) }
            if (typeof result.json?.autoWatch !== 'boolean' || typeof result.json?.reopenOnResume !== 'boolean') {
              return { ok: false, detail: t('selftest.settingsBad') }
            }
            return {
              ok: true,
              detail: 'autoWatch=' + String(result.json.autoWatch) + ' · reopenOnResume=' + String(result.json.reopenOnResume),
            }
          },
        },
        {
          id: 'events',
          label: t('selftest.events'),
          run: () => {
            if (typeof EventSource !== 'function') return { skip: true, detail: t('selftest.noEventSource') }
            return new Promise((resolve) => {
              let done = false
              let timer = null
              const source = new EventSource(EVENTS)
              const finish = (value) => {
                if (done) return
                done = true
                if (timer !== null) clearTimeout(timer)
                try {
                  source.close()
                } catch {
                  /* already closed */
                }
                resolve(value)
              }
              timer = setTimeout(() => finish({ skip: true, detail: t('selftest.eventsSilent') }), timeoutMs)
              source.addEventListener('todos', () => finish({ ok: true }))
              source.addEventListener('error', () => finish({ skip: true, detail: t('selftest.eventsUnavailable') }))
            })
          },
        },
        {
          id: 'tool',
          label: t('selftest.tool'),
          run: async () => {
            const result = await probe(HEALTH_ENDPOINT, { headers: { accept: 'application/json' }, cache: 'no-store' }, timeoutMs)
            if (!result.reached) return { ok: false, detail: missed(result) }
            if (result.status !== 200) return { ok: false, detail: t('selftest.http', { status: result.status }) }
            if (result.json?.registered !== true || result.json?.tool !== 'session_todos') {
              return { ok: false, detail: t('selftest.toolBad') }
            }
            return { ok: true, detail: 'session_todos' }
          },
        },
      ]
    }

    /** The section: a run button, the summary, the rows, and a Markdown copy. */
    function SelfTestSection({ ctx, subject, timeoutMs }) {
      const locale = ctx.locale ?? readService(ctx, 'locale')
      useLocaleRevision(locale)
      const t = locale.bind(NS)
      const [rows, setRows] = useState([])
      const [running, setRunning] = useState(false)
      const [note, setNote] = useState('')
      const budget = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : CHECK_TIMEOUT_MS
      const checks = selfTestChecks(t, budget)
      const pkg = subject !== null && typeof subject === 'object' ? subject.pkg : undefined
      const mine = pkg !== undefined && pkg !== null && typeof pkg === 'object' && pkg.name === PACKAGE_NAME
      if (!mine) return null

      const counts = rows.reduce((acc, row) => {
        if (row.status === 'pass') acc.pass += 1
        else if (row.status === 'skip') acc.skip += 1
        else if (row.status === 'fail') acc.fail += 1
        return acc
      }, { pass: 0, fail: 0, skip: 0 })
      const summary = rows.length === 0
        ? t('selftest.idle')
        : t('selftest.summary', { pass: counts.pass, fail: counts.fail, skip: counts.skip })

      const pending = () => checks.map((check) => ({ id: check.id, label: check.label, status: 'run', detail: '' }))

      const run = async () => {
        if (running) return
        setRunning(true)
        setNote('')
        setRows(pending())
        const settled = []
        for (const check of checks) {
          let outcome
          try {
            outcome = await check.run()
          } catch (error) {
            outcome = { ok: false, detail: String(error?.message ?? error) }
          }
          settled.push({
            id: check.id,
            label: check.label,
            status: outcome.skip === true ? 'skip' : outcome.ok === true ? 'pass' : 'fail',
            detail: typeof outcome.detail === 'string' ? outcome.detail : '',
          })
          setRows(settled.concat(checks.slice(settled.length).map((rest) => ({
            id: rest.id, label: rest.label, status: 'run', detail: '',
          }))))
        }
        setRows(settled)
        setRunning(false)
      }

      const statusText = (status) => (status === 'pass' ? t('selftest.pass')
        : status === 'fail' ? t('selftest.fail')
          : status === 'skip' ? t('selftest.skip')
            : status === 'run' ? t('selftest.running') : t('selftest.idle'))

      const markdown = () => rows.map((row) => (row.status === 'pass'
        ? '- [x] ' + row.label + ' — ' + t('selftest.pass')
        : '- [ ] ' + row.label + ' — ' + statusText(row.status)
          + (row.detail === '' ? '' : t('selftest.colon') + row.detail))).join('\n')

      const copy = async () => {
        const text = rows.length === 0 ? t('selftest.idle') : markdown()
        try {
          if (typeof navigator === 'undefined' || navigator.clipboard === undefined) throw new Error('no clipboard')
          await navigator.clipboard.writeText(text)
          setNote(t('selftest.copied'))
        } catch {
          setNote(t('selftest.copyFailed'))
        }
      }

      return h('div', { className: 'st-st', 'data-selftest': PACKAGE_NAME },
        h('div', { className: 'st-st-head' },
          h('h3', { className: 'st-st-title' }, t('selftest.title')),
          h('button', {
            type: 'button',
            className: 'st-st-btn',
            'data-primary': 'true',
            'data-selftest-action': 'run',
            disabled: running,
            onClick: () => {
              void run()
            },
          }, running ? t('selftest.running') : t('selftest.run')),
          h('span', { className: 'st-st-sum', 'data-selftest-summary': summary }, summary),
          h('button', {
            type: 'button',
            className: 'st-st-btn',
            'data-selftest-action': 'copy',
            disabled: rows.length === 0,
            onClick: () => {
              void copy()
            },
          }, t('selftest.copy'))),
        note === '' ? null : h('p', { className: 'st-st-sum', 'data-selftest-note': note }, note),
        h('div', { className: 'st-st-list' }, rows.map((row) => h('div', {
          key: row.id,
          className: 'st-st-row',
          'data-check': row.id,
          'data-status': row.status,
        },
          h('div', { className: 'st-st-label' },
            h('div', null, row.label),
            row.detail === '' || row.status === 'run' ? null : h('div', { className: 'st-st-detail' }, row.detail)),
          h('span', { className: 'st-st-badge', 'data-status': row.status }, statusText(row.status))))))
    }

    /* ------------------------------------------------------------------ *
     * Settings drawer (gear on the Todo page header)
     * ------------------------------------------------------------------ */

    const NOTIFY_WATCH_ENDPOINT = '/session-notify/watch'
    const NOTIFY_MODE_ENDPOINT = '/session-notify/mode'
    const NOTIFY_SETTINGS_ENDPOINT = '/session-notify/settings'

    /** The session the app currently shows, as far as the client can tell. */
    function readCurrentSessionId() {
      try {
        const raw = localStorage.getItem('dsh.sessions.current')
        if (typeof raw !== 'string' || raw === '') return ''
        const parsed = JSON.parse(raw)
        const id = parsed?.sessionId ?? parsed?.state?.sessionId ?? parsed?.value?.sessionId
        return typeof id === 'string' ? id : ''
      } catch {
        return ''
      }
    }

    /**
     * Session-notify's optional reminder state. The block only renders when the
     * peer answers; mode and defaults light up once its 0.5.0 routes exist.
     */
    function createReminderStore() {
      let state = {
        status: 'idle',
        available: false,
        capability: false,
        sessionId: '',
        watching: false,
        mode: 'once',
        defaultWatch: false,
        defaultMode: 'once',
        saving: null,
      }
      const listeners = new Set()
      let inflight = null

      function publish(next) {
        state = next
        for (const listener of listeners) listener()
      }

      async function call(url, options) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        let timer = null
        if (controller !== null) {
          timer = setTimeout(() => {
            try {
              controller.abort()
            } catch {
              /* already aborted */
            }
          }, LINK_TIMEOUT_MS)
        }
        try {
          const response = await fetch(url, Object.assign({ cache: 'no-store' }, options, {
            signal: controller === null ? undefined : controller.signal,
          }))
          const payload = await response.json().catch(() => null)
          if (response.ok !== true || payload === null) return null
          return payload
        } catch {
          return null
        } finally {
          if (timer !== null) clearTimeout(timer)
        }
      }

      function refresh(sessionId) {
        if (inflight !== null) return inflight
        inflight = (async () => {
          try {
            const list = await call(NOTIFY_ENDPOINT, { headers: { accept: 'application/json' } })
            if (list === null || list.ok !== true || list.watched === null || typeof list.watched !== 'object') {
              publish(Object.assign({}, state, { status: 'ready', available: false, sessionId, capability: false, saving: null }))
              return
            }
            const entry = sessionId === '' ? undefined : list.watched[sessionId]
            const settings = await call(NOTIFY_SETTINGS_ENDPOINT, { headers: { accept: 'application/json' } })
            const capability = settings !== null && settings.ok === true
              && typeof settings.defaultWatch === 'boolean'
            publish({
              status: 'ready',
              available: true,
              capability,
              sessionId,
              watching: entry !== undefined && entry !== null,
              mode: entry !== undefined && entry !== null && entry.mode === 'always' ? 'always' : 'once',
              defaultWatch: capability && settings.defaultWatch === true,
              defaultMode: capability && settings.defaultMode === 'always' ? 'always' : 'once',
              saving: null,
            })
          } finally {
            inflight = null
          }
        })()
        return inflight
      }

      async function setWatch(on) {
        if (state.available !== true || state.sessionId === '' || state.saving !== null) return
        const previous = state.watching
        publish(Object.assign({}, state, { watching: on === true, saving: 'watch' }))
        const result = await call(NOTIFY_WATCH_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sessionId: state.sessionId, on: on === true }),
        })
        if (result === null || result.ok !== true) {
          publish(Object.assign({}, state, { watching: previous, saving: null }))
          return
        }
        publish(Object.assign({}, state, { watching: result.watching === true, saving: null }))
      }

      async function setMode(mode) {
        if (state.capability !== true || state.watching !== true || state.saving !== null) return
        const next = mode === 'always' ? 'always' : 'once'
        if (next === state.mode) return
        const previous = state.mode
        publish(Object.assign({}, state, { mode: next, saving: 'mode' }))
        const result = await call(NOTIFY_MODE_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sessionId: state.sessionId, mode: next }),
        })
        if (result === null || result.ok !== true) {
          publish(Object.assign({}, state, { mode: previous, saving: null }))
          return
        }
        publish(Object.assign({}, state, { mode: result.mode === 'always' ? 'always' : 'once', saving: null }))
      }

      async function setDefaults(patch) {
        if (state.capability !== true || state.saving !== null) return
        const previous = { defaultWatch: state.defaultWatch, defaultMode: state.defaultMode }
        const next = {
          defaultWatch: patch.defaultWatch === undefined ? previous.defaultWatch : patch.defaultWatch === true,
          defaultMode: patch.defaultMode === undefined ? previous.defaultMode : (patch.defaultMode === 'always' ? 'always' : 'once'),
        }
        publish(Object.assign({}, state, next, { saving: 'defaults' }))
        const result = await call(NOTIFY_SETTINGS_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(next),
        })
        if (result === null || result.ok !== true) {
          publish(Object.assign({}, state, previous, { saving: null }))
          return
        }
        publish(Object.assign({}, state, {
          defaultWatch: result.defaultWatch === true,
          defaultMode: result.defaultMode === 'always' ? 'always' : 'once',
          saving: null,
        }))
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
        setWatch,
        setMode,
        setDefaults,
      }
    }

    const reminderStore = createReminderStore()

    function useReminderState() {
      return React.useSyncExternalStore(reminderStore.subscribe, reminderStore.getSnapshot, reminderStore.getSnapshot)
    }

    /** One switch, shared by every drawer row. */
    function DrawerSwitch({ checked, disabled, label, onChange }) {
      return h('button', {
        type: 'button',
        className: 'st-switch',
        role: 'switch',
        'aria-checked': checked === true,
        'aria-label': label,
        disabled: disabled === true,
        onClick: () => onChange(checked !== true),
      })
    }

    /** One row: label, hint, storage note, scope badge, controls. */
    function DrawerRow({ label, hint, store, scope, scopeKind, children }) {
      return h('div', { className: 'st-set-row' },
        h('div', { className: 'st-set-main' },
          h('div', { className: 'st-set-label' }, label),
          hint === undefined ? null : h('div', { className: 'st-set-hint' }, hint),
          store === undefined ? null : h('div', { className: 'st-set-store' }, store)),
        h('div', { className: 'st-set-actions' },
          scope === undefined ? null : h('span', { className: 'st-scope', 'data-scope': scopeKind ?? 'global' }, scope),
          children))
    }

    /** Two-state segment for once / always. */
    function ModeSegment({ value, disabled, onChange, once, always }) {
      return h('span', { className: 'st-seg', role: 'group' },
        h('button', {
          type: 'button',
          'aria-pressed': value !== 'always',
          disabled: disabled === true,
          onClick: () => onChange('once'),
        }, once),
        h('button', {
          type: 'button',
          'aria-pressed': value === 'always',
          disabled: disabled === true,
          onClick: () => onChange('always'),
        }, always))
    }

    /** The right-hand settings drawer; only mounted while it is open. */
    function SettingsDrawer({ ctx, onClose }) {
      const locale = ctx.locale ?? readService(ctx, 'locale')
      useLocaleRevision(locale)
      const t = locale.bind(NS)
      const link = useLinkState()
      const reminder = useReminderState()
      const panelRef = React.useRef(null)

      const available = link.notifyAvailable === true

      useEffect(() => {
        void linkStore.refresh()
        void reminderStore.refresh(readCurrentSessionId())
      }, [])

      useEffect(() => {
        const panel = panelRef.current
        if (panel === null) return undefined
        const first = panel.querySelector('button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])')
        if (first !== null) first.focus({ preventScroll: true })
        return undefined
      }, [])

      const onPanelKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
          return
        }
        if (event.key !== 'Tab') return
        const panel = event.currentTarget
        const list = panel.querySelectorAll('button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])')
        if (list.length === 0) return
        const head = list[0]
        const tail = list[list.length - 1]
        if (event.shiftKey && document.activeElement === head) {
          event.preventDefault()
          tail.focus()
        } else if (!event.shiftKey && document.activeElement === tail) {
          event.preventDefault()
          head.focus()
        }
      }

      const sessionReady = reminder.sessionId !== ''
      const modeHint = reminder.capability !== true
        ? t('drawer.modeOld')
        : (reminder.watching !== true ? t('drawer.modeNeedsWatch') : undefined)

      return h('div', { className: 'st-drawer', role: 'presentation' },
        h('div', {
          className: 'st-drawer-backdrop',
          role: 'presentation',
          onClick: onClose,
        }),
        h('aside', {
          className: 'st-drawer-panel',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': available ? t('drawer.reminderTitle') : t('drawer.title'),
          tabIndex: -1,
          ref: panelRef,
          onKeyDown: onPanelKeyDown,
        },
          h('header', { className: 'st-drawer-head' },
            h('span', { className: 'st-drawer-title' }, available ? t('drawer.reminderTitle') : t('drawer.title')),
            h('button', {
              type: 'button',
              className: 'st-drawer-close',
              'aria-label': t('drawer.close'),
              onClick: onClose,
            }, '\u00d7')),
          h('div', { className: 'st-drawer-body' },
            h('div', { className: 'st-set-group' },
              h('div', { className: 'st-set-group-title' }, t('drawer.todoTitle')),
              h(DrawerRow, {
                label: t('drawer.autoWatch'),
                hint: t('drawer.autoWatchHint'),
                store: 'session-todos.json · autoWatch',
                scope: t('scope.global'),
                scopeKind: 'global',
              }, h(DrawerSwitch, {
                checked: link.autoWatch === true,
                disabled: link.settingsAvailable !== true || link.saving === 'autoWatch',
                label: t('drawer.autoWatch'),
                onChange: () => {
                  void linkStore.toggleAutoWatch()
                },
              })),
              h(DrawerRow, {
                label: t('drawer.reopen'),
                hint: t('drawer.reopenHint'),
                store: 'session-todos.json · reopenOnResume',
                scope: t('scope.global'),
                scopeKind: 'global',
              }, h(DrawerSwitch, {
                checked: link.reopenOnResume === true,
                disabled: link.settingsAvailable !== true || link.saving === 'reopenOnResume',
                label: t('drawer.reopen'),
                onChange: () => {
                  void linkStore.toggleReopen()
                },
              }))),
            available
              ? h('div', { className: 'st-set-group' },
                h('div', { className: 'st-set-group-title' }, t('drawer.reminderTitle')),
                h(DrawerRow, {
                  label: t('drawer.watch'),
                  hint: sessionReady ? t('drawer.watchHint') : t('drawer.noSession'),
                  store: 'notify watch · POST /session-notify/watch',
                  scope: t('scope.session'),
                  scopeKind: 'session',
                }, h(DrawerSwitch, {
                  checked: reminder.watching === true,
                  disabled: !sessionReady || reminder.saving === 'watch',
                  label: t('drawer.watch'),
                  onChange: (next) => {
                    void reminderStore.setWatch(next)
                  },
                })),
                h(DrawerRow, {
                  label: t('drawer.mode'),
                  hint: modeHint,
                  store: "POST /session-notify/mode { mode: 'once' | 'always' }",
                  scope: t('scope.session'),
                  scopeKind: 'session',
                }, h(ModeSegment, {
                  value: reminder.mode,
                  disabled: reminder.capability !== true || reminder.watching !== true || reminder.saving === 'mode',
                  onChange: (mode) => {
                    void reminderStore.setMode(mode)
                  },
                  once: t('drawer.once'),
                  always: t('drawer.always'),
                })),
                h(DrawerRow, {
                  label: t('drawer.defaults'),
                  hint: reminder.capability !== true ? t('drawer.modeOld') : t('drawer.defaultsHint'),
                  store: 'GET/POST /session-notify/settings',
                  scope: t('scope.global'),
                  scopeKind: 'global',
                },
                  h(DrawerSwitch, {
                    checked: reminder.defaultWatch === true,
                    disabled: reminder.capability !== true || reminder.saving === 'defaults',
                    label: t('drawer.defaults'),
                    onChange: (next) => {
                      void reminderStore.setDefaults({ defaultWatch: next })
                    },
                  }),
                  h(ModeSegment, {
                    value: reminder.defaultMode,
                    disabled: reminder.capability !== true || reminder.defaultWatch !== true || reminder.saving === 'defaults',
                    onChange: (mode) => {
                      void reminderStore.setDefaults({ defaultMode: mode })
                    },
                    once: t('drawer.once'),
                    always: t('drawer.always'),
                  })))
              : null,
            h('p', { className: 'st-drawer-note' }, t('drawer.note')))))
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

        // Only register the resume watcher while the preference is on; toggling
        // it from the Todo page takes effect immediately, and off means off.
        ctx.effect(() => {
          let dispose = null
          const sync = () => {
            const wanted = linkStore.getSnapshot().reopenOnResume === true
            if (wanted && dispose === null) {
              dispose = watchRunningSessions(ctx) ?? null
            } else if (!wanted && dispose !== null) {
              dispose()
              dispose = null
            }
          }
          sync()
          const off = linkStore.subscribe(sync)
          // The watcher needs the stored preference even while the page is closed.
          void linkStore.refresh()
          return () => {
            off()
            if (typeof dispose === 'function') dispose()
          }
        }, 'session-todos: reopen on resume')

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

        // The self-test renders on this plugin's own detail page only, and runs
        // nothing until its button is pressed.
        const SelfTest = (props) => h(SelfTestSection, Object.assign({}, props, { ctx }))
        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'dsh-session-todos.selftest',
          order: 90,
          locale: NS,
        }, SelfTest))

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
