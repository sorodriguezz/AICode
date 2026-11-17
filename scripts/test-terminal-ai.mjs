import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { activate as activateRuntime } from "../mods/aicode.agent-runtime/main.js";
import { defineAgent } from "../mods/aicode.agent-runtime/kit.js";
import { activate as activateBridge } from "../mods/aicode.terminal-ai/main.js";
import { activate as activateClaude } from "../mods/aicode.agent-claude/main.js";
import { activate as activateCodex } from "../mods/aicode.agent-codex/main.js";

test("provider discovery supports new and legacy mods without loading Chat or duplicating agents", async () => {
  const calls = [];
  const agent = { id: "a", status() {} };
  const legacy = { id: "b", status() {} };
  const runtime = activateRuntime({ mods: {
    contributions: (point) => point === "agentProviders" ? [{ mod: "new" }] : [{ mod: "new" }, { mod: "legacy" }],
    get: async (id) => { calls.push(id); return id === "new" ? { agentProviders: { agent } } : { chatAgents: { legacy } }; },
  } });
  assert.deepEqual(calls, [], "discovery is lazy");
  assert.deepEqual(await runtime.listProviders(), [agent, legacy]);
  assert.deepEqual(calls, ["new", "legacy"]);
});

function providerContext() {
  const settings = new Map();
  return {
    settings: { get: async (key, fallback) => settings.get(key) ?? fallback, set: async (key, value) => settings.set(key, value) },
    process: { which: async (bin) => `/bin/${bin}` },
    commands: { register() {} },
    mods: { get: async (id) => {
      assert.equal(id, "aicode.agent-runtime");
      return { kit: { defineAgent } };
    } },
  };
}

test("the calling interface supplies approval behavior without reading Chat configuration", async () => {
  let launch;
  const ctx = providerContext();
  ctx.process.spawn = async () => ({ done: Promise.resolve(0), kill() {} });
  const agent = defineAgent(ctx, { id: "test", name: "Test", cli: {
    bin: "test-agent", build: (options) => { launch = options; return { args: [] }; },
  } });
  const run = await agent.run({ prompt: "hello", autoApprove: false, onText() {} });
  await run.done;
  assert.equal(launch.autoApprove, false);
});

for (const [name, activate] of [["claude", activateClaude], ["codex", activateCodex]]) {
  test(`${name}: interactive MCP credentials travel through env, and launch works without MCP`, async () => {
    const provider = (await activate(providerContext())).agentProviders[name];
    const mcp = { url: "http://127.0.0.1:1234/mcp", token: "private-test-token" };
    const line = await provider.terminal({ model: "chosen-model", cwd: "/project", mcp });
    assert.equal(line.command, name);
    assert.equal(line.cwd, "/project");
    assert.ok(line.args.includes("chosen-model"));
    assert.ok(line.args.some((a) => a.includes(mcp.url)));
    assert.equal(JSON.stringify(line.args).includes(mcp.token), false);
    assert.ok(Object.values(line.env).some((v) => v.includes(mcp.token)));
    assert.equal(provider.terminalCapabilities.mcp, true);
    const plain = await provider.terminal("chosen-model");
    assert.deepEqual(plain.args, ["--model", "chosen-model"]);
    assert.deepEqual(plain.env, {});
  });
}

function bridgeHarness({ enabledMcp = false, failMcp = false, legacy = [], profiles = [], agent } = {}) {
  const commands = new Map(), settings = new Map([["agentProfiles", profiles]]), calls = [], terminals = [], decorations = new Map(), changes = new Set(), messages = [];
  const terminal = {
    active: () => terminals.at(-1),
    list: () => terminals,
    open: async (opts) => { calls.push(opts); const t = { id: terminals.length + 1, ...opts }; terminals.push(t); return t; },
    split: async (opts) => terminal.open(opts),
    setDecoration: (id, value) => value ? decorations.set(id, value) : decorations.delete(id),
    onDidChange: (fn) => { changes.add(fn); return { dispose: () => changes.delete(fn) }; },
  };
  let pick = (items) => items.find((i) => i.agent);
  const ctx = {
    subscriptions: [],
    settings: { get: async (k, f) => settings.get(k) ?? f, set: async (k, v) => settings.set(k, v) },
    config: { getFor: (owner, key) => { assert.equal(owner, "aicode.terminal"); assert.equal(key, "agentProfiles"); return legacy; } },
    workspace: { folder: () => "/project" },
    mods: {
      isEnabled: (id) => enabledMcp && id === "aicode.mcp-server",
      get: async (id) => {
        assert.notEqual(id, "aicode.agents");
        if (id === "aicode.terminal") return terminal;
        if (id === "aicode.agent-runtime") return { listProviders: async () => agent ? [agent] : [] };
        if (id === "aicode.mcp-server") return { connection: async () => { if (failMcp) throw new Error("connection failed"); return { url: "http://local/mcp", token: "secret" }; } };
        throw new Error(`Unexpected mod: ${id}`);
      },
    },
    commands: { register: (id, fn) => commands.set(id, fn) },
    window: { showQuickPick: async (items) => pick(items), showInfo: (msg) => messages.push(msg) },
  };
  return { ctx, terminal, commands, settings, calls, decorations, changes, messages, pick: (fn) => { pick = fn; } };
}

