// OpenCode for the AI Chat: the `opencode` CLI (`opencode run`). OpenCode keeps its own providers
// and keys (`opencode auth login`), so there is no API mode here: it is already one.

export async function activate(ctx) {
  const { kit } = await ctx.mods.get("aicode.agents");
  const opencode = kit.defineAgent(ctx, {
    id: "opencode",
    name: "OpenCode",
    icon: "terminal",
    cli: {
      label: "OpenCode",
      bin: "opencode",
      install: "npm install -g opencode-ai",
      build: ({ prompt, model }) => ({ args: ["run", ...(model ? ["--model", model] : []), prompt] }),
    },
  });
  ctx.commands.register("opencode.configure", () => opencode.configure());
  return { chatAgents: { opencode } };
}
