import assert from "node:assert/strict";
import { test } from "node:test";
import { makeGit, groups } from "../mods/aicode.git-core/git.js";
import { activate } from "../mods/aicode.git/main.js";
import { addLineBlame, parseLineBlame } from "../mods/aicode.git/blame.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

function runner(spawn) {
  return { process: { spawn } };
}

test("Git cancellation kills its process tree and waits for exit before settling", async () => {
  const exit = deferred();
  const controller = new AbortController();
  let killed = false;
  let settled = false;
  const git = makeGit(runner(async (_program, _args, opts) => {
    assert.equal(opts.killTree, true);
    return { done: exit.promise, kill: async () => { killed = true; } };
  }));
  const operation = git.ok(["fetch"], { signal: controller.signal });
  const rejection = assert.rejects(operation, { name: "AbortError" }).then(() => { settled = true; });
  controller.abort();
  await tick();
  assert.equal(killed, true);
  assert.equal(settled, false);
  exit.resolve(null);
  await rejection;
});

test("remote timeout stops a stalled Git process and records a useful error", async () => {
  const exit = deferred();
  const records = [];
  let killed = 0;
  const git = makeGit(runner(async () => ({ done: exit.promise, kill: async () => { killed++; exit.resolve(null); } })), (...args) => records.push(args), { remoteTimeoutMs: 15 });
  await assert.rejects(git.ok(["pull", "--ff-only"]), { name: "TimeoutError" });
  assert.equal(killed, 1);
  assert.match(records[0][2], /timed out/);
});

test("successful Git calls clear the timeout and preserve stderr on failures", async () => {
  let killed = 0;
  const git = makeGit(runner(async (_program, _args, opts) => {
    opts.onData("Permission denied (publickey).", "stderr");
    return { done: Promise.resolve(128), kill: async () => { killed++; } };
  }), null, { remoteTimeoutMs: 5 });
  await assert.rejects(git.ok(["push"]), /Permission denied/);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(killed, 0);
});

test("cancellation before and during spawn never runs an untracked Git operation", async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(makeGit(runner(() => assert.fail("must not spawn"))).run(["fetch"], { signal: before.signal }), { name: "AbortError" });
  const spawning = deferred();
  const exit = deferred();
  const during = new AbortController();
  let killed = false;
  const operation = makeGit(runner(() => spawning.promise)).run(["fetch"], { signal: during.signal });
  const rejected = assert.rejects(operation, { name: "AbortError" });
  during.abort();
  spawning.resolve({ done: exit.promise, kill: async () => { killed = true; exit.resolve(null); } });
  await rejected;
  assert.equal(killed, true);
});

