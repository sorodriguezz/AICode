// Image Preview: images open as images, never as code.
//
// The mod registers an editor type with `default: true`, so the core opens these files straight in
// it (nothing is read as text first). SVG is text as well: its source stays one click away (Open
// Source in the tab bar, "Reopen Editor With… → Text Editor") and the preview follows the code as you
// type. Raster formats have no text form, so the text editor is not offered for them.

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  cur: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
};
/** Formats that are text: they keep a way to the code. */
const TEXT = new Set(["svg"]);
const TYPE = "image.preview";
const ZOOMS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 32];
const MIN = ZOOMS[0];
const MAX = ZOOMS[ZOOMS.length - 1];
const BACKGROUNDS = ["checkerboard", "dark", "light", "editor"];
const BG_LABEL = { checkerboard: "Checkerboard", dark: "Dark", light: "Light", editor: "Editor Background" };

const extOf = (path) => {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};
const isImage = (path) => !!path && ext2mime(path) !== undefined;
const ext2mime = (path) => MIME[extOf(path)];
const isText = (path) => !!path && TEXT.has(extOf(path));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const pct = (s) => `${Math.round(s * 100)}%`;

export async function activate(ctx) {
  const { h, icon, iconButton, basename, dirname } = ctx.ui;
  const setting = (key, fallback) => ctx.settings.getNow(key, fallback);

  /** Open viewers by file path (one tab per file: the tab's key). */
  const viewers = new Map();
  /** The viewer of the active tab, if it is one of ours. */
  let current = null;

  // ---------- status bar: size in pixels and on disk, and the zoom ----------

  const sizeItem = ctx.statusBar.add({ align: "right", priority: 95, tooltip: "Image size" });
  const zoomItem = ctx.statusBar.add({ align: "right", priority: 94, tooltip: "Zoom (click for presets)", run: (e) => current?.zoomMenu(e.clientX, e.clientY - 4) });
  const paintStatus = () => {
    const v = current;
    if (!v || !v.natural) {
      sizeItem.update({ text: "", icon: undefined });
      zoomItem.update({ text: "" });
      return;
    }
    const { w, h: hh } = v.natural;
    sizeItem.update({ icon: "file-media", text: `${w} × ${hh}${v.bytes != null ? `  ${formatBytes(v.bytes)}` : ""}`, tooltip: `${w} × ${hh} pixels${v.bytes != null ? `, ${formatBytes(v.bytes)} on disk` : ""}` });
    zoomItem.update({ text: v.fit ? `Fit ${pct(v.scale)}` : pct(v.scale) });
  };

  // ---------- one viewer per tab ----------

  function mount(el, path) {
    const name = basename(path);
    const text = isText(path);
    const root = h("div", { class: "imgp", tabindex: "0" });
    const stage = h("div", { class: "imgp-stage" });
    const canvas = h("div", { class: "imgp-canvas" });
    const img = h("img", { alt: name, draggable: "false" });
    canvas.append(img);
    stage.append(canvas);
    const zoomLabel = h("button", { class: "imgp-zoom", title: "Zoom presets", onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); view.zoomMenu(r.left, r.bottom + 4); } }, "");
    const bar = h(
      "div",
      { class: "imgp-bar" },
      iconButton("zoom-out", "Zoom Out (−)", () => view.step(-1)),
      zoomLabel,
      iconButton("zoom-in", "Zoom In (+)", () => view.step(1)),
      iconButton("screen-normal", "Zoom to Fit (0)", () => view.setFit()),
      h("span", { class: "sep" }),
      iconButton("color-mode", "Change Background (B)", (e) => { const r = e.currentTarget.getBoundingClientRect(); view.backgroundMenu(r.left, r.bottom + 4); }),
      text ? iconButton("go-to-file", "Open Source", () => showSource(path)) : null,
    );
    root.append(stage, bar);
    el.replaceChildren(root);

    const view = {
      path,
      natural: null,
      bytes: null,
      scale: 1,
      fit: true,
      disposed: false,
      step,
      setFit,
      setScale,
      zoomMenu,
      backgroundMenu,
      cycleBackground,
      focus: () => root.focus(),
    };

    // --- painting ---

    const paintBackground = () => {
      const bg = BACKGROUNDS.includes(setting("background", "checkerboard")) ? setting("background", "checkerboard") : "checkerboard";
      for (const b of BACKGROUNDS) stage.classList.toggle(`bg-${b}`, b === bg);
    };
    const fitScale = () => {
      if (!view.natural) return 1;
      const pad = 32;
      const w = Math.max(1, stage.clientWidth - pad);
      const hh = Math.max(1, stage.clientHeight - pad);
      const s = Math.min(w / view.natural.w, hh / view.natural.h);
      return clamp(setting("fitUpscale", false) ? s : Math.min(1, s), MIN, MAX);
    };
    const layout = () => {
      if (!view.natural) return;
      if (view.fit) view.scale = fitScale();
      canvas.style.width = `${Math.max(1, Math.round(view.natural.w * view.scale))}px`;
      canvas.style.height = `${Math.max(1, Math.round(view.natural.h * view.scale))}px`;
      img.classList.toggle("pixelated", setting("pixelated", true) && view.scale >= 2);
      zoomLabel.textContent = pct(view.scale);
      zoomLabel.title = view.fit ? "Zoomed to fit · presets" : "Zoom presets";
      const pannable = stage.scrollWidth > stage.clientWidth + 1 || stage.scrollHeight > stage.clientHeight + 1;
      stage.classList.toggle("grab", pannable);
      if (current === view) paintStatus();
    };

    // --- zoom, keeping the point under the cursor (or the middle) in place ---

    function setScale(next, anchor) {
      if (!view.natural) return;
      const s = clamp(next, MIN, MAX);
      const rect = stage.getBoundingClientRect();
      const ax = anchor ? anchor.x - rect.left : stage.clientWidth / 2;
      const ay = anchor ? anchor.y - rect.top : stage.clientHeight / 2;
      // The point under the anchor, in image pixels, before the change.
      const cr = canvas.getBoundingClientRect();
      const ix = (rect.left + ax - cr.left - 16) / view.scale;
      const iy = (rect.top + ay - cr.top - 16) / view.scale;
      view.fit = false;
      view.scale = s;
      layout();
      const cr2 = canvas.getBoundingClientRect();
      stage.scrollLeft += cr2.left + 16 + ix * s - (rect.left + ax);
      stage.scrollTop += cr2.top + 16 + iy * s - (rect.top + ay);
    }
    function step(dir, anchor) {
      const s = view.scale;
      const next = dir > 0 ? ZOOMS.find((z) => z > s + 1e-6) ?? MAX : [...ZOOMS].reverse().find((z) => z < s - 1e-6) ?? MIN;
      setScale(next, anchor);
    }
    function setFit() {
      view.fit = true;
      layout();
    }
    function zoomMenu(x, y) {
      ctx.window.contextMenu(x, y, [
        { label: "Zoom to Fit", keybinding: "0", checked: view.fit, run: setFit },
        { separator: true, label: "" },
        ...[0.25, 0.5, 1, 2, 4, 8, 16].map((z) => ({ label: pct(z), keybinding: z === 1 ? "1" : undefined, checked: !view.fit && Math.abs(view.scale - z) < 1e-6, run: () => setScale(z) })),
      ]);
    }
    function backgroundMenu(x, y) {
      const bg = setting("background", "checkerboard");
      ctx.window.contextMenu(x, y, BACKGROUNDS.map((b) => ({ label: BG_LABEL[b], checked: bg === b, run: () => ctx.settings.set("background", b) })));
    }
    function cycleBackground() {
      const bg = setting("background", "checkerboard");
      ctx.settings.set("background", BACKGROUNDS[(BACKGROUNDS.indexOf(bg) + 1) % BACKGROUNDS.length]);
    }

    // --- loading: from the editor's buffer for an SVG being edited, else from disk ---

    let loadSeq = 0;
    let lastModified = null;
    const showMessage = (iconName, message, actions = []) => {
      view.natural = null;
      stage.replaceChildren(h("div", { class: "imgp-message" }, icon(iconName), h("div", null, message), ...actions));
      bar.style.display = "none";
      if (current === view) paintStatus();
    };
    const showImage = () => {
      if (canvas.parentElement !== stage) stage.replaceChildren(canvas);
      bar.style.display = "";
    };
    const sourceText = async () => {
      const open = ctx.editor.getText(path);
      if (typeof open === "string") return open;
      return (await ctx.fs.readText(path)).text;
    };
    const load = async ({ keepView = false } = {}) => {
      const seq = ++loadSeq;
      let src;
      try {
        const st = await ctx.fs.stat(path);
        if (!st.exists) return showMessage("warning", `${name} was deleted or moved.`);
        view.bytes = st.size;
        lastModified = st.modified_ms;
        src = text
          ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(await sourceText())}`
          : (await ctx.fs.readDataUrl(path)).replace(/^data:[^;,]*/, `data:${ext2mime(path)}`);
      } catch (e) {
        if (seq === loadSeq) showMessage("error", `Could not read ${name}: ${e?.message ?? e}`);
        return;
      }
      if (seq !== loadSeq || view.disposed) return;
      const probe = new Image();
      probe.onload = () => {
        if (seq !== loadSeq || view.disposed) return;
        const first = !view.natural;
        // An SVG without width/height has no intrinsic size: give it a sensible one.
        const w = probe.naturalWidth || 300;
        const hh = probe.naturalHeight || 150;
        img.src = src;
        showImage();
        view.natural = { w, h: hh };
        if (first && !keepView) view.fit = true;
        layout();
      };
      probe.onerror = () => {
        if (seq !== loadSeq || view.disposed) return;
        showMessage(
          "file-media",
          text ? `${name} has an error and cannot be drawn. Fix the code and the preview updates.` : `${name} cannot be shown: this format or this file is not supported.`,
          [
            text ? h("button", { class: "btn", onclick: () => showSource(path) }, "Open Source") : null,
            h("button", { class: "btn secondary", onclick: () => ctx.external.open(path) }, "Open in Default App"),
          ].filter(Boolean),
        );
      };
      probe.src = src;
    };

    // --- input: wheel/pinch zoom, click zoom, drag to pan, keys, context menu ---

    stage.addEventListener(
      "wheel",
      (e) => {
        // ⌘/Ctrl + scroll, and the trackpad pinch (which arrives as a ctrl wheel), zoom; plain scroll pans.
        if (!(e.ctrlKey || e.metaKey) || !view.natural) return;
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.002));
        setScale(view.scale * factor, { x: e.clientX, y: e.clientY });
      },
      { passive: false },
    );
    let drag = null;
    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !view.natural) return;
      // Where the press began (once the pointer is captured, every event targets the stage).
      drag = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop, moved: false, onImage: canvas.contains(e.target) };
      stage.setPointerCapture(e.pointerId);
      root.focus();
    });
    stage.addEventListener("pointermove", (e) => {
      if (!drag) {
        stage.classList.toggle("zoom-out", e.altKey && !!view.natural);
        stage.classList.toggle("zoom-in", !e.altKey && !!view.natural && !stage.classList.contains("grab"));
        return;
      }
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      stage.classList.add("grabbing");
      stage.scrollLeft = drag.left - dx;
      stage.scrollTop = drag.top - dy;
    });
    const endDrag = (e) => {
      if (!drag) return;
      const clicked = !drag.moved && drag.onImage;
      drag = null;
      stage.classList.remove("grabbing");
      // A click (not a drag) zooms in at that point; ⌥-click zooms out.
      if (clicked && e.type === "pointerup" && view.natural) step(e.altKey ? -1 : 1, { x: e.clientX, y: e.clientY });
    };
    stage.addEventListener("pointerup", endDrag);
    stage.addEventListener("pointercancel", endDrag);
    root.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey) return;
      const k = e.key;
      if (k === "+" || k === "=") step(1);
      else if (k === "-" || k === "_") step(-1);
      else if (k === "0") setFit();
      else if (k === "1") setScale(1);
      else if (k === "b" || k === "B") cycleBackground();
      else return;
      e.preventDefault();
    });
    root.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const bg = setting("background", "checkerboard");
      ctx.window.contextMenu(e.clientX, e.clientY, [
        { label: "Zoom In", keybinding: "+", icon: "zoom-in", run: () => step(1, { x: e.clientX, y: e.clientY }) },
        { label: "Zoom Out", keybinding: "-", icon: "zoom-out", run: () => step(-1, { x: e.clientX, y: e.clientY }) },
        { label: "Zoom to Fit", keybinding: "0", checked: view.fit, run: setFit },
        { label: "Actual Size", keybinding: "1", checked: !view.fit && view.scale === 1, run: () => setScale(1) },
        { separator: true, label: "" },
        ...BACKGROUNDS.map((b) => ({ label: `Background: ${BG_LABEL[b]}`, checked: bg === b, run: () => ctx.settings.set("background", b) })),
        { separator: true, label: "" },
        ...(text ? [{ label: "Open Source", icon: "go-to-file", run: () => showSource(path) }] : []),
        { label: "Open in Default App", run: () => ctx.external.open(path) },
        { label: "Reveal in Finder", run: () => ctx.fs.reveal(path) },
        { label: "Copy Path", run: () => ctx.window.copy(path) },
      ]);
    });

    // --- staying current: resizes, settings, the file on disk, the SVG's code as you type ---

    const disposers = [];
    const ro = new ResizeObserver(() => view.fit && layout());
    ro.observe(stage);
    disposers.push(() => ro.disconnect());
    disposers.push(ctx.settings.onDidChange(() => { paintBackground(); layout(); }).dispose);
    let reloadTimer;
    const reloadSoon = (delay) => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => load({ keepView: true }), delay);
    };
    disposers.push(
      ctx.fs.watch(dirname(path), async () => {
        // A change in the folder: reload only when this file is new on disk (and not being edited).
        if (text && ctx.editor.all().some((d) => d.path === path && d.dirty)) return;
        const st = await ctx.fs.stat(path).catch(() => null);
        if (!st?.exists || st.modified_ms !== lastModified) reloadSoon(120);
      }).dispose,
    );
    if (text) {
      disposers.push(ctx.editor.onDidChangeContent((info) => info?.path === path && reloadSoon(150)).dispose);
      // Closing the code without saving puts the preview back to what is on disk.
      disposers.push(ctx.editor.onDidChangeEditors(() => reloadSoon(50)).dispose);
    }

    paintBackground();
    load();
    viewers.set(path, view);
    queueMicrotask(() => root.isConnected && root.focus());
    return {
      dispose: () => {
        view.disposed = true;
        clearTimeout(reloadTimer);
        for (const d of disposers) {
          try {
            d?.();
          } catch {}
        }
        if (viewers.get(path) === view) viewers.delete(path);
        if (current === view) {
          current = null;
          paintStatus();
        }
      },
    };
  }

  // ---------- opening ----------

  const tabs = new Map(); // tab id -> path
  const openPreview = (path) => {
    const tab = ctx.editor.openCustom({
      title: basename(path),
      icon: "file-media",
      forPath: path,
      editorType: TYPE,
      key: `image:${path}`,
      render: (el) => mount(el, path),
    });
    if (tab) tabs.set(tab.id, path);
    syncActive(ctx.editor.active());
    return tab;
  };
  const showSource = (path) => ctx.editor.open(path, { asText: true });

  ctx.editor.registerEditorType({
    id: TYPE,
    label: "Image Preview",
    default: true,
    when: (info) => isImage(info.path),
    // A PNG has no text form: "Reopen Editor With…" does not offer the text editor for it.
    hasText: (info) => isText(info.path),
    open: (info) => openPreview(info.path),
  });

  // ---------- the active tab ----------

  const syncActive = (info) => {
    const path = info ? tabs.get(info.id) : undefined;
    current = path ? viewers.get(path) ?? null : null;
    paintStatus();
  };
  ctx.editor.onDidChangeActive(syncActive);
  ctx.editor.onDidChangeEditors(() => {
    const open = new Set(ctx.editor.all().map((d) => d.id));
    for (const id of [...tabs.keys()]) if (!open.has(id)) tabs.delete(id);
  });
  syncActive(ctx.editor.active());

  // ---------- tab bar icons ----------

  const isOurs = (info) => info?.editorType === TYPE;
  const isSvgText = (info) => !!info?.path && isText(info.path) && (info.editorType ?? "default") === "default";
  ctx.editor.addTitleAction({ id: "source", icon: "go-to-file", title: "Open Source", order: 10, when: (info) => isOurs(info) && isText(info.path), run: (info) => showSource(info.path) });
  ctx.editor.addTitleAction({ id: "preview", icon: "open-preview", title: "Open Image Preview", order: 10, when: isSvgText, run: (info) => openPreview(info.path) });

  // ---------- commands ----------

  const needViewer = (fn) => () => {
    if (current) return fn(current);
    ctx.window.showInfo("Open an image to use this.");
  };
  ctx.commands.register("imagePreview.zoomIn", needViewer((v) => v.step(1)));
  ctx.commands.register("imagePreview.zoomOut", needViewer((v) => v.step(-1)));
  ctx.commands.register("imagePreview.fit", needViewer((v) => v.setFit()));
  ctx.commands.register("imagePreview.actualSize", needViewer((v) => v.setScale(1)));
  ctx.commands.register("imagePreview.cycleBackground", needViewer((v) => v.cycleBackground()));
  ctx.commands.register("imagePreview.showSource", () => {
    const path = current?.path ?? ctx.editor.active()?.path;
    if (path && isText(path)) showSource(path);
    else ctx.window.showInfo(path && isImage(path) ? `${basename(path)} has no code to show: it is a binary image.` : "Open an SVG image to see its code.");
  });
  ctx.commands.register("imagePreview.showPreview", () => {
    const path = ctx.editor.active()?.path;
    if (path && isImage(path)) openPreview(path);
    else ctx.window.showInfo("Open an image file to preview it.");
  });
}
