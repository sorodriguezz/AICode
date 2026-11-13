# AICode

A notepad that grows into an editor, one mod at a time.

AICode opens as a single text editor — the same Monaco editor VS Code uses, in a window that looks
like VS Code — with **no telemetry, no account, no network connection of its own (only *Check for
Updates*, when you ask), nothing running in the background**. Everything else is a mod you turn on: the file explorer, search, terminals, an
AI chat over the CLIs you already have, an MCP server, the CodeFlow integration. A mod's code only
loads when you first use it.

- **Stack**: Tauri 2 (Rust) + Monaco, using the system web view — no bundled Chromium.
- **Mods**: a mod can be **one JSON file** — commands that run actions (insert text, run a shell
  command, open a file or URL, ask the AI chat…), launcher panels, status bar items, right-click
  items, snippets, themes, settings. [docs/MOD-GUIDE.md](docs/MOD-GUIDE.md) is written so any AI
  can read it and write a mod for you (*Mods: Create Mod with AI…*, or *Copy Mod Guide for AI* and
  paste into the AI you use). Mods with code: [docs/MODS.md](docs/MODS.md). Share one as a single
  `.aicode-mod` file (*Export…* on its card, *Install from File…*).
- **Configure everything**: settings in layers like VS Code (defaults ← mods ← you ← this window),
  live. Colors over any theme, the cursor, tab shapes, themed tooltips, hidden parts, your own CSS,
  acrylic transparency and background images, title bar buttons, windows with their own layout (a
  view in place of the editor, tabs dragged out into a window, always on top). Mods change all of
  it with `configurationDefaults`; an AI can too through the MCP server.
  [docs/CONFIGURATION.md](docs/CONFIGURATION.md).
- **Profiles**: separate spaces, each with its own mods (on/off, and mods installed only in it),
  settings, keyboard shortcuts, windows and open files. Create empty or as a copy, rename, delete,
  and export/import as one `.aicode-profile` file that carries its mods (*Profiles* in the gear
  menu). Switching closes the old profile's windows (sessions kept) and opens the new one's.
- **Your layout**: drag any view — its activity bar icon, its tab or its title — to the activity
  bar, another part, or the left, right or bottom edge of the editor, as in VS Code (or right-click
  → *Move to…*). The profile keeps where you put them.
- **Only its own mods**: AICode loads AICode mods and nothing else — no VS Code extensions, no
  marketplace. Themes, languages, grammars and snippets are declarative mods; everything else is a
  mod with code.
- **Windows**: as many as you like (⇧⌘N, *Open Folder in New Window…*), each with its own folder,
  tabs and layout; all of them come back when AICode starts again.
- **Drop to open**: drop files or folders on a window, on the Dock icon, or use *Open With* in
  Finder / `open -a AICode path` / `aicode path…` — a file opens in a tab, a folder becomes the
  window's folder.
- **Motion**: panels slide open, tabs unfold and fold, pickers and dialogs ease in — short, and only
  when you do something (no animation runs at idle). Off with *Preferences: Toggle Animations*, and
  automatically when macOS *Reduce motion* is on.
- **Clean start, nothing lost**: AICode opens with one empty window, with no files and no folder. The last
  session (tabs, folder, unsaved text) is kept aside: *File › Reopen Last Session* brings it back,
  and AICode offers it when it had unsaved text. `window.restoreOnStartup: "all"` reopens everything
  as you left it instead. Reloads and profile switches keep everything. Closing one window of
  several asks about its unsaved files first.

## Size and memory (measured, v0.1.0, macOS, release build, notepad mode)

| | Physical footprint (app + WebKit processes) | Idle CPU |
|---|---|---|
| App on disk | **12 MB** (VS Code on the same Mac: 1.0 GB) | |
| A blank WebKit page — the floor for any web-view app | 155 MB | 0.2% |
| AICode in front, editor focused | 274 MB | ~3.5% |
| AICode in the background | **212 MB** | **0.1%** |

What the numbers taught: loading Monaco's code costs almost nothing; drawing an editor does. Any
focused text field makes WebKit repaint for each caret blink (~3% CPU, ~55 MB of GPU memory) —
Monaco or a plain `<input>` alike — so AICode lets go of the focus while the window is in the
background and gives it back on return. Monaco's layer hinting is off (~25 MB less).

