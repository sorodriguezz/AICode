import "@vscode/codicons/dist/codicon.css";
import "./styles.css";

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as monaco from "monaco-editor";
import { invoke, prepareStreams, streamCounts, type ModInfo } from "./core/ipc";
import * as commands from "./core/commands";
import { Workbench } from "./core/workbench";
import { EditorService, DEFAULT_FONT_SIZE } from "./core/editor";
import { Workspace } from "./core/workspace";
import { ModHost, decorations } from "./core/mods";
import { registerModManager } from "./core/modManager";
import { applyTheme, BUILTIN_DARK, BUILTIN_LIGHT, ThemeEntry } from "./core/theme";
import { configureFileIcons } from "./core/fileIcons";
import { quickInput, fuzzyScore, highlight, pick, notify, QuickItem, dialog } from "./core/widgets";
import { basename, h, icon } from "./core/ui";
import { motionEnabled, setMotion } from "./core/motion";
import { openProfiles, openSettings, switchProfile, createProfile, importProfile, exportProfile, ProfileView } from "./core/profiles";
import { ModHost as ModHostClass } from "./core/mods";
import { initUpdates, checkForUpdates, checkOnStartup } from "./core/updates";
import { config } from "./core/config";
import { Appearance, editorOptions } from "./core/appearance";
import { openWindow, resolveLayout, layouts, type WindowSpec, type WindowLayout } from "./core/windows";
import type { ViewLocation, LayoutState, TitleHandle, StatusHandle } from "./core/workbench";

