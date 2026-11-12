// Grok for the AI Chat, two ways:
//   cli — a Grok CLI (`grok -p`) you installed and signed in to.
//   api — the xAI API (chat completions, streamed) with an API key kept in your Keychain.

const MODELS = ["grok-4", "grok-code-fast-1"];

export async function activate(ctx) {
  const { kit } = await ctx.mods.get("aicode.agents");
  const grok = kit.defineAgent(ctx, {
    id: "grok",
    name: "Grok",
    icon: "rocket",
    cli: {
      label: "the Grok CLI",
      bin: "grok",
      models: MODELS,
      build: ({ prompt, model }) => ({ args: [...(model ? ["--model", model] : []), "-p", prompt] }),
    },
    api: {
      label: "the xAI API",
      keyUrl: "https://console.x.ai",
      keyHint: "xai-…",
      envVars: ["XAI_API_KEY"],
      models: MODELS,
      defaultModel: "grok-4",
      request: ({ model, system, messages, key }) => ({
        url: "https://api.x.ai/v1/chat/completions",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: { model, stream: true, messages: [{ role: "system", content: system }, ...messages.map((m) => ({ role: m.role, content: m.text }))] },
      }),
      stream: (out) => (ev) => {
        if (ev.error) return out.error(ev.error.message ?? String(ev.error));
        const delta = ev.choices?.[0]?.delta?.content;
        if (delta) out.text(delta);
        if (ev.usage) out.result({ tokens: ev.usage.total_tokens, model: ev.model });
      },
    },
  });
  ctx.commands.register("grok.configure", () => grok.configure());
  return { chatAgents: { grok } };
}
