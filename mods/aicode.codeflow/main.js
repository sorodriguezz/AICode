// CodeFlow: the bridge to the CodeFlow app, both ways.
//
// AICode → CodeFlow: `codeflow://flow/<name>?input=<json>` starts one of the user's CodeFlow flows
//   (CodeFlow asks before running a link-triggered flow, by default). The input carries the active
//   file and selection.
// CodeFlow → AICode: CodeFlow's agents can connect to the optional AICode MCP server —
//   CodeFlow › Settings › MCP servers, transport "http", the URL and the Authorization header.

export async function activate(ctx) {
  const { h, icon, clear } = ctx.ui;
  const hasMcp = () => ctx.mods.isEnabled("aicode.mcp-server");
  const mcpConnection = async () => {
    const mcp = hasMcp() ? await ctx.mods.get("aicode.mcp-server") : null;
    return mcp?.connection();
  };
  let recent = await ctx.settings.get("recentFlows", []);
  let root;

  const installed = () => ctx.external.appInstalled("CodeFlow");

  const flowInput = (what) => {
    const active = ctx.editor.active();
    if (what === "none" || !active?.language) return null;
    const sel = ctx.editor.getSelection();
    const input = { source: "aicode", file: active.path, title: active.title, language: active.language, folder: ctx.workspace.folder() };
    if (what === "selection" && sel?.text) Object.assign(input, { selection: sel.text, startLine: sel.startLine, endLine: sel.endLine });
    else input.text = ctx.editor.getText(active.id);
    return input;
  };

  const runFlow = async (name, what = "selection") => {
    if (!name) {
      const typed = await ctx.window.showQuickPick(
        [...recent.map((r) => ({ label: r, description: "recent" })), { label: "Type a flow name…", description: "", typed: true }],
        { placeholder: "CodeFlow flow to run" },
      );
      if (!typed) return;
      name = typed.typed ? await ctx.window.showInputBox({ prompt: "Name of the CodeFlow flow (as in codeflow://flow/<name>)", placeholder: "nightly-build" }) : typed.label;
      if (!name) return;
    }
    const slug = name.trim();
    const input = flowInput(what);
    let url = `codeflow://flow/${encodeURIComponent(slug)}`;
    if (input) {
      const json = JSON.stringify(input);
      // Links are not a transport for whole files: a big buffer goes as its path only.
      url += `?input=${encodeURIComponent(json.length > 60_000 ? JSON.stringify({ ...input, text: undefined, truncated: true }) : json)}`;
    }
    try {
      await ctx.external.open(url);
      recent = [slug, ...recent.filter((r) => r !== slug)].slice(0, 8);
      await ctx.settings.set("recentFlows", recent);
      render();
    } catch (e) {
      ctx.window.showError(`CodeFlow did not open the flow: ${e}`);
    }
  };

  const copyMcp = async () => {
    if (!hasMcp()) return ctx.window.showInfo("Enable the AICode MCP Server mod to connect CodeFlow's agents.");
    const info = await mcpConnection().catch(() => null);
    if (!info) return ctx.window.showError("The AICode MCP server is unavailable.");
    await ctx.window.copy(JSON.stringify({ name: "aicode", transport: "http", url: info.url, headers: { Authorization: `Bearer ${info.token}` } }, null, 2));
    ctx.window.showInfo("Copied. In CodeFlow: Settings › MCP servers › add one with transport http, this URL and the Authorization header.");
  };

  const render = async () => {
    if (!root) return;
    const isInstalled = await installed();
    clear(root);
    const connection = h("div", { class: "stack" }, h("div", { class: "muted" }, "Connecting to MCP…"));
    let what = "selection";
    const flowName = h("input", { class: "input", placeholder: "flow name", value: recent[0] ?? "", onkeydown: (e) => e.key === "Enter" && runFlow(flowName.value, what) });
    const whatSelect = h(
      "select",
      { class: "input", onchange: (e) => (what = e.target.value) },
      h("option", { value: "selection" }, "Send the selection (or the file)"),
      h("option", { value: "file" }, "Send the whole file"),
      h("option", { value: "none" }, "Send nothing"),
    );
    const copyRow = (label, value, secret) =>
      h(
        "div",
        { style: { display: "flex", gap: "4px", alignItems: "center" } },
        h("span", { class: "muted", style: { width: "56px", flex: "0 0 auto" } }, label),
        h("input", { class: "input", readOnly: true, value: secret ? "Bearer ••••••••••••" : value, style: { fontFamily: "var(--font-mono)", fontSize: "11px" } }),
        h("button", { class: "icon-button", title: `Copy ${label}`, onclick: () => ctx.window.copy(value).then(() => ctx.window.showInfo(`${label} copied.`)) }, icon("copy")),
      );
    root.append(
      h(
        "div",
        { class: "pad stack" },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "8px" } },
          icon("git-merge"),
          h("b", null, "CodeFlow"),
          h("span", { class: `state-dot${isInstalled ? " active" : ""}` }, isInstalled ? "installed" : "not found"),
        ),
        h("button", { class: "btn block", disabled: !isInstalled, onclick: () => ctx.external.open("", "CodeFlow") }, icon("link-external"), "Open CodeFlow"),

        h("div", { class: "section-header", style: { marginTop: "18px" } }, h("span", null, "Run a flow")),
        h("div", { class: "muted", style: { fontSize: "12px" } }, "Starts one of your CodeFlow flows. CodeFlow asks before running a flow a link started."),
        flowName,
        whatSelect,
        h("button", { class: "btn block", disabled: !isInstalled, onclick: () => runFlow(flowName.value, what) }, icon("play"), "Run in CodeFlow"),
        recent.length ? h("div", null, recent.map((r) => h("div", { class: "list-row", onclick: () => runFlow(r, what), title: `codeflow://flow/${r}` }, icon("history"), h("span", { class: "name" }, r)))) : null,

        hasMcp() ? h(
          "div", { class: "stack", style: { marginTop: "18px" } },
          h("div", { class: "section-header" }, h("span", null, "Let CodeFlow's agents use AICode")),
          h(
            "div",
            { class: "muted", style: { fontSize: "12px" } },
            "Add AICode as an MCP server in CodeFlow (Settings › MCP servers, transport http). Its agents can then list your open editors, read unsaved text, and propose edits that open here as a diff.",
          ),
          connection,
          h("button", { class: "btn secondary block", onclick: copyMcp }, icon("copy"), "Copy server settings (JSON)"),
          h("div", { class: "muted", style: { fontSize: "11px" } }, "The header holds a secret token for this machine. Only programs that have it can reach the editor."),
        ) : null,
      ),
    );
    if (connection.isConnected) {
      const info = await mcpConnection().catch(() => null);
      clear(connection);
      if (info) connection.append(copyRow("URL", info.url), copyRow("Header", `Bearer ${info.token}`, true));
      else connection.append(h("div", { class: "err" }, "The MCP server is unavailable."));
    }
  };

  ctx.views.provide("codeflow", {
    actions: [{ icon: "refresh", title: "Refresh", run: () => render() }],
    render: (el) => {
      root = el;
      render();
    },
    onShow: () => render(),
  });

  ctx.commands.register("codeflow.open", () => ctx.external.open("", "CodeFlow"));
  ctx.commands.register("codeflow.runFlow", (name) => runFlow(typeof name === "string" ? name : undefined));
  ctx.commands.register("codeflow.copyMcp", copyMcp);
}
