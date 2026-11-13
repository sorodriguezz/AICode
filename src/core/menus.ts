// Menus mods add items to: every context menu of the window (by id), the editor's own right-click
// menu (Monaco), and the app's menu bar (File, Edit, View, Window, or a menu of their own).
//
// Context menu ids the core and the bundled mods show (each passes a `context` to `when` and `run`):
//   editor/context   right click in the text editor          { path, language, selection }
//   editor/tab       right click on a tab                    the tab's EditorInfo
//   editor/title     the "…" button of the tab bar           the active EditorInfo
//   explorer/context right click in the Explorer             { path, paths, isDir }
//   explorer/title   the Explorer's "…" button               { folder }
//   terminal/context right click in a terminal               { id }
//   activityBar      right click on the activity bar         { viewId? }
//   view/title       right click on a view's title           { viewId }
//   manage           the gear button (status bar)            {}
//   menubar/<Menu>   the app's menu bar: File, Edit, View, Window, or any other name (a new menu)
// A mod can show a menu of its own with `ctx.window.contextMenu(x, y, items, { menu: "<id>" })`, and
// other mods add to it the same way.

import * as monacoNs from "monaco-editor";
import { invoke } from "./ipc";
import * as commands from "./commands";
import { type Disposable, toDisposable } from "./ui";
import type { MenuItem } from "./widgets";

export interface MenuContribution {
  /** Unique within the menu (an item added again with the same id replaces the old one). */
  id?: string;
  label: string | ((context: any) => string);
  icon?: string;
  /** Shown on the right (and, in the menu bar, the shortcut itself: "mod+shift+d"). */
  keybinding?: string;
  /** Run this command (with `args`, or the menu's context) … */
  command?: string;
  args?: unknown[];
  /** … or this. */
  run?: (context: any) => unknown;
  /** Shown only when this is true. */
  when?: (context: any) => boolean;
  checked?: boolean | ((context: any) => boolean);
  disabled?: boolean | ((context: any) => boolean);
  /** Lower comes first. */
  order?: number;
  /** A line above this item. */
  separatorBefore?: boolean;
  /** The mod that added it. */
  owner?: string;
}

const registry = new Map<string, MenuContribution[]>();
const listeners = new Set<(menu: string) => void>();

const val = <T>(v: T | ((c: any) => T) | undefined, context: any): T | undefined => (typeof v === "function" ? (v as (c: any) => T)(context) : v);

export function addMenuItem(menu: string, item: MenuContribution): Disposable {
  const list = registry.get(menu) ?? [];
  const i = item.id ? list.findIndex((x) => x.id === item.id && x.owner === item.owner) : -1;
  if (i >= 0) list.splice(i, 1, item);
  else list.push(item);
  registry.set(menu, list);
  for (const fn of listeners) fn(menu);
  return toDisposable(() => {
    const now = registry.get(menu);
    const at = now?.indexOf(item) ?? -1;
    if (now && at >= 0) now.splice(at, 1);
    for (const fn of listeners) fn(menu);
  });
}

