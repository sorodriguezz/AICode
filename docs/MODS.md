# Writing an AICode mod

> Most mods need no code: a single `mod.json` can add commands that run actions, panels,
> status bar items, snippets, themes and settings. That is described in
> [MOD-GUIDE.md](MOD-GUIDE.md), written so an AI can follow it too. This page is about mods with
> code (`main`).

A mod is a folder with a `mod.json` and, optionally, an ES module. AICode reads every enabled mod's
manifest at startup and puts what it **declares** on screen — views, commands, keybindings, themes,
snippets — without running any of its code. The code loads the first time it is needed.

```
my.mod/
├── mod.json        identity, activation events, permissions, what it contributes
├── main.js         export function activate(ctx) { … }   (omit for a declarative mod)
└── …               anything else it loads (relative imports work: ./vendor/lib.mjs)
```

Install one with **Mods › Install from folder…**, or copy the folder into
`~/Library/Application Support/AICode/mods/` (a user mod with the id of a bundled one replaces it).
In a debug build the bundled mods load straight from `mods/` in this repo: edit, then
**Developer: Reload Window** (⌘R).

## States

| State | Meaning |
|---|---|
| installed | the folder exists |
| enabled | the active **profile** lists it (`profiles/<name>/profile.json`) — its declarations are on screen |
| running | an activation event fired and `activate(ctx)` ran |

Turning a mod on also turns on its `dependencies`; turning one off also turns off what depends on
it. Changes apply on reload (open files and unsaved text survive a reload).

## mod.json

```jsonc
{
  "id": "acme.todo",                // letters, digits, . - _  — also the folder name
  "name": "TODO Tree",
  "version": "1.0.0",
  "description": "Lists TODO comments in the open folder.",
  "icon": "checklist",              // a codicon name (https://microsoft.github.io/vscode-codicons/)
  "main": "main.js",                // omit for a declarative mod
  "api": 1,                         // the mod API version it was written for
  "activation": ["onView:todo"],    // when to load main.js (see below)
  "permissions": ["fs:read"],       // what its calls into the core may do
  "dependencies": [],               // mods that must be on (their exports via ctx.mods.get)
  "optionalDependencies": [],       // used when present
  "contributes": {
    "views": [{ "id": "todo", "title": "TODOs", "icon": "checklist", "location": "sidebar", "order": 30, "keybinding": "mod+shift+t" }],
    "commands": [{ "id": "todo.refresh", "title": "Refresh TODOs", "category": "TODO", "keybinding": "mod+k t" }],
    "keybindings": [{ "key": "ctrl+alt+t", "command": "todo.refresh" }],
    "themes": [{ "id": "night", "label": "Night", "uiTheme": "vs-dark", "path": "themes/night.json" }],
    "snippets": [{ "language": "markdown", "path": "snippets/md.json" }],
    "configurationDefaults": { "core": { "workbench.tabs.shape": "pill" } },
    "styles": [{ "path": "todo.css" }],
    "titleBar": [{ "id": "todo.refresh", "icon": "refresh", "command": "todo.refresh", "align": "right" }],
    "windowLayouts": { "todos": { "center": "todo", "options": { "activityBar": false } } }
  }
}
```

`configurationDefaults`, `styles`, `titleBar` and `windowLayouts` change the window itself. What
they can reach is described in [CONFIGURATION.md](CONFIGURATION.md).

- **Locations**: `sidebar` (primary side bar, with an activity bar icon), `secondary` (right side
  bar, tabs in its header), `panel` (bottom, tabs in its header). A part with no views is not shown.
- **Keys**: `mod` is ⌘ on macOS and Ctrl elsewhere; chords are space separated (`mod+k mod+o`).

### Activation events

| Event | Fires when |
|---|---|
| `onStartup` (or `*`) | the window opens |
| `onView:<id>` | that view is first shown |
| `onCommand:<id>` | that command is first run (commands listed in `contributes.commands` imply it) |
| `onLanguage:<id>` | a file of that Monaco language is first made active |
| `onFolder` | a folder is opened |

Prefer the narrowest one. `onStartup` is for mods whose job is to be running (the MCP server).

### Permissions