## The core (no mods)

New / Open / Save / Save As, tabs (with preview tabs), find & replace, multi-cursor, go to line,
language mode for ~80 languages (JSON, CSS, HTML, TypeScript/JavaScript with full language
services), indentation, end-of-line and encoding (UTF-8, BOM kept), zoom, the command palette
(⇧⌘P), go to file (⌘P), Settings (⌘,), keyboard shortcuts you can change, color themes, profiles,
and the Mods page.

## Bundled mods

| Mod | Adds | Permissions |
|---|---|---|
| **Explorer** | file tree like VS Code's: new/rename in place, delete to the Trash, cut/copy/paste, drag to move (⌥ copies), keyboard navigation, git colors, follows changes on disk; open editors | fs:read, fs:write |
| **Search** | find and replace across the folder (regex with `$1`, case, whole word, preserve case), files to include/exclude, only open editors, unsaved editors searched as they are, .gitignore on or off | fs:read, fs:write |
| **Terminal** | integrated terminals (xterm.js + a real PTY): tabs, side-by-side splits, a shell picker, ⌘-click on paths and URLs, ⌘K clears | pty, fs:read, open-external |
| **AI Chat** | the chat panel only: attach files and selections, slash commands, edit/retry, chat history, file links and *Run in Terminal* in answers. The agents are the mods below | fs:read, open-external |
| **Claude**, **Codex (OpenAI)**, **Gemini**, **Grok (xAI)** | one agent each for the AI Chat, through its CLI (your subscription — reads the folder; Claude and Codex also propose edits through the MCP server) or its API with an API key kept in the system's password store (Keychain, Credential Manager, Secret Service) (no CLI needed). *Configure …* in the agent picker switches | process, open-external |
| **OpenCode**, **Cline** | an agent each, through its CLI (which keeps its own providers and keys) | process, open-external |
| **Ollama** | local models: `ollama run`, or the local Ollama server with the conversation as messages | process, open-external |
| **Custom Agent Commands** | any program that takes a message and prints an answer (aider, llm, a script) as an agent | process |
| **Agents Window** | a window made for agents: the chat in the middle, files/changes/search on the right, the terminal below (⌥⇧⌘A; configuration only) | — |
| **MCP Server** | AICode's open editors as MCP tools (read unsaved text, propose edits as diffs) on 127.0.0.1 with a token | mcp-server |
| **CodeFlow** | run CodeFlow flows with the file/selection as input; connect CodeFlow's agents to AICode | open-external |
| **Source Control** | git: changes, stage/unstage/discard, commit, diffs, branches, fetch/pull/push, gutter markers | process, fs:read |
| **Themes** | 39 color themes for the whole window (editor, side bars, tabs, terminal, widgets): CodeFlow Dark/Light, Dracula, Monokai, One Dark/Light, Tokyo Night (+Light), Catppuccin Mocha/Latte, Night Owl (+Light), Omni Owl, Nord, Gruvbox, GitHub, Solarized, Darcula, Kiro Dark, Rosé Pine Dawn, Ayu Light… (declarative) | — |
| **File Icon Themes** | Seti (the default) and VS Code Icons, with packs for Angular, React, Next.js, Vue/Nuxt, NestJS, Bun, Spring Boot, .NET, FastAPI, Django and Laravel — or *Auto*, which picks the pack each folder calls for (*Preferences: File Icon Theme…*) | fs:read |
| **JSON & YAML Paths** | the keys down to the cursor in the breadcrumbs (`dependencies › react`), click to jump | — |
| **Glass (Acrylic)** | the system's frosted glass behind the window (macOS vibrancy, Windows Acrylic/Mica; opaque on Linux, which has no blur), tinted with the theme so nothing turns invisible (configuration only) | — |
| **Soft Look** | pill tabs, rounded corners, themed tooltips, a smooth cursor (configuration only) | — |
| **Syntax Highlighting** | VS Code's own TextMate grammars (TypeScript, JavaScript, Python, Rust, Go, C/C++, …), so code is colored exactly as in VS Code | — |
| **Markdown Preview** | preview .md files to the side or in their own tab (⌘K V, ⇧⌘V), live while typing, scrolling with the editor, maximized over the editor; the headings above the cursor in the breadcrumbs; Markdown snippets; raw HTML is shown as text | open-external |
| **Image Preview** | images open as images, never as code (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, TIFF, SVG): zoom with buttons, ⌘-scroll, pinch, click/⌥-click and + − 0 1, drag to pan, fit or actual size, checkerboard/dark/light background, sharp pixels when zoomed, size in the status bar, reloads on change; SVG keeps *Open Source* and previews its code live. On by default | fs:read, open-external |

