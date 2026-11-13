// The title bar's own menu bar and window buttons, on Windows and Linux. There the window has no
// frame of the system's (windows.rs), so, as in VS Code, the title bar shows the app's icon, the
// menus' names (File, Edit, View, …) and minimize / maximize / close at its right. A menu's name
// opens that same native menu (menu.rs keeps it on the window, hidden, for its shortcuts).
// On macOS none of this is made: the system draws the menu bar and the window buttons.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { h, icon, clear } from "./ui";
import * as commands from "./commands";

export const OWN_TITLE_BAR = !navigator.platform.toLowerCase().includes("mac");

/** Opens a menu (all of them without a title) under `anchor`. */
function popup(anchor: HTMLElement, title?: string) {
  const r = anchor.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  anchor.classList.add("open");
  invoke("menu_popup", { title: title ?? null, x: Math.round(r.left * scale), y: Math.round(r.bottom * scale) })
    .catch((e) => console.warn("menu:", e))
    .finally(() => anchor.classList.remove("open"));
}

/** The app's icon and the menus' names, left of the navigation arrows. */
export function menuBar(): HTMLElement {
  const names = h("div", { class: "menubar-items", role: "menubar" });
  const more = h("button", { class: "menubar-item menubar-more", title: "Application Menu", "aria-label": "Application Menu", onclick: () => popup(more) }, icon("menu"));
  const bar = h("div", { class: "menubar", dataset: { part: "titleBar.menu" } }, h("div", { class: "menubar-icon", "data-tauri-drag-region": true }, icon("code")), more, names);
  const render = (titles: string[]) => {
    clear(names);
    for (const title of titles) {
      const b: HTMLButtonElement = h("button", { class: "menubar-item", role: "menuitem", onclick: () => popup(b, title) }, title);
      names.append(b);
    }
  };
  invoke<string[]>("menu_titles").then(render).catch(() => {});
  listen<string[]>("menu-titles", (e) => render(e.payload)).catch(() => {});
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