| Permission | Describes |
|---|---|
| `fs:read` | `ctx.fs.readText/readDataUrl/readBytes/readDir/stat/listFiles/search/watch/reveal` |
| `fs:write` | `ctx.fs.writeText/create/rename/delete/copy` (`copy` needs `fs:read` too) |
| `process` | `ctx.process.which/spawn` — programs on the user's machine (login-shell PATH) |
| `pty` | `ctx.pty.spawn`, `ctx.pty.shells` — terminals |
| `mcp-server` | `ctx.mcp.start` — serve tools on 127.0.0.1 |
| `open-external` | `ctx.external.open` — links, files, other apps |
| `network` | `ctx.http` — HTTP requests to any address |
| `secrets` | `ctx.secrets` — the macOS Keychain |

They tell the user what a mod does: the Mods page shows them and the user confirms them when
enabling the mod. **They do not limit it**: an enabled mod can call anything in `ctx`, declared or
not (run `bash`, `curl`, any program; read and write any file). AICode is meant to be changed
without limits, so declaring is for the user's information. Mods share the window's JavaScript
realm: install mods you trust.

## Where mods live

`bundled` (inside the app) → `AICode/mods/<id>` (shared by every profile) →
`AICode/profiles/<profile>/mods/<id>` (only that profile; exported with it). A later one replaces an
earlier one with the same id. *Install from File/Folder* and *Create Mod* put mods in the current
profile.

## Declarative mods

A mod with no `main` runs no code of its own. Besides the inline contributions in
[MOD-GUIDE.md](MOD-GUIDE.md) (commands with `run`, `views` with `items`/`markdown`, `statusBar`,
`editorContextMenu`, `settings`, inline `themes` and `snippets`), it can point at files:

| `contributes` | File | Used for |
|---|---|---|
| `themes` | theme JSON: `colors` (workbench keys) and `tokenColors` (rules by scope); `include` builds on another theme file | the whole window — every key becomes a CSS variable (`sideBar.background` → `--aicode-sideBar-background`) — and the editor's token colors |
| `languages` | `{ id, extensions, filenames, aliases, configuration }`; the configuration file sets comments, brackets, auto-closing pairs, indentation and folding | new languages and file associations |
| `grammars` | `{ language, scopeName, path }` pointing at a TextMate grammar (`.tmLanguage.json`) | syntax highlighting for a language Monaco does not know (the grammar engine loads only when such a file is opened) |
| `snippets` | `{ "Name": { "prefix", "body", "description" } }` | completions |
| `iconThemes` | `{ id, label, path }` pointing at a VS Code file-icon-theme JSON: font glyphs (`fonts`, `fontCharacter`, `fontColor`, like Seti) or pictures (`iconPath`, like vscode-icons), with `file`, `folder`, `folderExpanded`, `fileNames`, `fileExtensions`, `folderNames`, `folderNamesExpanded`, `languageIds` and `light`; AICode also reads `fileNamePatterns` / `folderNamePatterns` (`"*Controller.java": "rest"`, in order, after exact names and before extensions). Fonts and pictures are relative to the JSON | the icons of files and folders everywhere they are listed; `workbench.iconTheme` (or *Preferences: File Icon Theme…*) picks one by `id`. With none, files show codicons. See `mods/aicode.icons` |

