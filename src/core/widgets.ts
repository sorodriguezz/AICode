// Notifications, dialogs, the quick input (command palette / pickers / input boxes) and context
// menus — the workbench's small widgets, also offered to mods through `ctx.window`.

import { h, icon, clear } from "./ui";
import { prettyKey, keyCaps } from "./commands";
import { leave } from "./motion";
import { fileIconEl } from "./fileIcons";

// ---------- notifications ----------

type Severity = "info" | "warning" | "error";

let toastHost: HTMLElement | null = null;

export function notify(severity: Severity, message: string, actions: { label: string; run: () => void }[] = [], timeoutMs?: number): () => void {
  if (!toastHost) {
    toastHost = h("div", { class: "toasts" });
    document.body.append(toastHost);
  }
  const close = () => {
    if (toast.classList.contains("leaving")) return;
    leave(toast, "leaving", 240).then(() => toast.remove());
  };
  const toast = h(
    "div",
    { class: "toast", role: severity === "error" ? "alert" : "status" },
    icon(severity),
    h(
      "div",
      { class: "msg" },
      message,
      actions.length
        ? h("div", { class: "toast-actions" }, actions.map((a, i) => h("button", { class: i === 0 ? "btn" : "btn secondary", onclick: () => { close(); a.run(); } }, a.label)))
        : null,
    ),
    h("button", { class: "icon-button", title: "Close", onclick: close }, icon("close")),
  );
  toastHost.append(toast);
  const ms = timeoutMs ?? (severity === "error" || actions.length ? 0 : 5000);
  if (ms > 0) setTimeout(close, ms);
  return close;
}

// ---------- dialogs ----------

export interface DialogButton<T> {
  label: string;
  value: T;
  primary?: boolean;
}

export function dialog<T>(opts: { title: string; message?: string; kind?: "info" | "warning"; buttons: DialogButton<T>[]; cancelValue: T }): Promise<T> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const done = (value: T) => {
      backdrop.style.pointerEvents = "none";
      leave(backdrop, "leaving", 140).then(() => backdrop.remove());
      document.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(opts.cancelValue);
      }
    };
    const buttons = opts.buttons.map((b) => h("button", { class: b.primary ? "btn" : "btn secondary", onclick: () => done(b.value) }, b.label));
    const backdrop = h(
      "div",
      { class: "dialog-backdrop", onmousedown: (e: MouseEvent) => e.target === backdrop && done(opts.cancelValue) },
      h(
        "div",
        { class: "dialog", role: "dialog", "aria-modal": "true" },
        icon(opts.kind === "warning" ? "warning" : "info", `dialog-icon ${opts.kind ?? ""}`),
        h("div", { style: { flex: "1" } }, h("h3", null, opts.title), opts.message ? h("p", null, opts.message) : null, h("div", { class: "buttons" }, buttons)),
      ),
    );
    document.body.append(backdrop);
    document.addEventListener("keydown", onKey, true);
    (buttons.find((_, i) => opts.buttons[i].primary) ?? buttons[0])?.focus();
  });
}

export async function confirm(message: string, detail?: string, primary = "OK"): Promise<boolean> {
  return dialog({ title: message, message: detail, buttons: [{ label: "Cancel", value: false }, { label: primary, value: true, primary: true }], cancelValue: false });
}

// ---------- quick input ----------

export interface QuickItem {
  label: string;
  description?: string;
  detail?: string;
  icon?: string;
  /** A file name: shows that file's icon (from the icon theme) instead of `icon`. */
  fileIcon?: string;
  keybinding?: string;
  separator?: boolean;
  [key: string]: unknown;
}

interface QuickOptions<T extends QuickItem> {
  placeholder?: string;
  value?: string;
  /** Called on every keystroke; return the items to show (sync or async). */
  items: (query: string) => T[] | Promise<T[]>;
  /** Called when the text changes into a prefix another provider owns (e.g. ">" for commands). */
  onValue?: (value: string) => boolean;
  prompt?: string;
  allowFreeText?: boolean;
  noMatch?: string;
  /** The row that starts active (when the items first show, and while the query is empty). */
  activeIndex?: number;
  /** Called when the keyboard moves the active row, or a new query changes it (a live preview). */
  onActive?: (item: T) => void;
}

let activeQuick: { close: () => void } | null = null;

