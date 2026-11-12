# Configuring AICode — everything is a setting

AICode is configured like VS Code: **JSON, in layers**. Everything you can see can be changed:
colors, transparency, the cursor, tabs, tooltips, which parts show, where views go, extra windows,
and any CSS you want. You can write the JSON yourself, let an AI write it (through the MCP server,
or by writing a mod), or install mods that others shared.

## The layers

```
schema default  ←  enabled mods (contributes.configurationDefaults, in load order)  ←  you (profile.json)  ←  this window (its layout)
```

The value of a setting is the last layer that sets it. **Your values always win over mods**, and
turning a mod off removes its layer, so nothing it set stays behind.

- **Objects merge key by key.** If a mod sets `workbench.colorCustomizations` with one color and you
  set another, both apply. To remove a key a lower layer set, set it to `null`.
- **Everything else replaces.** Arrays, strings, numbers and booleans are replaced whole.

| Where | What |
|---|---|
| **Settings** (⌘,) | Every setting, generated from the schema. Each one shows where its value comes from ("set by you", "set by Glass"), and **reset** goes back one layer. |
| **Preferences: Open Profile Settings (JSON)** | Your `profile.json`. Saving it applies your changes right away. Only turning mods on or off needs a reload. |
| **Preferences: Open Default Settings (JSON)** | Every setting with its default and description (read-only). |
| **Preferences: Open Effective Settings (JSON)** | The value each setting has right now, and which layer set it. |
| **Developer: Inspect Window Parts** | Move the pointer over the window to see each part's name, for `workbench.hide` and custom CSS. |

`profile.json` gets completions and validation while you edit it. A change made in one window
shows up in every other window at once.

```jsonc
// profiles/<name>/profile.json
{
  "enabled": ["aicode.explorer", "aicode.glass"],
  "settings": {
    "core": {                       // the editor's own settings
      "editor.cursorColor": "#ff79c6",
      "workbench.tabs.shape": "pill"
    },
    "aicode.explorer": {            // a mod's settings, by its id
      "showOpenEditors": true
    }
  }
}
```

## What you can change

The full list, with defaults, is in **Open Default Settings (JSON)**. The highlights:

### Editor and cursor
`editor.fontFamily`, `editor.fontLigatures`, `editor.fontWeight`, `editor.lineHeight`, `editor.wordWrap`…
`editor.cursorStyle` (line, block, underline, line-thin, block-outline, underline-thin),
`editor.cursorBlinking` (blink, smooth, phase, expand, solid), `editor.cursorWidth`,
`editor.cursorColor`, `editor.cursorSmoothCaretAnimation`.
**`editor.monacoOptions`** takes any Monaco editor option as is, and goes over everything else.

### Gutter, minimap and markers
`editor.minimap*`, `editor.glyphMargin`, `editor.folding`, `editor.showFoldingControls`,
`editor.rulers` (`[80, 120]`), `editor.guides.*`, `editor.overviewRuler` (the markers along the
scroll bar), `editor.renderLineHighlight`, `editor.lightbulb`, `editor.scrollbar.*`.

### Tabs
`workbench.tabs.shape` (connected, square, rounded, pill, underline), `.height`, `.minWidth`,
`.maxWidth`, `.gap`, `.closeButton` (right, left, hidden), `.showIcons`, `.activeIndicator`,
`.wrap` (several rows), `.visible`, `.dragToWindow`.
You can drag a tab along the bar to reorder it, or out of the window to open it in a new window.
Unsaved text goes along with it.

### Tooltips, indicators, chrome
`workbench.tooltips.style` (custom = themed, native, off), `.delay`, `.maxWidth`; colors
`tooltip.background` / `tooltip.foreground` / `tooltip.border` in `workbench.colorCustomizations`.
`workbench.badges`, `workbench.activityBar.indicator`, `workbench.breadcrumbs`,
`workbench.scrollbars.*`, `workbench.focusOutline`, `workbench.fontFamily`, `workbench.fontSize`,
`workbench.cornerRadius`, `workbench.titleBar.height`, `workbench.statusBar.height`.

### File icons
`workbench.iconTheme` picks the icons files and folders show with, from the icon themes mods
contribute (`contributes.iconThemes`, see [MODS.md](MODS.md)). The File Icon Themes mod
(`aicode.icons`, on in every profile by default) has `"seti"` (the default, VS Code's), `"vscode-icons"`
and one pack per stack: `"vscode-icons-angular"`, `-react`, `-nextjs`, `-vue`, `-nestjs`, `-bun`,
`-spring`, `-dotnet`, `-fastapi`, `-django`, `-laravel` — and `"vscode-icons-auto"`, which draws each
window with the pack its folder calls for, read off the folder's root (`angular.json`, `nest-cli.json`,
`package.json` dependencies, a Spring Boot `pom.xml`, `manage.py`, a `.sln`…; General when nothing
matches), as CodeFlow does. `"none"` (or no icon theme mod) shows plain codicons. *Preferences: File
Icon Theme…* previews each one as you move through the list.

### Colors over any theme
```jsonc
"workbench.colorCustomizations": {
  "tab.activeBackground": "#282a36",
  "editorCursor.foreground": "#ff79c6",
  "[aicode-light]": { "editor.background": "#fdf6e3" }   // only for that theme
},
"editor.tokenColorCustomizations": {
  "comments": { "foreground": "#6a9955", "fontStyle": "italic" },
  "strings": "#ce9178",
  "textMateRules": [{ "scope": "keyword.control", "settings": { "foreground": "#c586c0" } }]
}
```

