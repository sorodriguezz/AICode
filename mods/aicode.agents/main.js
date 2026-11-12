// AI Chat: the secondary side bar's chat — the panel only. The agents come from other mods (Claude,
// Codex, Gemini, Grok, OpenCode, Cline, Ollama, custom commands): each declares
// `contributes.chatAgents` and exports `chatAgents` from activate(), usually built with the `kit`
// this mod exports (see kit.js). An agent answers through its CLI (the user's subscription) or its
// API (an API key); with the MCP Server mod on, CLI agents that support it also get AICode's tools,
// so the edits they propose open as a diff to accept or reject.
//
// Laid out like VS Code's chat: attachments over the input (the active file, files picked with
// "Add Context…"), agent and model pickers under it, slash commands, actions on each message,
// and a history of past chats.

import { kit } from "./kit.js";
import { renderMarkdown } from "./markdown.js";

const isMac = navigator.platform.toLowerCase().includes("mac");

const STYLE = `
.chat { position: absolute; inset: 0; display: flex; flex-direction: column; }
.chat-log { flex: 1 1 auto; overflow-y: auto; padding: 4px 14px 14px; user-select: text; -webkit-user-select: text; cursor: auto; }
.chat-welcome { margin: 40px 10px 10px; color: var(--aicode-descriptionForeground); text-align: center; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.chat-welcome > .codicon { font-size: 44px; opacity: .55; margin-bottom: 8px; }
.chat-welcome .title { font-size: 15px; font-weight: 600; color: var(--aicode-foreground); }
.chat-welcome .sub { font-size: 12px; line-height: 1.5; max-width: 300px; }
.chat-suggest { display: flex; flex-direction: column; gap: 6px; margin-top: 18px; width: 100%; max-width: 320px; }
.chat-suggest button { display: flex; align-items: center; gap: 8px; text-align: left; padding: 7px 10px; border-radius: 6px; border: 1px solid var(--aicode-widget-border); background: transparent; color: var(--aicode-foreground); cursor: pointer; font: inherit; font-size: 12px; }
.chat-suggest button:hover { background: var(--aicode-list-hoverBackground); }
.chat-suggest button .codicon { font-size: 14px; color: var(--aicode-descriptionForeground); }
.chat-tip { margin-top: 22px; font-size: 12px; line-height: 1.5; max-width: 320px; }
.msg { margin: 6px 0 14px; position: relative; }
.msg.msg-enter { animation: card-in var(--motion-slow) var(--ease-out) both; }
.msg .who { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12px; margin-bottom: 6px; min-height: 22px; }
.msg .who .codicon { font-size: 14px; }
.msg .who .meta { font-weight: 400; color: var(--aicode-descriptionForeground); font-size: 11px; }
.msg .msg-actions { margin-left: auto; display: flex; gap: 0; opacity: 0; transition: opacity var(--motion-fast) ease; }
.msg:hover .msg-actions, .msg:focus-within .msg-actions { opacity: 1; }
.msg .msg-actions .icon-button { width: 22px; height: 22px; }
body .msg .msg-actions .codicon { font-size: 14px; }
.msg.user .body { background: var(--aicode-chat-requestBackground, var(--aicode-input-background)); border: 1px solid var(--aicode-input-border); border-radius: 8px; padding: 7px 10px; white-space: pre-wrap; word-break: break-word; }
.msg.user .refs { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.msg .body { line-height: 1.55; word-break: break-word; }
.msg .body p { margin: 0 0 8px; }
.msg .body h3, .msg .body h4, .msg .body h5, .msg .body h6 { margin: 14px 0 6px; font-size: 13px; }
.msg .body h3 { font-size: 14px; }
.msg .body ul, .msg .body ol { margin: 4px 0 8px; padding-left: 20px; }
.msg .body li { margin: 2px 0; }
.msg .body li.nested { margin-left: 16px; }
.msg .body li:has(> input[type="checkbox"]) { list-style: none; margin-left: -18px; }
.msg .body li > input[type="checkbox"] { margin: 0 4px 0 0; vertical-align: -2px; }
.msg .body hr { border: 0; border-top: 1px solid var(--aicode-widget-border); margin: 12px 0; }
.msg .body code { font-family: var(--font-mono); font-size: 12px; background: var(--aicode-textCodeBlock-background, #ffffff14); padding: 1px 4px; border-radius: 3px; }
.msg .body code.file-link, .msg .body a { color: var(--aicode-textLink-foreground, #4daafc); cursor: pointer; }
.msg .body code.file-link:hover, .msg .body a:hover { text-decoration: underline; }
.msg .body blockquote { margin: 4px 0 8px; padding-left: 10px; border-left: 3px solid var(--aicode-widget-border); color: var(--aicode-descriptionForeground); }
.msg .body .md-table { overflow-x: auto; margin: 6px 0 10px; }
.msg .body table { border-collapse: collapse; font-size: 12px; }
.msg .body th, .msg .body td { border: 1px solid var(--aicode-widget-border); padding: 3px 8px; text-align: left; }
.msg .body th { background: var(--aicode-editorWidget-background); }
.code-block { margin: 8px 0; border: 1px solid var(--aicode-widget-border); border-radius: 6px; overflow: hidden; }
.code-block .bar { display: flex; align-items: center; gap: 0; padding: 1px 3px 1px 8px; background: var(--aicode-editorWidget-background); font-size: 11px; color: var(--aicode-descriptionForeground); min-height: 24px; }
.code-block .bar .lang { margin-right: auto; }
.code-block .bar .icon-button { width: 22px; height: 22px; }
body .code-block .bar .codicon { font-size: 14px; }
.code-block pre { margin: 0; padding: 8px 10px; overflow-x: auto; background: var(--aicode-editor-background); }
.msg .body .code-block pre code { background: none; padding: 0; border-radius: 0; font-size: 12px; line-height: 1.45; white-space: pre; }
.tools { margin: 0 0 8px; font-size: 12px; color: var(--aicode-descriptionForeground); }
.tools summary { cursor: pointer; display: flex; align-items: center; gap: 6px; list-style: none; padding: 2px 0; }
.tools summary::-webkit-details-marker { display: none; }
.tools summary .codicon { font-size: 14px; }
.tools[open] summary .chev { transform: rotate(90deg); }
.tools .chev { transition: transform var(--motion-fast) ease; }
.tool-line { display: flex; gap: 6px; align-items: center; margin: 3px 0 3px 20px; animation: row-in var(--motion) var(--ease-out) both; }
.tool-line .codicon { font-size: 13px; }
.working { display: flex; align-items: center; gap: 6px; color: var(--aicode-descriptionForeground); font-size: 12px; }
.log-details { font-size: 11px; color: var(--aicode-descriptionForeground); margin-top: 6px; }
.log-details pre { white-space: pre-wrap; max-height: 200px; overflow: auto; margin: 4px 0 0; font-family: var(--font-mono); }
.err { color: var(--aicode-errorForeground); white-space: pre-wrap; border-left: 3px solid var(--aicode-errorForeground); padding: 4px 8px; margin-top: 6px; background: var(--aicode-inputValidation-errorBackground, #5a1d1d55); border-radius: 0 4px 4px 0; }
.chat-input { position: relative; flex: 0 0 auto; margin: 0 10px 10px; border: 1px solid var(--aicode-input-border); border-radius: 8px; background: var(--aicode-input-background); }
.chat-input:focus-within { border-color: var(--aicode-focusBorder); }
.chat-chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px 0; }
.ctx-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; height: 20px; padding: 0 6px; border-radius: 4px; border: 1px solid var(--aicode-widget-border); color: var(--aicode-foreground); cursor: default; max-width: 220px; }
.ctx-chip .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctx-chip.suggested { border-style: dashed; color: var(--aicode-descriptionForeground); font-style: italic; cursor: pointer; }
.ctx-chip .x { cursor: pointer; opacity: .7; display: inline-flex; }
.ctx-chip .x:hover { opacity: 1; }
.ctx-chip .codicon { font-size: 12px; }
.ctx-add { height: 20px; padding: 0 5px; font-size: 11px; display: inline-flex; align-items: center; gap: 3px; border-radius: 4px; border: 1px solid var(--aicode-widget-border); background: transparent; color: var(--aicode-foreground); cursor: pointer; }
.ctx-add:hover { background: var(--aicode-toolbar-hoverBackground); }
.ctx-add .codicon { font-size: 12px; }
.chat-input textarea { width: 100%; box-sizing: border-box; border: 0; background: transparent; color: var(--aicode-input-foreground); padding: 8px 10px 4px; resize: none; max-height: 240px; min-height: 40px; line-height: 1.45; font: inherit; user-select: text; -webkit-user-select: text; }
.chat-input textarea:focus { outline: none; }
.chat-input textarea::placeholder { color: var(--aicode-input-placeholderForeground); }
.chat-row { display: flex; align-items: center; gap: 2px; padding: 2px 6px 6px; }
.pick { display: inline-flex; align-items: center; gap: 3px; height: 22px; padding: 0 6px; border-radius: 4px; border: 0; background: transparent; color: var(--aicode-descriptionForeground); font: inherit; font-size: 12px; cursor: pointer; max-width: 160px; }
.pick:hover { background: var(--aicode-toolbar-hoverBackground); color: var(--aicode-foreground); }
.pick .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
body .pick .codicon { font-size: 12px; }
.chat-row .grow { flex: 1; }
.chat-row .send { width: 26px; height: 26px; border-radius: 4px; }
.chat-row .send.ready { background: var(--aicode-button-background); color: var(--aicode-button-foreground); }
.chat-row .send.stop { color: var(--aicode-foreground); }
.slash-menu { position: absolute; left: 0; right: 0; bottom: calc(100% + 4px); background: var(--aicode-quickInput-background, var(--aicode-menu-background)); border: 1px solid var(--aicode-widget-border); border-radius: 6px; padding: 4px; box-shadow: 0 2px 8px var(--aicode-widget-shadow); z-index: 20; }
.slash-menu .item { display: flex; gap: 8px; align-items: baseline; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.slash-menu .item b { font-family: var(--font-mono); font-weight: 600; }
.slash-menu .item span { color: var(--aicode-descriptionForeground); }
.slash-menu .item.active { background: var(--aicode-quickInputList-focusBackground); color: var(--aicode-quickInputList-focusForeground); }
.slash-menu .item.active span { color: inherit; opacity: .8; }
`;