| `icons` | `{ "<name>": "icons/x.svg" \| { "path", "svg", "url", "codicon", "char", "font", "color", "scale" } }` | draw any icon of the window differently (`"files"` is the Explorer's, `"gear"` the settings button, `"search"`, `"source-control"`…), or add new icon names that work wherever an icon name does (views, status bar, menus). An SVG is tinted with the text color unless `color: true` |
| `menus` | `{ "<menu id>": [{ "command", "label", "icon", "keybinding", "order", "separatorBefore" }] }` | items in the window's menus and the app's menu bar (ids below); the label defaults to the command's title |
| `activityBar` | `[{ "icon", "title", "command", "position": "top" \| "bottom", "order" }]` | activity bar buttons that run a command (not views) |

See `mods/aicode.themes` for themes and `mods/aicode.markdown/snippets` for snippets. AICode mods are the only kind of extension it
loads: a folder without a `mod.json` is not a mod.

## The `ctx` API (api 1)

```js
export async function activate(ctx) {
  ctx.views.provide("todo", {
    actions: [{ icon: "refresh", title: "Refresh", run: refresh }],
    render(el) { el.append(ctx.ui.h("div", { class: "pad" }, "Hello")); },
    onShow() {}, onHide() {},
  });
  ctx.commands.register("todo.refresh", refresh);
  return { refresh };            // what other mods get from ctx.mods.get("acme.todo")
}
```

| Area | Calls |
|---|---|
| `ctx.commands` | `register(id, fn)`, `execute(id, ...args)`, `bind(key, id)`, `exists(id)`, `list()` |
| `ctx.views` | `provide(id, provider)`, `reveal(id)`, `isVisible(id)`, `setBadge(id, n)`, `refreshActions()` |
| `ctx.statusBar` | `add({ text, icon, tooltip, command, align, priority })` → `{ update, dispose }` |
| `ctx.window` | `showInfo/showWarning/showError(msg, ...actions)`, `showQuickPick(items, { placeholder, matchDescription, activeIndex, onActive(item), onButton(item, button) })` (an item's `buttons: [{ icon, title, id }]` show on its row; `onButton` returns `"remove"` to drop that row or `"close"`), `showInputBox(opts)`, `confirm(msg, detail?, primary?)`, `contextMenu(x, y, [{ label, run, keybinding, disabled, checked, icon, separator, submenu }], { menu, context })` (`menu`: an id other mods can add to), `pickFolder()`, `pickFiles()`, `copy(text)` |
| `ctx.editor` | `active()`, `all()`, `getText(idOrPath?)`, `getSelection()`, `replaceSelection(text)`, `open(path, {line})`, `focus(id)`, `newUntitled(text, lang)`, `openCustom({ title, icon, render })`, `close(id)`, `save(id?)`, `proposeEdit(target, { newText } \| { edits }, { description })` → accepted?, `onDidChangeActive/onDidChangeEditors/onDidSave/onDidChangeContent(fn)`, `monacoEditor()`, `addTitleAction({ id, icon, title, order, when(info), run(info) })` (an icon in the tab bar, VS Code's editor/title), `refreshTitleActions()`, `registerEditorType({ id, label, default, hasText(info), when(info), open(info) })` ("Reopen Editor With…"; a tab opened with `openCustom({ forPath, editorType })` is that view of the file and comes back after a restart; `default: true` opens matching files straight in it, never as text first, as preview tabs on a single click; binary files go to the first matching type; `hasText` returning false leaves the text editor out of "Reopen Editor With…" — see `mods/aicode.image-preview`), `open(path, { asText: true })` (the text editor even so), `openSide({ title, icon, render, actions: [{ id, icon, title, run }], onDidChangeMaximized(on) })` / `closeSide()` (a pane beside the editor, with its own tab bar icons), `maximizeSide(on?)` / `isSideMaximized()` (that pane over the whole editor area — the Markdown preview's *Maximize*), `openPage(spec)` (the modal editor, or a tab when it is off), `registerBreadcrumbs({ languages, path(text, line, column) → [{ name, line, icon }] })` (the breadcrumbs after the file name: where the cursor is — the JSON & YAML mod's keys, the Markdown mod's headings) |
| `ctx.fs` (binary) | `readDataUrl(path)` (any file as a `data:` URL for an `<img>`/`<video>`), `readBytes(path)` → `Uint8Array` (up to 40 MB) |
| `ctx.workspace` | `folder()`, `setFolder(path)` (closes the previous folder's tabs first; resolves `false` if the user cancels a save prompt), `onDidChangeFolder(fn)`, `listFiles()` |
| `ctx.fs` | `readText`, `writeText`, `readDir`, `stat`, `create(path, dir)`, `rename(from, to)` (open editors follow), `delete(path, { trash })` (to the Trash by default), `copy(from, to)`, `reveal(path)` (Finder / Explorer), `watch(dir, fn)` (changes directly inside `dir`), `listFiles(root)`, `search(root, query, opts)`, `home()` |
| `ctx.decorations` | `register(path => ({ badge, color, tooltip, faded }))` → `{ fire, dispose }`, `get(path)`, `onDidChange(fn)` — how files show in the explorer (the Git mod's colors) |
| `ctx.process` | `which(program)`, `spawn(program, args, { cwd, stdin, env, keepStdin, encoding, onData, onExit })` → `{ id, done, kill, write(text \| bytes), end() }` — `keepStdin` keeps the input open so you can talk to a REPL, a database client or a helper script over stdio; `encoding: "base64"` gives `onData` the raw bytes |
| `ctx.http` | `request({ url, method, headers, body, timeoutMs, followRedirects, insecure, onHead, onChunk })` → `{ status, statusText, ok, headers, header(name), body, text(), json(), timings: { ttfbMs, totalMs }, size }` (the promise also has `cancel()`); `get(url, opts)`, `post(url, body, opts)`. Sent from Rust: any address, no CORS or CSP, binary bodies, streaming. A non-string `body` goes as JSON |
| `ctx.secrets` | `get(key)`, `set(key, value)`, `delete(key)` (`{ service }` to use another Keychain service) — passwords, tokens, connection strings in the macOS Keychain |
| `ctx.menus` | `add(menuId, { id, label, icon, keybinding, command, args, run(context), when(context), checked, disabled, order, separatorBefore })` → disposable; `items(menuId)`. Menu ids below |
| `ctx.icons` | `set(name, source)` → disposable (see `icons` above: change any icon, or add one), `list()` |
| `ctx.pty` | `spawn({ cwd, command, args, cols, rows, onData, onExit })` → `{ write, resize, kill }`, `shells()` → `{ default, shells }` |
| `ctx.mcp` | `start()`, `stop()`, `status()`, `setTools(tools)`, `onCall(handler)` |
| `ctx.external` | `open(target, app?)`, `appInstalled(name)` |
| `ctx.settings` | `get(key, fallback)`, `getNow(key, fallback)`, `set(key, value)`, `all()`, `inspect(key)`, `onDidChange(fn)`: this mod's settings, by layers (the user's value, else a mod's default, else the declared default) |
| `ctx.config` | `get(key)` (a core setting), `getFor(owner, key)`, `all(owner)`, `inspect(key, owner)`, `update(key, value, owner)`, `watch(keys, fn)`, `onDidChange(fn)`, `schema(owner)`: the whole configuration |
| `ctx.styles` | `add(css)`, `addFile(path)`: CSS that stays while the mod runs |
| `ctx.workbench` | `root()`, `part(name)`, `parts(name)`, `addTitleItem({ icon, text, title, command, run, align, order })`, `addActivityItem({ icon, title, command, run, position, order, badge, checked })` → `{ update, dispose }`, `setViewIcon(viewId, icon)`, `options()`, `setOptions(o)`, `toggle(loc)`, `isPartVisible(loc)`, `views()`, `moveView(id, loc)`, `setCenterView(id)`, `centerView()`, `drawIconThemeWith(themeId, targetId \| null)` (in this window, draw a file icon theme with another one while it stays the chosen one — the Auto pack) |
| `ctx.windows` | `open({ layout, view, title, width, height, alwaysOnTop, settings })`, `openView(id, opts)`, `layouts()`, `current()`, `setAlwaysOnTop(on)`, `isAlwaysOnTop()`, `reopen()`, `moveViewToNewWindow(id)` |
| `ctx.mods` | `get(id)` (activates it, returns its exports), `isEnabled(id)`, `contributions(point)` (what enabled mods declare under `contributes.<point>`, each with `mod` = its id — how a mod offers an extension point of its own) |
| `ctx.ui` | `h(tag, attrs, ...children)`, `icon(name)`, `iconButton(name, title, fn)`, `clear(el)`, `basename`, `dirname`, `joinPath`, `fileIcon`, `fileIconColor` (codicons), `fileIconEl(name)` (the icon theme's icon for a file, a codicon without one), `folderIconEl(name, expanded)` (a folder's, or null when the theme draws no folders) |
| `ctx.monaco` | the Monaco API (languages, providers, decorations) |
| `ctx.asset(path)` | URL of a file in the mod (stylesheets, images, workers) |

View actions get the click (`run(e)`), so one can open a menu under its button. An element can
keep keys the workbench would otherwise take: `data-own-keys="mod+k"` (the terminal's ⌘K).

Style with the workbench's CSS variables (`var(--aicode-foreground)`, …) and classes (`btn`,
`input`, `list-row`, `section-header`, `chip`, `muted`, `pad`) so a mod follows the theme.

## Menus and bars

Every bar and menu of the window takes items from mods:

| Where | How |
|---|---|
| Activity bar | a view (`contributes.views`), or a button that runs a command: `ctx.workbench.addActivityItem` / `contributes.activityBar` (`position: "bottom"` puts it by the gear) |
| Title bar | `ctx.workbench.addTitleItem` / `contributes.titleBar` |
| Status bar | `ctx.statusBar.add` / `contributes.statusBar` |
| Tab bar of the editor | `ctx.editor.addTitleAction({ icon, title, when(info), run(info) })` |
| A view's title | the view provider's `actions` |
| Menu bar (File, Edit, View, Window, or a new menu) | `ctx.menus.add("menubar/<Menu>", { label, command, keybinding })` — a name that is not one of the app's makes a new menu before Window |
| Context menus | `ctx.menus.add(id, item)`; `item.when(context)` and `item.run(context)` get what was clicked |

| Menu id | Where | `context` |
|---|---|---|
| `editor/context` | right click in the text editor | `{ path, language, selection }` |
| `editor/tab` | right click on a tab | the tab (`{ id, path, title, language, dirty, editorType }`) |
| `editor/title` | the tab bar's "…" | the active editor |
| `explorer/context` | right click in the Explorer | `{ path, paths, isDir, folder }` |
| `explorer/title` | the Explorer's "…" | `{ folder }` |
| `terminal/context` | right click in a terminal | `{ id, selection }` |
| `activityBar` | right click on the activity bar | `{ viewId }` |
| `view/title` | right click on a view's title | `{ viewId }` |
| `manage` | the gear button | `{}` |

A mod's own menu gets an id the same way: `ctx.window.contextMenu(x, y, items, { menu: "docker/container", context: c })`.

The text editor's right-click menu is AICode's own (Monaco's is off): Monaco's items (Go to
Definition, Rename, Format, Cut/Copy/Paste…) appear when they apply, then actions added with
`ctx.monaco`'s `editor.addAction({ contextMenuGroupId })` (shown while their `precondition` holds),
then the `editor/context` items.

Menu bar shortcuts: `keybinding` is also bound in the window, so it works from the keyboard either way.
The menu bar itself takes one keystroke with modifiers (`mod+shift+d`, `ctrl+alt+f5`, `f12`); a chord
(`mod+k mod+d`) is shown in the item's name instead (`Run [⌘K ⌘D]`) and the console says why. There is
no `+` key there: use `=`.

To change what is already there: `ctx.icons.set(name, …)` draws any icon differently (all of
them are codicons: `files`, `search`, `source-control`, `gear`, `bell`…), `setViewIcon` changes one
view's icon, and the `workbench.hide` setting hides parts and items (`"statusBar.item:<id>"`,
`"css:<selector>"`). With `ctx.styles` a mod can restyle anything.

## Tool mods: Docker, cloud CLIs, API clients, databases

Everything a tool mod needs is in `ctx`. Some shapes:

**Docker** — `ctx.process.spawn("docker", ["ps", "-a", "--format", "{{json .}}"])` for the list
(one JSON object per line), a view in the side bar with the containers, `docker logs -f <id>` streamed
into a custom tab through `onData`, `docker exec -it <id> sh` in a terminal (`ctx.pty.spawn({ command:
"docker", args: ["exec", "-it", id, "sh"] })`), start/stop/remove in a `docker/container` context menu.
The Engine API also works without the CLI: `ctx.process.spawn("curl", ["--unix-socket",
"/var/run/docker.sock", "http://localhost/containers/json"])`.

**Azure / GCP / AWS** — the CLIs print JSON (`az account list -o json`, `gcloud projects list
--format=json`, `aws sts get-caller-identity --output json`). Log in in a terminal (`ctx.pty.spawn({
command: "az", args: ["login"] })`), show the account or subscription in the status bar, and keep
choices in `ctx.settings`. Tokens the mod gets itself go in `ctx.secrets`.

**API client** — requests go through `ctx.http.request` (status, headers, timings, binary, `cancel()`):

```js
const res = await ctx.http.request({ url, method: "POST", headers: { Authorization: `Bearer ${await ctx.secrets.get("token")}` }, body: { name: "x" } });
show(res.status, res.headers, res.timings.totalMs, res.text());
// Server-sent events or a big download: onChunk gets each piece as it arrives.
```

**Database client** — keep one session open with `keepStdin` and send each query as it comes:

```js
const psql = await ctx.process.spawn("psql", [url, "--csv", "-v", "ON_ERROR_STOP=0"], { keepStdin: true, onData: (out) => buffer += out });
await psql.write("select * from users limit 50;\n");
// … later, in the same session (transactions keep working):
await psql.write("begin; update users set active = false where id = 3;\n");
await psql.end(); // or psql.kill()
```

A mod can also ship a helper script (Node, Python) in its folder and talk to it over stdio:
`ctx.process.spawn("node", [path, …], { keepStdin: true })` with the path from the mod's folder
(`ctx.manifest.dir`). Passwords and connection strings go in `ctx.secrets`, never in settings.

## Agents for the AI Chat

The AI Chat (`aicode.agents`) is only the panel. Every agent is a mod of its own (`aicode.agent-claude`,
`-codex`, `-gemini`, `-grok`, `-opencode`, `-cline`, `-ollama`, `-custom`) — copy one to add another.
An agent mod depends on `aicode.agents`, declares itself, and exports the agent:

```jsonc
"dependencies": ["aicode.agents"],
"permissions": ["process", "open-external"],
"contributes": {
  "chatAgents": [{ "id": "mistral", "name": "Mistral" }]
}
```

An agent with both a `cli` and an `api` part also declares the setting that picks one:
`"settings": { "mode": { "type": "string", "enum": ["cli", "api"], "default": "cli" } }`.

```js
export async function activate(ctx) {
  const { kit } = await ctx.mods.get("aicode.agents");
  const mistral = kit.defineAgent(ctx, {
    id: "mistral", name: "Mistral", icon: "sparkle",
    api: {
      label: "the Mistral API", envVars: ["MISTRAL_API_KEY"], models: ["mistral-large-latest"],
      request: ({ model, system, messages, key }) => ({
        url: "https://api.mistral.ai/v1/chat/completions",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: { model, stream: true, messages: [{ role: "system", content: system }, ...messages.map((m) => ({ role: m.role, content: m.text }))] },
      }),
      stream: (out) => (ev) => ev.choices?.[0]?.delta?.content && out.text(ev.choices[0].delta.content),
    },
  });
  return { chatAgents: { mistral } };
}
```

- **cli** (the user's subscription): `bin`, `build({ prompt, sessionId, mcp, model }) → { args, env }`,
  optionally `parser({ onText, onTool, onSession, onResult })` for structured output (Claude Code's
  stream-json), `resumable`, `mcp` (gets AICode's MCP server), `models`, `needsModel`, `install`
  (a command or URL offered when the CLI is missing), `interactive(model)` (for *Open Agent in Terminal*).
- **api** (an API key): `request(...)` returns the HTTP request, `stream(out)` returns a handler for
  each event (`format`: `"sse"`, `"ndjson"` or `"json"`); call `out.text`, `out.result({ tokens, model,
  cost })`, `out.error(message)`. The key is kept in the macOS Keychain (*Configure …*), or read from one
  of `envVars` in the user's login shell; `noKey: true` for a local server. Requests run through
  `/usr/bin/curl` with the agent mod's `process` permission, so the key is never on a command line.
- The kit adds the *Configure …* menu (CLI or API, set/remove the key, install the CLI) and the status
  the chat shows. A mod can skip the kit and export any object with `id`, `name`, `status()`, `run(opts)`
  → `{ done, kill }` and, optionally, `configure()` and `terminal(model)` — see `mods/aicode.agents/kit.js`.

## Checking a mod

`pnpm check:mods` validates every bundled mod: manifest fields, permissions, dependencies,
referenced files, activation events for each view, and that the entry module parses.
