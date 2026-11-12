# Writing an AICode mod — a guide for people and for AIs

> **If you are an AI assistant:** you have been given this guide so you can write an AICode mod
> for a user. Read it all, then answer with **one complete `mod.json`** in a single ```json code
> block, and nothing else in the block. Use only the fields, action types, variables and
> permissions described here — anything else is ignored or rejected. Comments are not allowed
> in the JSON you produce. Check your answer against the checklist at the end before replying.

AICode is a lightweight code editor. On its own it is a notepad; everything else comes from
**mods**. A mod can be **a single JSON file** — no code, no build step. It can add commands
(run from the command palette with ⇧⌘P), keyboard shortcuts, buttons in the status bar, panels
with launchers or notes, right-click items in the editor, snippets and color themes.

Commands do their work through **actions**: insert text, change the selection, run a shell
command, open a URL or a file, write a file, ask an AI agent, run another command, and so on.
Actions can use **variables** such as `${file}`, `${selection}` or `${input:Commit message}`.

---

## 1. The smallest mod

```json
{
  "id": "me.hello",
  "name": "Hello",
  "version": "1.0.0",
  "description": "Says hello.",
  "contributes": {
    "commands": [
      {
        "id": "hello.say",
        "title": "Say Hello",
        "keybinding": "mod+alt+h",
        "run": { "type": "notify", "message": "Hello from ${fileName}!" }
      }
    ]
  }
}
```

To install it, the user opens **Mods** (⇧⌘X), clicks **Install from file…** (or pastes the JSON
into a new tab and runs **Mods: Install This File as Mod**), enables it and reloads the window.

---

## 2. Manifest fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique id, `publisher.name` style. Only letters, digits, `.`, `-`, `_`; at most 96 characters; must not start with `.`. Example: `ana.markdown-tools`. |
| `name` | yes | Name shown to the user. |
| `version` | yes | Version string, e.g. `"1.0.0"`. |
| `description` | no | One sentence: what the mod does. |
| `author` | no | Who made it. |
| `icon` | no | A codicon name (see §8) shown on the mod's card and used for its views. |
| `api` | no | Mod API version it was written for. Always `1`. |
| `permissions` | no | What the mod may do (see §3). Declare only what its actions need. |
| `dependencies` | no | Ids of mods that must be enabled with this one (e.g. `["aicode.terminal"]`). |
| `contributes` | no | What the mod adds (see §4). |
| `main` | no | Only for code mods (§9). **Leave it out for a JSON mod.** |
| `activation` | no | Only for code mods. Leave it out. |

---

## 3. Permissions

The user sees and approves these when enabling the mod. An action that needs a permission the
mod did not declare fails with an error.

| Permission | Needed by |
|---|---|
| `process` | `shell` actions (running programs) |
| `fs:read` | `openFile` and `writeFile` actions |
| `fs:write` | `writeFile` actions (together with `fs:read`) |
| `open-external` | `openUrl` actions |
| `pty` | code mods that open terminals (not needed by JSON mods) |
| `mcp-server` | code mods that serve MCP tools (not needed by JSON mods) |

All other actions (`notify`, `insert`, `transform`, `replace`, `newFile`, `command`, `copy`,
`ask`, `confirm`) need no permission.

---

## 4. Contributions (`contributes`)

Every part is optional. Ids of commands and views must be unique; prefix them with a short name
of the mod (`hello.say`, `tasks.view`).

### 4.1 `commands`

```json
"commands": [
  {
    "id": "tools.upper",
    "title": "Uppercase Selection",
    "category": "Tools",
    "icon": "case-sensitive",
    "keybinding": "mod+k mod+u",
    "run": { "type": "transform", "to": "upper" }
  }
]
```

- `id`, `title` — required. `category` — shown before the title in the palette (defaults to the
  mod's name). `icon` — codicon. `hidden: true` — not listed in the palette (still runnable, e.g.
  from a status bar item).
- `keybinding` — optional shortcut (§7).
- `run` — **one action, or an array of actions run in order** (§5). If an action fails or the
  user cancels an input, the rest are skipped.

### 4.2 `keybindings`

Extra shortcuts for any command, including AICode's own (§6):

```json
"keybindings": [
  { "key": "mod+alt+t", "command": "preferences.theme" },
  { "key": "ctrl+shift+`", "command": "terminal.new" }
]
```

### 4.3 `statusBar`

Items in the bottom bar. Clicking runs `command`.

```json
"statusBar": [
  { "id": "tools.build", "text": "Build", "icon": "tools", "tooltip": "Run the build", "command": "tools.build", "align": "left", "priority": 10 }
]
```

`align` is `"left"` or `"right"` (default left). Higher `priority` sits further left on each
side. `text` may use variables that do not ask anything (`${workspaceName}`, `${date}`), resolved
once at startup.

### 4.4 `views`

A panel with a list of launchers and/or notes, in the side bar (`"sidebar"`, the left), the
secondary side bar (`"secondary"`, the right) or the bottom panel (`"panel"`). A side bar view
gets an icon in the activity bar on the far left.

```json
"views": [
  {
    "id": "tasks.view",
    "title": "Tasks",
    "icon": "checklist",
    "location": "sidebar",
    "keybinding": "mod+alt+k",
    "markdown": "Common tasks for **this project**.",
    "items": [
      { "label": "Install dependencies", "icon": "package", "command": "tasks.install" },
      { "label": "Run tests", "description": "npm test", "icon": "beaker", "command": "tasks.test" },
      { "label": "Open docs", "icon": "book", "command": "tasks.docs" }
    ]
  }
]
```

- `markdown` — optional text above the list: paragraphs, `**bold**`, `*italic*`, `` `code` ``,
  `[links](https://…)`, `# headings` and `- lists`.
- `items` — optional rows; each runs `command` (with optional `args`) when clicked.
- `order` — position among views (lower first, default 50).

### 4.5 `editorContextMenu`

Items in the editor's right-click menu:

```json
"editorContextMenu": [
  { "command": "ai.explain", "title": "Explain with AI", "when": "selection" }
]
```

`when: "selection"` shows it only when text is selected. `title` defaults to the command's.

### 4.6 `snippets`

Completions offered while typing in a language. Write them inline:

```json
"snippets": [
  {
    "language": "markdown",
    "items": {
      "Note box": { "prefix": "note", "body": ["> **Note**", "> $0"], "description": "A note" },
      "Today": { "prefix": "today", "body": "${CURRENT_YEAR}-${CURRENT_MONTH}-${CURRENT_DATE}" }
    }
  }
]
```

`body` is a string or an array of lines. Snippet syntax: `$1`, `$2` tab stops, `${1:default}`
placeholders, `$0` final cursor, `${CURRENT_YEAR}`/`${TM_FILENAME}`-style snippet variables.
Common language ids: `plaintext`, `markdown`, `javascript`, `typescript`, `json`, `html`, `css`,
`scss`, `python`, `rust`, `go`, `java`, `csharp`, `cpp`, `c`, `php`, `ruby`, `shell`, `sql`,
`yaml`, `xml`, `dockerfile`, `swift`, `kotlin`.

### 4.7 `themes`

A color theme, inline:

```json
"themes": [
  {
    "id": "sunset",
    "label": "Sunset Dark",
    "uiTheme": "vs-dark",
    "colors": {
      "editor.background": "#1e1a24",
      "editor.foreground": "#e8dff0",
      "sideBar.background": "#19161f",
      "activityBar.background": "#19161f",
      "statusBar.background": "#7a3e65",
      "focusBorder": "#d97aa6"
    },
    "tokenColors": [
      { "scope": "comment", "settings": { "foreground": "#7d7088", "fontStyle": "italic" } },
      { "scope": ["string"], "settings": { "foreground": "#f2b38f" } },
      { "scope": ["keyword", "storage"], "settings": { "foreground": "#d97aa6" } }
    ]
  }
]
```

`uiTheme`: `"vs-dark"` (dark), `"vs"` (light) or `"hc-black"` (high contrast). Colors not given
fall back to AICode's dark theme. Useful color keys: `editor.background`, `editor.foreground`,
`editor.lineHighlightBackground`, `editor.selectionBackground`, `editorCursor.foreground`,
`editorLineNumber.foreground`, `editorLineNumber.activeForeground`, `sideBar.background`,
`sideBar.foreground`, `sideBarSectionHeader.background`, `activityBar.background`,
`activityBar.foreground`, `activityBar.inactiveForeground`, `activityBar.activeBorder`,
`activityBarBadge.background`, `titleBar.activeBackground`, `tab.activeBackground`,
`tab.inactiveBackground`, `tab.activeBorderTop`, `editorGroupHeader.tabsBackground`,
`statusBar.background`, `statusBar.foreground`, `panel.background`, `panel.border`,
`list.hoverBackground`, `list.activeSelectionBackground`, `input.background`, `input.border`,
`button.background`, `button.foreground`, `focusBorder`, `foreground`, `terminal.background`,
`terminal.foreground`. Token scopes: `comment`, `string`, `keyword`, `storage`, `constant`,
`constant.numeric`, `variable`, `entity.name.function`, `entity.name.type`, `support`, `tag`,
`attribute.name`, `markup.heading`, `markup.bold`, `markup.italic`, `invalid`.

### 4.8 `languages`

Teach AICode a new file type, or more file names for a known one:

```json
"languages": [
  { "id": "ini", "extensions": [".conf", ".env.example"], "filenames": ["config"] }
]
```

### 4.9 `settings`

Settings the user can change in **Settings** (each profile has its own values). Read them in
actions with `${config:<key>}`.

```json
"settings": {
  "testCommand": { "type": "string", "default": "npm test", "description": "Command that runs the tests" },
  "openAfter": { "type": "boolean", "default": true, "description": "Open the report afterwards" },
  "level": { "type": "string", "enum": ["fast", "full"], "default": "fast", "description": "How much to check" }
}
```

`type` is `"string"`, `"number"` or `"boolean"`. `enum` lists allowed values (shown as a menu).

---

## 5. Actions

An action is an object with a `type`. `run` takes one action or an array of them.

| `type` | Fields | Does |
|---|---|---|
| `notify` | `message`, `level` (`info`/`warning`/`error`, default `info`) | Shows a notification. |
| `insert` | `text` | Inserts at the cursor, replacing the selection. `text` uses snippet syntax: `$1`, `${1:placeholder}`, `$0`. |
| `transform` | `to` | Changes the selected text (or the current line if nothing is selected): `upper`, `lower`, `title`, `camel`, `snake`, `kebab`, `trim`, `sortLines`, `sortLinesDesc`, `reverseLines`, `uniqueLines`. |
| `replace` | `find`, `replace`, `regex` (bool), `caseSensitive` (bool), `scope` (`selection`/`document`, default `document`) | Find and replace. With `regex`, `replace` may use `$1`… groups. |
| `newFile` | `text`, `language` | Opens a new unsaved tab. |
| `openFile` | `path`, `line` | Opens a file (absolute path, or relative to the open folder). Needs `fs:read`. |
| `writeFile` | `path`, `text`, `ifExists` (`ask`/`overwrite`/`append`/`keep`, default `ask`), `open` (bool) | Writes a file (relative paths are inside the open folder; missing folders are created). If the file exists: `ask` asks before replacing it, `overwrite` replaces it, `append` adds `text` at the end, `keep` leaves it as it is. `open: true` opens it afterwards. Needs `fs:write` and `fs:read`. |
| `openUrl` | `url` | Opens a link in the browser. Needs `open-external`. |
| `copy` | `text` | Copies text to the clipboard. |
| `shell` | `command`, `cwd`, `in` (`output`/`terminal`/`background`, default `output`), `title` | Runs a shell command (`/bin/sh -c` with the user's PATH). `output`: shows output in a tab; `terminal`: runs in a terminal (needs the Terminal mod enabled; falls back to `output`); `background`: shows only a notification when it ends. `cwd` defaults to the open folder. Needs `process`. |
| `ask` | `prompt` | Sends a prompt to the AI Chat (the AI Chat mod must be enabled). |
| `command` | `command`, `args` (array) | Runs any command — AICode's (§6), another mod's, or one of this mod's. |
| `confirm` | `message`, `detail`, `button` | Asks the user; choosing Cancel stops the remaining actions. |

**In `shell` commands, variables are inserted already quoted for the shell** (`${file}` becomes
`'/path/with spaces/a.txt'`), so do not put quotes around them. In `openUrl`, variables are
URL-encoded. Everywhere else they are inserted as plain text.

---

## 6. AICode's own commands (for `command` actions and `keybindings`)

`workbench.commandPalette`, `workbench.quickOpen`, `workbench.toggleSidebar`,
`workbench.togglePanel`, `workbench.toggleSecondary`, `workbench.reload`, `workbench.newWindow`,
`workbench.openFolderNewWindow`, `window.close`, `preferences.theme`, `preferences.settings`,
`preferences.toggleAnimations`, `profiles.manage`, `profiles.switch`, `workbench.keybindings`,
`mods.manage`, `file.new`, `file.open`, `file.save`, `file.saveAs`, `file.saveAll`, `file.revert`,
`editor.close`, `editor.closeAll`, `editor.closeOthers`, `editor.closeSaved`, `editor.showOpened`, `editor.togglePreview`, `editor.nextTab`, `editor.previousTab`,
`edit.undo`, `edit.redo`, `edit.find`, `edit.replace`, `editor.gotoLine`,
`editor.changeLanguage`, `editor.toggleWordWrap`, `editor.toggleMinimap`,
`editor.formatDocument`, `editor.zoomIn`, `editor.zoomOut`, `editor.zoomReset`,
`editor.fontBigger`, `editor.fontSmaller`.

From bundled mods (work when that mod is enabled): `terminal.new`, `terminal.toggle`,
`terminal.split`, `terminal.clear`, `terminal.kill`, `terminal.sendText` (args: the text to run),
`git.commit`, `git.pull`, `git.push`, `git.fetch`, `git.checkout`, `git.refresh`,
`explorer.refresh`, `explorer.newFile`, `explorer.newFolder`, `explorer.revealActive`,
`explorer.collapseAll`, `search.inFolder` (args: a folder path), `search.replace`, `git.stageActive`, `agents.ask`, `agents.newChat`,
`agents.attachFile` (args: a file path), `agents.attachSelection`, `codeflow.open`,
`workbench.view.explorer`, `workbench.view.search`, `workbench.view.scm`,
`workbench.view.terminal`, `workbench.view.agents.chat`.

For example, a button that runs a project script in the terminal:
`{ "type": "command", "command": "terminal.sendText", "args": ["npm run dev"] }`.

---

## 7. Variables

Write them as `${name}`. To write a literal `${`, write `$${`.

| Variable | Value |
|---|---|
| `${file}` | Full path of the active file (empty for an unsaved tab) |
| `${fileName}` | File name with extension: `app.ts` |
| `${fileBase}` | File name without extension: `app` |
| `${fileExt}` | Extension with the dot: `.ts` |
| `${fileDir}` | Folder of the active file |
| `${relativeFile}` | Path of the file relative to the open folder |
| `${workspaceFolder}` | The open folder (empty if none) |
| `${workspaceName}` | Name of the open folder |
| `${selection}` | Selected text (empty if none) |
| `${selectionOrLine}` | Selected text, or the current line if nothing is selected |
| `${text}` | All the text of the active file |
| `${line}`, `${column}` | Cursor position (1-based) |
| `${language}` | Language id of the active file |
| `${home}` | The user's home folder |
| `${date}`, `${time}`, `${datetime}` | `2026-11-11`, `14:05`, `2026-11-11 14:05` |
| `${config:key}` | This mod's setting `key` (§4.9) |
| `${input:Prompt}` | Asks the user to type something. `${input:Prompt\|default}` pre-fills it. |
| `${pick:Prompt\|one\|two\|three}` | Asks the user to choose one of the options |

The same `${input:…}` or `${pick:…}` used twice in one command asks once.

**Keys** (`keybinding`, `key`): modifiers `mod` (⌘ on macOS, Ctrl elsewhere — prefer it), `cmd`,
`ctrl`, `shift`, `alt`, joined with `+`: `mod+shift+l`, `alt+up`. A chord is two presses
separated by a space: `mod+k mod+t`. Keys: letters, digits, `f1`–`f12`, `enter`, `escape`,
`space`, `tab`, `backspace`, `up`, `down`, `left`, `right`, `` ` ``, `,`, `.`, `/`, `=`, `-`.
Avoid shortcuts AICode already uses: ⌘N, ⌘O, ⌘S, ⌘W, ⌘P, ⇧⌘P, ⌘B, ⌘J, ⌥⌘B, ⇧⌘X, ⌘R, ⌘F,
⌘Z, ⌘C, ⌘V, ⌘X, ⌘A, ⌘=, ⌘-, ⌘0, ⇧⌘N, ⇧⌘W.

---

## 8. Icons

Icons are [codicon](https://microsoft.github.io/vscode-codicons/dist/codicon.html) names. Some
useful ones: `add`, `archive`, `beaker`, `bell`, `book`, `bookmark`, `bug`, `calendar`, `check`,
`checklist`, `chevron-right`, `clippy`, `cloud`, `code`, `coffee`, `comment`, `copy`, `dashboard`,
`database`, `debug-alt`, `edit`, `extensions`, `eye`, `file`, `file-code`, `files`, `filter`,
`flame`, `folder`, `gear`, `git-branch`, `github-action`, `globe`, `graph`, `heart`, `history`,
`home`, `json`, `key`, `law`, `library`, `lightbulb`, `link`, `list-unordered`, `lock`, `mail`,
`markdown`, `megaphone`, `mortar-board`, `note`, `notebook`, `organization`, `package`, `paintcan`,
`pencil`, `person`, `pin`, `play`, `pulse`, `question`, `quote`, `rocket`, `run-all`, `save`,
`search`, `send`, `server`, `settings-gear`, `shield`, `sparkle`, `star`, `symbol-color`,
`sync`, `tag`, `terminal`, `tools`, `trash`, `wand`, `warning`, `watch`, `whole-word`, `zap`.

---

## 9. When JSON is not enough: code mods

A mod can also ship JavaScript (`"main": "main.js"`, an ES module exporting `activate(ctx)`) to
build any UI and use the full API: files, processes, terminals, the Monaco editor, MCP tools.
That is described in `docs/MODS.md`. **A JSON mod never needs `main`.**

---

## 10. Complete examples

### Markdown helpers

```json
{
  "id": "me.md-helpers",
  "name": "Markdown Helpers",
  "version": "1.0.0",
  "description": "Bold, links and a table of contents stub for Markdown.",
  "icon": "markdown",
  "contributes": {
    "commands": [
      { "id": "md.bold", "title": "Bold", "category": "Markdown", "keybinding": "mod+alt+b", "run": { "type": "insert", "text": "**${selection}$0**" } },
      { "id": "md.link", "title": "Insert Link", "category": "Markdown", "run": { "type": "insert", "text": "[${selection}](${input:URL|https://})$0" } },
      { "id": "md.date", "title": "Insert Today's Date", "category": "Markdown", "run": { "type": "insert", "text": "${date}" } }
    ],
    "editorContextMenu": [{ "command": "md.bold", "when": "selection" }],
    "snippets": [{ "language": "markdown", "items": { "Task": { "prefix": "task", "body": "- [ ] $0" } } }]
  }
}
```

### Project tasks panel

```json
{
  "id": "me.tasks",
  "name": "Project Tasks",
  "version": "1.0.0",
  "description": "Buttons for the usual npm scripts.",
  "icon": "checklist",
  "permissions": ["process"],
  "contributes": {
    "settings": {
      "testCommand": { "type": "string", "default": "npm test", "description": "How to run the tests" }
    },
    "commands": [
      { "id": "tasks.install", "title": "Install Dependencies", "category": "Tasks", "run": { "type": "shell", "command": "npm install", "in": "terminal" } },
      { "id": "tasks.test", "title": "Run Tests", "category": "Tasks", "keybinding": "mod+alt+t", "run": { "type": "shell", "command": "${config:testCommand}", "in": "output", "title": "Tests" } },
      { "id": "tasks.lintFile", "title": "Lint This File", "category": "Tasks", "run": [{ "type": "command", "command": "file.save" }, { "type": "shell", "command": "npx eslint ${file}" }] }
    ],
    "views": [
      {
        "id": "tasks.view", "title": "Tasks", "icon": "checklist", "location": "sidebar",
        "items": [
          { "label": "Install dependencies", "icon": "package", "command": "tasks.install" },
          { "label": "Run tests", "icon": "beaker", "command": "tasks.test" },
          { "label": "Lint this file", "icon": "check", "command": "tasks.lintFile" }
        ]
      }
    ],
    "statusBar": [{ "text": "Test", "icon": "beaker", "command": "tasks.test", "tooltip": "Run the tests" }]
  }
}
```

Note: `${config:testCommand}` inside `shell` is **not** quoted — settings are inserted as written,
so a setting can hold a whole command line. Only file, text and input variables are quoted.

### Ask the AI about the selection

```json
{
  "id": "me.ai-actions",
  "name": "AI Actions",
  "version": "1.0.0",
  "description": "Right-click actions that send code to the AI Chat.",
  "icon": "sparkle",
  "dependencies": ["aicode.agents"],
  "contributes": {
    "commands": [
      { "id": "ai.explain", "title": "Explain Selection", "category": "AI", "run": { "type": "ask", "prompt": "Explain this ${language} code from ${fileName}:\n\n${selectionOrLine}" } },
      { "id": "ai.tests", "title": "Write Tests for Selection", "category": "AI", "run": { "type": "ask", "prompt": "Write ${pick:Test framework|jest|vitest|pytest|cargo test} tests for:\n\n${selection}" } }
    ],
    "editorContextMenu": [
      { "command": "ai.explain", "when": "selection" },
      { "command": "ai.tests", "when": "selection" }
    ]
  }
}
```

### Daily note

```json
{
  "id": "me.daily-note",
  "name": "Daily Note",
  "version": "1.0.0",
  "description": "Creates notes/YYYY-MM-DD.md in the open folder and opens it.",
  "icon": "calendar",
  "permissions": ["fs:write", "fs:read"],
  "contributes": {
    "commands": [
      {
        "id": "daily.open", "title": "Open Today's Note", "category": "Notes", "keybinding": "mod+alt+n",
        "run": { "type": "writeFile", "path": "notes/${date}.md", "text": "# ${date}\n\n", "ifExists": "keep", "open": true }
      }
    ]
  }
}
```

---

## 11. Checklist (AIs: check every item before answering)

1. The answer is one JSON object, valid JSON (double quotes, no comments, no trailing commas).
2. It has `id` (letters, digits, `.`, `-`, `_` only), `name` and `version`. No `main`, no `activation`.
3. Every command has a unique `id`, a `title` and a `run`; every `run` uses only action types from §5 with their fields.
4. Every command referenced by `keybindings`, `statusBar`, `views[].items` or `editorContextMenu` exists — in this mod or in §6.
5. `permissions` lists exactly what the actions need: `shell` → `process`, `openFile` → `fs:read`, `writeFile` → `fs:write` and `fs:read`, `openUrl` → `open-external`.
6. Uses `ask` → `"dependencies": ["aicode.agents"]`. Uses `shell` with `"in": "terminal"` → it still works without the Terminal mod (it falls back), so no dependency is needed.
7. Variables are written `${name}` from §7; inside `shell`, file/text/input variables are not wrapped in quotes.
8. Keybindings use `mod` and do not clash with the ones listed in §7.
9. Icons are codicon names.

## 12. Installing and sharing (for people)

- **From the JSON an AI wrote:** ⌘N, paste, then ⇧⌘P → **Mods: Install This File as Mod**.
- **From a file:** Mods (⇧⌘X) → **Install from file…** — takes a `mod.json` or an `.aicode-mod`.
- **Share one:** on its card in Mods, **Export…** writes an `.aicode-mod` file (one JSON with every
  file of the mod) that anyone can install the same way.
- Mods are installed into the current **profile**; a profile exported with **Profiles → Export**
  carries its mods with it.
- Edit an installed mod: Mods → its card → **Edit**, change, save, then **Reload Window**.
