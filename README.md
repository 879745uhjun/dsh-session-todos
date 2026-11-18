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

## Session boxes integration

When `dsh-session-boxes` is installed, the Todo page groups by box (read-only: same-origin `GET /session-boxes`; its code is never imported and its JSON file is never read):

- **Grouping** — one group per box, child boxes labelled `Parent › Child` and preceded by the box colour dot; ungrouped todos always come last;
- **Group stats** — the header shows `open/total` (for example `2/5`);
- **Filter chips** — `All` / `Ungrouped` / one chip per non-empty box. A parent chip covers its child boxes;
- **Ordering inside a group** — the existing order is kept (in progress → to do by priority/due date → done by completion time).

**Degradation:** if the boxes route answers 404, exceeds the 1.5 s timeout, or returns unparseable JSON, the page falls back to the flat "in progress / to do / done" sections — no error, no blocking. Row checkboxes, the … menu, SSE sync, the storage format, and the `/session-todos` contract are untouched. Installing the boxes plugin later needs no restart: the page re-reads the route every time it opens.

## Session notify linkage (auto-watch)

When `dsh-session-notify` is installed, the Todo page header gains an **Auto-watch todos** switch (off by default; the preference lives in `~/.dsh/session-todos.json` as `autoWatch`):

- with it on, opening a todo (not done) posts `POST /session-notify/watch {on:true}`, so the session pops a card when its turn finishes;
- marking it done, or clearing the todo, releases **only the watches this plugin created** — the `autoWatched` list in the file records ownership, a watch the user set by hand is never touched;
- turning the switch off releases every watch this plugin created;
- requests fire only on state changes: serialized per session and idempotent, no retry storms;
- **degradation:** a 404, a 1.5 s timeout, or an unparseable payload is skipped silently and the todo itself is still saved; without the notify plugin the switch does not render at all;
- **no backfill:** enabling the switch does not watch existing todos, only later state changes.

## Reopen a done todo when its session runs again

When a session transitions from idle to working, its done todo is unchecked automatically so the list matches reality:

- the client watches the session catalog and only a **false → true** transition counts, so a session that is already running when the window opens keeps the state you left it in;
- the write goes through the normal `/session-todos` route, so every other window follows over SSE, and with auto-watch enabled the session is watched again;
- sessions without a todo, or with an open todo, are left alone.

## dsh-notepad linkage (inline note marker)

When dsh-notepad (4.4.0+) is installed, every todo whose session already has a note shows a small document icon next to its title; clicking it opens that note:

- only the public client protocol `window.dshNotepad` (`version: 1`) is used: `listSessionNotes()`, `openSessionNote(id)`, `subscribe()`; its localStorage is never read and its code is never imported;
- **rows without a note take no space** and show no icon;
- when a note lands, the `subscribe` callback re-reads the list so the row's marker refreshes; the subscription is detached when the page unmounts;
- **degradation:** a missing `window.dshNotepad`, `version !== 1`, or any throwing call means no icons at all — todos keep working and loading is never blocked.

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

## Install from GitHub

```sh
dsh plugin --profile desktop add github:879745uhjun/dsh-session-todos
```

Reload the Web UI page after installing.

## Publishing (maintainers)

The normal path is a real `git push`. If it fails with `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`, check whether the credential helper is empty (`git config --get credential.helper` prints nothing) — this is **not** a machine limitation:

```sh
git config --local credential.helper '!gh auth git-credential'
git push origin main
```

Prove the remote with the API (a local `ls-remote` can be flaky, the API channel is stable):

```sh
gh api repos/879745uhjun/dsh-session-todos/git/ref/heads/main --jq '.object.sha'
```

Only when the environment genuinely cannot authenticate, fall back to the REST path (the token is read from `GITHUB_TOKEN` and never written to disk):

```sh
GITHUB_TOKEN="$(gh auth token)" REPO=879745uhjun/dsh-session-todos DIR=. \
  COMMIT_MESSAGE="feat: …" node tools/publish.mjs
```

## License

MIT