The window uses VS Code's 2026 look: its Dark / Light 2026 color themes are built in (MIT, see
`src/core/themes/LICENSE.md`). File icons come from the File Icon Themes mod (Seti, VS Code Icons
and framework packs, MIT — see `mods/aicode.icons/NOTICE.md`), on in every profile by default;
*Preferences: File Icon Theme…* picks one or turns them off.

The Mods page (⇧⌘X) and Settings (⌘,) open over the editor as a modal, like VS Code (both in the
gear menu of the status bar); its header moves them into a tab, and *Settings → Open Pages in a
Modal* turns this off. The Mods page shows what each mod may do, whether it is running, and what AICode is
running right now with its memory use.

## CodeFlow

AICode is a separate app; the **CodeFlow** mod connects the two:

- **AICode → CodeFlow**: *CodeFlow: Run a Flow…* opens `codeflow://flow/<name>?input=<json>` with the
  active file or selection as input. CodeFlow asks before running a flow a link started.
- **CodeFlow → AICode**: add AICode as an MCP server in CodeFlow (Settings › MCP servers, transport
  `http`). The CodeFlow side bar view has the URL and header to copy. CodeFlow's agents can then
  list open editors, read unsaved buffers, open files and propose edits that appear in AICode as a
  diff to accept or reject.

The same MCP server works with any MCP client: *MCP: Show Connection Details* copies the JSON
configuration or a `claude mcp add` command.

## Developing

```sh
pnpm install
pnpm tauri dev          # debug build; bundled mods load live from ./mods
pnpm check:mods         # validate the bundled mods
cd src-tauri && cargo test
pnpm tauri build        # this OS's bundles in src-tauri/target/release/bundle
                        # (macOS .app/.dmg, Windows NSIS -setup.exe, Linux AppImage/.deb/.rpm)
```

Environment variables:

- `AICODE_HOME=/some/dir` keeps all data (profiles, mods, session) there instead of
  `~/Library/Application Support/AICode`.
- `AICODE_DIAG=1` writes a text report of the window layout to the terminal 5 s after start.

## Releases and updates