### Transparency, glass and backgrounds
| Setting | What it does |
|---|---|
| `window.transparent` | Makes the window able to show what is behind it. It is set when a window is created: AICode offers **Reopen Window**. |
| `window.vibrancy` | macOS material behind the window, e.g. `sidebar`, `underWindowBackground`, `hudWindow`, `fullScreenUI`. It blurs what is behind (acrylic). It follows the theme's light or dark. |
| `workbench.partOpacity` | Opacity of each part's background, from 0 to 1. Parts: `window` (between the cards), `titleBar`, `activityBar`, `sideBar`, `secondarySideBar`, `panel`, `editor`, `tabs`, `statusBar`. Text stays solid. |
| `workbench.opacity` | Multiplies every part's opacity: one knob for the whole window. |
| `window.background` | An image, a video or a color behind the whole window, e.g. `{ "image": "~/Pictures/a.jpg", "opacity": 0.4, "blur": 6 }`. |
| `workbench.partBackgrounds` | An image behind one part, e.g. `{ "editor": { "image": "~/x.png", "opacity": 0.12 } }`. |
| `window.alwaysOnTop`, `window.shadow`, `window.pinButton` | Keep windows on top, drop the shadow, and show a pin in the title bar. |
| `window.restoreOnStartup` | `"none"` (default): AICode opens clean, and **File › Reopen Last Session** brings the last session back. `"all"`: every window as you left it. |

**Acrylic** = `window.transparent: true` + a `window.vibrancy` + parts at 0.4–0.8 opacity. Opacity 0
with no vibrancy makes a part fully see-through. The **Glass (Acrylic)** mod is a ready-made
preset. Its commands cycle the material and the strength.

### Hide, move, add
| Setting | What it does |
|---|---|
| `workbench.hide` | Part names (`titleBar.layoutControls`, `tab.close`, `activityBar.badge`, `breadcrumbs`…), `"statusBar.item:<id>"` or `"titleBar.item:<id>"` for one item, or `"css:<selector>"` for anything else. |
| `workbench.hiddenViews` | Views taken off the window without turning their mod off (`"scm"`, `"search"`). |
| `workbench.titleBar.items` | Your own title bar buttons: `[{ "icon": "rocket", "text": "Deploy", "command": "…", "align": "left" \| "center" \| "right" }]`. |
| `workbench.statusBar.items` | Your own status bar items, in the same shape. |
| `workbench.cssVariables` | Any CSS variable, e.g. `{ "--tabs-h": "28px", "--aicode-focusBorder": "hotpink" }`. |
| `workbench.customCSS` / `workbench.customCSSFiles` | Your own CSS, inline or from files. Saving a file reapplies it. |

**Part names.** Every part of the window has `data-part="<name>"`:

`titleBar`, `titleBar.nav`, `titleBar.commandCenter`, `titleBar.items`, `titleBar.item`,
`titleBar.layoutControls`, `titleBar.pin`, `activityBar`, `activityBar.badge`,
`sideBar`, `sideBar.header`, `secondarySideBar`, `secondarySideBar.header`, `panel`, `panel.header`,
`editor`, `tabs`, `tab`, `tab.icon`, `tab.close`, `tab.actions`, `breadcrumbs`, `editorSide`,
`centerView`, `watermark`, `statusBar`, `statusBar.item`, `sash`, `tooltip`, `windowBackground`.

```css
[data-part="tab"].active { font-weight: 600; }
[data-part="statusBar.item"][data-id="profile"] { color: gold; }
```

## Windows with a layout

`workbench.windowLayouts` names window arrangements. Open one with **Open Window with Layout…**,
with a `{ "type": "window", "layout": "<name>" }` action, or with the MCP `open_window` tool.

```jsonc
"workbench.windowLayouts": {
  "agents": {
    "title": "Agents",
    "width": 1320, "height": 860,
    "alwaysOnTop": false,
    "center": "agents.chat",                     // a view in place of the editor
    "views": { "explorer": "secondary", "scm": "secondary", "terminal": "panel", "search": "hidden" },
    "options": { "activityBar": false },         // Customize Layout choices for this window
    "parts": { "sidebar": false, "secondary": true, "panel": false },
    "sizes": { "secondary": 340 },
    "hide": ["titleBar.item:agentsWindow.open"], // parts hidden in this window only
    "settings": { "workbench.tabs.shape": "pill" } // settings for this window only
  }
}
```

A window keeps its layout across restarts. Changes you make in it (moving views, Customize Layout)
stay in that window and never touch the profile's arrangement.

- **Move to New Window** on a view's tab or icon moves that view into a window of its own (layout `view`).
- **Move into New Window** on a tab, or dragging the tab out, opens the file in a window of its own (layout `editor`).
- **Toggle Always on Top**, or the pin in the title bar, keeps a window above other apps.

The **Agents Window** mod is VS Code's agents window built with this: one layout, one command
(⌥⇧⌘A) and one title bar button.

## Let an AI change it

With the **MCP Server** mod on, an agent such as Claude Code or Codex can drive the interface. It has
these tools:

- `list_commands` / `run_command`
- `get_settings` / `set_setting` (any setting, applied live)
- `list_views` / `show_view` (move a view to a part, the center or a new window)
- `open_window`

An AI can also write a mod for you (see [MOD-GUIDE.md](MOD-GUIDE.md)): a mod's
`configurationDefaults`, `styles`, `titleBar` and `windowLayouts` reach everything above, without code.
