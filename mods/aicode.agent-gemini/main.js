// Gemini for the AI Chat, two ways:
//   cli — the Gemini CLI (`gemini -p`), signed in with your Google account: it reads the folder.
//   api — the Gemini API (streamed) with an API key kept in your Keychain.

const MODELS = ["gemini-2.5-pro", "gemini-2.5-flash"];

export async function activate(ctx) {
  const { kit } = await ctx.mods.get("aicode.agents");
  const gemini = kit.defineAgent(ctx, {
    id: "gemini",
    name: "Gemini",
    icon: "star-full",
    cli: {
      label: "the Gemini CLI",
      bin: "gemini",
      install: "npm install -g @google/gemini-cli",
      models: MODELS,
      interactive: (model) => (model ? ["--model", model] : []),
      // --yolo: every tool call approved without asking.
      build: ({ prompt, model, autoApprove }) => ({ args: [...(autoApprove ? ["--yolo"] : []), ...(model ? ["--model", model] : []), "-p", prompt] }),
    },
    api: {
      label: "the Gemini API",
      keyUrl: "https://aistudio.google.com/apikey",
      envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      models: MODELS,
      defaultModel: "gemini-2.5-pro",
      request: ({ model, system, messages, key }) => ({
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] })),
        },
      }),
      stream: (out) => {
        let tokens = 0;
        let model = "";
        return (ev) => {
          if (ev.error) return out.error(ev.error.message ?? "The Gemini API reported an error.");
          const cand = ev.candidates?.[0];
          for (const part of cand?.content?.parts ?? []) if (part.text && !part.thought) out.text(part.text);
          if (cand?.finishReason === "SAFETY" || cand?.finishReason === "PROHIBITED_CONTENT") out.error("Gemini declined this request.");
          if (ev.usageMetadata?.totalTokenCount) tokens = ev.usageMetadata.totalTokenCount;
          if (ev.modelVersion) model = ev.modelVersion;
          if (cand?.finishReason) out.result({ tokens, model });
        };
      },
    },
  });
  ctx.commands.register("gemini.configure", () => gemini.configure());
  return { chatAgents: { gemini } };
}
