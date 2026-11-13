// Motion: whether to animate, and small helpers for the animations that need JavaScript (sizes,
// leaving elements). Everything else is CSS in styles.css, switched off by `html.no-motion`.
//
// Animations only run in response to something the user did — nothing loops at idle — and they
// are off when macOS "Reduce motion" is on, or when the user turns them off.

import { Emitter } from "./events";

const reduce = matchMedia("(prefers-reduced-motion: reduce)");
let enabled = true;
/** Fires with motionEnabled() when it changes (the setting, or macOS "Reduce motion"). */
export const onDidChangeMotion = new Emitter<boolean>();
let last: boolean | null = null;

export function motionEnabled(): boolean {
  return enabled && !reduce.matches;
}

export function setMotion(on: boolean) {
  enabled = on;
  document.documentElement.classList.toggle("no-motion", !motionEnabled());
  if (last !== motionEnabled()) {
    last = motionEnabled();
    onDidChangeMotion.fire(last);
  }
}

reduce.addEventListener("change", () => setMotion(enabled));

/** Plays a CSS animation class once (restarting it if it is already on). */
export function play(el: Element, cls: string) {
  if (!motionEnabled()) return;
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
  el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
}

/** Adds a leaving class, waits for its animation (or a timeout), then resolves. */
export function leave(el: Element, cls: string, maxMs = 260): Promise<void> {
  if (!motionEnabled() || !el.isConnected) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    el.classList.add(cls);
    el.addEventListener("animationend", finish, { once: true });
    el.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, maxMs);
  });
}

/**
 * FLIP: moves elements to where they are after `mutate()` by animating from where they were. Give
 * it the elements (or a container: its children, and the ones that replace them, matched by `key`).
 * Elements a re-render replaced are matched to the old ones by `key(el)` (default: data-flip-key,
 * data-doc, data-view, data-before, data-id).
 */
export async function flip(
  target: Element | Element[] | (() => Element[]),
  mutate: () => void | Promise<void>,
  opts: { duration?: number; easing?: string; key?: (el: Element) => string | undefined } = {},
): Promise<void> {
  const key = opts.key ?? ((el: Element) => {
    const d = (el as HTMLElement).dataset ?? {};
    return d.flipKey ?? d.doc ?? d.view ?? d.before ?? d.id;
  });
  const list = () => (typeof target === "function" ? target() : Array.isArray(target) ? target : Array.from(target.children));
  const before = new Map<string, DOMRect>();
  for (const el of list()) {
    const k = key(el);
    if (k) before.set(k, el.getBoundingClientRect());
  }
  await mutate();
  if (!motionEnabled()) return;
  const animations: Animation[] = [];
  for (const el of list()) {
    const k = key(el);
    const from = k ? before.get(k) : undefined;
    if (!from) continue;
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (!dx && !dy) continue;
    animations.push(
      (el as HTMLElement).animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: opts.duration ?? 180,
        easing: opts.easing ?? "cubic-bezier(.2, .8, .2, 1)",
      }),
    );
  }
  await Promise.all(animations.map((a) => a.finished.catch(() => {})));
}