/** /commands: a short way to ask the usual things. */
const SLASH = [
  { name: "explain", detail: "Explain how the selected code or the active file works", prompt: "Explain how this code works, step by step." },
  { name: "fix", detail: "Find and fix problems in the selection or the file", prompt: "Find the bugs or problems in this code and propose a fix." },
  { name: "tests", detail: "Write tests for the selection or the file", prompt: "Write unit tests for this code, using the test framework the project already uses." },
  { name: "doc", detail: "Add documentation comments", prompt: "Add clear documentation comments to this code. Keep the code itself unchanged." },
  { name: "review", detail: "Review the code like a careful colleague", prompt: "Review this code: correctness first, then clarity. List concrete issues with their location." },
  { name: "clear", detail: "Start a new chat", action: "clear" },
];

const SHELL_LANGS = new Set(["sh", "bash", "zsh", "shell", "console", "shellscript", "fish", "powershell", "ps1", "pwsh", "bat", "cmd"]);

export async function activate(ctx) {
  const { h, icon, iconButton, clear, basename, dirname, fileIcon, fileIconColor } = ctx.ui;
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);
  ctx.subscriptions.push({ dispose: () => style.remove() });

  // ---------- agents (from other mods) ----------

  /** The agent objects, and what each one says about itself (ready? which mode? models?). */
  let agents = [];
  const statuses = new Map();
  let agentsState = "loading"; // "loading" | "ready"
  let agentId = await ctx.settings.get("agent", null);
  const models = await ctx.settings.get("models", {});
  const refreshStatuses = (fresh = false) =>
    Promise.all(agents.map(async (a) => statuses.set(a.id, await a.status(fresh).catch((e) => ({ ready: false, detail: String(e), models: [] })))));
  // Loaded once the chat is first drawn — never inside activate(), since each agent mod asks this
  // one for its kit while it activates.
  let loading = null;
  const loadAgents = () =>
    (loading ??= (async () => {
      const owners = [...new Set(ctx.mods.contributions("chatAgents").map((c) => c.mod))];
      const found = [];
      for (const id of owners) {
        try {
          const exported = await ctx.mods.get(id);
          for (const a of Object.values(exported?.chatAgents ?? {})) if (a?.id && a.run) found.push(a);
        } catch (e) {
          console.error(`AI Chat: the agent mod ${id} failed`, e);
        }
      }
      agents = found;
      await refreshStatuses();
      const ready = (id) => statuses.get(id)?.ready;
      if (!agents.some((a) => a.id === agentId) || !ready(agentId)) agentId = agents.find((a) => ready(a.id))?.id ?? (agents.some((a) => a.id === agentId) ? agentId : agents[0]?.id ?? null);
      agentsState = "ready";
      paintPickers();
      paint();
    })());
  const statusOf = (a) => (a ? statuses.get(a.id) : null);
  const configureAgent = async (a = agent()) => {
    if (!a?.configure) return;
    if (await a.configure()) {
      statuses.set(a.id, await a.status(true));
      paintPickers();
      paint();
    }
  };
  const showAgentMods = () => ctx.commands.execute("mods.manage", "agent");
  let includeActive = true;
  let attachments = []; // { kind: "file", path } | { kind: "selection", path, title, startLine, endLine, text, language }
  let chat = newChatState();
  let running = null;
  let root, log, textarea, chips, sendBtn, agentBtn, modelBtn, slashMenu;
  let promptHistory = [];
  let historyIndex = -1;

  function newChatState() {
    return { id: `chat-${Date.now()}`, title: "", messages: [], sessions: {}, at: Date.now() };
  }
  const agent = () => agents.find((a) => a.id === agentId);
  const rel = (p) => {
    const f = ctx.workspace.folder();
    return f && p?.startsWith(f + "/") ? p.slice(f.length + 1) : p;
  };

  // ---------- history ----------

  const HISTORY_MAX = 30;
  let history = await ctx.settings.get("history", []);
  const saveHistory = async () => {
    const msgs = chat.messages.filter((m) => !m.pending);
    if (!msgs.length) return;
    const entry = {
      id: chat.id,
      title: chat.title || msgs.find((m) => m.role === "user")?.text.slice(0, 80) || "Chat",
      at: Date.now(),
      agent: agentId,
      sessions: chat.sessions,
      messages: msgs.map(({ role, text, agent, meta, tools, error, refs }) => ({ role, text: text.slice(0, 60000), agent, meta, tools, error, refs })),
    };
    history = [entry, ...history.filter((x) => x.id !== chat.id)].slice(0, HISTORY_MAX);
    await ctx.settings.set("history", history);
    await ctx.settings.set("current", chat.id);
  };
  const loadChat = (entry) => {
    if (running) stop();
    chat = { id: entry.id, title: entry.title, sessions: { ...(entry.sessions ?? {}) }, at: entry.at, messages: entry.messages.map((m) => ({ ...m, tools: m.tools ?? [], log: "", shown: true })) };
    if (entry.agent && (agentsState === "loading" || agents.some((a) => a.id === entry.agent))) agentId = entry.agent;
    paintPickers();
    paint();
    ctx.settings.set("current", chat.id);
  };
  const current = await ctx.settings.get("current", null);
  const restored = history.find((x) => x.id === current);
  if (restored) loadChat(restored);

  // ---------- context ----------

  const mcpConnection = async () => {
    if (!ctx.mods.isEnabled("aicode.mcp-server")) return null;
    try {
      const server = await ctx.mods.get("aicode.mcp-server");
      return await server.connection();
    } catch {
      return null;
    }
  };

  const activeContext = () => {
    const active = ctx.editor.active();
    if (!active || !active.language) return null;
    const sel = ctx.editor.getSelection();
    return { active, sel: sel && sel.text ? sel : null };
  };

  const readFile = async (path) => {
    const open = ctx.editor.all().find((e) => e.path === path);
    if (open) return ctx.editor.getText(open.id) ?? "";
    try {
      const f = await ctx.fs.readText(path);
      return f.binary ? null : f.text;
    } catch {
      return null;
    }
  };

  /** The context as text; `a` is the agent's status (does it read the folder itself?). */
  const contextBlock = async (a) => {
    const parts = [];
    const clip = (t) => (t.length > 120_000 ? t.slice(0, 120_000) + "\n… (truncated)" : t);
    const c = includeActive ? activeContext() : null;
    if (c) {
      const { active, sel } = c;
      const name = active.path ? rel(active.path) : `${active.title} (unsaved, not on disk)`;
      if (sel) parts.push(`The user selected lines ${sel.startLine}-${sel.endLine} of ${name}:\n\`\`\`${active.language}\n${sel.text}\n\`\`\``);
      else if (!active.path || active.dirty || !a.readsFiles) parts.push(`The user is editing ${name}${active.dirty && active.path ? " (with unsaved changes)" : ""}:\n\`\`\`${active.language}\n${clip(ctx.editor.getText(active.id) ?? "")}\n\`\`\``);
      else parts.push(`The user has ${name} open in the editor.`);
    }
    for (const at of attachments) {
      if (at.kind === "selection") {
        parts.push(`Lines ${at.startLine}-${at.endLine} of ${rel(at.path) ?? at.title}:\n\`\`\`${at.language ?? ""}\n${at.text}\n\`\`\``);
      } else if (at.kind === "file") {
        if (c?.active.path === at.path && !c.sel) continue;
        // Agents that read the folder themselves get the path; the others the text.
        const open = ctx.editor.all().find((e) => e.path === at.path);
        if (a.readsFiles && !open?.dirty) parts.push(`The user attached the file ${rel(at.path)}.`);
        else {
          const text = await readFile(at.path);
          if (text != null) parts.push(`The user attached ${rel(at.path)}:\n\`\`\`\n${clip(text)}\n\`\`\``);
        }
      }
    }
    return parts.join("\n\n");
  };

  /** The earlier turns: as messages for API agents, as text for CLI agents without sessions. */
  const pastTurns = (n) => chat.messages.filter((m) => !m.error && !m.pending && m.text).slice(-n).map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: m.sent ?? m.text }));
  const transcript = () => {
    const turns = pastTurns(8);
    if (!turns.length) return "";
    return "Conversation so far:\n" + turns.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n\n") + "\n\n";
  };

  const attachFile = (path) => {
    if (!path || attachments.some((x) => x.kind === "file" && x.path === path)) return;
    attachments.push({ kind: "file", path });
    paintChips();
  };

  const attachSelection = () => {
    const c = activeContext();
    if (!c?.sel) return ctx.window.showInfo("Select some code in the editor first.");
    const { active, sel } = c;
    attachments.push({ kind: "selection", path: active.path, title: active.title, startLine: sel.startLine, endLine: sel.endLine, text: sel.text, language: active.language });
    paintChips();
  };

  const addContext = async (e) => {
    const r = e?.currentTarget?.getBoundingClientRect?.();
    const pickFiles = async () => {
      const files = await ctx.workspace.listFiles(20000).catch(() => []);
      if (!files.length) return ctx.window.showInfo(ctx.workspace.folder() ? "No files found in the folder." : "Open a folder to attach its files, or attach open editors.");
      const choice = await ctx.window.showQuickPick(
        files.map((f) => ({ label: basename(f), description: dirname(f) === "." || !f.includes("/") ? "" : dirname(f), path: `${ctx.workspace.folder()}/${f}` })),
        { placeholder: "Search for files to attach", matchDescription: true },
      );
      if (choice) attachFile(choice.path);
    };
    const open = ctx.editor.all().filter((x) => x.path);
    const items = [
      { label: "Files & Folders…", icon: "file", run: pickFiles },
      { label: "Open Editors", icon: "files", disabled: !open.length, run: () => open.forEach((x) => attachFile(x.path)) },
      { label: "Selection", icon: "selection", disabled: !activeContext()?.sel, run: attachSelection },
    ];
    if (r) ctx.window.contextMenu(r.left, r.top - 4 - items.length * 24 - 10, items);
    else pickFiles();
  };

  // ---------- sending ----------

  const expandSlash = (text) => {
    const m = text.match(/^\/(\w+)\b\s*([\s\S]*)$/);
    if (!m) return { text };
    const cmd = SLASH.find((s) => s.name === m[1]);
    if (!cmd) return { text };
    if (cmd.action === "clear") return { action: "clear" };
    return { text: m[2].trim() ? `${cmd.prompt}\n\n${m[2].trim()}` : cmd.prompt, shown: text };
  };

  const send = async (raw, opts = {}) => {
    const typed = (raw ?? textarea.value).trim();
    if (!typed || running) return;
    const expanded = expandSlash(typed);
    if (expanded.action === "clear") {
      textarea.value = "";
      autosize();
      return newChat();
    }
    const question = expanded.text;
    await loadAgents();
    const a = agent();
    if (!a) {
      ctx.window.showInfo("Turn on an agent mod first (Claude, Codex, Gemini…).", { label: "Show Agent Mods", run: showAgentMods });
      return;
    }
    const st = statuses.get(a.id) ?? (await a.status());
    if (!st.ready) {
      ctx.window.showWarning(`${a.name}: ${st.detail}`, { label: `Configure ${a.name}…`, run: () => configureAgent(a) }, { label: "Choose Another Agent", run: () => pickAgent() });
      return;
    }
    if (!opts.keepInput) {
      promptHistory = [typed, ...promptHistory.filter((p) => p !== typed)].slice(0, 50);
      historyIndex = -1;
      textarea.value = "";
      autosize();
      hideSlash();
    }
    const context = await contextBlock(st);
    const refs = [];
    const c = includeActive ? activeContext() : null;
    if (c) refs.push({ label: c.active.title + (c.sel ? `:${c.sel.startLine}-${c.sel.endLine}` : ""), path: c.active.path, line: c.sel?.startLine });
    for (const at of attachments) refs.push(at.kind === "file" ? { label: basename(at.path), path: at.path } : { label: `${at.title}:${at.startLine}-${at.endLine}`, path: at.path, line: at.startLine });
    attachments = [];
    const mcp = st.mcp ? await mcpConnection() : null;
    const history = pastTurns(20);
    const previous = !st.resumable || !chat.sessions[a.id] ? transcript() : "";
    const mcpNote = mcp ? "\n\n(You are running inside the AICode editor. Its MCP tools — server `aicode` — read what is open, unsaved text included; to change a file the user has open, use propose_edit so they can review it.)" : "";
    const message = [context, question].filter(Boolean).join("\n\n") + mcpNote;
    const prompt = [previous, context, question].filter(Boolean).join("\n\n") + mcpNote;
    if (!chat.title) chat.title = (expanded.shown ?? question).split("\n")[0].slice(0, 80);
    chat.messages.push({ role: "user", text: expanded.shown ?? question, sent: question, refs });
    const reply = { role: "assistant", agent: a.name, text: "", tools: [], log: "", error: "", meta: "", pending: true, started: Date.now() };
    chat.messages.push(reply);
    paint();

    const onText = (t) => {
      reply.text += t;
      paintLast();
    };
    const onTool = (name, input) => {
      const target = input?.target || input?.path || input?.file_path || input?.pattern || input?.command;
      reply.tools.push(`${String(name).replace(/^mcp__aicode__/, "aicode · ")}${target ? ` — ${String(target).includes("/") ? basename(String(target)) : String(target).slice(0, 60)}` : ""}`);
      paintLast();
    };
    const onResult = (r) => {
      if (r.isError) reply.error = r.text || "The agent reported an error.";
      else if (!reply.text && r.text) reply.text = r.text;
      const bits = [];
      if (r.cost) bits.push(`$${r.cost.toFixed(4)}`);
      if (r.turns) bits.push(`${r.turns} turn${r.turns === 1 ? "" : "s"}`);
      if (r.tokens) bits.push(`${r.tokens.toLocaleString()} tokens`);
      if (r.model) bits.push(r.model);
      reply.meta = bits.join(" · ");
    };

    const tick = setInterval(() => reply.pending && paintLast(), 1000);
    try {
      running = await a.run({
        prompt,
        message,
        history,
        sessionId: chat.sessions[a.id],
        mcp,
        model: models[a.id] || st.defaultModel || "",
        cwd: ctx.workspace.folder() ?? undefined,
        onText,
        onTool,
        onResult,
        onSession: (id) => (chat.sessions[a.id] = id),
        onLog: (t) => {
          reply.log += t;
          paintLast();
        },
      });
      paint();
      const result = await running.done;
      if (result?.error && !reply.error) reply.error = result.error;
    } catch (e) {
      reply.error = String(e);
    } finally {
      clearInterval(tick);
      running = null;
      reply.pending = false;
      const secs = ((Date.now() - reply.started) / 1000).toFixed(1);
      reply.meta = [reply.meta, `${secs}s`].filter(Boolean).join(" · ");
      paint();
      saveHistory();
    }
  };

  const stop = () => running?.kill();

  const retry = () => {
    if (running) return;
    const lastUser = [...chat.messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    const i = chat.messages.lastIndexOf(lastUser);
    chat.messages.splice(i);
    // The agent's own session already holds the failed turn; start that agent afresh.
    delete chat.sessions[agentId];
    send(lastUser.text, { keepInput: true });
  };

  const editMessage = (m) => {
    if (running) return;
    const i = chat.messages.indexOf(m);
    chat.messages.splice(i);
    delete chat.sessions[agentId];
    textarea.value = m.text;
    autosize();
    paint();
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  };

  const newChat = () => {
    if (running) stop();
    chat = newChatState();
    attachments = [];
    ctx.settings.set("current", null);
    paint();
    textarea?.focus();
  };

  const showHistory = async () => {
    if (!history.length) return ctx.window.showInfo("No past chats yet.");
    const when = (t) => {
      const d = (Date.now() - t) / 1000;
      return d < 3600 ? `${Math.max(1, Math.round(d / 60))} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : new Date(t).toLocaleDateString();
    };
    const choice = await ctx.window.showQuickPick(
      history.map((x) => ({ label: x.title, description: `${agents.find((a) => a.id === x.agent)?.name ?? ""} · ${when(x.at)}`, id: x.id })),
      { placeholder: "Select a chat to restore" },
    );
    if (choice) loadChat(history.find((x) => x.id === choice.id));
  };

  // ---------- rendering ----------

  const openRef = async (raw) => {
    const m = String(raw).match(/^(.*?)(?::(\d+)(?::(\d+))?|#L(\d+)(?:-L?\d+)?)?$/);
    let path = m[1];
    const line = Number(m[2] ?? m[4]) || undefined;
    const column = Number(m[3]) || undefined;
    if (!path.startsWith("/")) {
      const folder = ctx.workspace.folder();
      if (!folder) return ctx.window.showInfo(`Open a folder to follow ${raw}.`);
      path = `${folder}/${path.replace(/^\.\//, "")}`;
    }
    try {
      const st = await ctx.fs.stat(path);
      if (!st.exists) return ctx.window.showInfo(`${raw} was not found in this folder.`);
      if (st.is_dir) return ctx.mods.get("aicode.explorer").then((x) => x?.reveal?.(path));
    } catch {}
    ctx.editor.open(path, { line, column });
  };

  const codeBlock = (pre, lang, code) => {
    const insert = () => {
      if (!ctx.editor.replaceSelection(code)) ctx.window.showInfo("Open an editor first.");
    };
    const propose = async () => {
      const active = ctx.editor.active();
      if (!active?.language) return ctx.window.showInfo("Open the file to change first.");
      const sel = ctx.editor.getSelection();
      const edits = sel && sel.text ? [{ startLine: sel.startLine, startColumn: sel.startColumn, endLine: sel.endLine, endColumn: sel.endColumn, text: code }] : null;
      await ctx.editor.proposeEdit(active.id, edits ? { edits } : { newText: code }, { description: edits ? "replace the selection" : "replace the whole file" });
    };
    const shell = SHELL_LANGS.has((lang || "").toLowerCase());
    const copyBtn = iconButton("copy", "Copy", () => {
      ctx.window.copy(code);
      copyBtn.replaceChildren(icon("check"));
      setTimeout(() => copyBtn.replaceChildren(icon("copy")), 1200);
    });
    return h(
      "div",
      { class: "code-block" },
      h(
        "div",
        { class: "bar" },
        h("span", { class: "lang" }, lang || "text"),
        shell && ctx.commands.exists("terminal.sendText") ? iconButton("terminal", "Run in Terminal", () => ctx.commands.execute("terminal.sendText", code.replace(/^\$ /gm, ""))) : null,
        iconButton("diff", "Apply to Editor (review as a diff: the selection, or the whole file)", propose),
        iconButton("insert", "Insert at Cursor", insert),
        copyBtn,
        iconButton("new-file", "Open in New Editor", () => ctx.editor.newUntitled(code, lang || "plaintext")),
      ),
      pre,
    );
  };

  const refChip = (ref) =>
    h(
      "span",
      { class: "ctx-chip", title: ref.path ?? ref.label, style: { cursor: ref.path ? "pointer" : "default" }, onclick: () => ref.path && ctx.editor.open(ref.path, { line: ref.line }) },
      fileGlyph(ref.label),
      h("span", { class: "label" }, ref.label),
    );

  const fileGlyph = (name) => {
    if (ctx.ui.fileIconEl) return ctx.ui.fileIconEl(name.replace(/:\d+-\d+$/, ""));
    const el = icon(fileIcon(name.replace(/:\d+-\d+$/, "")));
    const c = fileIconColor?.(name.replace(/:\d+-\d+$/, ""));
    if (c) el.style.color = c;
    return el;
  };

  const renderMessage = (m, i) => {
    // A message slides in once, when it first appears — not on every streamed update.
    const enter = m.shown ? "" : " msg-enter";
    m.shown = true;
    const last = i === chat.messages.length - 1;
    if (m.role === "user") {
      return h(
        "div",
        { class: `msg user${enter}`, dataset: { index: String(i) } },
        h(
          "div",
          { class: "who" },
          icon("account"),
          "You",
          h(
            "span",
            { class: "msg-actions" },
            iconButton("edit", "Edit and Resend", () => editMessage(m)),
            iconButton("copy", "Copy", () => ctx.window.copy(m.text)),
          ),
        ),
        h("div", { class: "body" }, m.text, m.refs?.length ? h("div", { class: "refs" }, m.refs.map(refChip)) : null),
      );
    }
    const body = h("div", { class: "body" });
    if (m.text) renderMarkdown(body, m.text, codeBlock);
    body.addEventListener("click", (e) => {
      const link = e.target.closest?.("[data-href], .file-link");
      if (!link) return;
      e.preventDefault();
      if (link.dataset.href) ctx.external.open(link.dataset.href);
      else if (link.dataset.path) openRef(link.dataset.path.replace(/&amp;/g, "&"));
    });
    const working = m.pending && !m.text && !m.error;
    const secs = m.pending ? Math.floor((Date.now() - m.started) / 1000) : 0;
    const tools = m.tools.length
      ? h(
          "details",
          { class: "tools", open: m.pending ? true : null },
          h("summary", null, icon("chevron-right", "chev"), icon(m.pending ? "loading" : "tools", m.pending ? "codicon-modifier-spin" : ""), m.pending ? `Working — ${m.tools[m.tools.length - 1]}` : `Used ${m.tools.length} tool${m.tools.length === 1 ? "" : "s"}`),
          m.tools.map((t) => h("div", { class: "tool-line" }, icon("circle-small-filled"), t)),
        )
      : null;
    return h(
      "div",
      { class: `msg assistant${enter}`, dataset: { index: String(i) } },
      h(
        "div",
        { class: "who" },
        icon("sparkle"),
        m.agent,
        m.meta ? h("span", { class: "meta" }, m.meta) : null,
        !m.pending
          ? h(
              "span",
              { class: "msg-actions" },
              last ? iconButton("refresh", "Retry", retry) : null,
              iconButton("copy", "Copy", () => ctx.window.copy(m.text)),
            )
          : null,
      ),
      tools,
      working ? h("div", { class: "working" }, icon("loading", "codicon-modifier-spin"), `Working…${secs >= 2 ? ` ${secs}s` : ""}`) : null,
      body,
      m.error ? h("div", { class: "err" }, m.error) : null,
      m.log?.trim() ? h("details", { class: "log-details" }, h("summary", null, "Agent log"), h("pre", null, m.log.trim().slice(-20000))) : null,
    );
  };

  let paintQueued = false;
  const paintLast = () => {
    if (paintQueued || !log) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      const i = chat.messages.length - 1;
      const old = log.querySelector(`[data-index="${i}"]`);
      const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
      if (old) {
        const open = old.querySelector("details.tools")?.open;
        const next = renderMessage(chat.messages[i], i);
        if (open !== undefined && next.querySelector("details.tools")) next.querySelector("details.tools").open = open || chat.messages[i].pending;
        old.replaceWith(next);
      } else paint();
      if (stick) log.scrollTop = log.scrollHeight;
    });
  };

  const paintChips = () => {
    if (!chips) return;
    clear(chips);
    chips.append(h("button", { class: "ctx-add", title: "Add Context…", onclick: addContext }, icon("attach"), "Add Context…"));
    const c = activeContext();
    if (c) {
      const label = c.active.title + (c.sel ? `:${c.sel.startLine}-${c.sel.endLine}` : "");
      if (includeActive) {
        chips.append(
          h(
            "span",
            { class: "ctx-chip", title: `${c.active.path ?? c.active.title}${c.sel ? " (selection)" : ""} — goes along as context` },
            fileGlyph(c.active.title),
            h("span", { class: "label" }, label),
            h("span", { class: "x", title: "Leave Out", onclick: () => { includeActive = false; paintChips(); } }, icon("close")),
          ),
        );
      } else {
        chips.append(h("span", { class: "ctx-chip suggested", title: "Attach the active editor", onclick: () => { includeActive = true; paintChips(); } }, icon("add"), h("span", { class: "label" }, label)));
      }
    }
    attachments.forEach((at, n) => {
      const label = at.kind === "file" ? basename(at.path) : `${at.title}:${at.startLine}-${at.endLine}`;
      chips.append(
        h(
          "span",
          { class: "ctx-chip", title: at.path ?? label },
          fileGlyph(label),
          h("span", { class: "label" }, label),
          h("span", { class: "x", title: "Remove", onclick: () => { attachments.splice(n, 1); paintChips(); } }, icon("close")),
        ),
      );
    });
  };

  const paint = () => {
    if (!log) return;
    clear(log);
    if (!chat.messages.length && (agentsState === "loading" || !agents.length)) {
      log.append(
        agentsState === "loading"
          ? h("div", { class: "chat-welcome" }, icon("loading", "codicon-modifier-spin"), h("div", { class: "sub" }, "Loading agents…"))
          : h(
              "div",
              { class: "chat-welcome" },
              icon("chat-sparkle"),
              h("div", { class: "title" }, "Add an agent to chat with"),
              h("div", { class: "sub" }, "Each AI is a mod of its own — Claude, Codex, Gemini, Grok, OpenCode, Cline, Ollama, or your own command. Turn on the ones you use, then sign in with their CLI (your subscription) or give them an API key."),
              h("div", { class: "chat-suggest" }, h("button", { onclick: showAgentMods }, icon("extensions"), "Show Agent Mods")),
            ),
      );
    } else if (!chat.messages.length) {
      const a = agent();
      const st = statusOf(a);
      const ok = !!st?.ready;
      const c = activeContext();
      log.append(
        h(
          "div",
          { class: "chat-welcome" },
          icon("chat-sparkle"),
          h("div", { class: "title" }, ok ? `Ask ${a.name}` : `${a.name} is not set up`),
          h(
            "div",
            { class: "sub" },
            ok
              ? st.mode === "api"
                ? `It answers through the ${a.name} API with your key; the files you attach go along as text. AI answers can be wrong: review what it proposes.`
                : `It runs in ${ctx.workspace.folder() ? basename(ctx.workspace.folder()) : "your home folder"} with ${st.label} and your own login. AI answers can be wrong: review what it proposes.`
              : st?.detail ?? "",
          ),
          !ok ? h("div", { class: "chat-suggest" }, h("button", { onclick: () => configureAgent(a) }, icon("settings-gear"), `Configure ${a.name}…`)) : null,
          ok
            ? h(
                "div",
                { class: "chat-suggest" },
                [
                  c ? { icon: "book", text: `Explain ${c.sel ? "the selection" : c.active.title}`, prompt: "/explain" } : { icon: "book", text: "Explain how this project is organized", prompt: "Explain how this project is organized: the main folders, entry points and how the pieces talk to each other." },
                  c ? { icon: "bug", text: `Find problems in ${c.sel ? "the selection" : c.active.title}`, prompt: "/fix" } : { icon: "search", text: "Where is … handled?", fill: "Where in this project is " },
                  c ? { icon: "beaker", text: "Write tests for it", prompt: "/tests" } : { icon: "lightbulb", text: "Suggest improvements to the code", prompt: "Suggest the three most valuable improvements to this codebase, with the files involved." },
                ].map((s) => h("button", { onclick: () => (s.fill ? (textarea.value = s.fill, autosize(), textarea.focus()) : send(s.prompt)) }, icon(s.icon), s.text)),
              )
            : null,
          h(
            "div",
            { class: "chat-tip" },
            !st?.mcp
              ? "The active file goes along as context. Type / for commands."
              : ctx.mods.isEnabled("aicode.mcp-server")
                ? `The active file goes along as context, and ${a.name} can propose edits through AICode's MCP server — you review each one as a diff.`
                : "The active file goes along as context. Type / for commands. Enable the MCP Server mod to let the agent propose edits you review as a diff.",
          ),
        ),
      );
    }
    chat.messages.forEach((m, i) => log.append(renderMessage(m, i)));
    log.scrollTop = log.scrollHeight;
    if (sendBtn) {
      sendBtn.replaceChildren(icon(running ? "debug-stop" : "send"));
      sendBtn.title = running ? "Stop" : "Send (Enter)";
      sendBtn.classList.toggle("stop", !!running);
      sendBtn.classList.toggle("ready", !running && !!textarea?.value.trim());
    }
    paintChips();
  };

  const autosize = () => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(240, textarea.scrollHeight)}px`;
    sendBtn?.classList.toggle("ready", !running && !!textarea.value.trim());
  };

  // ---------- pickers ----------

  const paintPickers = () => {
    if (!agentBtn) return;
    const a = agent();
    const st = statusOf(a);
    agentBtn.replaceChildren(icon(a?.icon ?? "sparkle"), h("span", { class: "label" }, a ? a.name : agentsState === "loading" ? "Agents…" : "Add Agent…"), icon("chevron-down"));
    agentBtn.title = a ? `Agent: ${a.name} — ${st?.detail ?? ""}` : "Choose an agent";
    modelBtn.style.display = a ? "" : "none";
    const model = (a && models[a.id]) || st?.defaultModel || "";
    modelBtn.replaceChildren(h("span", { class: "label" }, model || "Default model"), icon("chevron-down"));
    modelBtn.title = model ? `Model: ${model}` : "The CLI's default model";
    if (textarea) textarea.placeholder = a ? `Ask ${a.name}… (/ for commands)` : "Turn on an agent mod to chat";
  };

  const pickAgent = (e) => {
    const r = e?.currentTarget?.getBoundingClientRect?.();
    const current = agent();
    const items = [
      ...agents.map((a) => {
        const st = statusOf(a);
        return { label: `${a.name}${st?.ready ? (st.modes?.length > 1 ? ` · ${st.mode === "api" ? "API" : "CLI"}` : "") : " — not set up"}`, checked: a.id === agentId, run: () => selectAgent(a.id) };
      }),
      { separator: true, label: "" },
      ...(current?.configure ? [{ label: `Configure ${current.name}…`, run: () => configureAgent(current) }] : []),
      { label: "Add More Agents…", run: showAgentMods },
    ];
    if (r) ctx.window.contextMenu(r.left, r.top - items.length * 24 - 14, items);
    else ctx.commands.execute("agents.pickAgent");
  };

  const pickModel = async (e) => {
    const a = agent();
    if (!a) return;
    const st = statusOf(a) ?? {};
    const r = e?.currentTarget?.getBoundingClientRect?.();
    const current = models[a.id] ?? "";
    const known = [...new Set([...(st.models ?? []), ...(current ? [current] : [])])];
    const setModel = async (v) => {
      if (v) models[a.id] = v;
      else delete models[a.id];
      await ctx.settings.set("models", models);
      paintPickers();
    };
    const items = [
      ...(st.needsModel ? [] : [{ label: "Default (the CLI's choice)", checked: !current, run: () => setModel("") }]),
      ...known.map((m) => ({ label: m, checked: current === m || (!current && st.needsModel && m === st.defaultModel), run: () => setModel(m) })),
      { separator: true, label: "" },
      {
        label: "Other Model…",
        run: async () => {
          const v = await ctx.window.showInputBox({ prompt: `Model name for ${a.name}`, value: current, placeholder: st.defaultModel || "model name" });
          if (v !== undefined && v !== null) setModel(v.trim());
        },
      },
    ];
    if (r) ctx.window.contextMenu(r.left, r.top - items.length * 24 - 14, items);
  };

  const selectAgent = async (id) => {
    agentId = id;
    await ctx.settings.set("agent", id);
    const a = agent();
    if (a) statuses.set(a.id, await a.status(true));
    paintPickers();
    paint();
    if (a && !statuses.get(a.id)?.ready) configureAgent(a);
  };

  // ---------- slash menu ----------

  let slashIndex = 0;
  const hideSlash = () => {
    slashMenu?.remove();
    slashMenu = null;
  };
  const updateSlash = () => {
    const m = textarea.value.match(/^\/(\w*)$/);
    const list = m ? SLASH.filter((s) => s.name.startsWith(m[1])) : [];
    if (!list.length) return hideSlash();
    slashIndex = Math.min(slashIndex, list.length - 1);
    const menu = h(
      "div",
      { class: "slash-menu" },
      list.map((s, n) =>
        h(
          "div",
          { class: `item${n === slashIndex ? " active" : ""}`, onmousedown: (e) => { e.preventDefault(); chooseSlash(s); } },
          h("b", null, `/${s.name}`),
          h("span", null, s.detail),
        ),
      ),
    );
    menu.list = list;
    if (slashMenu) slashMenu.replaceWith(menu);
    else textarea.closest(".chat-input").append(menu);
    slashMenu = menu;
  };
  const chooseSlash = (s) => {
    hideSlash();
    if (s.action === "clear") {
      textarea.value = "";
      autosize();
      return newChat();
    }
    textarea.value = `/${s.name} `;
    autosize();
    textarea.focus();
  };

  // ---------- the view ----------

  const openInTerminal = async () => {
    if (!ctx.mods.isEnabled("aicode.terminal")) return ctx.window.showInfo("Enable the Terminal mod to run agents interactively.", { label: "Open Mods", run: () => ctx.commands.execute("mods.manage") });
    await loadAgents();
    const a = agent();
    if (!a) return showAgentMods();
    const line = await a.terminal?.(models[a.id] || statusOf(a)?.defaultModel || "");
    if (!line) return ctx.window.showInfo(`${a.name} answers through its API here. Switch it to its CLI to open it in a terminal.`, { label: `Configure ${a.name}…`, run: () => configureAgent(a) });
    const term = await ctx.mods.get("aicode.terminal");
    term.open({ command: line.command, args: line.args, name: a.name, cwd: ctx.workspace.folder() ?? undefined });
  };

  ctx.views.provide("agents.chat", {
    actions: [
      {
        icon: "add",
        title: "New Chat",
        run: () => newChat(),
        dropdownTitle: "More New Chat Options",
        dropdown: (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          ctx.window.contextMenu(r.left - 140, r.bottom + 4, [
            { label: "New Chat", run: () => newChat() },
            { label: "New Chat in Terminal", run: openInTerminal },
          ]);
        },
      },
      { icon: "history", title: "Show Chats…", run: () => showHistory() },
      {
        icon: "ellipsis",
        title: "Views and More Actions…",
        run: (e) => {
          const r = e?.currentTarget?.getBoundingClientRect?.() ?? { left: 200, bottom: 60 };
          ctx.window.contextMenu(r.left - 180, r.bottom + 4, [
            { label: "Select Agent…", run: () => ctx.commands.execute("agents.pickAgent") },
            { label: `Configure ${agent()?.name ?? "Agent"}…`, disabled: !agent(), run: () => configureAgent() },
            { label: "Add More Agents…", run: showAgentMods },
            { label: "Open Agent in Terminal", run: openInTerminal },
            { separator: true, label: "" },
            { label: "Show Chats…", run: () => showHistory() },
            { label: "Delete All Past Chats…", disabled: !history.length, run: () => ctx.commands.execute("agents.clearHistory") },
          ]);
        },
      },
    ],
    render: (el) => {
      root = el;
      log = h("div", { class: "chat-log" });
      chips = h("div", { class: "chat-chips" });
      textarea = h("textarea", {
        rows: 1,
        placeholder: "Ask… (/ for commands)",
        oninput: () => {
          autosize();
          slashIndex = 0;
          updateSlash();
        },
        onblur: () => setTimeout(hideSlash, 100),
        onkeydown: (e) => {
          if (slashMenu) {
            const list = slashMenu.list;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              slashIndex = (slashIndex + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
              return updateSlash();
            }
            if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
              e.preventDefault();
              return chooseSlash(list[slashIndex]);
            }
            if (e.key === "Escape") {
              e.preventDefault();
              return hideSlash();
            }
          }
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            send();
          } else if (e.key === "ArrowUp" && !textarea.value.includes("\n") && textarea.selectionStart === 0 && promptHistory.length) {
            // ↑ at the start brings back what was sent before.
            e.preventDefault();
            historyIndex = Math.min(historyIndex + 1, promptHistory.length - 1);
            textarea.value = promptHistory[historyIndex];
            autosize();
          } else if (e.key === "ArrowDown" && historyIndex >= 0 && !textarea.value.includes("\n")) {
            e.preventDefault();
            historyIndex--;
            textarea.value = historyIndex >= 0 ? promptHistory[historyIndex] : "";
            autosize();
          } else if (e.key === "Escape" && running) {
            stop();
          }
        },
      });
      agentBtn = h("button", { class: "pick", onclick: pickAgent });
      modelBtn = h("button", { class: "pick", onclick: pickModel });
      sendBtn = h("button", { class: "icon-button send", title: "Send (Enter)", onclick: () => (running ? stop() : send()) }, icon("send"));
      root.append(
        h(
          "div",
          { class: "chat" },
          log,
          h("div", { class: "chat-input" }, chips, textarea, h("div", { class: "chat-row" }, agentBtn, modelBtn, h("span", { class: "grow" }), sendBtn)),
        ),
      );
      paintPickers();
      paint();
      textarea.focus();
      loadAgents();
    },
    onShow: () => textarea?.focus(),
  });

  ctx.editor.onDidChangeActive(() => {
    paintChips();
    if (!chat.messages.length) paint();
  });
  ctx.monaco && ctx.editor.monacoEditor().onDidChangeCursorSelection(() => chips && paintChips());

  ctx.commands.register("agents.newChat", newChat);
  ctx.commands.register("agents.showHistory", showHistory);
  ctx.commands.register("agents.ask", async () => {
    await ctx.views.reveal("agents.chat");
    includeActive = true;
    paintChips();
    textarea?.focus();
  });
  ctx.commands.register("agents.attachFile", async (path) => {
    await ctx.views.reveal("agents.chat", false);
    attachFile(typeof path === "string" ? path : ctx.editor.active()?.path);
    textarea?.focus();
  });
  ctx.commands.register("agents.attachSelection", async () => {
    await ctx.views.reveal("agents.chat", false);
    attachSelection();
    textarea?.focus();
  });
  ctx.commands.register("agents.pickAgent", async () => {
    await loadAgents();
    if (!agents.length) return ctx.window.showInfo("No agent mods are on.", { label: "Show Agent Mods", run: showAgentMods });
    const choice = await ctx.window.showQuickPick(agents.map((a) => ({ label: a.name, description: statusOf(a)?.detail ?? "", id: a.id })), { placeholder: "Select the agent to chat with" });
    if (choice) selectAgent(choice.id);
  });
  ctx.commands.register("agents.configureAgent", async () => {
    await loadAgents();
    if (!agent()) return showAgentMods();
    configureAgent();
  });
  ctx.commands.register("agents.openInTerminal", openInTerminal);
  ctx.commands.register("agents.clearHistory", async () => {
    if (!(await ctx.window.confirm("Delete all past chats?", "The chats are removed from this profile. This cannot be undone.", "Delete"))) return;
    history = [];
    await ctx.settings.set("history", []);
  });
  // For other mods (and JSON mods' "ask" actions): send a prompt to the chat, as if typed.
  return {
    ask: async (prompt) => {
      await ctx.views.reveal("agents.chat");
      for (let i = 0; i < 50 && !textarea; i++) await new Promise((r) => setTimeout(r, 20));
      if (running) {
        ctx.window.showWarning("The agent is still answering; try again when it is done.");
        return;
      }
      await send(String(prompt));
    },
    attach: (path) => attachFile(path),
    /** For agent mods: `kit.defineAgent(ctx, spec)` and the pieces it is made of (kit.js). */
    kit,
  };
}
