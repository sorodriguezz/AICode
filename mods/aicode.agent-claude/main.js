// Claude for the AI Chat, two ways:
//   cli — Claude Code (`claude -p`), signed in with your Claude plan: it reads the folder, keeps a
//         session per chat and, with the MCP Server mod on, proposes edits you review as a diff.
//   api — the Claude API (Messages, streamed) with an API key kept in your Keychain.

const CLI_MODELS = ["opus", "sonnet", "haiku"];
const API_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"];
// These take the API's server-side fallback: when a safety classifier declines a request, the API
// re-runs it on a fallback model chosen for that kind of decline, inside the same call.
const FALLBACK = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2"]);

/** Claude Code's stream-json: one JSON object per line. */
function streamJson({ onText, onTool, onSession, onResult }) {
  let buffer = "";
  let wrote = false;
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
          if (block.type === "text" && block.text) {
            // Text between tool calls arrives as separate blocks: keep them apart.
            onText((wrote ? "\n\n" : "") + block.text);
            wrote = true;
          } else if (block.type === "tool_use") onTool(block.name, block.input);
        }
      } else if (ev.type === "result") {
        onResult({ text: ev.result, isError: ev.is_error, cost: ev.total_cost_usd, turns: ev.num_turns });
      }
    }
  };
}

export async function activate(ctx) {
  const { kit } = await ctx.mods.get("aicode.agents");
  const claude = kit.defineAgent(ctx, {
    id: "claude",
    name: "Claude",
    icon: "sparkle",
    cli: {
      label: "Claude Code",
      bin: "claude",
      install: "npm install -g @anthropic-ai/claude-code",
      resumable: true,
      mcp: true,
      models: CLI_MODELS,
      parser: streamJson,
      interactive: (model) => (model ? ["--model", model] : []),
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
    api: {
      label: "the Claude API",
      keyUrl: "https://console.anthropic.com/settings/keys",
      keyHint: "sk-ant-…",
      envVars: ["ANTHROPIC_API_KEY"],
      models: API_MODELS,
      defaultModel: "claude-opus-5-5",
      request: ({ model, system, messages, key }) => {
        const fallback = FALLBACK.has(model);
        return {
          url: "https://api.anthropic.com/v1/messages",
          headers: {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2026-10-21",
            ...(fallback ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
          },
          body: {
            model,
            max_tokens: 64000,
            stream: true,
            system,
            messages: messages.map((m) => ({ role: m.role, content: m.text })),
            ...(fallback ? { fallbacks: "default" } : {}),
          },
        };
      },
      stream: (out) => {
        let input = 0;
        let served = "";
        let blocks = 0;
        return (ev) => {
          if (ev.type === "message_start") {
            input = ev.message?.usage?.input_tokens ?? 0;
            served = ev.message?.model ?? "";
          } else if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
            if (blocks++) out.text("\n\n");
          } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            out.text(ev.delta.text);
          } else if (ev.type === "message_delta") {
            const stop = ev.delta?.stop_reason;
            if (stop === "refusal") out.error("Claude declined this request.");
            else if (stop === "max_tokens") out.error("The answer reached its length limit and was cut off.");
            out.result({ tokens: input + (ev.usage?.output_tokens ?? 0), model: served });
          } else if (ev.type === "error") {
            out.error(ev.error?.message ?? "The Claude API reported an error.");
          }
        };
      },
    },
  });
  ctx.commands.register("claude.configure", () => claude.configure());
  return { chatAgents: { claude } };
}