export function fuzzyScore(query: string, text: string): { score: number; ranges: [number, number][] } | null {
  if (!query) return { score: 0, ranges: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return { score: 1000 - direct - t.length * 0.01 + (direct === 0 ? 200 : 0), ranges: [[direct, direct + q.length]] };
  let ti = 0;
  const ranges: [number, number][] = [];
  let score = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    if (ranges.length && ranges[ranges.length - 1][1] === found) ranges[ranges.length - 1][1]++;
    else ranges.push([found, found + 1]);
    score += found === ti ? 5 : found > 0 && /[\s/._-]/.test(t[found - 1]) ? 4 : 1;
    ti = found + 1;
  }
  return { score: score - t.length * 0.01, ranges };
}

export function highlight(text: string, ranges: [number, number][]): (Node | string)[] {
  const out: (Node | string)[] = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a > at) out.push(text.slice(at, a));
    out.push(h("mark", null, text.slice(a, b)));
    at = b;
  }
  out.push(text.slice(at));
  return out;
}

export function quickInput<T extends QuickItem>(opts: QuickOptions<T>): Promise<T | string | undefined> {
  activeQuick?.close();
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    let items: T[] = [];
    let index = 0;
    let finished = false;
    let generation = 0;
    let firstLoad = true;
    let announced: T | undefined;
    const announce = () => {
      const item = items[index];
      if (item && item !== announced && !item.separator) {
        announced = item;
        opts.onActive?.(item);
      }
    };

    const finish = (value: T | string | undefined, restoreFocus = true) => {
      if (finished) return;
      finished = true;
      overlay.style.pointerEvents = "none";
      // The next picker may open right away (› commands, then a file): let this one fade on its own.
      leave(box, "leaving", 120).then(() => overlay.remove());
      activeQuick = null;
      if (restoreFocus) previous?.focus?.();
      resolve(value);
    };

    const input = h("input", { class: "input", placeholder: opts.placeholder ?? "", spellcheck: false, autocomplete: "off" }) as HTMLInputElement;
    input.value = opts.value ?? "";
    const list = h("div", { class: "quick-list", role: "listbox" });
    const promptEl = opts.prompt ? h("div", { class: "prompt muted" }, opts.prompt) : null;
    const box = h("div", { class: "quick-input" }, input, promptEl, list);
    const overlay = h("div", { class: "overlay", onmousedown: (e: MouseEvent) => e.target === overlay && finish(undefined) }, box);

    let firstPaint = true;
    const render = () => {
      clear(list);
      list.classList.toggle("refresh", firstPaint && items.length > 0);
      if (items.length) firstPaint = false;
      if (!items.length) {
        if (opts.noMatch) list.append(h("div", { class: "quick-empty" }, opts.noMatch));
        return;
      }
      items.forEach((item, i) => {
        const row = h(
          "div",
          {
            class: `quick-item${i === index ? " active" : ""}${item.separator && i > 0 ? " separator-top" : ""}`,
            role: "option",
            onmousemove: () => {
              if (index !== i) {
                index = i;
                render();
              }
            },
            onclick: () => finish(item),
          },
          item.fileIcon ? fileIconEl(item.fileIcon as string) : item.icon ? icon(item.icon) : null,
          h("span", { class: "label" }, ...((item as any)._label ?? [item.label])),
          item.description ? h("span", { class: "description" }, item.description) : h("span", { class: "description" }),
          item.keybinding ? h("span", { class: "keys" }, keyCaps(item.keybinding).map((k) => h("kbd", null, k))) : null,
        );
        if (list.classList.contains("refresh")) row.style.animationDelay = `${Math.min(i, 10) * 12}ms`;
        list.append(row);
      });
      (list.children[index] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
    };

    const refresh = async () => {
      const gen = ++generation;
      const result = await opts.items(input.value);
      if (gen !== generation || finished) return;
      items = result;
      const start = opts.activeIndex ?? 0;
      index = (firstLoad || !input.value) && start < items.length ? start : 0;
      firstLoad = false;
      render();
      announce();
    };

    input.addEventListener("input", () => {
      if (opts.onValue && opts.onValue(input.value)) {
        finish(undefined, false);
        return;
      }
      refresh();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (items.length) index = (index + 1) % items.length;
        render();
        announce();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (items.length) index = (index - 1 + items.length) % items.length;
        render();
        announce();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (items[index]) finish(items[index]);
        else if (opts.allowFreeText) finish(input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(undefined);
      }
    });

    document.body.append(overlay);
    activeQuick = { close: () => finish(undefined, false) };
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    refresh();
  });
}

