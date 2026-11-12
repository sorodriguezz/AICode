// Ollama for the AI Chat: models running on this Mac, two ways:
//   cli — `ollama run <model>` for each message.
//   api — the local Ollama server (`ollama serve`, http://127.0.0.1:11434), streamed, with the
//         conversation sent as messages. No key: nothing leaves the machine.

const MODELS = ["llama3.2", "qwen2.5-coder", "deepseek-r1", "gpt-oss"];

export async function activate(ctx) {
  const { kit } = await ctx.mods.get("aicode.agents");
  const ollama = kit.defineAgent(ctx, {
    id: "ollama",
    name: "Ollama",
    icon: "vm",
    cli: {
      label: "the ollama CLI",
      bin: "ollama",
      install: "https://ollama.com/download",
      readsFiles: false,
      needsModel: true,
      models: MODELS,
      defaultModel: "llama3.2",
      interactive: (model) => ["run", model || "llama3.2"],
      build: ({ prompt, model }) => ({ args: ["run", model || "llama3.2", "--nowordwrap", prompt] }),
    },
    api: {
      label: "the local Ollama server",
      noKey: true,
      models: MODELS,
      defaultModel: "llama3.2",
      format: "ndjson",
      request: ({ model, system, messages }) => ({
        url: "http://127.0.0.1:11434/api/chat",
        headers: { "content-type": "application/json" },
        body: { model, stream: true, messages: [{ role: "system", content: system }, ...messages.map((m) => ({ role: m.role, content: m.text }))] },
      }),
      stream: (out) => (ev) => {
        if (ev.error) return out.error(`Ollama: ${ev.error}`);
        if (ev.message?.content) out.text(ev.message.content);
        if (ev.done) out.result({ tokens: (ev.prompt_eval_count ?? 0) + (ev.eval_count ?? 0), model: ev.model });
      },
    },
  });
  ctx.commands.register("ollama.configure", () => ollama.configure());
  return { chatAgents: { ollama } };
}
