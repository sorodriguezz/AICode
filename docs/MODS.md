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

| Permission | Allows |
|---|---|
| `fs:read` | `ctx.fs.readText/readDir/stat/listFiles/search/watch/reveal` |
| `fs:write` | `ctx.fs.writeText/create/rename/delete/copy` (`copy` needs `fs:read` too) |
| `process` | `ctx.process.which/spawn` — programs on the user's machine (login-shell PATH) |
| `pty` | `ctx.pty.spawn`, `ctx.pty.shells` — terminals |
| `mcp-server` | `ctx.mcp.start` — serve tools on 127.0.0.1 |
| `open-external` | `ctx.external.open` — links, files, other apps |

The user sees them on the Mods page and confirms them when enabling the mod. The Rust side checks
them on every call. **This is a contract, not a sandbox**: mods share the window's JavaScript realm
in API 1, so a hostile mod could reach around `ctx`. Install mods you trust. Per-mod isolation
(each mod in its own realm, talking to the core over messages) is the plan for API 2.

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
| `ctx.window` | `showInfo/showWarning/showError(msg, ...actions)`, `showQuickPick(items, { placeholder, matchDescription, activeIndex, onActive(item), onButton(item, button) })` (an item's `buttons: [{ icon, title, id }]` show on its row; `onButton` returns `"remove"` to drop that row or `"close"`), `showInputBox(opts)`, `confirm(msg, detail?, primary?)`, `contextMenu(x, y, [{ label, run, keybinding, disabled, checked, icon, separator }])`, `pickFolder()`, `pickFiles()`, `copy(text)` |
| `ctx.editor` | `active()`, `all()`, `getText(idOrPath?)`, `getSelection()`, `replaceSelection(text)`, `open(path, {line})`, `focus(id)`, `newUntitled(text, lang)`, `openCustom({ title, icon, render })`, `close(id)`, `save(id?)`, `proposeEdit(target, { newText } \| { edits }, { description })` → accepted?, `onDidChangeActive/onDidChangeEditors/onDidSave/onDidChangeContent(fn)`, `monacoEditor()`, `addTitleAction({ id, icon, title, order, when(info), run(info) })` (an icon in the tab bar, VS Code's editor/title), `refreshTitleActions()`, `registerEditorType({ id, label, when(info), open(info) })` ("Reopen Editor With…"; a tab opened with `openCustom({ forPath, editorType })` is that view of the file), `openSide({ title, icon, render, actions: [{ id, icon, title, run }], onDidChangeMaximized(on) })` / `closeSide()` (a pane beside the editor, with its own tab bar icons), `maximizeSide(on?)` / `isSideMaximized()` (that pane over the whole editor area — the Markdown preview's *Maximize*), `openPage(spec)` (the modal editor, or a tab when it is off), `registerBreadcrumbs({ languages, path(text, line, column) → [{ name, line, icon }] })` (the breadcrumbs after the file name: where the cursor is — the JSON & YAML mod's keys, the Markdown mod's headings) |
| `ctx.workspace` | `folder()`, `setFolder(path)`, `onDidChangeFolder(fn)`, `listFiles()` |
| `ctx.fs` | `readText`, `writeText`, `readDir`, `stat`, `create(path, dir)`, `rename(from, to)` (open editors follow), `delete(path, { trash })` (to the Trash by default), `copy(from, to)`, `reveal(path)` (Finder / Explorer), `watch(dir, fn)` (changes directly inside `dir`), `listFiles(root)`, `search(root, query, opts)`, `home()` |
| `ctx.decorations` | `register(path => ({ badge, color, tooltip, faded }))` → `{ fire, dispose }`, `get(path)`, `onDidChange(fn)` — how files show in the explorer (the Git mod's colors) |
| `ctx.process` | `which(program)`, `spawn(program, args, { cwd, stdin, env, onData, onExit })` → `{ id, done, kill }` |
| `ctx.pty` | `spawn({ cwd, command, args, cols, rows, onData, onExit })` → `{ write, resize, kill }`, `shells()` → `{ default, shells }` |
| `ctx.mcp` | `start()`, `stop()`, `status()`, `setTools(tools)`, `onCall(handler)` |
| `ctx.external` | `open(target, app?)`, `appInstalled(name)` |
| `ctx.settings` | `get(key, fallback)`, `getNow(key, fallback)`, `set(key, value)`, `all()`, `inspect(key)`, `onDidChange(fn)`: this mod's settings, by layers (the user's value, else a mod's default, else the declared default) |
| `ctx.config` | `get(key)` (a core setting), `getFor(owner, key)`, `all(owner)`, `inspect(key, owner)`, `update(key, value, owner)`, `watch(keys, fn)`, `onDidChange(fn)`, `schema(owner)`: the whole configuration |
| `ctx.styles` | `add(css)`, `addFile(path)`: CSS that stays while the mod runs |
| `ctx.workbench` | `root()`, `part(name)`, `parts(name)`, `addTitleItem({ icon, text, title, command, run, align, order })`, `options()`, `setOptions(o)`, `toggle(loc)`, `isPartVisible(loc)`, `views()`, `moveView(id, loc)`, `setCenterView(id)`, `centerView()`, `drawIconThemeWith(themeId, targetId \| null)` (in this window, draw a file icon theme with another one while it stays the chosen one — the Auto pack) |
| `ctx.windows` | `open({ layout, view, title, width, height, alwaysOnTop, settings })`, `openView(id, opts)`, `layouts()`, `current()`, `setAlwaysOnTop(on)`, `isAlwaysOnTop()`, `reopen()`, `moveViewToNewWindow(id)` |
| `ctx.mods` | `get(id)` (activates it, returns its exports), `isEnabled(id)`, `contributions(point)` (what enabled mods declare under `contributes.<point>`, each with `mod` = its id — how a mod offers an extension point of its own) |
| `ctx.ui` | `h(tag, attrs, ...children)`, `icon(name)`, `iconButton(name, title, fn)`, `clear(el)`, `basename`, `dirname`, `joinPath`, `fileIcon`, `fileIconColor` (codicons), `fileIconEl(name)` (the icon theme's icon for a file, a codicon without one), `folderIconEl(name, expanded)` (a folder's, or null when the theme draws no folders) |
| `ctx.monaco` | the Monaco API (languages, providers, decorations) |
| `ctx.asset(path)` | URL of a file in the mod (stylesheets, images, workers) |

View actions get the click (`run(e)`), so one can open a menu under its button. An element can
keep keys the workbench would otherwise take: `data-own-keys="mod+k"` (the terminal's ⌘K).

Style with the workbench's CSS variables (`var(--aicode-foreground)`, …) and classes (`btn`,
`input`, `list-row`, `section-header`, `chip`, `muted`, `pad`) so a mod follows the theme.

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
