// What the AI Chat gives the mods that bring it an agent (Claude, Codex, Gemini…): one call,
// `defineAgent(ctx, spec)`, turns a description of a CLI and/or an HTTP API into the agent object
// the chat drives. It runs everything with the *agent mod's* ctx, so its `process` permission is
// the one checked — the chat itself starts nothing.
//
// Two ways to reach a model, chosen per agent in its settings (`mode`):
//   "cli" — the vendor's own CLI, signed in with the user's subscription. It reads the folder
//           itself, keeps its own sessions and can use AICode's MCP server.
//   "api" — the vendor's HTTP API with an API key. No CLI needed; the chat sends the files as text.
//           The key lives in the macOS Keychain (or comes from an environment variable of the
//           user's login shell). Requests go through /usr/bin/curl, so the key never sits on a
//           command line and AICode's web view never talks to the network.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\r(?!\n)/g;
export const stripAnsi = (text) => text.replace(ANSI, "");

/** A value for curl's config syntax: "…" with \ and " escaped (JSON has no raw newlines). */
const quote = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;

/** The Keychain item that holds one agent's API key. */
export function keychain(ctx, service) {
  const account = "AICode";
  return {
    async get() {
      let out = "";
      const p = await ctx.process.spawn("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], { onData: (d, s) => s === "stdout" && (out += d) });
      return (await p.done) === 0 ? out.trim() || null : null;
    },
    async set(value) {
      // `security -i` reads its command from stdin: the key is never an argument of a process.
      const cmd = `add-generic-password -U -s ${quote(service)} -a ${quote(account)} -l ${quote(service)} -w ${quote(value)}\n`;
      const p = await ctx.process.spawn("/usr/bin/security", ["-i"], { stdin: cmd });
      if ((await p.done) !== 0) throw new Error("The Keychain did not accept the key.");
    },
    async clear() {
      const p = await ctx.process.spawn("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", account]);
      await p.done;
    },
  };
}

/** An environment variable as the user's login shell sets it (an app from the Dock has none of them). */
const envCache = new Map();
export async function loginEnv(ctx, name) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return null;
  if (!envCache.has(name)) {
    envCache.set(
      name,
      (async () => {
        let out = "";
        const p = await ctx.process.spawn("/bin/zsh", ["-ilc", `printf '__AICODE__%s__AICODE__' "$${name}"`], { onData: (d, s) => s === "stdout" && (out += d) });
        await p.done;
        return out.match(/__AICODE__([\s\S]*?)__AICODE__/)?.[1]?.trim() || null;
      })(),
    );
  }
  return envCache.get(name);
}

/**
 * One HTTP request through curl, streamed. `format`: "sse" (data: lines), "ndjson" (a JSON object
 * per line) or "json" (one body). Calls `onEvent(object)` for each event; resolves `done` with
 * `{ status, error }` — `error` is the API's message when the status is not 2xx.
 */
export async function streamHttp(ctx, { url, method = "POST", headers = {}, body, format = "sse", onEvent, onLog }) {
  const lines = [`url = ${quote(url)}`, `request = ${quote(method)}`, `write-out = "\\n[[aicode-http %{http_code}]]\\n"`];
  for (const [k, v] of Object.entries(headers)) lines.push(`header = ${quote(`${k}: ${v}`)}`);
  if (body !== undefined) lines.push(`data-binary = ${quote(typeof body === "string" ? body : JSON.stringify(body))}`);
  let buffer = "";
  let rest = "";
  let status = 0;
  const handle = (line) => {
    const t = line.trim();
    if (!t) return;
    const m = t.match(/^\[\[aicode-http (\d+)\]\]$/);
    if (m) return void (status = Number(m[1]));
    if (format === "sse") {
      if (t.startsWith("data:")) {
        const data = t.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          return onEvent(JSON.parse(data));
        } catch {}
      }
      if (t.startsWith("event:") || t.startsWith(":")) return;
    } else if (format === "ndjson") {
      try {
        return onEvent(JSON.parse(t));
      } catch {}
    }
    rest += line + "\n";
  };
  const proc = await ctx.process.spawn("/usr/bin/curl", ["-sS", "-N", "--config", "-"], {
    stdin: lines.join("\n") + "\n",
    onData: (data, stream) => {
      if (stream === "stderr") return onLog?.(data);
      buffer += data;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        handle(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    },
  });
  const done = proc.done.then((code) => {
    if (buffer) handle(buffer);
    if (format === "json" && rest.trim() && status < 300) {
      try {
        onEvent(JSON.parse(rest));
      } catch {}
    }
    if (code === null) return { status, error: "Stopped." };
    if (code !== 0 && !status) return { status, error: `Could not reach ${new URL(url).host} (curl exited with ${code}).` };
    if (status >= 300) {
      let msg = rest.trim();
      try {
        const j = JSON.parse(msg);
        const e = Array.isArray(j) ? j[0]?.error : j.error;
        msg = (typeof e === "string" ? e : e?.message) || j.message || msg;
      } catch {}
      return { status, error: `${new URL(url).host} answered ${status}: ${msg || "no details"}` };
    }
    return { status, error: null };
  });
  return { done, kill: () => proc.kill() };
}