/** A picker over a fixed list, filtered as the user types. */
export async function pick<T extends QuickItem>(items: T[], opts: { placeholder?: string; matchDescription?: boolean; activeIndex?: number; onActive?: (item: T) => void } = {}): Promise<T | undefined> {
  // Rows carry a highlighted copy of the label: hand onActive the caller's own item.
  const original = (row: T) => items.find((i) => i.label === row.label && i.description === row.description) ?? row;
  const result = await quickInput<T>({
    placeholder: opts.placeholder,
    activeIndex: opts.activeIndex,
    onActive: opts.onActive && ((row) => opts.onActive!(original(row))),
    noMatch: "No matching results",
    items: (q) => {
      if (!q) return items.map((i) => ({ ...i, _label: [i.label] }));
      return items
        .map((i) => {
          const m = fuzzyScore(q, i.label) ?? (opts.matchDescription && i.description ? fuzzyScore(q, i.description) && { score: -1, ranges: [] } : null);
          return m ? { item: { ...i, _label: highlight(i.label, m.ranges) }, score: m.score } : null;
        })
        .filter((x): x is { item: T & { _label: (Node | string)[] }; score: number } => !!x)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.item);
    },
  });
  if (typeof result === "string" || !result) return undefined;
  const { _label, ...rest } = result as any;
  void _label;
  return rest as T;
}

export async function inputBox(opts: { prompt?: string; placeholder?: string; value?: string; validate?: (v: string) => string | null }): Promise<string | undefined> {
  for (;;) {
    const result = await quickInput<QuickItem>({ placeholder: opts.placeholder, prompt: opts.prompt ?? "Press Enter to confirm or Escape to cancel", value: opts.value, items: () => [], allowFreeText: true });
    if (typeof result !== "string") return undefined;
    const problem = opts.validate?.(result);
    if (!problem) return result;
    notify("warning", problem);
    opts = { ...opts, value: result };
  }
}

// ---------- context menu ----------

export interface MenuItem {
  label: string;
  run?: () => void;
  keybinding?: string;
  separator?: boolean;
  disabled?: boolean;
  checked?: boolean;
  icon?: string;
}

/** `above`: y is where the menu's bottom goes (menus opened from the status bar grow upward). */
export function contextMenu(x: number, y: number, items: MenuItem[], opts: { above?: boolean } = {}) {
  document.querySelector(".context-menu")?.remove();
  // No separator first, last or twice in a row (items that were left out leave gaps).
  const shown = items.filter((i, n, all) => !i.separator || (n > 0 && n < all.length - 1 && !all[n - 1].separator));
  while (shown.length && shown[shown.length - 1].separator) shown.pop();
  const anyCheck = shown.some((i) => i.checked !== undefined || i.icon);
  const rows: HTMLElement[] = [];
  const menu = h(
    "div",
    { class: "context-menu", role: "menu", tabindex: "-1" },
    shown.map((i) => {
      if (i.separator) return h("div", { class: "sep" });
      const row = h(
        "div",
        { class: `item${i.disabled ? " disabled" : ""}`, role: "menuitem", "aria-disabled": i.disabled ? "true" : null, onclick: () => { if (i.disabled) return; close(); i.run?.(); }, onmouseenter: () => focusRow(rows.indexOf(row)) },
        anyCheck ? h("span", { class: "check" }, i.checked ? icon("check") : i.icon ? icon(i.icon) : null) : null,
        h("span", { class: "label" }, i.label),
        i.keybinding ? h("span", { class: "muted" }, prettyKey(i.keybinding).join(" ")) : null,
      );
      rows.push(row);
      return row;
    }),
  );
  let focused = -1;
  const focusRow = (n: number) => {
    rows[focused]?.classList.remove("active");
    focused = n;
    rows[focused]?.classList.add("active");
  };
  const step = (dir: number) => {
    for (let k = 1; k <= rows.length; k++) {
      const n = (focused + dir * k + rows.length * 2) % rows.length;
      if (!rows[n].classList.contains("disabled")) return focusRow(n);
    }
  };
  const previousFocus = document.activeElement as HTMLElement | null;
  menu.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") step(1);
    else if (e.key === "ArrowUp") step(-1);
    else if (e.key === "Enter" || e.key === " ") rows[focused]?.click();
    else if (e.key === "Escape" || e.key === "Tab") { close(); previousFocus?.focus(); }
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  const close = () => {
    menu.remove();
    window.removeEventListener("mousedown", outside, true);
    window.removeEventListener("blur", close);
  };
  const outside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
  const top = opts.above ? y - rect.height : y;
  menu.style.top = `${Math.max(4, Math.min(top, window.innerHeight - rect.height - 4))}px`;
  if (opts.above) menu.style.transformOrigin = "bottom left";
  menu.focus({ preventScroll: true });
  setTimeout(() => {
    window.addEventListener("mousedown", outside, true);
    window.addEventListener("blur", close);
  });
  return { close };
}
