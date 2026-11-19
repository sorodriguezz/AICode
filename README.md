<img src="src-tauri/icons/128x128.png" width="72" height="72" alt="">

# AICode

**A modular desktop editor for code, notes, and AI-assisted work.**

Open a file and start writing. When a project needs more tools, turn on the file explorer, a terminal, Git, or AI chat. AICode runs on macOS, Windows, and Linux and lets you decide which tools each workspace needs.

[Download AICode](https://github.com/sorodriguezz/AICode/releases/latest) · [Leer en español](README.es.md)

## What you get

- **A capable editor from the first launch.** Monaco, the editor that powers VS Code, gives you tabs, multiple cursors, find and replace, and language support. The command palette and customizable shortcuts put everyday actions within reach.
- **Tools for the whole project.** Browse files, search across a folder, and run commands in an integrated terminal with tabs and splits. The bundled Git mods let you stage changes, review diffs, and browse commit history. Preview Markdown as you write and open images directly in the editor.
- **AI on your terms.** Add agents such as Claude, Codex, Gemini, or Ollama to AI Chat. Enable local code completion or Git commit message suggestions independently. The built-in inference engine runs models on your machine after download, and you can also connect to Ollama or an OpenAI-compatible server.
- **A layout for each kind of work.** Drag views to the left, right, or bottom. Give each project its own profile with a set of mods, settings, shortcuts, and a saved session. Themes, file icons, and window appearance are configurable.

Core editing works offline with no account setup. AICode uses Tauri and your operating system's webview.

## Start here

1. [Download the installer for your platform](https://github.com/sorodriguezz/AICode/releases/latest). Choose a `.dmg` for macOS, a `-setup.exe` for Windows, or an AppImage, `.deb`, or `.rpm` for Linux.
2. Open a file to write or open a folder to work on a project.
3. A new install starts with **Explorer**, **Terminal**, and **Source Control (Git)** on. Open **Mods** from the gear menu to add more, such as **Search** or **Git Graph**, or to turn any of them off. AICode activates their dependencies automatically.

Use **Settings → Updates → Check for Updates** to update an installed copy.

### The `aicode` command

On first launch AICode installs `aicode` in your terminal's PATH, like VS Code's `code`. It uses a folder that needs no password, such as `/opt/homebrew/bin` or `~/.local/bin`. On Windows it adds `AICode\bin` to your user PATH, so open a new terminal after installing. If only `/usr/local/bin` is available, AICode asks once. The `.deb` and `.rpm` packages already install `/usr/bin/aicode`. You can install or remove it at any time with **Shell Command: Install 'aicode' Command in PATH** and **Shell Command: Uninstall 'aicode' Command from PATH**.

```sh
aicode .                    # open this folder (in the window that already has it, if any)
aicode notes.md             # open a file; an empty one is created if it doesn't exist
aicode -g src/app.ts:12:5   # open at line 12, column 5
aicode -d old.txt new.txt   # compare two files
aicode -n . / aicode -r .   # new window / the window in front
git config --global core.editor "aicode -w"   # -w waits until the file is closed
echo hello | aicode -       # open stdin
```

Run `aicode --help` for every option. If AICode isn't running, `aicode` starts it.

In **Source Control**, fetch, pull, and push show **Cancel Operation** while running. Remote operations stop with an error after 120 seconds; adjust the limit in **Settings → Source Control (Git) → remoteTimeout**. Details appear in **Git: Show Git Output**.

With **Source Control (Git)** enabled, the status bar shows who last changed the cursor's line and how long ago. Hover for the commit details. Unsaved edits are included, and changed lines show **You, uncommitted changes**.

In **Terminal**, drag images, documents, or folders from your system's file manager onto a pane to paste their paths into the current prompt, including agent CLIs. Multiple files are supported, and the prompt stays ready for review before you submit it. Drag the separator to resize panes, double-click it to equalize them, or focus it and use the arrow keys. A subtle border marks the active pane.

On macOS, **Option (⌥)** types `@`, `|`, braces, brackets, and accents using the same keyboard layout as the editor. **Option + ←/→** still moves the cursor by word.

Use the split button's dropdown to split right, left, up, or down. **New Terminal Below Entire Group** adds a full-width terminal below the existing layout. With four terminals open, **Arrange Panes… → 3 Above + 1 Wide Below** creates that arrangement; equal rows, columns, and a grid are also available. Drag an entry from the terminal list onto a pane edge to move it there, or onto an outer group edge to span the group. A preview marks the destination; **Esc** cancels. The **Move Pane…** context menu offers the same moves without dragging. Rearranging keeps existing processes and their output.

Enable **Terminal AI** to add the robot button and **Terminal AI: Open Agent…**, which launch enabled agents' CLIs, including Claude, Codex, Gemini, and OpenCode. Use **Open Agent in Split…** to launch one beside the current terminal. **Add Agent Profile…** adds other executables; optional arguments live in `Terminal AI → agentProfiles`. Existing profiles are preserved when upgrading. Terminal AI works without enabling AI Chat.

The editor context menu's **Send Selection to Agent Terminal…** and **Send File to Agent Terminal…** let you choose the session that receives the context, including unsaved changes. Text is pasted for review before you submit it. With **MCP Server** enabled, Terminal AI automatically passes its configuration to Claude and Codex CLIs. The **MCP** badge means the configuration was supplied; confirm the connection from the CLI itself.

## Make it yours

Mods can add commands, snippets, themes, and panels. A single JSON file is enough to build a launcher for your project commands. Use JavaScript when you need a custom view or deeper editor integration. Export a mod as an `.aicode-mod` file or share a profile, including its mods, as an `.aicode-profile` file.

For agent workflows, the optional **MCP Server** lets compatible clients read open files, including unsaved changes, and propose edits you can review as diffs. The **CodeFlow** mod can launch workflows with the current file or selection. Enable MCP if you also want CodeFlow's agents to connect back to AICode.

- [Build a JSON mod](docs/MOD-GUIDE.md)
- [Explore the JavaScript mod API and permissions](docs/MODS.md)
- [Customize settings, themes, and layouts](docs/CONFIGURATION.md)
- [Build AICode from source](docs/DEVELOPMENT.md)
