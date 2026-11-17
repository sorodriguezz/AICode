# Developing AICode

[Back to AICode](../README.md)

## Build from source

Use Node.js LTS, pnpm, and the stable Rust toolchain. The release workflow lists the Linux build dependencies. [.github/workflows/release.yml](../.github/workflows/release.yml)

```sh
pnpm install
pnpm tauri dev          # debug build; bundled mods load live from ./mods
pnpm check:mods         # validate the bundled mods
pnpm test:terminal      # file drops, nested layouts, resizing, pane moves, focus and agent launches
pnpm test:terminal-ai   # provider discovery, optional MCP, credentials and profile migration
pnpm test:git           # operation cleanup, cancellation, timeouts and failed status refreshes
pnpm test:editor        # saved content, manual reverts, save races and Git editor metadata
(cd src-tauri && cargo test --locked)
pnpm tauri build        # this OS's bundles in src-tauri/target/release/bundle
                        # (macOS .app/.dmg, Windows NSIS -setup.exe, Linux AppImage/.deb/.rpm)
```

Development environment variables

- `AICODE_HOME=/some/dir` keeps all data (profiles, mods, session) there instead of
  the platform's application data directory.
- `AICODE_DIAG=1` writes a text report of the window layout to the terminal 5 s after start.

## Releases and updates

GitHub Actions builds packages for Intel and AMD (`x64`) and ARM (`aarch64`), including Apple silicon, Windows on ARM, and ARM64 Linux. [Release workflow](../.github/workflows/release.yml)

| | Install | Update package (signed) |
|---|---|---|
| macOS | `AICode_<v>_<arch>.dmg` | `.app.tar.gz` |
| Windows | `AICode_<v>_<arch>-setup.exe` (per user, no admin) | the installer itself |
| Linux | `AICode_<v>_<arch>.AppImage`, `.deb`, `.rpm` | the AppImage (and `.deb`/`.rpm` when signed) |

The release includes `latest.json`, the update feed the app reads. Tauri merges platform-specific
bundle settings over `tauri.conf.json`. [Windows bundle settings](../src-tauri/tauri.windows.conf.json) · [Linux bundle settings](../src-tauri/tauri.linux.conf.json)

Platform-specific installation notes are included with each release. [Latest release](https://github.com/sorodriguezz/AICode/releases/latest)

### App updates

Use **Settings → Updates → Check for Updates**. **Install and Restart** verifies the update's
signature, replaces the app and restores your windows, tabs and unsaved text. **Later** leaves an
update item in the status bar so you can install it when you're ready. **Check on Startup** checks
once per launch when enabled.

### Publish a release

Change `"version"` in `package.json` and push to `main`. For a new version, the workflow syncs
the Cargo and Tauri version files, creates a tag and builds all six targets. It writes
`latest.json` and publishes the draft after all packages are uploaded. Pull the release commit
to sync your checkout if the workflow changed any version files.

`pnpm release patch --push` updates the version files, commits, tags and pushes in one step.
It also accepts `minor`, `major`, or an explicit version in place of `patch`. Use **Dry run** from
the Actions tab to build installers as workflow artifacts before publishing.

### Release credentials

Configure the workflow credentials in **Settings → Secrets and variables → Actions**.

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the contents of the update signing key (`~/.tauri/aicode.key`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password (`~/.tauri/aicode.key.password`) |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Optional credentials for Developer ID signing and notarization |

The app verifies update signatures with `plugins.updater.pubkey` in `tauri.conf.json`. Back up
the corresponding private key. Losing it requires distributing a fresh installer with a new
public key. The workflow uses `--config src-tauri/tauri.release.conf.json` to produce signed
update archives.

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

## Mod compatibility and permissions

AICode loads its own mod format. The Mods page lists declared permissions, and the core checks permissions on mod API calls. JavaScript mods share the window's JavaScript environment. Review executable mods before installing them. [Mod API and permissions](MODS.md)

## Theme and icon credits

The built-in Dark 2026 and Light 2026 themes come from VS Code. [Theme license](../src/core/themes/LICENSE.md)

The File Icon Themes mod includes Seti, VS Code Icons, and framework icon packs. [Icon credits](../mods/aicode.icons/NOTICE.md)
