import assert from "node:assert/strict";
import { test } from "node:test";
import { makeGit, groups } from "../mods/aicode.git-core/git.js";
import { activate } from "../mods/aicode.git/main.js";

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
    workspace: { folder: () => "/repo" }, editor: { onDidChangeContent() {}, onDidChangeEditors() {} },
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