// Errors and warnings also go to the terminal that started AICode (see `core_log`).
for (const level of ["error", "warn"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    invoke("core_log", { level, message: args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ") }).catch(() => {});
  };
}
window.addEventListener("error", (e) => {
  // Browsers report this when an element is resized again in the same frame (Monaco and the
  // terminal re-measure while a panel animates). Nothing is lost; it is not an error.
  if (e.message?.includes("ResizeObserver loop")) return;
  console.error(`uncaught: ${e.message} at ${e.filename}:${e.lineno}`);
});
// Only the app's own context menus: the webview's native one (Reload, Inspect Element) never
// shows. Our handlers run first and open theirs; a right click on nothing does nothing.
window.addEventListener("contextmenu", (e) => e.preventDefault());
window.addEventListener("unhandledrejection", (e) => console.error(`unhandled rejection: ${e.reason?.stack ?? e.reason}`));

async function boot() {
  await prepareStreams();
  const wb = new Workbench(document.getElementById("app")!);
  const workspace = new Workspace();
  const editors = new EditorService(wb);
  editors.breadcrumbRoot = () => workspace.folder;
  editors.decorate = (path) => decorations.get(path);
  decorations.onDidChange.event(() => editors.refreshTabs());
  workspace.onDidChange.event(() => editors.refreshTabs());
  const host = new ModHost(wb, editors, workspace);
  registerModManager(host, editors);

  const session = await invoke<string | null>("session_load").then((s) => (s ? JSON.parse(s) : null)).catch(() => null);
  // The configuration's layers: the profile's values, and the defaults the enabled mods set.
  await config.loadUser();
  const modList = await invoke<ModInfo[]>("mods_list");
  config.setModLayers(ModHostClass.configurationLayers(modList));

  const profile = await invoke<ProfileView>("profile_get");
  // What this window was opened as (a layout, a view, a tab dragged out): from its session after a
  // restart, else from whoever opened it.
  const takenSpec = await invoke<WindowSpec | null>("window_take_spec").catch(() => null);
  const spec: WindowSpec | null = session?.window ?? takenSpec ?? null;
  const freshSpec = !session?.window && !!takenSpec;
  const layout: WindowLayout | null = spec ? resolveLayout(spec) : null;
  if (layout?.settings) config.setWindowLayer({ core: layout.settings });
  // A window with a layout keeps its arrangement to itself: the profile's stays as it was.
  const persistArrangement = !layout;
  const layoutViews = layout?.views ?? {};
  const layoutHidden = Object.entries(layoutViews).filter(([, p]) => p === "hidden").map(([id]) => id);
  const centerId = layout?.center ?? Object.entries(layoutViews).find(([, p]) => p === "center")?.[0] ?? null;
  const placementFor = () => {
    const base = { ...(config.core<Record<string, any>>("workbench.viewPlacement", {}) ?? {}) };
    let order = 1;
    for (const [id, place] of Object.entries(layoutViews)) if (place === "sidebar" || place === "secondary" || place === "panel") base[id] = { location: place, order: order++ * 10 };
    return base;
  };
  const hiddenViews = () => [...(config.core<string[]>("workbench.hiddenViews", []) ?? []), ...layoutHidden];
  // Where the user dragged views to (before mods put their views on screen).
  wb.setPlacement(placementFor());
  wb.onDidChangePlacement.event((placement) => {
    if (persistArrangement) config.update("core", "workbench.viewPlacement", Object.keys(placement).length ? placement : null).catch(() => {});
  });
  // Customize Layout's choices (side bar position, panel alignment, density…), kept by the profile.
  wb.setOptions({ ...(config.core<Record<string, any>>("workbench.layout", {}) ?? {}), ...(layout?.options ?? {}) }, false);
  wb.onDidChangeOptions.event((o) => {
    if (persistArrangement) config.update("core", "workbench.layout", o).catch(() => {});
  });
  wb.setHiddenViews(hiddenViews());
  // Theme first, so nothing flashes in the wrong colors.
  applyTheme(BUILTIN_DARK, await BUILTIN_DARK.load());
  await host.load(modList);
  config.installJsonSchemas(modList.map((m) => m.id));
  const allThemes = (): ThemeEntry[] => [BUILTIN_DARK, BUILTIN_LIGHT, ...host.themes];

  // Everything the configuration says about how the window looks.
  const appearance = new Appearance(await invoke<boolean>("window_is_transparent").catch(() => false));
  appearance.pinned = !!layout?.alwaysOnTop;
  appearance.extraHide = layout?.hide ?? [];
  await appearance.init();

  // Your own title bar buttons and status bar items (workbench.titleBar.items / statusBar.items).
  let userTitleItems: TitleHandle[] = [];
  let userStatusItems: StatusHandle[] = [];
  const applyUserItems = () => {
    for (const d of userTitleItems.splice(0)) d.dispose();
    for (const d of userStatusItems.splice(0)) d.dispose();
    for (const it of config.core<any[]>("workbench.titleBar.items", []) ?? []) {
      if (it && typeof it === "object" && it.command) userTitleItems.push(wb.addTitleItem({ id: it.id, icon: it.icon, text: it.text, title: it.title ?? it.tooltip, command: it.command, args: it.args, align: it.align, order: it.order }));
    }
    for (const it of config.core<any[]>("workbench.statusBar.items", []) ?? []) {
      if (it && typeof it === "object" && (it.text || it.icon)) userStatusItems.push(wb.addStatus({ id: it.id, icon: it.icon, text: it.text, tooltip: it.title ?? it.tooltip, command: it.command, args: it.args, align: it.align === "right" ? "right" : "left", priority: it.priority ?? it.order ?? 0 }));
    }
  };
  const pinVisible = () => {
    const mode = config.core<string>("window.pinButton", "auto");
    wb.pinButton.style.display = mode === "always" || (mode === "auto" && !!spec) ? "" : "none";
    wb.pinButton.classList.toggle("active", appearance.isOnTop());
    wb.pinButton.setAttribute("aria-pressed", String(appearance.isOnTop()));
    wb.pinButton.title = appearance.isOnTop() ? "Stop Keeping on Top" : "Keep on Top";
  };

  // The profile's own settings for the editor and the workbench (see the Settings page).
  const applyCore = async (changed: string[] | "*") => {
    const all = changed === "*";
    const has = (...keys: string[]) => all || keys.some((k) => (k.endsWith("*") ? (changed as string[]).some((c) => c.startsWith(k.slice(0, -1))) : (changed as string[]).includes(k)));
    if (has("editor.*")) {
      editors.setFontSize(Number(config.core("editor.fontSize", DEFAULT_FONT_SIZE)));
      editors.editor.updateOptions(editorOptions());
    }
    document.documentElement.dataset.iconSize = config.core("workbench.iconSize", "normal");
    editors.previewEnabled = config.core<boolean>("workbench.previewEditors", true) !== false;
    editors.useModal = config.core<string>("workbench.editor.useModal", "some") !== "off";
    editors.dragTabsToWindow = config.core("workbench.tabs.dragToWindow", true) !== false;
    if (has("workbench.iconTheme")) {
      configureFileIcons({ enabled: config.core<string>("workbench.iconTheme", "seti") !== "none" });
      if (!all) {
        editors.refreshTabs();
        decorations.onDidChange.fire(); // lists that show files repaint
      }
    }
    setMotion(config.core<boolean>("animations", true) !== false);
    if (has("workbench.hiddenViews")) wb.setHiddenViews(hiddenViews());
    if (has("workbench.titleBar.items", "workbench.statusBar.items")) applyUserItems();
    if (!all && persistArrangement && has("workbench.layout")) wb.setOptions(config.core("workbench.layout", {}) ?? {}, false);
    if (!all && has("workbench.viewPlacement")) wb.setPlacement(placementFor());
    if (!all && has("theme")) {
      const entry = allThemes().find((t) => t.id === config.core("theme"));
      if (entry && entry.id !== currentThemeId) await setTheme(entry, false);
    }
    if (all) await appearance.applyAll();
    else await appearance.applyChanged(changed as string[]);
    if (has("window.*")) pinVisible();
  };
  editors.onDidChangeFontSize.event((size) => {
    config.update("core", "editor.fontSize", size).catch(() => {});
  });
  let currentThemeId = BUILTIN_DARK.id;
  const setTheme = async (entry: ThemeEntry, persist = true) => {
    try {
      currentThemeId = entry.id;
      applyTheme(entry, await entry.load());
      configureFileIcons({ light: entry.uiTheme === "vs" });
      editors.refreshTabs();
      if (persist) await config.update("core", "theme", entry.id);
    } catch (e) {
      notify("error", `Could not load the theme ${entry.label}: ${e}`);
    }
  };
  const savedTheme = allThemes().find((t) => t.id === config.core("theme"));
  if (savedTheme && savedTheme !== BUILTIN_DARK) await setTheme(savedTheme, false);
  await applyCore("*");
  config.onDidChange.event((changes) => {
    const core = changes.filter((c) => c.owner === "core").map((c) => c.key);
    if (core.length) applyCore(core).catch((e) => console.error("applying settings", e));
  });

  // The profile's keyboard shortcuts go over the mods' (a shortcut set for a command replaces its default).
  const userBindings: { dispose: () => void }[] = [];
  const applyUserKeybindings = (list: ProfileView["keybindings"]) => {
    for (const d of userBindings.splice(0)) d.dispose();
    for (const kb of list ?? []) {
      if (!kb || typeof kb.command !== "string" || typeof kb.key !== "string") continue;
      const removed = commands.unbindCommand(kb.command, "user");
      const bound = kb.key ? commands.bind(kb.key, kb.command, "user", kb.args) : null;
      userBindings.push({ dispose: () => { bound?.dispose(); commands.rebind(removed); } });
    }
  };
  applyUserKeybindings(profile.keybindings);

  // Another window changed a setting (or saved profile.json): reread them here too.
  const myLabel = getCurrentWindow().label;
  await listen<string>("settings://changed", async (e) => {
    if (e.payload === myLabel) return;
    await config.loadUser();
    applyUserKeybindings((await invoke<ProfileView>("profile_get")).keybindings);
  });

  registerWorkbenchCommands(wb, editors, workspace, host, allThemes, setTheme, () => currentThemeId, applyUserKeybindings);
  commands.installKeyHandler();

  // Which profile this is, when there is more than one.
  if (profile.available.length > 1 || profile.name !== "default") {
    wb.addStatus({ id: "profile", icon: profile.icon || "account", text: profile.name, tooltip: `Profile: ${profile.name}${profile.description ? ` — ${profile.description}` : ""}\nClick to manage profiles`, command: "profiles.manage", align: "left", priority: 1000 });
  }

  // Saving profile.json applies it right away (settings and shortcuts); only turning mods on or
  // off needs a reload. Saving a mod's mod.json says how to try it; a CSS file of yours reapplies.
  editors.onDidSave.event(async (info) => {
    if (!info.path) return;
    if (info.path === profile.path) {
      try {
        await invoke("profile_reload");
        const now = await invoke<ProfileView>("profile_get");
        await config.loadUser();
        applyUserKeybindings(now.keybindings);
        const before = [...profile.enabled].sort().join("|");
        if ([...now.enabled].sort().join("|") !== before) notify("info", "Profile saved. Reload the window to turn the mods you changed on or off.", [{ label: "Reload Window", run: () => location.reload() }]);
        else notify("info", "Profile saved and applied.", [], 2500);
      } catch (e) {
        notify("error", `profile.json was not applied: ${e}`);
      }
    } else if (info.path.endsWith(".css")) {
      await appearance.fileSaved(info.path);
    } else if (info.path.endsWith("/mod.json")) {
      const mods = await invoke<{ dir: string }[]>("mods_list");
      if (mods.some((m) => info.path === `${m.dir}/mod.json`)) notify("info", "Mod saved. Reload the window to try your changes.", [{ label: "Reload Window", run: () => location.reload() }]);
    }
  });

  // Native menu items arrive as commands.
  await listen<string>("menu", (e) => commands.runOnce(e.payload));

  // Layout and session. A window opened with a layout starts with its parts as the layout says.
  if (layout && !session?.layout) {
    const start: Partial<LayoutState> = {};
    for (const loc of ["sidebar", "secondary", "panel"] as ViewLocation[]) {
      const visible = layout.parts?.[loc];
      const size = layout.sizes?.[loc];
      if (visible !== undefined || size !== undefined) (start as any)[loc] = { ...(visible !== undefined ? { visible } : {}), ...(size !== undefined ? { size } : {}) };
    }
    wb.restore(start);
  }
  wb.restore(session?.layout);
  if (centerId) await wb.setCenterView(centerId);
  if (layout?.title) getCurrentWindow().setTitle(layout.title).catch(() => {});
  // Restored after a restart: Rust made the window at the default size; give it its layout's.
  if (layout && !freshSpec && layout.width && layout.height) getCurrentWindow().setSize(new LogicalSize(layout.width, layout.height)).catch(() => {});
  applyUserItems();
  pinVisible();
  appearance.checkTransparency();
  if (session?.folder) workspace.set(session.folder);
  const updateTitle = () => wb.setTitle(workspace.name ?? (editors.activeInfo()?.title ?? "Search"));
  workspace.onDidChange.event(updateTitle);
  // Every folder this window opens joins the Dock icon's recent list, as in VS Code.
  if (session?.folder) invoke("recent_add", { path: session.folder });
  workspace.onDidChange.event((folder) => folder && invoke("recent_add", { path: folder }));
  editors.onDidChangeActive.event(updateTitle);
  await editors.restore(session?.editors);
  // A tab moved here from another window: its file, with its unsaved text.
  if (freshSpec && spec?.files?.length) {
    for (const f of spec.files) {
      if (f.path) {
        const doc = await editors.openFile(f.path, { line: f.line, column: f.column, preview: false });
        if (doc && typeof f.text === "string" && f.text !== doc.model.getValue()) doc.model.setValue(f.text);
      } else if (typeof f.text === "string") editors.newUntitled(f.text, f.language ?? "plaintext");
    }
  }
  // Paths this window was opened with (command line, Dock, "Open Folder in New Window"). Asking
  // marks the window ready, so the listener for later ones goes first and queues until we can open.
  let openLater: ((paths: string[]) => void) | null = null;
  const queued: string[][] = [];
  await listen<string[]>("open-paths", (e) => (openLater ? openLater(e.payload) : queued.push(e.payload)));
  const pending = await invoke<string[]>("window_take_pending");
  // Opened with nothing to show: the empty editor area (its watermark), as in VS Code. A new file
  // is a double click there, or ⌘N, away.
  updateTitle();

  // Updates: progress and "Update available" in the status bar; the check at startup if it is on.
  await initUpdates((item) => wb.addStatus(item));
  checkOnStartup(!!config.core("update.checkOnStartup", false));

  host.fire("onStartup");
  await wb.revealVisible();
  // The window is put together: from here on, opening and closing things animates.
  requestAnimationFrame(() => {
    wb.enableMotion();
    editors.motionReady = true;
  });

  // ---------- opening files and folders from outside ----------
  const openPaths = async (paths: string[]) => {
    const folders: string[] = [];
    for (const path of paths) {
      const st = await invoke<{ exists: boolean; is_dir: boolean }>("fs_stat", { modId: "core", path }).catch(() => null);
      if (!st?.exists) {
        notify("warning", `${path} does not exist.`);
        continue;
      }
      if (st.is_dir) folders.push(path);
      else if (await editors.openFile(path)) invoke("recent_add", { path });
    }
    // As in VS Code, a window without a folder takes the first one; a window that already has one
    // keeps it, and every other folder gets a window of its own.
    const mine = workspace.folder === null ? folders[0] : folders.find((f) => f === workspace.folder);
    for (const other of folders.filter((f) => f !== mine)) invoke("window_new", { paths: [other] });
    if (mine) {
      workspace.set(mine);
      if (wb.hasView("explorer")) wb.showView("explorer", false);
      else
        notify("info", `Opened ${basename(mine)}. Turn on the Explorer mod to browse it (⌘P already finds its files).`, [
          { label: "Open Mods", run: () => commands.execute("mods.manage") },
        ]);
    }
  };
  if (pending.length) await openPaths(pending);
  for (const paths of queued.splice(0)) await openPaths(paths);
  openLater = (paths) => openPaths(paths);

  // Drag and drop of files and folders from Finder (or anywhere) onto the window.
  const dropHint = h("div", { class: "drop-overlay" }, h("div", { class: "drop-card" }, icon("files"), h("span", null, "Drop to open")));
  document.body.append(dropHint);
  await getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "enter" || p.type === "over") dropHint.classList.add("visible");
    else dropHint.classList.remove("visible");
    if (p.type === "drop" && p.paths.length) openPaths(p.paths);
  });

  // Hot exit: the session (unsaved text included) is written as you type, so quitting, a crash or
  // a reload never loses anything and never asks.
  let timer: number | undefined;
  let closing = false;
  // What the window was opened as stays in its session (the files it came with are in `editors` now).
  const windowForSession = spec ? { ...spec, files: undefined } : undefined;
  const sessionData = () => JSON.stringify({ layout: wb.snapshot(), folder: workspace.folder, editors: editors.snapshot(), window: windowForSession });
  const persist = () => {
    if (closing) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      invoke("session_save", { data: sessionData() }).catch((e) => console.warn("session", e));
    }, 600);
  };
  if (freshSpec) persist();
  editors.onDidChangeContent.event(persist);
  editors.onDidChangeDocs.event(persist);
  wb.onDidChangeLayout.event(persist);
  workspace.onDidChange.event(persist);
  // Switching profiles: every window saves now, then closes.
  await listen("session-flush", async () => {
    clearTimeout(timer);
    closing = true;
    await invoke("session_save", { data: sessionData() }).catch(() => {});
  });
  window.addEventListener("beforeunload", () => {
    if (closing) return;
    invoke("session_save", { data: sessionData() });
  });

  // A focused text field costs WebKit a repaint per caret blink (measured: ~3% CPU and ~55 MB of
  // GPU memory at idle, for any field, Monaco or not). When the window is in the background
  // nobody sees the caret: let go of the focus, and give it back on return.
  let focusedBeforeBlur: HTMLElement | null = null;
  window.addEventListener("blur", () => {
    const el = document.activeElement as HTMLElement | null;
    if (el && el !== document.body) {
      focusedBeforeBlur = el;
      el.blur();
    }
  });
  window.addEventListener("focus", () => {
    if (focusedBeforeBlur?.isConnected && (!document.activeElement || document.activeElement === document.body)) focusedBeforeBlur.focus();
    focusedBeforeBlur = null;
  });

  // Closing one window of several forgets it, so unsaved text has to be saved or given up first.
  // The last window just closes: its session (unsaved text included) is kept, as on quit.
  await getCurrentWindow().onCloseRequested(async (event) => {
    const others = (await invoke<number>("window_count")) > 1;
    if (!others) {
      clearTimeout(timer);
      await invoke("session_save", { data: sessionData() });
      return;
    }
    const dirty = editors.list().filter((d) => d.dirty);
    if (dirty.length) {
      const answer = await dialog({
        title: dirty.length === 1 ? `Do you want to save the changes you made to ${dirty[0].title}?` : `Do you want to save the changes to ${dirty.length} files?`,
        message: "This window is closing; your changes will be lost if you don't save them.",
        kind: "warning",
        buttons: [{ label: "Don't Save", value: "discard" }, { label: "Cancel", value: "cancel" }, { label: dirty.length === 1 ? "Save" : "Save All", value: "save", primary: true }],
        cancelValue: "cancel",
      });
      if (answer === "cancel") return event.preventDefault();
      if (answer === "save") {
        for (const d of dirty) {
          const ok = d.path ? await commands.execute("file.saveById", d.id) : (editors.activateById(d.id), await editors.saveAs());
          if (!ok) return event.preventDefault();
        }
      }
    }
    closing = true;
    clearTimeout(timer);
  });

  // ---------- a clean start, and the last session on request ----------
  const reopenLastSession = async () => {
    const data = await invoke<string | null>("session_restore_previous").catch((e) => {
      notify("error", `Could not reopen the last session: ${e}`);
      return null;
    });
    if (!data) {
      notify("info", "There is no previous session to reopen.");
      return;
    }
    let prev: any;
    try {
      prev = JSON.parse(data);
    } catch {
      return;
    }
    await editors.restore(prev.editors);
    if (prev.folder) {
      if (!workspace.folder) {
        workspace.set(prev.folder);
        if (wb.hasView("explorer")) wb.showView("explorer", false);
      } else if (prev.folder !== workspace.folder) await invoke("window_new", { paths: [prev.folder] });
    }
    persist();
  };
  commands.register("workbench.reopenLastSession", reopenLastSession, { title: "Reopen Last Session", category: "File", owner: "core" });
  if (!session) {
    // Opened clean: offer the last session back once, when it had work that was not saved.
    invoke<{ windows: number; files: number; unsaved: number; folders: string[]; offer: boolean }>("session_previous_info")
      .then((info) => {
        if (!info.offer || !info.unsaved) return;
        notify("info", `Your last session had ${info.unsaved} unsaved file${info.unsaved === 1 ? "" : "s"}${info.files > info.unsaved ? ` (${info.files} open in all)` : ""}. AICode now starts clean.`, [
          { label: "Reopen Last Session", run: () => void reopenLastSession() },
          { label: "Always Restore", run: () => void config.update("core", "window.restoreOnStartup", "all").then(reopenLastSession) },
        ]);
      })
      .catch(() => {});
  }

  // ---------- windows opened as something ----------
  const detachView = async (viewId: string): Promise<void> => {
    const desc = wb.allViews().find((v) => v.id === viewId);
    if (!desc) {
      notify("warning", `No view ${viewId}.`);
      return;
    }
    const wasVisible = wb.isVisible(viewId);
    await openWindow({ view: viewId, title: desc.title });
    // Moved, not copied: it leaves this window's part (or the center).
    if (wb.centerViewId() === viewId) await wb.setCenterView(null);
    else if (wasVisible) wb.toggle(desc.location);
  };
  wb.detachView = (id) => void detachView(id).catch((e) => notify("error", String(e)));
  editors.detachTab = (tab, at) => {
    openWindow({ layout: "editor", files: [tab], title: tab.title, x: at ? Math.max(0, at.x - 120) : undefined, y: at ? Math.max(0, at.y - 16) : undefined }).catch((e) => notify("error", String(e)));
  };
  const reopenWindow = async () => {
    clearTimeout(timer);
    closing = true;
    await invoke("session_save", { data: sessionData() }).catch(() => {});
    await invoke("window_reopen", { spec: windowForSession ?? null });
  };
  host.windowServices = {
    current: () => (spec ? { ...spec } : null),
    setPinned: async (on) => {
      await appearance.setPinned(on);
      pinVisible();
    },
    isOnTop: () => appearance.isOnTop(),
    reopen: reopenWindow,
    detachView,
  };
  const reg = (id: string, title: string, run: (...a: any[]) => unknown, category: string, hidden = false) => commands.register(id, run, { title, category, owner: "core", hidden });
  reg("window.toggleAlwaysOnTop", "Toggle Always on Top", async () => {
    await appearance.setPinned(!appearance.isOnTop());
    pinVisible();
  }, "Window");
  reg("window.reopen", "Reopen Window", reopenWindow, "Window");
  reg("workbench.openWindowWithLayout", "Open Window with Layout…", async (name?: string) => {
    let layoutName = typeof name === "string" ? name : undefined;
    if (!layoutName) {
      const all = Object.entries(layouts()).filter(([n]) => n !== "view" && n !== "editor");
      if (!all.length) {
        notify("info", "No window layouts yet. Add one to workbench.windowLayouts in your profile, or turn on a mod that brings one (Agents Window).", [{ label: "Open Settings (JSON)", run: () => commands.execute("preferences.openProfileJson") }]);
        return;
      }
      const choice = await pick(all.map(([n, l]) => ({ label: l.title ?? n, description: n, value: n, icon: "window" })), { placeholder: "Open a window with layout…" });
      layoutName = choice?.value as string | undefined;
    }
    if (layoutName) await openWindow({ layout: layoutName }).catch((e) => notify("error", String(e)));
  }, "Window");
  reg("workbench.moveViewToNewWindow", "Move View to New Window…", async (id?: string) => {
    let viewId = typeof id === "string" ? id : undefined;
    if (!viewId) {
      const choice = await pick(wb.allViews().map((d) => ({ label: d.title, description: d.location, icon: d.icon, id: d.id })), { placeholder: "Select a view to move to a new window" });
      viewId = choice?.id as string | undefined;
    }
    if (viewId) await detachView(viewId);
  }, "View");
  reg("editor.moveIntoNewWindow", "Move Editor into New Window", async () => {
    const id = editors.activeInfo()?.id;
    const doc = id ? editors.find(id) : null;
    if (doc) await editors.detach(doc);
  }, "View");
  const readOnlyJson = (title: string, text: string) =>
    editors.openCustom({
      title,
      icon: "json",
      render: (el) => {
        const pre = h("pre", { class: "settings-json-view" });
        el.append(h("div", { class: "settings-json-page" }, h("div", { class: "settings-json-bar" }, h("button", { class: "btn secondary", onclick: () => invoke("clipboard_write", { text }).then(() => notify("info", "Copied.", [], 1500)) }, icon("copy"), "Copy"), h("button", { class: "btn secondary", onclick: () => commands.execute("preferences.openProfileJson") }, icon("go-to-file"), "Open Your profile.json")), pre));
        monaco.editor.colorize(text, "json", { tabSize: 2 }).then((html) => (pre.innerHTML = html));
      },
    });
  reg("preferences.openDefaultSettings", "Open Default Settings (JSON)", () => readOnlyJson("Default Settings", config.defaultsDocument()), "Preferences");
  reg("preferences.openEffectiveSettings", "Open Effective Settings (JSON)", () => readOnlyJson("Effective Settings", config.effectiveDocument()), "Preferences");
  reg("preferences.setSetting", "Set a Setting", async (key?: string, value?: unknown, owner = "core") => {
    if (typeof key === "string") await config.update(owner, key, value);
  }, "Preferences", true);
  reg("preferences.toggleSetting", "Toggle a Setting", async (key?: string, owner = "core") => {
    if (typeof key === "string") await config.update(owner, key, !config.get(owner, key));
  }, "Preferences", true);
  reg("preferences.editSettingJson", "Edit Setting in JSON", async (owner = "core", key?: string) => {
    if (typeof key !== "string") return commands.execute("preferences.openProfileJson");
    // Put the setting in profile.json with its current value, then show it.
    if (config.userValue(owner, key) === undefined) await config.update(owner, key, config.get(owner, key) ?? null);
    const prof = await invoke<ProfileView>("profile_get");
    const doc = await editors.openFile(prof.path, { preview: false });
    const match = doc?.model.findMatches(JSON.stringify(key), false, false, true, null, false)[0];
    if (match) {
      editors.editor.setSelection(match.range);
      editors.editor.revealRangeInCenter(match.range);
    }
  }, "Preferences", true);
  // Shows the name of the part under the pointer, for writing custom CSS and workbench.hide.
  let partsInspector: (() => void) | null = null;
  reg("developer.inspectParts", "Inspect Window Parts", () => {
    if (partsInspector) return partsInspector();
    const label = h("div", { class: "parts-inspector-label" });
    document.body.append(label);
    document.documentElement.classList.add("inspecting-parts");
    const move = (e: MouseEvent) => {
      const chain: string[] = [];
      let el = (e.target as HTMLElement | null)?.closest("[data-part]") as HTMLElement | null;
      document.querySelectorAll(".part-inspected").forEach((x) => x.classList.remove("part-inspected"));
      el?.classList.add("part-inspected");
      while (el && chain.length < 4) {
        chain.push(`${el.dataset.part}${el.dataset.id ? `:${el.dataset.id}` : ""}`);
        el = el.parentElement?.closest("[data-part]") as HTMLElement | null;
      }
      label.textContent = chain.length ? chain.join("  ‹  ") : "(no part)";
      label.style.transform = `translate(${Math.min(e.clientX + 14, innerWidth - label.offsetWidth - 8)}px, ${Math.min(e.clientY + 16, innerHeight - 30)}px)`;
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && partsInspector?.();
    window.addEventListener("mousemove", move, true);
    window.addEventListener("keydown", key, true);
    partsInspector = () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("keydown", key, true);
      label.remove();
      document.documentElement.classList.remove("inspecting-parts");
      document.querySelectorAll(".part-inspected").forEach((x) => x.classList.remove("part-inspected"));
      partsInspector = null;
    };
    notify("info", "Move the pointer over the window to see each part's name. Escape (or the same command) stops.", [], 4000);
  }, "Developer");

  editors.editor.focus();
  // Started behind another window (from a terminal, at login): same as being sent to the back.
  if (!document.hasFocus()) {
    focusedBeforeBlur = document.activeElement as HTMLElement | null;
    focusedBeforeBlur?.blur();
  }
  const info = await invoke<{ diag: boolean; diagRun: string }>("core_info");
  if (info.diag) {
    getCurrentWindow().setFocus().catch(() => {});
    setTimeout(async () => {
      for (const line of info.diagRun.split(",").map((x) => x.trim()).filter(Boolean)) {
        const [id, ...args] = line.split(" ");
        if (id === "@drag") {
          await dragSelfTest(args[0], args[1]);
          continue;
        }
        if (id === "@repl") {
          void diagRepl(host, args[0]);
          continue;
        }
        const t0 = performance.now();
        try {
          await Promise.race([commands.execute(id, ...args), new Promise((r) => setTimeout(r, 3000))]);
          invoke("core_log", { level: "diag", message: `ran ${id} in ${Math.round(performance.now() - t0)} ms` });
        } catch (e) {
          invoke("core_log", { level: "diag", message: `ran ${id}: ERROR ${e}` });
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      diagnostics();
    }, 4000);
  }
  (window as any).aicode = { wb, editors, workspace, host, commands, config, appearance, openWindow };
}

function registerWorkbenchCommands(
  wb: Workbench,
  editors: EditorService,
  workspace: Workspace,
  host: ModHost,
  themes: () => ThemeEntry[],
  setTheme: (t: ThemeEntry, persist?: boolean) => Promise<void>,
  currentThemeId: () => string,
  applyUserKeybindings: (list: ProfileView["keybindings"]) => void,
) {
  const reg = (id: string, title: string, run: (...a: any[]) => unknown, category = "View") => commands.register(id, run, { title, category, owner: "core" });
  const recent: string[] = [];

  const commandPalette = async (initial = ">") => {
    const all = commands.all();
    const result = await quickInput<QuickItem & { id: string }>({
      placeholder: "Type the name of a command to run.",
      value: initial,
      noMatch: "No matching commands",
      onValue: (v) => {
        if (!v.startsWith(">")) {
          quickOpen(v);
          return true;
        }
        return false;
      },
      items: (q) => {
        const query = q.replace(/^>\s*/, "");
        const items = all
          .map((c) => {
            const label = `${c.category ? c.category + ": " : ""}${c.title}`;
            const m = fuzzyScore(query, label);
            if (!m) return null;
            const r = recent.indexOf(c.id);
            return { item: { label, _label: highlight(label, m.ranges), id: c.id, keybinding: commands.keybindingFor(c.id), description: r >= 0 && !query ? "recently used" : undefined }, score: m.score + (r >= 0 ? 50 - r : 0) };
          })
          .filter((x): x is NonNullable<typeof x> => !!x)
          .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
        return items.map((x) => x.item);
      },
    });
    if (result && typeof result !== "string") {
      const i = recent.indexOf(result.id);
      if (i >= 0) recent.splice(i, 1);
      recent.unshift(result.id);
      commands.execute(result.id).catch((e) => notify("error", String(e)));
    }
  };

  let fileCache: { folder: string; files: string[]; at: number } | null = null;
  const quickOpen = async (initial = "") => {
    const folder = workspace.folder;
    if (folder && (!fileCache || fileCache.folder !== folder || Date.now() - fileCache.at > 15000)) {
      invoke<string[]>("fs_list_files", { modId: "core", root: folder, limit: 50000 }).then((files) => (fileCache = { folder, files, at: Date.now() }));
    }
    const result = await quickInput<QuickItem & { path?: string; docId?: string }>({
      placeholder: folder ? "Search files by name (append : to go to a line, or start with > for commands)" : "Open editors — or > for commands. Open a folder to search its files.",
      value: initial,
      noMatch: "No matching results",
      onValue: (v) => {
        if (v.startsWith(">")) {
          commandPalette(v);
          return true;
        }
        return false;
      },
      items: async (q) => {
        if (q.startsWith(":")) {
          return [{ label: `Go to line ${q.slice(1) || "…"}`, icon: "go-to-file", docId: "__line" }];
        }
        const open = editors.list().map((e) => ({ label: e.title, description: e.path ?? "", icon: "files", docId: e.id }));
        const files = fileCache && fileCache.folder === folder ? fileCache.files : [];
        const scored: { item: any; score: number }[] = [];
        for (const e of open) {
          const m = fuzzyScore(q, e.label);
          if (m) scored.push({ item: { ...e, _label: highlight(e.label, m.ranges), description: "open editor" }, score: m.score + 100 });
        }
        if (q) {
          for (const rel of files) {
            const name = basename(rel);
            const m = fuzzyScore(q, name) ?? (fuzzyScore(q, rel) ? { score: -50, ranges: [] as [number, number][] } : null);
            if (m) scored.push({ item: { label: name, _label: highlight(name, m.ranges), description: rel, fileIcon: name, path: `${folder}/${rel}` }, score: m.score });
            if (scored.length > 4000) break;
          }
        } else {
          for (const rel of files.slice(0, 30)) scored.push({ item: { label: basename(rel), description: rel, fileIcon: basename(rel), path: `${folder}/${rel}` }, score: 0 });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, 200).map((s) => s.item);
      },
    });
    if (!result || typeof result === "string") return;
    if (result.docId === "__line") return;
    if (result.docId) {
      editors.activateById(result.docId);
    } else if (result.path) editors.openFile(result.path);
  };

  reg("workbench.commandPalette", "Show All Commands", () => commandPalette());
  reg("workbench.quickOpen", "Go to File…", () => quickOpen());
  reg("workbench.toggleSidebar", "Toggle Primary Side Bar Visibility", () => wb.toggle("sidebar"));
  reg("workbench.togglePanel", "Toggle Panel Visibility", () => wb.toggle("panel"));
  reg("workbench.customizeLayout", "Customize Layout…", () => wb.customizeLayout());
  reg("workbench.toggleActivityBar", "Toggle Activity Bar Visibility", () => wb.setOptions({ activityBar: !wb.options.activityBar }));
  reg("workbench.toggleStatusBar", "Toggle Status Bar Visibility", () => wb.setOptions({ statusBar: !wb.options.statusBar }));
  reg("workbench.toggleSidebarPosition", "Toggle Primary Side Bar Position", () => wb.setOptions({ sidebarSide: wb.options.sidebarSide === "left" ? "right" : "left" }));
  reg("workbench.toggleMaximizedPanel", "Toggle Maximized Panel", () => wb.toggleMaximized("panel"));
  reg("workbench.toggleMaximizedSecondary", "Maximize Secondary Side Bar", () => wb.toggleMaximized("secondary"));
  const win = getCurrentWindow();
  reg("workbench.toggleFullScreen", "Toggle Full Screen", async () => win.setFullscreen(!(await win.isFullscreen())));
  // Zen Mode: only the editor, full screen; the same command (or Escape twice) brings everything back.
  let zen: { sidebar: boolean; secondary: boolean; panel: boolean; options: typeof wb.options; full: boolean } | null = null;
  let lastEscape = 0;
  const toggleZen = async () => {
    if (zen) {
      const z = zen;
      zen = null;
      wb.setOptions({ activityBar: z.options.activityBar, statusBar: z.options.statusBar }, false);
      for (const loc of ["sidebar", "secondary", "panel"] as const) if (z[loc] !== wb.state[loc].visible) wb.toggle(loc);
      if (!z.full) await win.setFullscreen(false).catch(() => {});
      document.documentElement.classList.remove("zen");
      return;
    }
    zen = { sidebar: wb.state.sidebar.visible, secondary: wb.state.secondary.visible, panel: wb.state.panel.visible, options: { ...wb.options }, full: await win.isFullscreen().catch(() => false) };
    for (const loc of ["sidebar", "secondary", "panel"] as const) if (wb.state[loc].visible) wb.toggle(loc);
    wb.setOptions({ activityBar: false, statusBar: false }, false);
    document.documentElement.classList.add("zen");
    await win.setFullscreen(true).catch(() => {});
  };
  reg("workbench.toggleZenMode", "Toggle Zen Mode", toggleZen);
  window.addEventListener("keydown", (e) => {
    if (!zen || e.key !== "Escape") return;
    const now = performance.now();
    if (now - lastEscape < 600) toggleZen();
    lastEscape = now;
  });
  commands.bind("ctrl+mod+f", "workbench.toggleFullScreen");
  commands.bind("mod+k z", "workbench.toggleZenMode");
  reg("workbench.toggleSecondary", "Toggle Secondary Side Bar Visibility", () => wb.toggle("secondary"));
  reg("workbench.reload", "Reload Window", () => location.reload(), "Developer");
  reg("workbench.newWindow", "New Window", () => invoke("window_new", {}), "File");
  reg("workbench.clearRecentlyOpened", "Clear Recently Opened", () => invoke("recent_clear"), "File");
  reg("workbench.openFolderNewWindow", "Open Folder in New Window…", async () => {
    const folder = await openDialog({ directory: true, multiple: false });
    if (typeof folder === "string") await invoke("window_new", { paths: [folder] });
  }, "File");
  reg("window.close", "Close Window", () => getCurrentWindow().close(), "Window");
  reg("window.toggleMaximize", "Toggle Maximize", () => getCurrentWindow().toggleMaximize(), "Window");
  reg("preferences.theme", "Color Theme", async () => {
    // Like VS Code: the theme under the keyboard applies right away; Escape puts the old one back.
    const list = themes();
    const before = list.find((t) => t.id === currentThemeId());
    let previewing = Promise.resolve();
    const choice = await pick(list.map((t) => ({ label: t.label, description: t.source === "core" ? "built in" : `from ${t.source}`, id: t.id })), {
      placeholder: "Select Color Theme (Up/Down Keys to Preview)",
      activeIndex: Math.max(0, list.findIndex((t) => t.id === currentThemeId())),
      onActive: (item) => {
        const entry = list.find((t) => t.id === item.id);
        if (entry && entry.id !== currentThemeId()) previewing = previewing.then(() => setTheme(entry, false));
      },
    });
    await previewing;
    const entry = list.find((t) => t.id === choice?.id);
    if (entry) await setTheme(entry);
    else if (before && before.id !== currentThemeId()) await setTheme(before, false);
  }, "Preferences");
  reg("profiles.switch", "Switch Profile…", async (target?: string) => {
    if (typeof target === "string" && target) return switchProfile(target);
    const prof = await invoke<ProfileView>("profile_get");
    const choice = await pick(
      [
        ...prof.available.map((p) => ({ label: p, description: p === prof.name ? "current" : "", icon: p === prof.name ? "check" : "account", value: p })),
        { label: "New Profile…", description: "empty, or a copy of one", value: "__new", icon: "add" },
        { label: "Manage Profiles", description: "rename, export, import, delete", value: "__manage", icon: "settings-gear" },
      ],
      { placeholder: "Profiles keep their own mods, settings, shortcuts and windows" },
    );
    if (!choice) return;
    if (choice.value === "__manage") return openProfiles(editors);
    const name = choice.value === "__new" ? await createProfile() : (choice.value as string);
    if (name && name !== prof.name) await switchProfile(name);
  }, "Preferences");
  reg("profiles.manage", "Profiles", () => openProfiles(editors), "Preferences");
  reg("profiles.create", "New Profile…", () => createProfile(), "Preferences");
  reg("profiles.import", "Import Profile…", (path?: string) => importProfile(typeof path === "string" ? path : undefined), "Preferences");
  reg("profiles.export", "Export Profile…", async (name?: string, path?: string) => exportProfile(typeof name === "string" && name ? name : (await invoke<ProfileView>("profile_get")).name, path), "Preferences");
  reg("workbench.resetViewLocations", "Reset View Locations", () => wb.resetPlacement());
  reg("workbench.moveView", "Move View…", async () => {
    const all = (["sidebar", "secondary", "panel"] as const).flatMap((loc) => wb.viewsAt(loc));
    const view = await pick(all.map((d) => ({ label: d.title, description: d.location, icon: d.icon, id: d.id })), { placeholder: "Select a view to move" });
    if (!view) return;
    const names = { sidebar: "Primary Side Bar", secondary: "Secondary Side Bar", panel: "Panel" } as const;
    const to = await pick((Object.keys(names) as (keyof typeof names)[]).filter((l) => l !== view.description).map((l) => ({ label: names[l], loc: l })), { placeholder: `Move ${view.label} to…` });
    if (to) wb.moveView(view.id as string, to.loc as any);
  });
  editors.restorers.set("profiles", () => openProfiles(editors));
  const settingsPage = () => openSettings({ host, editors, themes });
  reg("preferences.settings", "Settings", settingsPage, "Preferences");
  reg("update.check", "Check for Updates…", () => checkForUpdates(), "Update");
  editors.restorers.set("settings", settingsPage);
  reg("preferences.openProfileJson", "Open Profile Settings (JSON)", async () => {
    const prof = await invoke<ProfileView>("profile_get");
    await editors.openFile(prof.path);
  }, "Preferences");
  reg("preferences.toggleAnimations", "Toggle Animations", async () => {
    const on = !motionEnabled();
    setMotion(on);
    await config.update("core", "animations", on);
    notify("info", !on ? "Animations are off." : motionEnabled() ? "Animations are on." : "Animations stay off while macOS Reduce motion is on.");
  }, "Preferences");
  reg("workbench.keybindings", "Keyboard Shortcuts", () => {
    editors.openPage({
      title: "Keyboard Shortcuts",
      icon: "record-keys",
      key: "keybindings",
      restore: "keybindings",
      render: (el) => {
        const page = h("div", { class: "mods-page" });
        el.append(page);
        let filter = "";
        let recording: { command: string; stop: () => void } | null = null;

        const save = async (change: (list: ProfileView["keybindings"]) => ProfileView["keybindings"]) => {
          const prof = await invoke<ProfileView>("profile_get");
          const list = change(prof.keybindings ?? []);
          await invoke("profile_set_keybindings", { keybindings: list });
          applyUserKeybindings(list);
          render();
        };
        const record = (command: string, cell: HTMLElement) => {
          recording?.stop();
          cell.replaceChildren(h("span", { class: "recording" }, "Press the keys… (Esc cancels, ⌫ removes the shortcut)"));
          commands.suspendKeys(true);
          let first: string | null = null;
          let timer: number | undefined;
          const finish = (key: string | null) => {
            stop();
            if (key === null) return render();
            save((list) => [...list.filter((k) => k.command !== command), { key, command }]);
          };
          const onKey = (e: KeyboardEvent) => {
            if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return;
            e.preventDefault();
            e.stopPropagation();
            const chord = commands.eventChord(e);
            if (!first && chord === "escape") return finish(null);
            if (!first && chord === "backspace") return finish("");
            if (first) return finish(`${first} ${chord}`);
            first = chord;
            cell.replaceChildren(h("span", { class: "recording" }, commands.prettyKey(chord).join(" "), " … (press a second key for a chord, or wait)"));
            // A single key unless a second one follows quickly (a chord like ⌘K ⌘T).
            timer = window.setTimeout(() => finish(first), 900);
          };
          const stop = () => {
            clearTimeout(timer);
            window.removeEventListener("keydown", onKey, true);
            commands.suspendKeys(false);
            recording = null;
          };
          window.addEventListener("keydown", onKey, true);
          recording = { command, stop };
        };

        const render = () => {
          const q = filter.toLowerCase();
          const rows = commands
            .all()
            .map((c) => ({ c, key: commands.keybindingFor(c.id), owner: commands.keybindingOwner(c.id) }))
            .filter(({ c, key }) => !q || `${c.category ?? ""}: ${c.title} ${c.id} ${key ?? ""}`.toLowerCase().includes(q))
            .sort((a, b) => (a.c.category ?? "").localeCompare(b.c.category ?? "") || a.c.title.localeCompare(b.c.title));
          const search = h("input", { class: "input", placeholder: "Search commands and keys", value: filter, oninput: (e: Event) => { filter = (e.target as HTMLInputElement).value; render(); (page.querySelector(".mods-toolbar input") as HTMLInputElement)?.focus(); } });
          page.replaceChildren(
            h("h1", null, "Keyboard Shortcuts"),
            h("p", { class: "muted" }, "Click a shortcut to change it. Yours are kept in the current profile and replace the default of that command; mods declare their own defaults in mod.json."),
            h("div", { class: "mods-toolbar" }, search),
            h(
              "table",
              { class: "res-table keys-table" },
              h("thead", null, h("tr", null, h("th", null, "Command"), h("th", null, "Keybinding"), h("th", null, "Source"), h("th", null, ""))),
              h(
                "tbody",
                null,
                rows.map(({ c, key, owner }) => {
                  const cell = h("td", { class: "key-cell", title: "Click to change", onclick: () => record(c.id, cell) }, key ? commands.prettyKey(key).map((k) => h("kbd", null, k)) : h("span", { class: "muted" }, owner === "user" ? "none" : "—"));
                  return h(
                    "tr",
                    null,
                    h("td", null, `${c.category ? c.category + ": " : ""}${c.title}`, h("div", { class: "muted", style: { fontSize: "11px" } }, c.id)),
                    cell,
                    h("td", { class: "muted" }, owner === "user" ? "you (profile)" : owner ?? (key ? "menu" : c.owner)),
                    h("td", null, owner === "user" ? h("button", { class: "icon-button", title: "Back to the default", onclick: () => save((list) => list.filter((k) => k.command !== c.id)) }, icon("discard")) : null),
                  );
                }),
              ),
            ),
          );
        };
        render();
        return { dispose: () => recording?.stop() };
      },
    });
  }, "Preferences");
  editors.restorers.set("keybindings", () => commands.execute("workbench.keybindings"));
  reg("developer.showRunning", "Show Running Mods", () => {
    const lines = host.list().map((m) => `${m.name}: ${m.state}${m.loadMs != null ? ` (${m.loadMs} ms)` : ""}`);
    notify("info", lines.length ? lines.join("\n") : "No mods enabled.");
  }, "Developer");
  reg("help.about", "About AICode", async () => {
    const info = await invoke<{ version: string; modApi: number; dataDir: string }>("core_info");
    notify("info", `AICode ${info.version} · mod API ${info.modApi}\nData: ${info.dataDir}`);
  }, "Help");

  void icon;
}

/**
 * AICODE_DIAG_RUN="@repl <mod id>": drives the app from outside. Each time the enabled mod's
 * `in.txt` changes to a new <seq>, imports its `q/<seq>.js` (CSP allows only aimod: scripts),
 * awaits its default export and writes the result to the mod's `out.json`.
 */
async function diagRepl(host: ModHost, modId: string) {
  const dir = host.list().find((m) => m.id === modId)?.dir;
  if (!dir) return invoke("core_log", { level: "diag", message: `repl: no mod ${modId}` });
  let last = "";
  for (;;) {
    await new Promise((r) => setTimeout(r, 200));
    let seq: string;
    try {
      seq = (await invoke<{ text: string }>("fs_read_text", { modId: "core", path: `${dir}/in.txt` })).text.trim();
    } catch {
      continue;
    }
    if (!seq || seq === last) continue;
    last = seq;
    let out: unknown;
    try {
      const m = await import(/* @vite-ignore */ host.url(modId, `q/${seq}.js`));
      out = { ok: await m.default() };
    } catch (e) {
      out = { error: `${e}\n${(e as Error)?.stack ?? ""}` };
    }
    let json: string;
    try {
      json = JSON.stringify({ seq, ...(out as object) }, null, 1);
    } catch (e) {
      json = JSON.stringify({ seq, error: "unserializable: " + e });
    }
    await invoke("fs_write_text", { modId: "core", path: `${dir}/out.json`, text: json }).catch(() => {});
  }
}

/** AICODE_DIAG=1: a text picture of the window, written to the terminal (for checks without a screen). */
function diagnostics() {
  const box = (sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return `${sel}: missing`;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return `${sel}: ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} display=${st.display} bg=${st.backgroundColor}`;
  };
  const text = (sel: string, max = 300) => Array.from(document.querySelectorAll(sel)).map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim()).filter(Boolean).join(" | ").slice(0, max);
  const lines = [
    `window ${getCurrentWindow().label} ${innerWidth}x${innerHeight} folder=${(window as any).aicode?.workspace.folder}`,
    ...[".titlebar", ".activitybar", ".part.sidebar", ".center", ".editor-group", ".part.panel", ".part.secondary", ".statusbar", ".editor-body", ".monaco-host", ".monaco-editor", ".xterm", ".xterm-screen"].map((s) => box(s)),
    `activity items: ${document.querySelectorAll(".activity-item").length}`,
    `tabs: ${text(".tab .label")}`,
    `sidebar header: ${text(".part.sidebar .part-header")}`,
    `sidebar view: ${text(".part.sidebar .view-host:not([style*='none'])", 400)}`,
    `secondary header: ${text(".part.secondary .part-header")}`,
    `secondary view: ${text(".part.secondary .view-host:not([style*='none'])", 400)}`,
    `panel header: ${text(".part.panel .part-header")}`,
    `terminal: ${text(".xterm-rows", 300)} rows=${document.querySelector(".xterm-rows")?.children.length ?? "none"} streams=${JSON.stringify(streamCounts)}`,
    `status: ${text(".statusbar .status-item")}`,
    `monaco: model lines=${(window as any).aicode?.editors.editor.getModel()?.getLineCount()} rendered=${document.querySelectorAll(".view-line").length} first="${(document.querySelector(".view-line") as HTMLElement | null)?.textContent?.slice(0, 80) ?? ""}"`,
    `editor bg: ${getComputedStyle(document.documentElement).getPropertyValue("--aicode-editor-background")} language: ${(window as any).aicode?.editors.editor.getModel()?.getLanguageId()}`,
    `tokens: ${(() => {
      const model = (window as any).aicode?.editors.editor.getModel();
      if (!model) return "";
      const line = model.getLinesContent().find((l: string) => l.trim().length > 20) ?? "";
      return monaco.editor
        .tokenize(line, model.getLanguageId())[0]
        .map((t) => t.type)
        .filter(Boolean)
        .slice(0, 8)
        .join(" | ");
    })()}`,
    `font: ${getComputedStyle(document.body).fontFamily.slice(0, 60)} codicon loaded: ${document.fonts.check("16px codicon")}`,
    `icons: activity=${getComputedStyle(document.querySelector(".activity-item .codicon") ?? document.body).fontSize} bar=${(document.querySelector(".activitybar") as HTMLElement | null)?.offsetWidth} list=${getComputedStyle(document.documentElement).getPropertyValue("--list-icon")}`,
    `views: ${(["sidebar", "secondary", "panel"] as const).map((l) => `${l}=[${(window as any).aicode?.wb.viewsAt(l).map((d: any) => d.id).join(",")}]`).join(" ")}`,
    `status: ${text(".statusbar .status-item", 400)}`,
    `toasts: ${text(".toast .msg", 600)}`,
    `custom tab: ${text(".custom-host", 500)}`,
    `editor text: ${JSON.stringify(((window as any).aicode?.editors.editor.getModel()?.getValue() ?? "").slice(0, 200))}`,
  ];
  invoke("core_log", { level: "diag", message: "\n" + lines.join("\n") });
  motionSelfTest();
}

