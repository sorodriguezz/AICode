// Optional bridge: the terminal owns PTYs; providers own their CLI; this mod owns their association.
export async function activate(ctx) {
  const terminal = await ctx.mods.get("aicode.terminal");
  const runtime = await ctx.mods.get("aicode.agent-runtime");
  const sessions = new Map();

  // Preserve profiles configured before the launcher was extracted from Terminal.
  if (!(await ctx.settings.get("profilesMigrated", false))) {
    const previous = ctx.config.getFor("aicode.terminal", "agentProfiles", []);
    if (!(await ctx.settings.get("agentProfiles", [])).length && Array.isArray(previous) && previous.length) {
      await ctx.settings.set("agentProfiles", previous);
    }
    await ctx.settings.set("profilesMigrated", true);
  }

  ctx.subscriptions.push(terminal.onDidChange(({ type, terminal: t }) => {
    if (type === "close") sessions.delete(t.id);
    else if (type === "exit" && sessions.has(t.id)) terminal.setDecoration(t.id, { text: "Exited", tooltip: "The agent process has exited." });
  }));
  ctx.subscriptions.push({ dispose: () => {
    for (const id of sessions.keys()) terminal.setDecoration(id, null);
    sessions.clear();
  } });

  const addProfile = async () => {
    const name = await ctx.window.showInputBox({ prompt: "Agent name", placeholder: "My agent" });
    if (!name?.trim()) return;
    const command = await ctx.window.showInputBox({ prompt: "Agent executable (name on PATH or full path)", placeholder: "aider" });
    if (!command?.trim()) return;
    const profiles = await ctx.settings.get("agentProfiles", []);
    await ctx.settings.set("agentProfiles", [...profiles, { name: name.trim(), command: command.trim(), args: [] }]);
    ctx.window.showInfo(`${name.trim()} added. Optional launch arguments are in Terminal AI settings.`);
  };

  const open = async ({ agent, model, profile, inSplit = false, placement = {}, sessionId } = {}) => {
    if (!agent && !profile) {
      const items = [];
      for (const candidate of await runtime.listProviders()) {
        if (!candidate.terminal) continue;
        try {
          const status = await candidate.status(true);
          if (!status.terminal && !status.modes?.includes("cli")) continue;
          items.push({ label: candidate.name, description: status.detail, agent: candidate, icon: candidate.icon ?? "robot" });
        } catch (e) { console.error(`Terminal AI: ${candidate.id}`, e); }
      }
      for (const p of await ctx.settings.get("agentProfiles", [])) {
        if (p?.name && typeof p.command === "string" && p.command.trim()) items.push({ label: p.name, description: p.command, profile: p });
      }
      const choice = await ctx.window.showQuickPick([
        ...items,
        { label: "Add Agent Profile…", add: true },
        { label: "Manage Agent Mods…", manage: true },
      ], { placeholder: inSplit ? "Open an agent in a split terminal" : "Open an agent in a new terminal" });
      if (!choice) return;
      if (choice.add) return addProfile();
      if (choice.manage) return ctx.commands.execute("mods.manage");
      ({ agent, profile } = choice);
    }

    const workspace = ctx.workspace.folder();
    const cwd = (inSplit ? terminal.active()?.cwd : null) ?? workspace ?? undefined;
    let line, mcp;
    if (profile) {
      if (typeof profile.command !== "string" || !profile.command.trim() || (profile.args !== undefined && (!Array.isArray(profile.args) || profile.args.some((a) => typeof a !== "string")))) {
        return ctx.window.showInfo("An agent profile needs an executable and a list of string arguments. Update it in Terminal AI settings.");
      }
      line = { command: profile.command, args: profile.args ?? [] };
    } else {
      let status = await agent.status(true);
      if (!status.terminal || !status.ready) {
        await agent.configure?.();
        status = await agent.status(true);
      }
      if (!status.terminal || !status.ready) return ctx.window.showInfo(status.detail || `Configure ${agent.name}'s CLI first.`);
      if (agent.terminalCapabilities?.mcp && ctx.mods.isEnabled("aicode.mcp-server")) {
        try {
          const server = await ctx.mods.get("aicode.mcp-server");
          mcp = await server.connection();
        } catch (e) {
          ctx.window.showInfo(`The agent will open without AICode MCP: ${e}`);
        }
      }
      // Legacy third-party providers accept a model string; new providers declare capabilities.
      line = await agent.terminal(agent.terminalCapabilities ? { model: model ?? status.defaultModel ?? "", cwd, sessionId, mcp } : model ?? status.defaultModel ?? "");
    }
    if (!line?.command) return;
    const options = { ...line, name: agent?.name ?? profile.name, icon: agent?.icon ?? "robot", keepOpen: true, cwd };
    const t = inSplit ? await terminal.split({ ...placement, ...options }) : await terminal.open(options);
    if (!t || t.exited) return t;
    sessions.set(t.id, { id: t.id, agentId: agent?.id ?? null, name: options.name, workspace });
    terminal.setDecoration(t.id, {
      text: mcp ? "MCP" : "CLI",
      tooltip: mcp ? "AICode MCP configuration passed to the CLI. Check the CLI's MCP status to confirm its connection." : "Interactive agent CLI",
    });
    return t;
  };

  const sendContext = async (kind) => {
    // Capture before opening a picker or moving focus to a terminal.
    const editor = ctx.editor.active();
    const selection = ctx.editor.getSelection();
    const body = kind === "selection" ? selection?.text : ctx.editor.getText(editor?.id);
    if (!editor || !body) return ctx.window.showInfo(kind === "selection" ? "Select some code first." : "Open a text file first.");
    if (body.length > 64000) return ctx.window.showInfo("This context is too large. Select a smaller section, or ask the agent to read the file through MCP.");
    const source = editor.path ?? "Untitled";
    const location = kind === "selection" ? `${source}:${selection.startLine}-${selection.endLine}` : source;
    // Choose a fence longer than any fence inside the source.
    const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    const text = `Context from AICode (${kind === "selection" ? "selected text" : "current editor buffer, including unsaved changes"}): ${location}\n${fence}\n${body}\n${fence}\n`;
    const running = new Set(terminal.list().filter((t) => !t.exited).map((t) => t.id));
    const choices = [...sessions.values()].filter((s) => running.has(s.id) && s.workspace === ctx.workspace.folder());
    const choice = await ctx.window.showQuickPick([
      ...choices.map((s) => ({ label: s.name, description: `Terminal ${s.id}`, id: s.id })),
      { label: "Open New Agent…", newAgent: true },
    ], { placeholder: "Choose the agent to receive this context" });
    if (!choice) return;
    const id = choice.newAgent ? (await open())?.id : choice.id;
    if (id == null) return;
    try {
      await terminal.paste(id, text, { run: false });
    } catch (e) { ctx.window.showInfo(String(e)); }
  };

  ctx.commands.register("terminal.newAgent", () => open());
  ctx.commands.register("terminal.splitAgent", (placement) => open({ inSplit: true, placement }));
  ctx.commands.register("terminal.addAgentProfile", addProfile);
  ctx.commands.register("terminalAI.sendSelection", () => sendContext("selection"));
  ctx.commands.register("terminalAI.sendFile", () => sendContext("file"));
  return { open, sessions: () => [...sessions.values()].map((s) => ({ ...s })) };
}