class Element {
  children = [];
  constructor(attrs = {}, children = []) { Object.assign(this, attrs); this.append(...children); }
  append(...children) { this.children.push(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)); }
  querySelector(selector) {
    for (const child of this.children) {
      if (!(child instanceof Element)) continue;
      if ((child.class ?? "").split(" ").includes(selector.slice(1))) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  get textContent() { return this.children.map((child) => child instanceof Element ? child.textContent : String(child)).join(""); }
  set textContent(value) { this.children = [value]; }
}
globalThis.document = { createElement: () => new Element(), head: new Element() };

test("Source Control clears progress independently of a stalled or failed refresh, and can retry or cancel", async () => {
  const commands = new Map();
  const errors = [];
  const info = [];
  const statusItems = [];
  const processExit = deferred();
  let mode = "success";
  let refreshMode = "pending";
  let calls = 0;
  let listener, provider;
  const snapshot = { root: "/repo", status: { branch: "main", upstream: "origin/main", ahead: 0, behind: 0, files: [] } };
  const service = {
    available: true, groups, makeDiffTools: () => ({}),
    makeGit: () => ({ ok: async (_args, opts) => {
      calls++;
      if (mode === "error") throw new Error("Authentication failed");
      if (mode === "pending") {
        opts.signal.addEventListener("abort", () => processExit.reject(Object.assign(new Error("Git operation cancelled."), { name: "AbortError" })), { once: true });
        return processExit.promise;
      }
      return "";
    } }),
    onDidChangeStatus: (fn) => { listener = fn; return { dispose() {} }; },
    refreshStatus: async () => { listener(snapshot); },
    refreshAfterChange: () => refreshMode === "error" ? Promise.reject(new Error("Status unavailable")) : new Promise(() => {}),
  };
  const ctx = {
    mods: { get: async () => service }, subscriptions: [],
    ui: { h: (_tag, attrs, ...children) => new Element(attrs ?? {}, children), icon: () => new Element(), iconButton: () => new Element(), clear: (el) => { el.children = []; } },
    settings: { get: async (_key, fallback) => fallback },
    statusBar: { add: () => { const item = { update: (props) => Object.assign(item, props) }; statusItems.push(item); return item; } },
    workspace: { folder: () => "/repo" }, editor: {
      onDidChangeContent() {}, onDidChangeEditors() {}, onDidChangeActive() {}, active: () => null,
      monacoEditor: () => ({ getModel: () => null, getPosition: () => null, onDidChangeCursorPosition: () => ({ dispose() {} }) }),
    },
    views: { provide: (_id, value) => { provider = value; }, setBadge() {} },
    commands: { register: (id, run) => commands.set(id, run) },
    window: { showError: (error) => errors.push(error), showInfo: (message) => info.push(message) },
  };
  await activate(ctx);
  const view = new Element();
  provider.render(view);
  for (const id of ["git.fetch", "git.pull", "git.push"]) {
    await commands.get(id)();
    assert.equal(view.querySelector(".commit-main").textContent, "Commit");
    assert.equal(view.querySelector(".commit-main").disabled, false);
    assert.equal(view.querySelector(".scm-progress"), null);
    assert.equal(statusItems[1].icon, "sync");
  }
  assert.equal(calls, 3, "a pending status refresh does not prevent retrying");
  mode = "error";
  refreshMode = "error";
  await commands.get("git.fetch")();
  await tick();
  assert.equal(view.querySelector(".commit-main").textContent, "Commit");
  assert.ok(errors.some((error) => error.includes("Authentication failed")));
  assert.ok(errors.some((error) => error.includes("Status unavailable")));
  snapshot.status.ahead = 1;
  snapshot.status.behind = 1;
  const beforeSync = calls;
  await commands.get("git.sync")();
  assert.equal(calls - beforeSync, 1, "a failed pull must not continue with push");
  snapshot.status.ahead = 0;
  snapshot.status.behind = 0;
  mode = "pending";
  const operation = commands.get("git.fetch")();
  assert.equal(view.querySelector(".commit-main").textContent, "Fetching…");
  assert.ok(view.querySelector(".scm-cancel"));
  commands.get("git.cancelOperation")();
  await operation;
  assert.equal(view.querySelector(".scm-progress"), null);
  assert.equal(view.querySelector(".scm-cancel"), null);
  assert.match(info.at(-1), /cancelled/);
});

test("line blame uses Git's current-buffer line mapping, including unsaved insertions and Unicode paths", () => {
  const root = mkdtempSync(join(tmpdir(), "aicode-blame-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "First Author", GIT_AUTHOR_EMAIL: "first@example.test", GIT_COMMITTER_NAME: "Committer", GIT_COMMITTER_EMAIL: "committer@example.test" };
  const git = (args, input) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, env, input, encoding: "utf8" });
  try {
    git(["init", "-q"]);
    const path = "líneas con espacios.txt";
    writeFileSync(join(root, path), "first\nsecond\n");
    git(["add", "--", path]);
    git(["commit", "-qm", "Initial lines"]);
    env.GIT_AUTHOR_NAME = "Second Author";
    writeFileSync(join(root, path), "first\nchanged\n");
    git(["commit", "-qam", "Update second line"]);
    const blame = (line, text) => parseLineBlame(git(["blame", "--line-porcelain", "--contents", "-", "-L", `${line},${line}`, "--", path], text));
    assert.equal(blame(1, "first\nchanged\n").author, "First Author");
    assert.equal(blame(2, "first\nchanged\n").author, "Second Author");
    assert.equal(blame(2, "inserted\nfirst\nchanged\n").author, "First Author");
    assert.equal(blame(1, "inserted\nfirst\nchanged\n").uncommitted, true);
    assert.equal(blame(2, "first\nunsaved edit\n").uncommitted, true);
    assert.equal(parseLineBlame(""), null);
    assert.equal(parseLineBlame("unexpected output"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function blameHarness(run) {
  const listeners = {};
  const listen = (name, callback) => {
    listeners[name] = callback;
    const subscription = { dispose: () => { delete listeners[name]; } };
    return subscription;
  };
  const model = { version: 1, getVersionId() { return this.version; }, getValue: () => "first\nsecond\n" };
  const state = { active: { id: "doc-1", path: "/repo/file.txt", editorType: "default" }, line: 1, model };
  const item = { update(patch) { Object.assign(this, patch); }, dispose() { this.disposed = true; } };
  const ctx = {
    statusBar: { add: (props) => { Object.assign(item, props); return item; } }, subscriptions: [],
    editor: {
      active: () => state.active, model: () => state.model,
      onDidChangeActive: (callback) => ctx.subscriptions.push(listen("active", callback)),
      onDidChangeContent: (callback) => ctx.subscriptions.push(listen("content", callback)),
      monacoEditor: () => ({ getModel: () => state.model, getPosition: () => ({ lineNumber: state.line }), onDidChangeCursorPosition: (callback) => listen("cursor", callback) }),
    },
  };
  const control = addLineBlame(ctx, { run }, { delay: 0 });
  return { state, model, item, ctx, control, listeners, dispose: () => ctx.subscriptions.forEach(sub => sub.dispose()) };
}
const settleBlame = () => new Promise(resolve => setTimeout(resolve, 10));
const blameOutput = (author = "First Author", hash = "a".repeat(40)) => `${hash} 1 1 1\nauthor ${author}\nauthor-time 1700000000\nsummary Update line\nfilename file.txt\n\tfirst\n`;

test("line blame follows the cursor, caches lines, refreshes on edits and repository changes, and disposes", async () => {
  const calls = [];
  const h = blameHarness(async (args, opts) => { calls.push({ args, opts }); return { code: 0, stdout: blameOutput() }; });
  try {
    h.control.setRepository("/repo");
    await settleBlame();
    assert.match(h.item.text, /^First Author, /);
    assert.match(h.item.tooltip, /Who last changed this line/);
    assert.equal(h.item.align, "right");
    assert.equal(h.item.priority, 110);
    assert.equal(calls[0].opts.stdin, "first\nsecond\n");
    h.listeners.cursor();
    await settleBlame();
    assert.equal(calls.length, 1, "moving within the same line avoids another process");
    h.state.line = 2;
    h.listeners.cursor();
    await settleBlame();
    assert.equal(calls[1].args[calls[1].args.indexOf("-L") + 1], "2,2");
    h.state.line = 1;
    h.listeners.cursor();
    assert.equal(calls.length, 2, "returning to a line uses the cache");
    h.model.version++;
    h.listeners.content();
    await settleBlame();
    assert.equal(calls.length, 3);
    h.control.setRepository("/repo");
    await settleBlame();
    assert.equal(calls.length, 4, "Git changes invalidate cached authorship");
    h.state.active = { id: "custom", editorType: "image", path: "/repo/file.txt" };
    h.listeners.active();
    assert.equal(h.item.text, "");
    h.state.active = { id: "outside", editorType: "default", path: "/other/file.txt" };
    h.listeners.active();
    await settleBlame();
    assert.equal(calls.length, 4);
  } finally { h.dispose(); }
  assert.equal(h.item.disposed, true);
  assert.deepEqual(Object.keys(h.listeners), []);
});

test("line blame ignores stale replies, cancels work, handles uncommitted and unavailable lines, and hides without an editor", async () => {
  const pending = [];
  const h = blameHarness((_args, opts) => { const request = deferred(); pending.push({ ...request, opts }); return request.promise; });
  try {
    h.control.setRepository("/repo");
    await settleBlame();
    h.state.line = 2;
    h.listeners.cursor();
    assert.equal(pending[0].opts.signal.aborted, true);
    await settleBlame();
    pending[1].resolve({ code: 0, stdout: blameOutput("New Author") });
    await tick();
    pending[0].resolve({ code: 0, stdout: blameOutput("Stale Author") });
    await tick();
    assert.match(h.item.text, /^New Author, /);
    h.model.version++;
    h.listeners.content();
    await settleBlame();
    pending[2].resolve({ code: 0, stdout: blameOutput("Not Committed Yet", "0".repeat(40)) });
    await tick();
    assert.equal(h.item.text, "You, uncommitted changes");
    h.control.setRepository("/repo");
    await settleBlame();
    pending[3].resolve({ code: 128, stdout: "" });
    await tick();
    assert.equal(h.item.text, "");
    h.state.active = null;
    h.listeners.active();
    assert.equal(h.item.icon, "");
    h.state.active = { id: "doc-1", editorType: "default", path: "/repo/file.txt" };
    h.control.setRepository("/repo");
    await settleBlame();
    h.dispose();
    assert.equal(pending[4].opts.signal.aborted, true);
    pending[4].resolve({ code: 0, stdout: blameOutput("After disposal") });
    await tick();
    assert.equal(h.item.text, "");
  } finally { h.dispose(); }
});
