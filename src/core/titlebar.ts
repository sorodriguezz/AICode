// The title bar's own menu bar and window buttons, on Windows and Linux. There the window has no
// frame of the system's (windows.rs), so, as in VS Code, the title bar shows the app's icon, the
// menus' names (File, Edit, View, …) and minimize / maximize / close at its right. A menu's name
// opens a themed dropdown (menu.rs supplies its entries and keeps the native shortcuts).
// macOS uses the system's menu bar and window buttons.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { editor } from "monaco-editor";
import { h, icon, clear } from "./ui";
import * as commands from "./commands";
import { contextMenu, notify, type MenuItem } from "./widgets";

export const OWN_TITLE_BAR = !navigator.platform.toLowerCase().includes("mac");

type MenuRole = "about" | "cut" | "copy" | "paste" | "selectAll" | "minimize" | "fullscreen";
type MenuGroup = { kind: "submenu"; label: string; items: MenuEntry[] };
type MenuEntry =
  | MenuGroup
  | { kind: "command"; id: string; label: string; accelerator: string | null; enabled: boolean }
  | { kind: "check"; id: string; label: string; checked: boolean }
  | { kind: "separator" }
  | { kind: "role"; role: MenuRole };

async function paste() {
  const target = document.activeElement;
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !target || document.activeElement !== target) return;
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    if (target.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true, composed: true }))) {
      document.execCommand("insertText", false, text);
    }
  } catch {
    notify("info", "Use Ctrl+V to paste from the clipboard.");
  }
}

const editorCommands = {
  cut: "editor.action.clipboardCutAction",
  copy: "editor.action.clipboardCopyAction",
  paste: "editor.action.clipboardPasteAction",
  selectAll: "editor.action.selectAll",
};

function edit(action: keyof typeof editorCommands) {
  const focused = editor.getEditors().find((e) => e.hasTextFocus() && e.getModel());
  if (focused) focused.trigger("menu", editorCommands[action], null);
  else if (action === "paste") void paste();
  else document.execCommand(action);
}

const roleItems: Record<MenuRole, MenuItem> = {
  cut: { label: "Cut", keybinding: "mod+x", run: () => edit("cut") },
  copy: { label: "Copy", keybinding: "mod+c", run: () => edit("copy") },
  paste: { label: "Paste", keybinding: "mod+v", run: () => edit("paste") },
  selectAll: { label: "Select All", keybinding: "mod+a", run: () => edit("selectAll") },
  minimize: { label: "Minimize", run: () => getCurrentWindow().minimize() },
  fullscreen: {
    label: "Toggle Full Screen",
    get keybinding() { return commands.keybindingFor("workbench.toggleFullScreen"); },
    run: () => void commands.execute("workbench.toggleFullScreen").catch(console.error),
  },
  about: { label: "About AICode", run: () => void commands.execute("help.about").catch(console.error) },
};

function menuItem(entry: MenuEntry): MenuItem {
  switch (entry.kind) {
    case "submenu": return { label: entry.label, submenu: entry.items.map(menuItem) };
    case "separator": return { label: "", separator: true };
    case "role": return roleItems[entry.role];
    default: return {
      label: entry.label,
      keybinding: entry.kind === "command" ? entry.accelerator?.replace("CmdOrCtrl", "mod") : undefined,
      disabled: entry.kind === "command" && !entry.enabled,
      checked: entry.kind === "check" ? entry.checked : undefined,
      run: () => void invoke("menu_select", { id: entry.id }).catch((e) => console.warn("menu:", e)),
    };
  }
}

