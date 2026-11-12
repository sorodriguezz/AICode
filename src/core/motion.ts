// Motion: whether to animate, and small helpers for the animations that need JavaScript (sizes,
// leaving elements). Everything else is CSS in styles.css, switched off by `html.no-motion`.
//
// Animations only run in response to something the user did — nothing loops at idle — and they
// are off when macOS "Reduce motion" is on, or when the user turns them off.

const reduce = matchMedia("(prefers-reduced-motion: reduce)");
let enabled = true;

export function motionEnabled(): boolean {
  return enabled && !reduce.matches;
}

export function setMotion(on: boolean) {
  enabled = on;
  document.documentElement.classList.toggle("no-motion", !motionEnabled());
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