Every release is built by GitHub Actions ([.github/workflows/release.yml](.github/workflows/release.yml))
and published on the [Releases page](https://github.com/sorodriguezz/AICode/releases), for ARM
(`aarch64`: Apple silicon, Windows on ARM, ARM64 Linux) and Intel/AMD (`x64`) each:

| | Install | Update package (signed) |
|---|---|---|
| macOS | `AICode_<v>_<arch>.dmg` | `.app.tar.gz` |
| Windows | `AICode_<v>_<arch>-setup.exe` (per user, no admin) | the installer itself |
| Linux | `AICode_<v>_<arch>.AppImage`, `.deb`, `.rpm` | the AppImage (and `.deb`/`.rpm` when signed) |

plus `latest.json`, the feed the app reads. The bundles each OS makes are set in
`src-tauri/tauri.windows.conf.json` and `tauri.linux.conf.json` (merged over `tauri.conf.json`).

**Installing**: on macOS open the `.dmg`, drag AICode to Applications. The app is not signed with
an Apple Developer ID, so the first time macOS may say it "is damaged" or "cannot be opened": run
`xattr -dr com.apple.quarantine /Applications/AICode.app` once. Updates installed from the app do
not need this. On Windows the installer is not code-signed: SmartScreen asks once (*More info →
Run anyway*).

**Updating**: *Settings → Updates → Check for Updates* (also the gear menu, the AICode menu and the
command palette: *Update: Check for Updates…*). If there is a newer version it offers **Install and
Restart** or **Later**; *Later* leaves an *Update x.y.z* item in the status bar to install it
whenever you like. Installing downloads the update, checks its signature, replaces the app and
restarts it — windows, tabs and unsaved text come back as they were, even with a clean start.
*Settings → Updates → Check on Startup* (off by default) checks once per launch.

**Making a release**: change `"version"` in `package.json` (say `0.2.0`) and push to `main`. The
workflow runs on every push to `main`; when `v0.2.0` is not released yet it copies the version to
`src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` and `Cargo.lock` (a `chore(release): v0.2.0`
commit on `main` when they differ — `git pull` afterwards), tags `v0.2.0`, builds and publishes it.
A push that leaves the version as it is does nothing. The release stays a draft until all six builds
are uploaded, then `latest.json` is written and the release is published, so installed copies see
it at once. `pnpm release patch --push` (or minor / major / 1.2.3) still works: it sets the version
everywhere, commits, tags and pushes in one step. The workflow can also be run by hand from the
Actions tab; with **Dry run** ticked it only builds the branch for every platform and leaves the
installers as artifacts of the run (no tag, no release, no secrets), to try a change on Windows or
Linux before releasing it.

**One-time setup** — the repository secrets the workflow needs (*Settings → Secrets and
variables → Actions*):

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the contents of the update signing key (`~/.tauri/aicode.key`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password (`~/.tauri/aicode.key.password`) |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | optional: sign with a Developer ID and notarize, so the `xattr` step is not needed |

The public half of the key is `plugins.updater.pubkey` in `tauri.conf.json`; the app installs only
updates signed with the private half. **Keep the private key safe and backed up**: if it is lost,
installed copies cannot verify new releases and must be reinstalled by hand from an installer after
you put a new key in place.

A local `pnpm tauri build` does not need the key: update archives are only made with
`--config src-tauri/tauri.release.conf.json`, as the workflow does.

## Layout

```
src/                 the window (TypeScript, no framework)
  core/workbench.ts  title bar, activity bar, side bars, panel, status bar
  core/editor.ts     tabs, Monaco, saving, edit proposals, session
  core/mods.ts       mod host: declarations, activation events, the ctx API
  core/modManager.ts the Mods page, creating and installing mods
  core/declarative.ts what a JSON mod does: actions, variables, launcher views
  core/profiles.ts   the Profiles and Settings pages
  core/updates.ts    the update dialog, its progress and status bar item
src-tauri/src/       the core (Rust)
  mods.rs            discovery, permissions, the aimod:// protocol
  profiles.rs        profiles: create, rename, delete, switch, export/import
  bundle.rs          .aicode-mod and .aicode-profile files
  fsops.rs           files, listing, search
  procs.rs           programs, terminals, clipboard, resource stats
  mcp.rs             the MCP HTTP transport
  updater.rs         Check for Updates: the release feed, download, install, restart
mods/                bundled mods
docs/MOD-GUIDE.md    JSON mods, for people and AIs (mod.schema.json validates them)
docs/MODS.md         mods with code
docs/CONFIGURATION.md  settings in layers, window parts, transparency, window layouts
scripts/release.mjs  sets the version everywhere, tags a release
.github/workflows/   release.yml: on push to main, build, sign and publish the version in package.json
```

## Not there yet

- Split editors, a remote-hosting mod (pull requests on GitHub/GitLab/Azure DevOps).
- Mods share the window's JavaScript realm: permissions are checked on every core call, but a
  hostile mod could reach around them. Per-mod isolation is planned for mod API 2.
- Windows and Linux builds are made by the release workflow but have barely been tried. Paths
  reach the window as `C:/Users/…` on Windows (see `uiPath` in src/core/ui.ts); native code runs
  in PowerShell (Windows) and Python 3 (Linux) instead of JXA; Glass on Linux has no blur, so the
  window stays opaque there. One AICode runs per user (tauri-plugin-single-instance): a file
  opened from Explorer or the file manager opens in the window in front.
