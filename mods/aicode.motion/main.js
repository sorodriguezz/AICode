// Fluid Motion: the parts of the animations that need JavaScript.
//   - the intensity (html[data-motion]) that motion.css reads its timing and easing from
//   - FLIP for things the core rebuilds: tabs and activity bar icons glide from where they were
//     to where the redraw put them, instead of jumping
//   - a press ripple on buttons (expressive only)
// Every animation goes through ctx.motion / checks ctx.motion.enabled(), so "Toggle Animations"
// and the system's Reduce motion turn all of it off.

const LEVELS = ["subtle", "fluid", "expressive"];
const LABELS = { subtle: "Subtle", fluid: "Fluid", expressive: "Expressive" };
const TIMING = {
  subtle: { duration: 140, easing: "cubic-bezier(.25, .8, .25, 1)" },
  fluid: { duration: 260, easing: "cubic-bezier(.16, 1, .3, 1)" },
  expressive: { duration: 380, easing: "cubic-bezier(.34, 1.4, .64, 1)" },
};

export async function activate(ctx) {
  const root = document.documentElement;
  const level = () => {
    const v = ctx.settings.getNow("intensity", "fluid");
    return LEVELS.includes(v) ? v : "fluid";
  };
  const apply = () => (root.dataset.motion = level());
  apply();
  ctx.subscriptions.push({ dispose: () => delete root.dataset.motion });
  ctx.settings.onDidChange((keys) => keys.includes("intensity") && apply());

  // ---------- FLIP: measure before a redraw, animate after ----------
  const keyOf = (el) => el.dataset.doc ?? el.dataset.view ?? el.dataset.before ?? el.dataset.id;
  const flipper = (list, enabled) => {
    let before = null;
    return {
      measure() {
        if (!enabled() || !ctx.motion.enabled()) return (before = null);
        before = new Map();
        for (const el of list()) {
          const k = keyOf(el);
          if (k) before.set(k, el.getBoundingClientRect());
        }
      },
      play() {
        if (!before) return;
        const prev = before;
        before = null;
        const { duration, easing } = TIMING[level()];
        for (const el of list()) {
          const from = prev.get(keyOf(el));
          if (!from) continue; // new ones have their own enter animation (CSS)
          const to = el.getBoundingClientRect();
          const dx = from.left - to.left;
          const dy = from.top - to.top;
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
          el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration, easing, composite: "add" });
        }
      },
    };
  };

  const tabs = flipper(
    () => [...document.querySelectorAll('[data-part="tabs"] .tab')],
    () => ctx.settings.getNow("flipTabs", true),
  );
  ctx.editor.onWillRenderTabs?.(() => tabs.measure());
  ctx.editor.onDidRenderTabs?.(() => tabs.play());

  const activity = flipper(
    () => [...document.querySelectorAll(".activity-item[data-view], .activity-item[data-before]")],
    () => ctx.settings.getNow("flipActivityBar", true),
  );
  ctx.workbench.onWillRender?.(() => activity.measure());
  ctx.workbench.onDidRender?.(() => activity.play());

  // ---------- press ripple (expressive) ----------
  const onDown = (e) => {
    if (e.button !== 0 || level() !== "expressive" || !ctx.motion.enabled()) return;
    const host = e.target.closest?.(".btn:not(:disabled), .mod-tile");
    if (!host) return;
    const r = host.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2;
    const dot = document.createElement("span");
    dot.className = "fm-ripple";
    Object.assign(dot.style, { width: `${size}px`, height: `${size}px`, left: `${e.clientX - r.left - size / 2}px`, top: `${e.clientY - r.top - size / 2}px` });
    host.classList.add("fm-ripple-host");
    host.append(dot);
    dot.addEventListener("animationend", () => dot.remove(), { once: true });
    setTimeout(() => dot.remove(), 1000);
  };
  document.addEventListener("pointerdown", onDown, true);
  ctx.subscriptions.push({ dispose: () => document.removeEventListener("pointerdown", onDown, true) });

  // ---------- commands ----------
  const setLevel = async (v) => {
    await ctx.settings.set("intensity", v);
    apply();
    if (!ctx.motion.enabled()) ctx.window.showInfo(`Animation intensity: ${LABELS[v]}. Animations are off right now (Toggle Animations, or the system's Reduce motion).`);
  };
  ctx.commands.register("motion.cycleIntensity", async () => {
    const next = LEVELS[(LEVELS.indexOf(level()) + 1) % LEVELS.length];
    await setLevel(next);
    ctx.window.showInfo(`Animation intensity: ${LABELS[next]}`);
  });
  ctx.commands.register("motion.pickIntensity", async () => {
    const cur = level();
    const picked = await ctx.window.showQuickPick(
      [
        { id: "subtle", label: "Subtle", description: "Quick fades, almost no movement" },
        { id: "fluid", label: "Fluid", description: "Smooth eased motion everywhere (default)" },
        { id: "expressive", label: "Expressive", description: "Longer, springier motion, hover lift and ripples" },
      ].map((it) => ({ ...it, icon: it.id === cur ? "check" : "blank" })),
      { placeholder: "Animation intensity", activeIndex: LEVELS.indexOf(cur) },
    );
    if (picked?.id) await setLevel(picked.id);
  });

  return { intensity: level, setIntensity: setLevel };
}
