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
3. Open **Mods** from the gear menu. Try **Explorer**, **Search**, and **Terminal** for a coding workspace. Enable **Source Control (Git)** and **Git Graph** to work with your repository. AICode activates their dependencies automatically.

Use **Settings → Updates → Check for Updates** to update an installed copy.

## Make it yours

Mods can add commands, snippets, themes, and panels. A single JSON file is enough to build a launcher for your project commands. Use JavaScript when you need a custom view or deeper editor integration. Export a mod as an `.aicode-mod` file or share a profile, including its mods, as an `.aicode-profile` file.

For agent workflows, the optional **MCP Server** lets compatible clients read open files, including unsaved changes, and propose edits you can review as diffs. The **CodeFlow** mod can launch workflows with the current file or selection. Enable MCP if you also want CodeFlow's agents to connect back to AICode.

- [Build a JSON mod](docs/MOD-GUIDE.md)
- [Explore the JavaScript mod API and permissions](docs/MODS.md)
- [Customize settings, themes, and layouts](docs/CONFIGURATION.md)
- [Build AICode from source](docs/DEVELOPMENT.md)