/** AICODE_DIAG_RUN="@drag <view> <sidebar|secondary|panel|before:<view>>": drags a view with mouse events. */
async function dragSelfTest(viewId: string, where: string) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const wb = (window as any).aicode?.wb;
  const source = (document.querySelector(`.activity-item[data-before="${viewId}"], .part-tab[data-before="${viewId}"]`) as HTMLElement | null) ?? null;
  if (!source) return invoke("core_log", { level: "diag", message: `drag test: no handle for ${viewId}` });
  const center = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const target = where.startsWith("before:")
    ? document.querySelector(`[data-before="${where.slice(7)}"]`)
    : document.querySelector(`.view-drop-zones .zone[data-drop="${where}"]`);
  const a = center(source);
  source.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: a.x, clientY: a.y }));
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: a.x + 20, clientY: a.y + 20 }));
  await wait(50);
  if (!target) return invoke("core_log", { level: "diag", message: `drag test: no target ${where}` });
  const b = center(target);
  const r = (target as HTMLElement).getBoundingClientRect();
  const bx = where.startsWith("before:") ? r.left + 3 : b.x;
  const by = where.startsWith("before:") ? r.top + 3 : b.y;
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: bx, clientY: by }));
  await wait(50);
  const highlighted = document.querySelector(".drop-target, .drop-before, .drop-after")?.className ?? "none";
  const ghost = !!document.querySelector(".view-drag-ghost");
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: bx, clientY: by }));
  await wait(400);
  const views = (["sidebar", "secondary", "panel"] as const).map((l) => `${l}=[${wb.viewsAt(l).map((d: any) => d.id).join(",")}]`).join(" ");
  invoke("core_log", { level: "diag", message: `drag test ${viewId} → ${where}: ghost=${ghost} highlighted="${highlighted}" now ${views} visible=${wb.isVisible(viewId)} host-in=${document.querySelector(`.view-host[data-view="${viewId}"]`)?.closest(".part")?.className}` });
}

/** AICODE_DIAG: closes and reopens the primary side bar, sampling its width as it animates. */
async function motionSelfTest() {
  const wb = (window as any).aicode?.wb;
  const el = document.querySelector(".part.sidebar") as HTMLElement | null;
  if (!wb || !el || el.style.display === "none") return;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const width = () => `${Math.round(el.getBoundingClientRect().width)}px/${getComputedStyle(el).display}`;
  const out: string[] = [`motion=${document.documentElement.classList.contains("no-motion") ? "off" : "on"}`];
  wb.toggle("sidebar");
  await wait(70);
  out.push(`closing@70ms=${width()}`);
  await wait(400);
  out.push(`closed=${width()}`);
  wb.toggle("sidebar");
  await wait(70);
  out.push(`opening@70ms=${width()}`);
  await wait(400);
  out.push(`open=${width()}`);
  invoke("core_log", { level: "diag", message: `motion test: ${out.join(" ")}` });
}

boot().catch((e) => {
  console.error(e);
  document.body.append(Object.assign(document.createElement("pre"), { textContent: `AICode failed to start:\n${e?.stack ?? e}`, style: "color:#f85149;padding:20px;white-space:pre-wrap" }));
});