export function menuContributions(menu: string): MenuContribution[] {
  return [...(registry.get(menu) ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

const runItem = (item: MenuContribution, context: any) => {
  if (item.run) return item.run(context);
  if (item.command) return commands.execute(item.command, ...(item.args ?? (context === undefined ? [] : [context])));
};

/** The mods' items for a context menu, ready to append (a separator first when there are any). */
export function menuItems(menu: string, context: any): MenuItem[] {
  const out: MenuItem[] = [];
  for (const item of menuContributions(menu)) {
    try {
      if (item.when && !item.when(context)) continue;
      if (item.separatorBefore && out.length) out.push({ separator: true, label: "" });
      out.push({
        label: String(val(item.label, context) ?? ""),
        icon: item.icon,
        keybinding: item.keybinding ?? (item.command ? commands.keybindingFor(item.command) ?? undefined : undefined),
        checked: !!val(item.checked, context),
        disabled: !!val(item.disabled, context),
        run: () => void Promise.resolve(runItem(item, context)).catch((e) => console.error(`[menu ${menu}]`, e)),
      });
    } catch (e) {
      console.warn(`[menu ${menu}] item from ${item.owner ?? "?"}`, e);
    }
  }
  return out.length ? [{ separator: true, label: "" }, ...out] : [];
}

// ---------- the text editor's right-click menu ----------
//
// The editor shows AICode's own menu (Monaco's is turned off with `contextmenu: false`), built only
// from Monaco's public API: its actions by id (`getAction(id)`, `isSupported()`, `run()`). So mods'
// items filter with `when` like in every other menu, and nothing depends on how Monaco builds its menu.

/** Monaco's items, as VS Code shows them. Each appears only when Monaco has it and it applies here
 *  (`isSupported()`: a definition provider exists, the editor is writable…). */
const EDITOR_ITEMS: ({ action: string; label: string; key?: string; withSelection?: boolean } | { command: string; label: string; key?: string } | null)[] = [
  { action: "editor.action.revealDefinition", label: "Go to Definition", key: "f12" },
  { action: "editor.action.goToTypeDefinition", label: "Go to Type Definition" },
  { action: "editor.action.goToImplementation", label: "Go to Implementations", key: "mod+f12" },
  { action: "editor.action.goToReferences", label: "Go to References", key: "shift+f12" },
  null,
  { action: "editor.action.quickOutline", label: "Go to Symbol…", key: "shift+mod+o" },
  { action: "editor.action.rename", label: "Rename Symbol", key: "f2" },
  { action: "editor.action.changeAll", label: "Change All Occurrences", key: "mod+f2" },
  { action: "editor.action.formatDocument", label: "Format Document", key: "shift+alt+f" },
  { action: "editor.action.formatSelection", label: "Format Selection", withSelection: true },
  { action: "editor.action.refactor", label: "Refactor…", key: "ctrl+shift+r" },
  { action: "editor.action.sourceAction", label: "Source Action…" },
  null,
  { action: "editor.action.clipboardCutAction", label: "Cut", key: "mod+x" },
  { action: "editor.action.clipboardCopyAction", label: "Copy", key: "mod+c" },
  { action: "editor.action.clipboardPasteAction", label: "Paste", key: "mod+v" },
  null,
  { command: "workbench.commandPalette", label: "Command Palette", key: "mod+shift+p" },
];

/**
 * Right click in `editor` shows AICode's menu: Monaco's items, then actions anyone added with
 * `addAction({ contextMenuGroupId })` (mods using Monaco directly, declarative `editorContextMenu`),
 * then the `editor/context` items. `show` is the window's contextMenu (passed in: no import cycle).
 */
export function bindEditorContextMenu(
  editor: monacoNs.editor.IStandaloneCodeEditor,
  contextOf: () => any,
  show: (x: number, y: number, items: MenuItem[]) => void,
) {
  editor.updateOptions({ contextmenu: false });
  // Actions added for the context menu, kept in the order Monaco would group them.
  const added: { desc: monacoNs.editor.IActionDescriptor; seq: number }[] = [];
  let seq = 0;
  const addAction = editor.addAction.bind(editor);
  editor.addAction = (desc: monacoNs.editor.IActionDescriptor) => {
    const d = addAction(desc);
    if (!desc.contextMenuGroupId) return d;
    const rec = { desc, seq: seq++ };
    added.push(rec);
    return {
      dispose: () => {
        const i = added.indexOf(rec);
        if (i >= 0) added.splice(i, 1);
        d.dispose();
      },
    };
  };

  const build = (): MenuItem[] => {
    const items: MenuItem[] = [];
    const sep = () => items.length && !items[items.length - 1].separator && items.push({ separator: true, label: "" });
    const sel = editor.getSelection();
    const hasSelection = !!sel && !sel.isEmpty();
    for (const it of EDITOR_ITEMS) {
      if (!it) {
        sep();
        continue;
      }
      if ("command" in it) {
        if (commands.has(it.command)) items.push({ label: it.label, keybinding: commands.keybindingFor(it.command) ?? it.key, run: () => void commands.execute(it.command) });
        continue;
      }
      if (it.withSelection && !hasSelection) continue;
      const action = editor.getAction(it.action);
      if (!action?.isSupported()) continue;
      items.push({ label: it.label, keybinding: it.key, run: () => void action.run().catch((e) => console.error(it.action, e)) });
    }
    const extra = [...added].sort((a, b) => (a.desc.contextMenuGroupId ?? "").localeCompare(b.desc.contextMenuGroupId ?? "") || (a.desc.contextMenuOrder ?? 0) - (b.desc.contextMenuOrder ?? 0) || a.seq - b.seq);
    let group: string | undefined;
    for (const { desc } of extra) {
      const action = editor.getAction(desc.id);
      if (!action?.isSupported()) continue;
      if (group !== desc.contextMenuGroupId) {
        sep();
        group = desc.contextMenuGroupId;
      }
      items.push({ label: desc.label, run: () => void action.run().catch((e) => console.error(desc.id, e)) });
    }
    while (items.length && items[items.length - 1].separator) items.pop();
    return [...items, ...menuItems("editor/context", contextOf())];
  };

  editor.onContextMenu((e) => {
    // Monaco has already focused the editor and moved the cursor to the click (outside a selection).
    // Only on the text itself: the find widget's field, the scrollbars and so on keep their own behavior.
    const T = monacoNs.editor.MouseTargetType;
    const t = e.target.type;
    if (t !== T.TEXTAREA && t !== T.CONTENT_TEXT && t !== T.CONTENT_EMPTY) return;
    e.event.preventDefault();
    e.event.stopPropagation();
    const be = e.event.browserEvent;
    show(be.clientX, be.clientY, build());
  });
}

// ---------- the app's menu bar ----------

/** Keys a menu bar shortcut can use (what Tauri's menus accept), by AICode's key names. */
const MENU_KEYS: Record<string, string> = {
  enter: "Enter", return: "Enter", tab: "Tab", space: "Space", backspace: "Backspace", delete: "Delete", escape: "Escape", esc: "Escape",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", insert: "Insert",
  up: "Up", down: "Down", left: "Left", right: "Right", arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right",
  "`": "`", "\\": "\\", "[": "[", "]": "]", ",": ",", "=": "=", "-": "-", ".": ".", "'": "'", ";": ";", "/": "/",
};
const MENU_MODS: Record<string, string> = { mod: "CmdOrCtrl", cmd: "Cmd", meta: "Cmd", command: "Cmd", ctrl: "Ctrl", control: "Ctrl", alt: "Alt", option: "Alt", shift: "Shift" };

/** "mod+shift+d" → "CmdOrCtrl+Shift+D", or why the menu bar cannot use it. */
export function menuAccelerator(key: string): { accelerator: string } | { problem: string } {
  const k = key.trim().toLowerCase();
  if (/\s/.test(k)) return { problem: "it is a chord (two keystrokes), which a menu bar shortcut cannot be" };
  // "mod++" is mod and the + key.
  const plusKey = k === "+" || k.endsWith("++");
  const body = plusKey ? k.slice(0, k === "+" ? 0 : -2) : k;
  const parts = body ? body.split("+") : [];
  if (plusKey) return { problem: 'the menu bar has no + key: use "=" (mod+= is how ⌘+ is usually bound)' };
  const last = parts.pop() ?? "";
  const mods: string[] = [];
  for (const p of parts) {
    const m = MENU_MODS[p];
    if (!m) return { problem: `"${p}" is not a modifier (use mod, cmd, ctrl, alt or shift)` };
    if (!mods.includes(m)) mods.push(m);
  }
  let keyName: string | undefined;
  if (/^[a-z0-9]$/.test(last)) keyName = last.toUpperCase();
  else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(last)) keyName = last.toUpperCase();
  else keyName = MENU_KEYS[last];
  if (!keyName) return { problem: `"${last}" is not a key the menu bar knows` };
  if (!mods.length && /^[A-Z0-9]$/.test(keyName)) return { problem: "a letter or digit without a modifier would fire while typing" };
  return { accelerator: [...mods, keyName].join("+") };
}

const warned = new Set<string>();
/** Tells the mod's author once per session (the console, and a note naming the mod). */
function warnShortcut(item: MenuContribution, key: string, problem: string) {
  const id = `${item.owner}:${key}`;
  if (warned.has(id)) return;
  warned.add(id);
  const label = String(val(item.label, undefined) ?? item.command ?? "");
  console.warn(`[${item.owner ?? "mod"}] menu bar item "${label}": the shortcut ${key} cannot go in the menu bar (${problem}). It is shown in the item's name and still works from the keyboard.`);
}

let menubarTimer: number | undefined;
function syncMenuBar() {
  clearTimeout(menubarTimer);
  menubarTimer = window.setTimeout(() => {
    const items: { menu: string; command: string; label: string; accelerator?: string; separatorBefore: boolean }[] = [];
    for (const [menu, list] of registry) {
      if (!menu.startsWith("menubar/")) continue;
      for (const item of [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
        const command = item.command;
        if (!command) continue;
        let label = String(val(item.label, undefined) ?? command);
        const key = item.keybinding ?? commands.keybindingFor(command);
        let accel: string | undefined;
        if (key) {
          const r = menuAccelerator(key);
          if ("accelerator" in r) accel = r.accelerator;
          else {
            // As the core's own items do ("Close Folder [⌘K F]"): the shortcut in the name.
            label = `${label} [${commands.prettyKey(key).join(" ")}]`;
            warnShortcut(item, key, r.problem);
          }
        }
        items.push({ menu: menu.slice("menubar/".length), command, label, accelerator: accel, separatorBefore: !!item.separatorBefore });
      }
    }
    invoke("menu_set_extra", { items }).catch((e) => console.warn("menu bar", e));
  }, 50);
}
listeners.add((menu) => menu.startsWith("menubar/") && syncMenuBar());

/**
 * What a menu bar item needs besides its place: the menu runs commands by id, so a `run` gets a
 * command of its own; and its shortcut is bound in the window too, so it works from the keyboard
 * even when the menu bar cannot show it (a chord). Undone with the item.
 */
export function prepareMenuBarItem(item: MenuContribution): { item: MenuContribution; dispose(): void } {
  const undo: Disposable[] = [];
  let out = item;
  if (!item.command && item.run) {
    const command = `mods.menubar.${item.owner ?? "mod"}.${item.id ?? String(val(item.label, undefined)).replace(/\W+/g, "-")}`;
    undo.push(commands.register(command, () => item.run!(undefined), { owner: item.owner ?? "core", title: String(val(item.label, undefined)) }));
    out = { ...item, command };
  }
  if (out.keybinding && out.command && commands.keybindingFor(out.command) !== out.keybinding) {
    undo.push(commands.bind(out.keybinding, out.command, item.owner ?? "core"));
  }
  return { item: out, dispose: () => undo.forEach((d) => d.dispose()) };
}
