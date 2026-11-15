# dsh-session-todos

A todo checkbox on every session row in the DeepSeek Harness sidebar, plus a dedicated Todo page that groups sessions as **in progress / to do / done**.

## What it does

- **Row checkbox** — one small square on each session row. Click toggles done ↔ not done.
  - empty = to do; blue ring = the session is running (in progress); green check = done.
  - the row's hover button strip is owned by dsh-session-quickbar; its built-in todo button reads and writes this plugin's /session-todos route, so this plugin no longer registers on sidebar.workspaces.session.row.action;
  - the row's … menu carries "Mark as done / Mark as not done" next to "Importance…".
- **Todo page** — its own sidebar entry, rendered full-width in the main column.
  - three summary cards (in progress / to do / done, with percentages);
  - three collapsible groups, with Done collapsed by default;
  - per-todo note, priority (low / normal / high), and due date; overdue dates turn red;
  - search across session titles, notes, and working directories; optional archived sessions;
  - click a title to open that session.
- **Agent tool `session_todos`** — list / set / clear, so a model can update todos from a conversation.
- **Live sync** — Server-Sent Events push every change to every open window.
- **Durable** — stored in `~/.dsh/session-todos.json`.

## How the state is derived

- **Done** — the square is checked (manual).
- **In progress** — not checked, and the session is running right now (automatic).
- **To do** — everything else.

An explicit check wins: a session that runs again after being marked done stays in Done until you uncheck it.

## Why the square sits on the right

The leading cell of a session row belongs to the app: it shows a running dot while the session works and a completion reminder once it finishes. Any control placed there disappears with those states, so the square lives in the row's trailing seat (next to the star) where it is always visible and never moves.

## Install

In `~/.dsh/profiles/desktop/package.json`:

```json
{
  "dependencies": {
    "dsh-session-todos": "link:D:/Deepseek work/workplace/dsh-session-todos"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "dsh-session-todos"]
    }
  }
}
```

Restart DSH. The Host half registers `/session-todos`, `/session-todos/events`, and the `session_todos` tool; the browser half registers the row square, the Todo page, and its sidebar entry.

## Development

```bash
npm test          # host: store, routes, tool, persistence
npm run test:dom  # browser: square states, click write, page grouping
```

The browser test runs `client.js` under a tiny hooks runtime, so it needs neither React nor jsdom.

## License

MIT
