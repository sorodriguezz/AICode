// Interaction regressions with a small DOM/PTY harness; no agent or shell is launched by the UI tests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import ts from "typescript";
import { Terminal as XtermTerminal } from "../node_modules/@xterm/xterm/lib/xterm.mjs";
import { fileReferences, resizePair } from "../mods/aicode.terminal/interaction.js";
import { insertPane, removePane, layoutTerms, arrangeLayout } from "../mods/aicode.terminal/layout.js";

const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const { FileDropTargets } = await import(moduleUrl(ts.transpile(readFileSync(new URL("../src/core/fileDrops.ts", import.meta.url), "utf8"), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext })));

test("dropped file references round-trip through a POSIX shell, including quotes and metacharacters", () => {
  const paths = ["/tmp/capture.png", "/tmp/my document.pdf", "/tmp/niño's image.png", "/tmp/$(echo unexpected); `echo hi` &.pdf"];
  const script = `set -- ${fileReferences(paths)}; printf '%s\\0' "$@"`;
  assert.deepEqual(execFileSync("/bin/sh", ["-c", script]).toString().split("\0").slice(0, -1), paths);
  assert.throws(() => fileReferences(["/tmp/a\ncommand"]), /control characters/);
  assert.equal(fileReferences(["C:/My Files/O'Brien.pdf"], "pwsh.exe"), "'C:/My Files/O''Brien.pdf' ");
});

test("resizing preserves the adjacent pair's total weight and clamps both panes", () => {
  const [left, right] = resizePair(1, 2, 200, 400, 100);
  assert.equal(left, 1.5);
  assert.equal(right, 1.5);
  assert.deepEqual(resizePair(1, 1, 200, 200, -10000), [0.4, 1.6]);
  assert.deepEqual(resizePair(1, 1, 200, 200, 10000), [1.6, 0.4]);
  assert.deepEqual(resizePair(1, 1, 30, 30, 100), [1, 1]);
  assert.deepEqual(resizePair(1, 2, 0, 0, 100), [1, 2]);
});

test("nested layouts support three above one wide pane, preserve branches, and collapse on removal", () => {
  const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((name) => ({ name }));
  let tree = insertPane(null, null, a);
  tree = insertPane(tree, a, b);
  tree = insertPane(tree, b, c);
  const top = tree;
  tree = insertPane(tree, null, d, "below");
  assert.equal(tree.axis, "column");
  assert.equal(tree.first, top, "a group split preserves the complete top row");
  assert.equal(tree.second.term, d);
  tree.ratio = 0.7;
  tree = insertPane(tree, b, e, "above");
  assert.equal(tree.ratio, 0.7, "splitting one pane preserves the outer divider");
  assert.deepEqual(layoutTerms(tree), [a, e, b, c, d]);
  tree = removePane(tree, e);
  assert.deepEqual(layoutTerms(tree), [a, b, c, d]);
  tree = removePane(tree, d);
  assert.equal(tree.axis, "row");
  tree = removePane(removePane(tree, b), c);
  assert.equal(tree.term, a, "single-child branches collapse to the surviving pane");
  assert.equal(removePane(tree, a), null);
});

test("layout presets reuse every session once, with equal columns and a full-width bottom pane", () => {
  const terms = Array.from({ length: 4 }, (_, id) => ({ id }));
  for (const preset of ["columns", "rows", "grid", "bottom", "right"]) {
    const tree = arrangeLayout(terms, preset);
    assert.deepEqual(layoutTerms(tree), terms);
    assert.equal(new Set(layoutTerms(tree)).size, 4);
  }
  const bottom = arrangeLayout(terms, "bottom");
  assert.equal(bottom.axis, "column");
  assert.equal(bottom.second.term, terms[3]);
  assert.equal(bottom.first.axis, "row");
  const shares = (node, portion = 1) => node.term ? [portion] : [...shares(node.first, portion * node.ratio), ...shares(node.second, portion * (1 - node.ratio))];
  for (const share of shares(bottom.first)) assert.ok(Math.abs(share - 1 / 3) < 1e-12);
  assert.equal(arrangeLayout([terms[0]], "grid").term, terms[0]);
});