const SYSTEM = "You are a coding assistant inside AICode, a code editor. Answer in the user's language. Use Markdown; put code in fenced blocks with the language. When you refer to a file in the open folder, write its path relative to the folder in backticks (`src/main.ts:42`), so the user can click it.";

/**
 * The agent object the chat drives, from a description:
 *
 *   { id, name, icon,
 *     cli: { label, bin, install, readsFiles, resumable, mcp, models, defaultModel, needsModel,
 *            build({ prompt, sessionId, mcp, model }) → { args, env },
 *            parser?({ onText, onTool, onSession, onResult }) → (chunk) => void,
 *            interactive?(model) → args, stderr: "log" },
 *     api: { label, keyUrl, keyHint, envVars: ["ANTHROPIC_API_KEY"], noKey, models, defaultModel, format,
 *            request({ model, system, messages: [{ role, text }], key }) → { url, headers, body },
 *            stream({ text, tool, result, error }) → (event) => void   — one per request } }
 *
 * Either part may be left out; then the agent has that one mode.
 */
export function defineAgent(ctx, spec) {
  const modes = [spec.cli && "cli", spec.api && "api"].filter(Boolean);
  const keys = spec.api && !spec.api.noKey ? keychain(ctx, `AICode ${spec.name} API key`) : null;
  let cache = null;

  const mode = async () => {
    const m = await ctx.settings.get("mode", modes[0]);
    return modes.includes(m) ? m : modes[0];
  };
  const apiKey = async () => {
    if (!keys) return { key: "", source: "none needed" };
    const stored = await keys.get().catch(() => null);
    if (stored) return { key: stored, source: "the Keychain" };
    for (const name of spec.api.envVars ?? []) {
      const v = await loginEnv(ctx, name).catch(() => null);
      if (v) return { key: v, source: `$${name}` };
    }
    return null;
  };

  /** What the chat shows and needs: ready or not, and what this mode can do. */
  const status = async (fresh = false) => {
    if (cache && !fresh) return cache;
    const m = await mode();
    if (m === "cli") {
      const c = spec.cli;
      const path = await ctx.process.which(c.bin).catch(() => null);
      cache = {
        mode: m, modes, label: c.label ?? `${c.bin} CLI`, ready: !!path,
        detail: path ? `${c.label ?? c.bin} — ${path}` : `${c.bin} is not installed or not on your PATH`,
        readsFiles: c.readsFiles !== false, resumable: !!c.resumable, mcp: !!c.mcp,
        models: c.models ?? [], defaultModel: c.defaultModel ?? "", needsModel: !!c.needsModel, terminal: true,
      };
    } else {
      const a = spec.api;
      const k = await apiKey();
      cache = {
        mode: m, modes, label: a.label ?? "API key", ready: !!k,
        detail: !k ? `No API key yet: set one with "Configure ${spec.name}…"` : keys ? `${a.label ?? "API"} — key from ${k.source}` : a.label ?? "API",
        readsFiles: false, resumable: false, mcp: false,
        models: a.models ?? [], defaultModel: a.defaultModel ?? a.models?.[0] ?? "", needsModel: true, terminal: false,
      };
    }
    return cache;
  };

  const setKey = async () => {
    const value = await ctx.window.showInputBox({ prompt: `${spec.name} API key — stored in your macOS Keychain`, placeholder: spec.api.keyHint ?? "paste the key", password: true });
    if (!value?.trim()) return false;
    await keys.set(value.trim());
    cache = null;
    ctx.window.showInfo(`${spec.name}: API key saved in the Keychain.`);
    return true;
  };

  /** Mode, key and install, in one menu (the chat's agent picker opens it). */
  const configure = async () => {
    const m = await mode();
    const s = await status(true);
    const items = [];
    if (spec.cli) items.push({ label: `${m === "cli" ? "✓ " : ""}Use the ${spec.cli.label ?? `${spec.cli.bin} CLI`} (your subscription)`, description: spec.cli.bin, id: "cli" });
    if (spec.api) items.push({ label: `${m === "api" ? "✓ " : ""}Use ${spec.api.label ?? "an API key"}`, description: spec.api.noKey ? "" : "pay per use", id: "api" });
    if (keys) items.push({ label: "Set API Key…", description: "kept in the macOS Keychain", id: "key" });
    if (keys && (await keys.get().catch(() => null))) items.push({ label: "Remove the Stored API Key", id: "clear" });
    if (spec.api?.keyUrl && keys) items.push({ label: "Get an API Key…", description: spec.api.keyUrl, id: "keyUrl" });
    if (spec.cli?.install && m === "cli" && !s.ready) items.push({ label: `Install ${spec.cli.bin}…`, description: spec.cli.install, id: "install" });
    const choice = await ctx.window.showQuickPick(items, { placeholder: `${spec.name}: ${s.detail}` });
    if (!choice) return false;
    if (choice.id === "cli" || choice.id === "api") {
      await ctx.settings.set("mode", choice.id);
      cache = null;
      if (choice.id === "api" && keys && !(await apiKey())) await setKey();
    } else if (choice.id === "key") await setKey();
    else if (choice.id === "clear") {
      await keys.clear();
      cache = null;
    } else if (choice.id === "keyUrl") ctx.external?.open?.(spec.api.keyUrl);
    else if (choice.id === "install") {
      if (/^https?:/.test(spec.cli.install)) ctx.external?.open?.(spec.cli.install);
      else {
        ctx.window.copy(spec.cli.install);
        ctx.window.showInfo(`Copied “${spec.cli.install}”: run it in a terminal, then pick ${spec.name} again.`);
      }
    }
    return true;
  };

  const runCli = async (o) => {
    const c = spec.cli;
    const { args, env } = c.build({ prompt: o.prompt, sessionId: o.sessionId, mcp: o.mcp, model: o.model });
    const parse = c.parser ? c.parser({ onText: o.onText, onTool: o.onTool, onSession: o.onSession, onResult: o.onResult }) : (chunk) => o.onText(stripAnsi(chunk));
    let log = "";
    const proc = await ctx.process.spawn(c.bin, args, {
      cwd: o.cwd,
      env,
      onData: (data, stream) => {
        if (stream === "stdout") parse(data);
        else (log += data), o.onLog?.(stripAnsi(data));
      },
    });
    const done = proc.done.then((code) => {
      if (code === null) return { error: "Stopped." };
      if (code !== 0) return { error: `${c.bin} exited with code ${code}${log.trim() ? " — see the agent log below." : "."}` };
      return { error: null };
    });
    return { done, kill: () => proc.kill() };
  };

  const runApi = async (o) => {
    const a = spec.api;
    const k = await apiKey();
    if (!k) return { done: Promise.resolve({ error: `No ${spec.name} API key. Use "Configure ${spec.name}…" in the agent picker.` }), kill() {} };
    const messages = [...(o.history ?? []).map((t) => ({ role: t.role, text: t.text })), { role: "user", text: o.message }];
    while (messages[0]?.role !== "user") messages.shift();
    const req = a.request({ model: o.model || a.defaultModel, system: SYSTEM, messages, key: k.key });
    let apiError = null;
    const emit = {
      text: (t) => t && o.onText(t),
      tool: (name, input) => o.onTool?.(name, input),
      result: (r) => o.onResult?.(r),
      error: (msg) => (apiError = msg),
    };
    const http = await streamHttp(ctx, { ...req, format: a.format ?? "sse", onEvent: a.stream(emit), onLog: o.onLog });
    return { done: http.done.then((r) => ({ error: r.error ?? apiError })), kill: http.kill };
  };

  return {
    id: spec.id,
    name: spec.name,
    icon: spec.icon,
    status,
    configure,
    /** Runs one turn. Resolves `done` with `{ error }` (null when it went well). */
    run: async (o) => ((await mode()) === "cli" ? runCli(o) : runApi(o)),
    /** The command line for "Open Agent in Terminal" (CLI mode only). */
    terminal: async (model) => {
      if ((await mode()) !== "cli" || !spec.cli) return null;
      return { command: spec.cli.bin, args: spec.cli.interactive ? spec.cli.interactive(model) : [] };
    },
  };
}

export const kit = { defineAgent, streamHttp, keychain, loginEnv, stripAnsi };