/** The app's icon and the menus' names, left of the navigation arrows. */
export function menuBar(): HTMLElement {
  const names = h("div", { class: "menubar-items", role: "menubar" });
  const more = h("button", { class: "menubar-item menubar-more", title: "Application Menu", "aria-label": "Application Menu" }, icon("menu"));
  const bar = h("div", { class: "menubar", dataset: { part: "titleBar.menu" } }, h("div", { class: "menubar-icon", "data-tauri-drag-region": true }, icon("code")), more, names);
  let groups: MenuGroup[] = [];
  let buttons: HTMLButtonElement[] = [];
  let active: { button: HTMLButtonElement; close: () => void; previousFocus: HTMLElement | null } | undefined;

  const show = (button: HTMLButtonElement, index: number, focusFirst: boolean) => {
    const previousFocus = active ? active.previousFocus : document.activeElement as HTMLElement | null;
    active?.close();
    const r = button.getBoundingClientRect();
    const items = index < 0 ? groups : groups[index].items;
    button.classList.add("open");
    button.setAttribute("aria-expanded", "true");
    const { close } = contextMenu(r.left, r.bottom, items.map(menuItem), {
      className: "titlebar-menu",
      keepOpenWithin: index < 0 ? more : names,
      previousFocus,
      focusFirst,
      onNavigate: index < 0 ? undefined : (direction) => {
        const next = (index + direction + buttons.length) % buttons.length;
        show(buttons[next], next, true);
      },
      onClose: () => {
        button.classList.remove("open");
        button.setAttribute("aria-expanded", "false");
        active = undefined;
      },
    });
    active = { button, close, previousFocus };
  };

  const bind = (button: HTMLButtonElement, index: number) => {
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    // The selected editor or input remains the target for Edit commands.
    button.addEventListener("mousedown", (e) => { if (e.button === 0) e.preventDefault(); });
    button.addEventListener("click", (e) => {
      if (!groups.length) return;
      if (active?.button === button) {
        const { close, previousFocus } = active;
        close();
        previousFocus?.focus({ preventScroll: true });
      } else show(button, index, e.detail === 0);
    });
    button.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse" && active && active.button !== button) show(button, index, false);
    });
    button.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" || !groups.length) return;
      e.preventDefault();
      show(button, index, true);
    });
    return button;
  };
  bind(more, -1);

  const render = (items: MenuGroup[]) => {
    const sameLabels = groups.length === items.length && groups.every((group, i) => group.label === items[i].label);
    groups = items;
    if (sameLabels) return;
    active?.close();
    clear(names);
    buttons = groups.map(({ label }, index) => bind(h("button", { class: "menubar-item", role: "menuitem" }, label), index));
    names.append(...buttons);
  };
  let revision = 0;
  getCurrentWebview().listen<MenuGroup[]>("menu-entries", (e) => { revision++; render(e.payload); })
    .catch((e) => console.warn("menu:", e))
    .then(async () => {
      const initialRevision = revision;
      const items = await invoke<MenuGroup[]>("menu_entries");
      if (revision === initialRevision) render(items);
    }).catch((e) => console.warn("menu:", e));
  return bar;
}

/** Minimize, maximize (restore when maximized) and close, at the title bar's right edge. */
export function windowControls(): HTMLElement {
  const win = getCurrentWindow();
  const button = (cls: string, title: string, name: string, onclick: () => void) =>
    h("button", { class: `window-control ${cls}`, title, "aria-label": title, tabindex: "-1", onclick }, icon(name));
  const min = button("minimize", "Minimize", "chrome-minimize", () => win.minimize());
  const max = button("maximize", "Maximize", "chrome-maximize", () => commands.execute("window.toggleMaximize"));
  const close = button("close", "Close", "chrome-close", () => commands.execute("window.close"));
  const sync = async () => {
    const on = await win.isMaximized().catch(() => false);
    max.title = max.ariaLabel = on ? "Restore" : "Maximize";
    max.replaceChildren(icon(on ? "chrome-restore" : "chrome-maximize"));
    document.documentElement.classList.toggle("window-maximized", on);
  };
  sync();
  win.onResized(() => sync()).catch(() => {});
  return h("div", { class: "window-controls", dataset: { part: "titleBar.windowControls" } }, min, max, close);
}
