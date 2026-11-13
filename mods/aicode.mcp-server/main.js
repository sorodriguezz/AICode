// MCP Server: AICode's editor state as MCP tools. The transport (HTTP on 127.0.0.1, bearer token)
// is the core's; the tools are defined and answered here, with the editor API every mod has.

const TOOLS = [
  {
    name: "list_open_editors",
    title: "List open editors",
    description: "The tabs open in AICode: id, file path (null for an unsaved new file), language, whether it has unsaved changes, and which one is active.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_active_editor",
    title: "Get the active editor",
    description: "The editor the user is looking at: its path, language, cursor and current selection (with the selected text).",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_buffer",
    title: "Read an editor's text",
    description: "The current text of an open editor, including changes the user has not saved. `target` is an editor id from list_open_editors or an absolute file path; a path that is not open is read from disk. Omit it for the active editor.",
    inputSchema: { type: "object", properties: { target: { type: "string", description: "Editor id or absolute path" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "open_file",
    title: "Open a file",
    description: "Opens a file in AICode and optionally moves the cursor to a line.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 } }, required: ["path"] },
  },
  {
    name: "propose_edit",
    title: "Propose an edit",
    description:
      "Shows the user a side-by-side diff of a change to an open editor or a file and waits for them to accept or reject it. Accepted changes go into the editor's buffer as one undoable edit; the user saves. Give either `newText` (the whole new content) or `edits` (ranges, 1-based, end exclusive like the editor's). Returns whether it was accepted.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Editor id or absolute path" },
        description: { type: "string", description: "One line shown to the user: what the change does" },
        newText: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: { startLine: { type: "integer" }, startColumn: { type: "integer" }, endLine: { type: "integer" }, endColumn: { type: "integer" }, text: { type: "string" } },
            required: ["startLine", "startColumn", "endLine", "endColumn", "text"],
          },
        },
      },
      required: ["target"],
    },
  },
  {
    name: "get_workspace",
    title: "Get the workspace",
    description: "The folder open in AICode (or null) and how many editors are open.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  // ----- the interface itself: commands, settings, views and windows -----
  {
    name: "list_commands",
    title: "List AICode commands",
    description: "Every command AICode can run (the command palette's list): id, title, category, the mod that owns it and its keybinding. Filter with `query` (matches id, title or category).",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "run_command",
    title: "Run an AICode command",
    description: "Runs a command by id with optional arguments, as if the user picked it in the command palette. Examples: workbench.toggleSidebar, workbench.toggleZenMode, window.toggleAlwaysOnTop, workbench.openWindowWithLayout [\"agents\"], workbench.moveViewToNewWindow [\"agents.chat\"], preferences.theme.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, args: { type: "array" } }, required: ["id"] },
  },
  {
    name: "get_settings",
    title: "Read AICode settings",
    description: "AICode's configuration. With `key`: that setting's value and where it comes from (default, mods, the user). Without: every setting of `owner` (\"core\" for the editor's own — editor.*, workbench.*, window.* — or a mod id). `schema: true` also returns what each setting accepts.",
    inputSchema: { type: "object", properties: { owner: { type: "string", default: "core" }, key: { type: "string" }, schema: { type: "boolean" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "set_setting",
    title: "Change an AICode setting",
    description: "Sets a setting in the user's profile and applies it right away (null removes the user's value). Anything in the window can be changed this way: colors (workbench.colorCustomizations), transparency (workbench.partOpacity, window.vibrancy), tabs (workbench.tabs.*), the cursor (editor.cursor*), hidden parts (workbench.hide), custom CSS (workbench.customCSS), window layouts (workbench.windowLayouts)…",
    inputSchema: { type: "object", properties: { owner: { type: "string", default: "core" }, key: { type: "string" }, value: {} }, required: ["key", "value"] },
  },
  {
    name: "list_views",
    title: "List views and the layout",
    description: "Every view (explorer, search, chat, terminal…) with where it is and whether it is visible, the layout options, and what this window was opened as.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "show_view",
    title: "Show or move a view",
    description: "Shows a view; with `to` moves it first: \"sidebar\", \"secondary\", \"panel\", \"center\" (in place of the editor) or \"window\" (a new window of its own).",
    inputSchema: { type: "object", properties: { id: { type: "string" }, to: { enum: ["sidebar", "secondary", "panel", "center", "window"] } }, required: ["id"] },
  },
  {
    name: "open_window",
    title: "Open an AICode window",
    description: "Opens a new window: with `layout` (a name in workbench.windowLayouts), or `view` (one view filling it). `alwaysOnTop`, `width`, `height`, `title` and `settings` (core settings for that window only) are optional.",
    inputSchema: {
      type: "object",
      properties: { layout: { type: "string" }, view: { type: "string" }, alwaysOnTop: { type: "boolean" }, width: { type: "number" }, height: { type: "number" }, title: { type: "string" }, settings: { type: "object" } },
    },
  },
];

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const error = (message) => ({ isError: true, content: [{ type: "text", text: message }] });

export async function activate(ctx) {
  let calls = 0;
  let info = null;
  const item = ctx.statusBar.add({ align: "left", priority: 10, icon: "mcp", text: "", tooltip: "AICode MCP server", command: "mcp.showConnection" });

  const paint = () => {
    item.update(info ? { text: calls ? `MCP · ${calls}` : "MCP", tooltip: `AICode MCP server on ${info.url}\n${calls} tool calls this session\nClick for connection details` } : { text: "MCP off", tooltip: "AICode MCP server is stopped" });
  };

  const start = async () => {
    await ctx.mcp.setTools(TOOLS);
    info = await ctx.mcp.start();
    paint();
    return info;
  };

  const sourceName = (args) => args?.client ?? "An MCP client";

  ctx.mcp.onCall(async ({ name, arguments: args = {} }) => {
    calls++;
    paint();
    switch (name) {
      case "list_open_editors":
        return text(ctx.editor.all());
      case "get_active_editor": {
        const active = ctx.editor.active();
        if (!active) return text({ active: null });
        return text({ ...active, selection: ctx.editor.getSelection() });
      }
      case "read_buffer": {
        const target = args.target ?? ctx.editor.active()?.id;
        if (!target) return error("No editor is open.");
        const open = ctx.editor.getText(target);
        if (open !== undefined) return text(open);
        if (typeof target === "string" && ctx.ui.isAbsolute(target)) {
          const f = await ctx.fs.readText(target).catch((e) => ({ error: String(e) }));
          if (f.error) return error(f.error);
          return f.binary ? error(`${target} is binary`) : text(f.text);
        }
        return error(`No open editor ${target}`);
      }
      case "open_file": {
        const r = await ctx.editor.open(args.path, { line: args.line, column: args.column });
        return r ? text(r) : error(`Could not open ${args.path}`);
      }
      case "propose_edit": {
        if (!args.target) return error("target is required");
        const proposal = typeof args.newText === "string" ? { newText: args.newText } : Array.isArray(args.edits) ? { edits: args.edits } : null;
        if (!proposal) return error("Give newText or edits.");
        try {
          const accepted = await ctx.editor.proposeEdit(args.target, proposal, { description: args.description, source: sourceName(args) });
          return text(accepted ? "The user accepted the edit. It is in the editor's buffer, not yet saved." : "The user rejected the edit.");
        } catch (e) {
          return error(String(e));
        }
      }
      case "get_workspace":
        return text({ folder: ctx.workspace.folder(), openEditors: ctx.editor.all().length });
      case "list_commands": {
        const q = String(args.query ?? "").toLowerCase();
        return text(ctx.commands.list().filter((c) => !q || `${c.id} ${c.title} ${c.category ?? ""}`.toLowerCase().includes(q)));
      }
      case "run_command": {
        if (!args.id) return error("id is required");
        if (!ctx.commands.exists(args.id)) return error(`No command ${args.id}. Use list_commands.`);
        try {
          const result = await ctx.commands.execute(args.id, ...(Array.isArray(args.args) ? args.args : []));
          return text(result === undefined ? `Ran ${args.id}.` : { ran: args.id, result });
        } catch (e) {
          return error(String(e));
        }
      }
      case "get_settings": {
        const owner = args.owner ?? "core";
        if (args.key) return text({ owner, key: args.key, ...ctx.config.inspect(args.key, owner), ...(args.schema ? { schema: ctx.config.schema(owner)[args.key] ?? null } : {}) });
        return text(args.schema ? { values: ctx.config.all(owner), schema: ctx.config.schema(owner) } : ctx.config.all(owner));
      }
      case "set_setting": {
        if (!args.key) return error("key is required");
        try {
          await ctx.config.update(args.key, args.value ?? null, args.owner ?? "core");
          return text({ key: args.key, now: ctx.config.getFor(args.owner ?? "core", args.key) });
        } catch (e) {
          return error(String(e));
        }
      }
      case "list_views": {
        const views = ctx.workbench.views().map((v) => ({ id: v.id, title: v.title, location: v.location, owner: v.owner, visible: ctx.views.isVisible(v.id) }));
        return text({ views, center: ctx.workbench.centerView(), options: ctx.workbench.options(), window: ctx.windows.current(), layouts: Object.keys(ctx.windows.layouts()) });
      }
      case "show_view": {
        if (!args.id) return error("id is required");
        if (!ctx.workbench.views().some((v) => v.id === args.id)) return error(`No view ${args.id}. Use list_views.`);
        if (args.to === "window") await ctx.windows.moveViewToNewWindow(args.id);
        else if (args.to === "center") await ctx.workbench.setCenterView(args.id);
        else {
          if (args.to) ctx.workbench.moveView(args.id, args.to);
          await ctx.views.reveal(args.id);
        }
        return text(`Done: ${args.id}${args.to ? ` → ${args.to}` : ""}.`);
      }
      case "open_window": {
        try {
          const label = await ctx.windows.open({ layout: args.layout, view: args.view, alwaysOnTop: args.alwaysOnTop, width: args.width, height: args.height, title: args.title, settings: args.settings });
          return text({ opened: label });
        } catch (e) {
          return error(String(e));
        }
      }
      default:
        return error(`Unknown tool ${name}`);
    }
  });

  const clientConfig = () => ({
    mcpServers: {
      aicode: { type: "http", url: info.url, headers: { Authorization: `Bearer ${info.token}` } },
    },
  });

  ctx.commands.register("mcp.copyConfig", async () => {
    if (!info) await start();
    await ctx.window.copy(JSON.stringify(clientConfig(), null, 2));
    ctx.window.showInfo("Copied. Paste it into your MCP client's configuration. It includes the token: keep it to yourself.");
  });
  ctx.commands.register("mcp.showConnection", async () => {
    if (!info) await start();
    const choice = await ctx.window.showQuickPick(
      [
        { label: "Copy URL", description: info.url, action: "url" },
        { label: "Copy Authorization header", description: "Bearer ••••••••", action: "header" },
        { label: "Copy client configuration (JSON)", description: "mcpServers.aicode", action: "json" },
        { label: "Copy Claude Code command", description: "claude mcp add --transport http aicode …", action: "claude" },
        { label: "Stop server", description: `${calls} calls this session`, action: "stop" },
      ],
      { placeholder: `AICode MCP server — ${info.url}` },
    );
    if (!choice) return;
    if (choice.action === "url") await ctx.window.copy(info.url);
    if (choice.action === "header") await ctx.window.copy(`Bearer ${info.token}`);
    if (choice.action === "json") return ctx.commands.execute("mcp.copyConfig");
    if (choice.action === "claude") await ctx.window.copy(`claude mcp add --transport http aicode ${info.url} --header "Authorization: Bearer ${info.token}"`);
    if (choice.action === "stop") return ctx.commands.execute("mcp.stop");
    ctx.window.showInfo("Copied.");
  });
  ctx.commands.register("mcp.restart", async () => {
    await ctx.mcp.stop();
    await start();
    ctx.window.showInfo(`MCP server listening on ${info.url}`);
  });
  ctx.commands.register("mcp.stop", async () => {
    await ctx.mcp.stop();
    info = null;
    paint();
  });

  try {
    await start();
  } catch (e) {
    ctx.window.showError(`The MCP server could not start: ${e}`);
  }

  /** For other mods (CodeFlow, agents): the connection, starting the server if needed. */
  return {
    connection: async () => info ?? (await start()),
    clientConfig: async () => {
      if (!info) await start();
      return clientConfig();
    },
    tools: TOOLS.map((t) => t.name),
  };
}