class Element extends EventTarget {
  children = [];
  parentElement = null;
  style = {};
  dataset = {};
  className = "";
  classList = {
    contains: (name) => this.className.split(" ").includes(name),
    add: (...names) => { this.className = [...new Set([...this.className.split(" ").filter(Boolean), ...names])].join(" "); },
    remove: (...names) => { this.className = this.className.split(" ").filter((name) => !names.includes(name)).join(" "); },
    toggle: (name, force = !this.classList.contains(name)) => { force ? this.classList.add(name) : this.classList.remove(name); return force; },
  };
  get firstChild() { return this.children[0]; }
  append(...nodes) {
    for (const node of nodes.flat(Infinity)) {
      if (!(node instanceof Element)) continue;
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }
  before(node) {
    const parent = this.parentElement;
    node.remove();
    node.parentElement = parent;
    parent.children.splice(parent.children.indexOf(this), 0, node);
  }
  remove() {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [...(child.classList.contains(selector.slice(1)) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  closest(selector) {
    const matches = selector.split(",").some((part) => part.trim().startsWith(".") ? this.classList.contains(part.trim().slice(1)) : this.tagName === part.trim());
    return matches ? this : this.parentElement?.closest(selector) ?? null;
  }
  getBoundingClientRect() { return this.rect ?? { width: 300, height: 400, left: 0, right: 300, top: 0, bottom: 400 }; }
  focus() { document.activeElement = this; this.dispatchEvent(new Event("focusin")); }
}

function h(tag, attrs, ...children) {
  const el = new Element();
  el.tagName = tag;
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el[key] = value;
  }
  el.append(...children);
  return el;
}

let hit = null;
let hitCoordinates;
globalThis.document = {
  head: new Element(), body: new Element(), documentElement: new Element(),
  createElement: () => new Element(),
  elementFromPoint: (x, y) => { hitCoordinates = [x, y]; return hit; },
};
globalThis.window = Object.assign(new EventTarget(), { devicePixelRatio: 2 });
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
globalThis.requestAnimationFrame = (fn) => queueMicrotask(fn);
globalThis.ResizeObserver = globalThis.MutationObserver = class { observe() {} disconnect() {} };

test("native drops hit the hovered pane on Retina, clear hover, and release closed targets", async () => {
  const drops = new FileDropTargets();
  const pane = new Element();
  const child = new Element();
  pane.append(child);
  let pasted;
  const registration = drops.add(pane, { drop: (paths) => { pasted = paths; } });
  hit = child;
  const target = drops.hover({ x: 420, y: 240 });
  assert.deepEqual(hitCoordinates, [210, 120]);
  assert.equal(target.el, pane);
  assert.equal(pane.classList.contains("file-drop-target"), true);
  await target.spec.drop(["/tmp/image.png"]);
  assert.deepEqual(pasted, ["/tmp/image.png"]);
  drops.clear();
  assert.equal(pane.classList.contains("file-drop-target"), false);
  hit = new Element();
  assert.equal(drops.at({ x: 10, y: 20 }), null, "outside a terminal the default editor handler can receive the drop");
  hit = child;
  drops.hover({ x: 420, y: 240 });
  registration.dispose();
  assert.equal(pane.classList.contains("file-drop-target"), false);
  assert.equal(drops.at({ x: 420, y: 240 }), null);
});

class Terminal {
  cols = 80;
  rows = 24;
  constructor(options) { this.options = options; }
  loadAddon(fit) { this.fit = fit; }
  open(el) { this.el = el; }
  focus() { document.activeElement = this.el; this.el.parentElement.dispatchEvent(new Event("focusin")); }
  registerLinkProvider() {}
  onTitleChange() {}
  attachCustomKeyEventHandler(fn) { this.keyHandler = fn; }
  onData(fn) { this.data = fn; }
  onResize() {}
  paste(text) { this.data(text); }
  write() {}
  dispose() { this.disposed = true; }
}
class FitAddon { count = 0; fit() { this.count++; } }
globalThis.terminalTest = { Terminal, FitAddon };
const terminalSource = readFileSync(new URL("../mods/aicode.terminal/main.js", import.meta.url), "utf8")
  .replace('import { Terminal } from "./vendor/xterm.mjs";', "const { Terminal, FitAddon } = globalThis.terminalTest;")
  .replace('import { FitAddon } from "./vendor/addon-fit.mjs";', "")
  .replace('"./interaction.js"', JSON.stringify(new URL("../mods/aicode.terminal/interaction.js", import.meta.url).href))
  .replace('"./layout.js"', JSON.stringify(new URL("../mods/aicode.terminal/layout.js", import.meta.url).href));
const { activate } = await import(moduleUrl(terminalSource));

const pointer = (type, props) => Object.assign(new Event(type, { cancelable: true }), { button: 0, ...props });

test("terminal splits resize, retain order and shell, follow keyboard focus, paste to the target, and clean up", async () => {
  const commands = new Map();
  const drops = new FileDropTargets();
  const spawns = [];
  const infos = [];
  const settings = new Map();
  let provider;
  let pick = () => null;
  const agent = {
    name: "Test Agent", icon: "robot",
    status: async () => ({ ready: true, terminal: true, detail: "Installed CLI" }),
    terminal: async () => ({ command: "test-agent", args: ["--interactive"] }),
  };
  const ctx = {
    subscriptions: [], asset: (path) => path,
    ui: { h, icon: () => new Element(), iconButton: () => new Element(), clear: (el) => { while (el.firstChild) el.firstChild.remove(); }, basename: (path) => path.split("/").at(-1) },
    settings: { get: async (key, fallback) => settings.get(key) ?? fallback, set: async (key, value) => settings.set(key, value) },
    workspace: { folder: () => "/workspace" },
    pty: {
      shells: async () => ({ default: "/bin/zsh", shells: ["/bin/zsh", "/bin/bash"] }),
      spawn: async (options) => {
        const process = { options, writes: [], resizes: [], write(text) { this.writes.push(text); }, resize(...size) { this.resizes.push(size); }, kill() { this.killed = true; } };
        spawns.push(process);
        return process;
      },
    },
    views: { provide: (_id, value) => { provider = value; }, isVisible: () => true, reveal: async () => {}, refreshActions() {} },
    commands: { register: (id, fn) => commands.set(id, fn), execute: async (id, ...args) => commands.get(id)?.(...args) },
    workbench: { addFileDropTarget: (el, spec) => drops.add(el, spec) },
    mods: { contributions: () => [{ mod: "test.agent" }], isEnabled: () => true, get: async () => ({ chatAgents: { test: agent } }) },
    window: { showQuickPick: async (items) => pick(items), showInfo: (message) => infos.push(message) },
  };
  const terminal = await activate(ctx);
  // render normally creates a shell, as it does when first opening the real terminal view.
  const view = new Element();
  provider.render(view);
  while (!spawns.length) await new Promise((resolve) => setImmediate(resolve));
  const firstPane = view.querySelectorAll(".term-pane")[0];
  const second = await terminal.split({ command: "/bin/bash" });
  assert.equal(spawns[1].options.command, "/bin/bash");
  // Use xterm's actual keyboard handling with the options and handler supplied by the mod.
  // No browser DOM is needed to check that Option characters reach onData as plain text.
  const keyboardTerminal = new XtermTerminal(second.term.options);
  Object.defineProperty(keyboardTerminal._core, "browser", { value: { isMac: true, isWindows: false } });
  keyboardTerminal.attachCustomKeyEventHandler(second.term.keyHandler);
  let typed = "";
  keyboardTerminal.onData((data) => { typed += data; });
  for (const key of ["@", "|", "\\", "{", "}", "[", "]", "€", "á"]) {
    keyboardTerminal._core._keyPress({
      type: "keypress", key, charCode: key.charCodeAt(0), keyCode: key.charCodeAt(0),
      altKey: true, ctrlKey: false, metaKey: false,
      preventDefault() {}, stopPropagation() {},
    });
  }
  assert.equal(typed, "@|\\{}[]€á", "Option must produce characters instead of Meta sequences");
  keyboardTerminal.dispose();
  if (navigator.platform.toLowerCase().includes("mac")) {
    const key = (name) => ({ type: "keydown", key: name, altKey: true, metaKey: false, ctrlKey: false, preventDefault() {} });
    assert.equal(second.term.keyHandler(key("ArrowLeft")), false);
    assert.equal(second.term.keyHandler(key("ArrowRight")), false);
    assert.deepEqual(second.pty.writes.splice(0), ["\x1bb", "\x1bf"], "Option+arrows still move by word");
  }
  const third = await terminal.split();
  assert.equal(spawns[2].options.command, "/bin/bash", "split inherits and starts the chosen shell");
  assert.equal(view.querySelectorAll(".term-sash").length, 2);
  assert.deepEqual(view.querySelectorAll(".term-pane"), [firstPane, second.pane, third.pane]);
  const tree = firstPane.parentElement;
  const sash = tree.children[1];
  const beforeFit = second.fit.count;
  sash.dispatchEvent(pointer("pointerdown", { clientX: 300 }));
  window.dispatchEvent(pointer("pointermove", { clientX: 400 }));
  window.dispatchEvent(pointer("pointerup", { clientX: 400 }));
  assert.ok(Number(firstPane.style.flexGrow) > Number(tree.children[2].style.flexGrow));
  assert.ok(second.fit.count > beforeFit);
  assert.equal(sash.classList.contains("dragging"), false);
  sash.dispatchEvent(new Event("dblclick"));
  assert.equal(firstPane.style.flexGrow, "50");
  assert.equal(tree.children[2].style.flexGrow, "50");
  second.term.focus();
  assert.equal(second.pane.classList.contains("focused"), true);
  assert.equal(third.pane.classList.contains("focused"), false);
  third.term.focus();
  hit = second.el;
  await drops.at({ x: 100, y: 100 }).spec.drop(["/tmp/my picture.png", "/tmp/info.pdf"]);
  assert.deepEqual(second.pty.writes, ["'/tmp/my picture.png' /tmp/info.pdf "]);
  assert.equal(third.pty.writes.length, 0);
  assert.equal(second.pane.classList.contains("focused"), true);
  await commands.get("terminal.kill")();
  assert.equal(second.term.disposed, true);
  assert.equal(drops.at({ x: 100, y: 100 }), null);
  assert.equal(view.querySelectorAll(".term-sash").length, 1);
  assert.deepEqual(view.querySelectorAll(".term-pane"), [firstPane, third.pane]);
  assert.equal(Number(firstPane.style.flexGrow) + Number(third.pane.style.flexGrow), 100, "remaining panes fill the group after closing a pane");
  const bottom = await commands.get("terminal.splitGroupDown")();
  assert.equal(bottom.group.layout.axis, "column");
  assert.equal(bottom.group.layout.second.term, bottom);
  assert.equal(bottom.group.layout.first.axis, "row");
  const column = bottom.pane.parentElement;
  const horizontalSash = column.children[1];
  const top = column.children[0];
  const topWidth = firstPane.style.flexGrow;
  horizontalSash.dispatchEvent(pointer("pointerdown", { clientX: 0, clientY: 200 }));
  window.dispatchEvent(pointer("pointermove", { clientX: 0, clientY: 280 }));
  window.dispatchEvent(pointer("pointerup", { clientX: 0, clientY: 280 }));
  assert.ok(Number(top.style.flexGrow) > Number(bottom.pane.style.flexGrow));
  assert.equal(firstPane.style.flexGrow, topWidth, "vertical resizing preserves the top row's column widths");
  horizontalSash.dispatchEvent(pointer("keydown", { key: "ArrowUp" }));
  assert.ok(bottom.group.layout.ratio < 0.6, "a horizontal divider accepts vertical arrow keys");
  const nested = await commands.get("terminal.splitUp")();
  assert.equal(nested.group.layout.second.axis, "column");
  assert.equal(nested.group.layout.second.first.term, nested);
  assert.equal(nested.group.layout.second.second.term, bottom);
  const spawnedBeforeMove = spawns.length;
  pick = (items) => items.find((item) => item.scope === "group" && item.direction === "below");
  third.term.focus();
  await commands.get("terminal.movePane")();
  assert.equal(third.group.layout.second.term, third);
  assert.equal(spawns.length, spawnedBeforeMove, "moving a pane reuses the PTY");
  assert.equal(third.term.disposed, undefined);
  pick = (items) => items.find((item) => item.preset === "bottom");
  await commands.get("terminal.arrange")();
  assert.equal(third.group.layout.second.term, third);
  assert.equal(third.group.layout.first.axis, "row");
  assert.equal(new Set(third.group.terms).size, third.group.terms.length);
  pick = (items) => items.find((item) => item.agent);
  const launched = await commands.get("terminal.splitAgent")();
  assert.equal(launched.pty.options.command, "test-agent");
  assert.deepEqual(launched.pty.options.args, ["--interactive"]);
  assert.equal(launched.cwd, "/workspace");
  assert.equal(launched.icon, "robot");
  settings.set("agentProfiles", [{ name: "Other CLI", command: "other-agent", args: ["--chat", "with spaces"] }]);
  pick = (items) => items.find((item) => item.profile);
  const custom = await commands.get("terminal.newAgent")();
  assert.equal(custom.pty.options.command, "other-agent");
  assert.deepEqual(custom.pty.options.args, ["--chat", "with spaces"]);
  // A tab from another group can join the visible layout; dragging never starts another process.
  third.term.focus();
  const customTab = view.querySelectorAll(".term-tab").at(-1);
  const beforeDrag = spawns.length;
  customTab.dispatchEvent(pointer("pointerdown", { clientX: 400, clientY: 100 }));
  hit = firstPane;
  window.dispatchEvent(pointer("pointermove", { clientX: 150, clientY: 300 }));
  assert.equal(view.querySelectorAll(".term-layout-preview").length, 1);
  window.dispatchEvent(pointer("pointerup", { clientX: 150, clientY: 300 }));
  assert.equal(custom.group, third.group);
  assert.equal(spawns.length, beforeDrag);
  assert.equal(custom.pty.killed, undefined);
  assert.equal(view.querySelectorAll(".term-layout-preview").length, 0);
  // An outer-edge drop moves an existing terminal below the whole group.
  const beforeEdgeDrag = custom.group.layout;
  const tab = view.querySelectorAll(".term-tab").find((item) => item.classList.contains("active"));
  tab.dispatchEvent(pointer("pointerdown", { clientX: 400, clientY: 100 }));
  window.dispatchEvent(pointer("pointermove", { clientX: 150, clientY: 398 }));
  window.dispatchEvent(pointer("pointerup", { clientX: 150, clientY: 398 }));
  assert.notEqual(custom.group.layout, beforeEdgeDrag);
  assert.equal(custom.group.layout.second.term, custom);
  assert.equal(custom.group.layout.axis, "column");
  const beforeCancel = custom.group.layout;
  view.querySelectorAll(".term-tab").find((item) => item.classList.contains("active"))
    .dispatchEvent(pointer("pointerdown", { clientX: 400, clientY: 100 }));
  window.dispatchEvent(pointer("pointermove", { clientX: 150, clientY: 30 }));
  window.dispatchEvent(pointer("keydown", { key: "Escape" }));
  assert.equal(custom.group.layout, beforeCancel, "Escape cancels without changing the layout");
  assert.equal(view.querySelectorAll(".term-layout-preview").length, 0);
  custom.exited = true;
  hit = custom.el;
  await drops.at({ x: 100, y: 100 }).spec.drop(["/tmp/image.png"]);
  assert.equal(custom.pty.writes.length, 0);
  assert.match(infos.at(-1), /not running/);
  ctx.subscriptions.forEach((sub) => sub.dispose());
  assert.equal(drops.at({ x: 100, y: 100 }), null);
});
