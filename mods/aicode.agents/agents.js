// The agents AICode knows how to drive headless. Each is a CLI the user installed and signed in
// to; AICode only starts it with a prompt and reads what it prints. `mcp` is AICode's MCP server
// (when that mod is on): agents that support it get it, so they can read unsaved buffers and
// propose edits that show up as a diff in the editor.

export const BUILTIN_AGENTS = [
  {
    id: "claude",
    readsFiles: true,
    name: "Claude Code",
    bin: "claude",
    parser: "claude-stream",
    resumable: true,
    interactive: [],
    build: ({ prompt, sessionId, mcp, model }) => {
      const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
      if (model) args.push("--model", model);
      if (sessionId) args.push("--resume", sessionId);
      const env = {};
      if (mcp) {
        // The token reaches the CLI as an environment variable that Claude Code expands inside
        // --mcp-config, so it never appears on a command line.
        args.push("--mcp-config", JSON.stringify({ mcpServers: { aicode: { type: "http", url: mcp.url, headers: { Authorization: "Bearer ${AICODE_MCP_TOKEN}" } } } }));
        args.push("--allowedTools", "mcp__aicode");
        env.AICODE_MCP_TOKEN = mcp.token;
      }
      return { args, env };
    },
  },
  {
    id: "codex",
    readsFiles: true,
    name: "Codex",
    bin: "codex",
    parser: "text",
    stderr: "log",
    interactive: [],
    build: ({ prompt, mcp, model }) => {
      const args = ["exec", "--skip-git-repo-check"];
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
  { id: "gemini", readsFiles: true, name: "Gemini CLI", bin: "gemini", parser: "text", interactive: [], build: ({ prompt, model }) => ({ args: [...(model ? ["--model", model] : []), "-p", prompt] }) },
  { id: "grok", readsFiles: true, name: "Grok CLI", bin: "grok", parser: "text", interactive: [], build: ({ prompt, model }) => ({ args: [...(model ? ["--model", model] : []), "-p", prompt] }) },
  { id: "opencode", readsFiles: true, name: "OpenCode", bin: "opencode", parser: "text", interactive: [], build: ({ prompt, model }) => ({ args: ["run", ...(model ? ["--model", model] : []), prompt] }) },
  { id: "cline", readsFiles: true, name: "Cline", bin: "cline", parser: "text", interactive: [], note: "plan mode (read-only)", build: ({ prompt, model }) => ({ args: ["--plan", "--auto-approve", "true", ...(model ? ["--model", model] : []), prompt] }) },
  {
    id: "ollama",
    name: "Ollama (local)",
    bin: "ollama",
    parser: "text",
    needsModel: true,
    defaultModel: "llama3.2",
    interactive: ["run"],
    build: ({ prompt, model }) => ({ args: ["run", model || "llama3.2", "--nowordwrap", prompt] }),
  },
];

/** A user-defined agent: { id, name, program, args: ["--flag", "{prompt}"] }. */
export function customAgent(def) {
  return {
    id: def.id,
    name: def.name,
    bin: def.program,
    parser: "text",
    custom: true,
    interactive: [],
    build: ({ prompt, model }) => ({ args: (def.args ?? ["{prompt}"]).map((a) => a.replace("{prompt}", prompt).replace("{model}", model ?? "")) }),
  };
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\r(?!\n)/g;

export function stripAnsi(text) {
  return text.replace(ANSI, "");
}

/**
 * Claude Code's stream-json: one JSON object per line. Calls back with text as it arrives, tool
 * uses, the session id and the final result.
 */
export function claudeStreamParser({ onText, onTool, onSession, onResult }) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        onText(line + "\n");
        continue;
      }
      if (ev.session_id) onSession(ev.session_id);
      if (ev.type === "assistant" && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === "text" && block.text) onText(block.text);
          else if (block.type === "tool_use") onTool(block.name, block.input);
        }
      } else if (ev.type === "result") {
        onResult({ text: ev.result, isError: ev.is_error, cost: ev.total_cost_usd, turns: ev.num_turns, ms: ev.duration_ms });
      }
    }
  };
}
