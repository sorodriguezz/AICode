// The modal editor: a page (Settings, Mods, Keyboard Shortcuts…) shown over the workbench instead of
// in a tab, the way VS Code opens them (`workbench.editor.useModal`). 80% of the window, at most
// 1400×900, centered and fitted to the app window (it can't be dragged or resized by its edges).
// It can be maximized or moved into a regular tab. Escape or a click outside closes it.

import { h, icon, Disposable } from "./ui";

export interface ModalAction {
  icon: string;
  title: string;
  run: () => void;
}

export interface ModalSpec {
  title: string;
  icon?: string;
  render(container: HTMLElement): void | Disposable;
  /** The page's own actions, left of the modal's (e.g. "Open Settings (JSON)"). */
  actions?: ModalAction[];
  /** Shown as "Open in Main Window": closes the modal and opens the page as a tab. */
  moveToMain?: () => void;
  onClose?: () => void;
}

let current: { close: () => void; title: string } | null = null;

export function closeModal(): boolean {
  if (!current) return false;
  current.close();
  return true;
}

export function modalOpen(): string | null {
  return current?.title ?? null;
}

export function openModal(spec: ModalSpec) {
  current?.close();
  const previousFocus = document.activeElement as HTMLElement | null;
  const content = h("div", { class: "modal-editor-content" });
  const actionButton = (a: ModalAction) => h("button", { class: "icon-button", title: a.title, onclick: () => a.run() }, icon(a.icon));
  let maximized = false;
  const maxButton = actionButton({ icon: "screen-full", title: "Maximize Modal Editor", run: () => setMaximized(!maximized) });
  const own = spec.actions ?? [];
  const header = h(
    "div",
    { class: "modal-editor-header" },
    h("div", { class: "modal-editor-title", id: "modal-editor-title" }, spec.icon ? icon(spec.icon) : null, h("span", null, spec.title)),
    h(
      "div",
      { class: "modal-editor-actions" },
      own.map(actionButton),
      own.length ? h("span", { class: "modal-editor-action-separator" }) : null,
      spec.moveToMain ? actionButton({ icon: "window", title: "Open Modal Editor in Main Window", run: () => { close(); spec.moveToMain!(); } }) : null,
      maxButton,
      actionButton({ icon: "close", title: "Close Modal Editor (Escape)", run: () => close() }),
    ),
  );
  const part = h("div", { class: "modal-editor", role: "dialog", "aria-modal": "true", "aria-labelledby": "modal-editor-title", tabindex: "-1" }, header, content);
  const block = h("div", { class: "modal-editor-block" }, part);

  // ---------- size and position ----------
  let box = { left: 0, top: 0, width: 0, height: 0 };
  const fit = () => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const width = Math.round(Math.min(W * 0.8, 1400, W));
    const height = Math.round(Math.min(H * 0.8, 900, H));
    box = { width, height, left: Math.round((W - width) / 2), top: Math.round((H - height) / 2) };
  };
  const paint = () => {
    const b = maximized ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight } : box;
    Object.assign(part.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
    part.classList.toggle("maximized", maximized);
  };
  const setMaximized = (on: boolean) => {
    maximized = on;
    maxButton.title = on ? "Restore Modal Editor" : "Maximize Modal Editor";
    maxButton.replaceChildren(icon(on ? "screen-normal" : "screen-full"));
    paint();
  };
  fit();
  paint();

  header.addEventListener("dblclick", (e) => {
    if (!(e.target as HTMLElement).closest("button")) setMaximized(!maximized);
  });
  const onResize = () => {
    fit();
    paint();
  };
  window.addEventListener("resize", onResize);

  // ---------- closing ----------
  block.addEventListener("mousedown", (e) => {
    if (e.target === block) close();
  });
  const onKey = (e: KeyboardEvent) => {
    // A menu or picker opened from the page closes first.
    if (e.key !== "Escape" || document.querySelector(".context-menu, .quick-input, .dialog-backdrop")) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  window.addEventListener("keydown", onKey, true);

  let disposable: void | Disposable;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (current?.close === close) current = null;
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onResize);
    try {
      disposable?.dispose();
    } catch (e) {
      console.error(e);
    }
    block.remove();
    spec.onClose?.();
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  current = { close, title: spec.title };

  document.body.append(block);
  try {
    disposable = spec.render(content);
  } catch (e) {
    content.append(h("div", { class: "notice" }, String(e)));
  }
  // Focus the page's first field (Settings' search), or the dialog itself.
  const focusFirst = () => {
    const first = content.querySelector<HTMLElement>("input:not([type=checkbox]), textarea");
    if (first) first.focus();
    return !!first;
  };
  if (!focusFirst()) {
    part.focus();
    // Pages that load first (Settings, Mods) draw their fields a moment later.
    for (const ms of [60, 200, 500]) setTimeout(() => !closed && document.activeElement === part && focusFirst(), ms);
  }
}
