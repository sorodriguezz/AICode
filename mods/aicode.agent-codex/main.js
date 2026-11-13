// Codex for the AI Chat, two ways:
//   cli — OpenAI's Codex CLI (`codex exec`), signed in with your ChatGPT plan: it reads the folder
//         and, with the MCP Server mod on, proposes edits you review as a diff.
//   api — the OpenAI API (Responses, streamed) with an API key kept in your Keychain.

export async function activate(ctx) {
  const { kit } = await ctx.mods.get("aicode.agents");
  const codex = kit.defineAgent(ctx, {
    id: "codex",
    name: "Codex",
    icon: "hubot",
    cli: {
      label: "the Codex CLI",
      bin: "codex",
      install: "npm install -g @openai/codex",
      mcp: true,
      models: ["gpt-5", "gpt-5-codex", "gpt-5-mini"],
      interactive: (model) => (model ? ["--model", model] : []),
      build: ({ prompt, mcp, model, autoApprove }) => {
        const args = ["exec", "--skip-git-repo-check"];
        // Edits and commands without asking, outside Codex's sandbox.
        if (autoApprove) args.push("--dangerously-bypass-approvals-and-sandbox");
        if (model) args.push("--model", model);
        const env = {};
        if (mcp) {
          args.push("-c", `mcp_servers.aicode.url="${mcp.url}"`);
          args.push("-c", `mcp_servers.aicode.env_http_headers={ "Authorization" = "AICODE_MCP_AUTH" }`);
          env.AICODE_MCP_AUTH = `Bearer ${mcp.token}`;
        }
        args.push(prompt);
        return { args, env };
      },
    },
    api: {
      label: "the OpenAI API",
      keyUrl: "https://platform.openai.com/api-keys",
      keyHint: "sk-…",
      envVars: ["OPENAI_API_KEY"],
      models: ["gpt-5", "gpt-5-codex", "gpt-5-mini"],
      defaultModel: "gpt-5",
      request: ({ model, system, messages, key }) => ({
        url: "https://api.openai.com/v1/responses",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: { model, instructions: system, stream: true, input: messages.map((m) => ({ role: m.role, content: m.text })) },
      }),
      stream: (out) => (ev) => {
        if (ev.type === "response.output_text.delta") out.text(ev.delta);
        else if (ev.type === "response.completed") out.result({ tokens: ev.response?.usage?.total_tokens, model: ev.response?.model });
        else if (ev.type === "response.failed") out.error(ev.response?.error?.message ?? "The OpenAI API could not answer.");
        else if (ev.type === "error") out.error(ev.message ?? ev.error?.message ?? "The OpenAI API reported an error.");
      },
    },
  });
  ctx.commands.register("codex.configure", () => codex.configure());
  return { chatAgents: { codex } };
}
