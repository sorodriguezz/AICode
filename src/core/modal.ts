// The modal editor: a page (Settings, Mods, Keyboard Shortcuts…) shown over the workbench instead of
// in a tab, the way VS Code opens them (`workbench.editor.useModal`). 80% of the window, at most
// 1400×900, centered and fixed in place (it can't be dragged); its edges resize it, and it can be
// maximized or moved into a regular tab. Escape or a click outside closes it.

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

const MIN_W = 400;
const MIN_H = 300;
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
  const edges = (["n", "s", "e", "w"] as const).map((side) => h("div", { class: `modal-editor-sash ${side}`, dataset: { side } }));
  const part = h("div", { class: "modal-editor", role: "dialog", "aria-modal": "true", "aria-labelledby": "modal-editor-title", tabindex: "-1" }, header, content, edges);
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
  const clamp = () => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    box.width = Math.max(MIN_W, Math.min(box.width, W));
    box.height = Math.max(MIN_H, Math.min(box.height, H));
    box.left = Math.max(0, Math.min(box.left, W - box.width));
    box.top = Math.max(0, Math.min(box.top, H - box.height));
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

  const drag = (e: PointerEvent, move: (dx: number, dy: number, start: typeof box) => void) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = { ...box };
    const x0 = e.clientX;
    const y0 = e.clientY;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      move(ev.clientX - x0, ev.clientY - y0, start);
      clamp();
      paint();
    };
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  };
  header.addEventListener("dblclick", (e) => {
    if (!(e.target as HTMLElement).closest("button")) setMaximized(!maximized);
  });
  for (const edge of edges) {
    const side = edge.dataset.side!;
    edge.addEventListener("pointerdown", (e) => {
      if (maximized) return;
      drag(e, (dx, dy, s) => {
        if (side === "e") box.width = Math.max(MIN_W, s.width + dx);
        if (side === "s") box.height = Math.max(MIN_H, s.height + dy);
        if (side === "w") {
          const w = Math.max(MIN_W, s.width - dx);
          box.left = s.left + s.width - w;
          box.width = w;
        }
        if (side === "n") {
          const hh = Math.max(MIN_H, s.height - dy);
          box.top = s.top + s.height - hh;
          box.height = hh;
        }
      });
    });
  }
  const onResize = () => {
    clamp();
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