test("the bridge configures MCP and keeps metadata free of credentials; cleanup leaves PTYs alone", async () => {
  let launch;
  const agent = {
    id: "test", name: "Test", terminalCapabilities: { mcp: true },
    status: async () => ({ ready: true, terminal: true }),
    terminal: async (options) => { launch = options; return { command: "agent", args: [], env: { TOKEN: options.mcp.token } }; },
  };
  const h = bridgeHarness({ enabledMcp: true, agent });
  const bridge = await activateBridge(h.ctx);
  const t = await h.commands.get("terminal.newAgent")();
  assert.equal(launch.mcp.token, "secret");
  assert.equal(h.calls[0].env.TOKEN, "secret");
  assert.equal(JSON.stringify(bridge.sessions()).includes("secret"), false);
  assert.equal(h.decorations.get(t.id).text, "MCP");
  assert.match(h.decorations.get(t.id).tooltip, /configuration passed/);
  for (const fn of h.changes) fn({ type: "exit", terminal: t });
  assert.equal(h.decorations.get(t.id).text, "Exited");
  for (const fn of h.changes) fn({ type: "close", terminal: t });
  assert.deepEqual(bridge.sessions(), []);
  h.ctx.subscriptions.forEach((d) => d.dispose());
  assert.equal(h.changes.size, 0);
  assert.equal(h.terminal.list().length, 1, "disposing the bridge does not terminate terminals");
});

test("custom profiles migrate once and user edits survive reactivation", async () => {
  const legacy = [{ name: "Custom", command: "custom-cli", args: ["with spaces"] }];
  const h = bridgeHarness({ legacy });
  await activateBridge(h.ctx);
  assert.deepEqual(h.settings.get("agentProfiles"), legacy);
  h.pick((items) => items.find((i) => i.profile));
  await h.commands.get("terminal.newAgent")();
  assert.deepEqual(h.calls[0].args, ["with spaces"]);
  h.settings.set("agentProfiles", []);
  h.ctx.subscriptions.forEach((d) => d.dispose());
  h.ctx.subscriptions = [];
  await activateBridge(h.ctx);
  assert.deepEqual(h.settings.get("agentProfiles"), []);
});

test("a failed optional MCP connection still launches the agent without credentials", async () => {
  let launch;
  const agent = {
    id: "test", name: "Test", terminalCapabilities: { mcp: true },
    status: async () => ({ ready: true, terminal: true }),
    terminal: async (options) => { launch = options; return { command: "agent", args: [] }; },
  };
  const h = bridgeHarness({ agent, enabledMcp: true, failMcp: true });
  await activateBridge(h.ctx);
  await h.commands.get("terminal.newAgent")();
  assert.equal(launch.mcp, undefined);
  assert.equal(h.calls.length, 1);
  assert.match(h.messages[0], /without AICode MCP/);
  assert.equal(h.decorations.get(1).text, "CLI");
});

test("built-in providers and Terminal AI have no required Chat dependency", () => {
  for (const id of ["claude", "codex", "gemini", "grok", "opencode", "cline", "ollama", "custom"]) {
    const manifest = JSON.parse(readFileSync(new URL(`../mods/aicode.agent-${id}/mod.json`, import.meta.url)));
    assert.deepEqual(manifest.dependencies, ["aicode.agent-runtime"]);
    assert.ok(manifest.contributes.agentProviders.length);
  }
  const bridge = JSON.parse(readFileSync(new URL("../mods/aicode.terminal-ai/mod.json", import.meta.url)));
  assert.deepEqual(bridge.dependencies, ["aicode.terminal", "aicode.agent-runtime"]);
});
