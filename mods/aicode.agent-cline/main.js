// Cline for the AI Chat: the `cline` CLI in plan mode (it reads, it does not change files). Cline
// keeps its own providers and keys, so there is no API mode here.

export async function activate(ctx) {
  const { kit } = await ctx.mods.get("aicode.agents");
  const cline = kit.defineAgent(ctx, {
    id: "cline",
    name: "Cline",
    icon: "robot",
    cli: {
      label: "the Cline CLI (plan mode)",
      bin: "cline",
      install: "npm install -g cline",
      build: ({ prompt, model }) => ({ args: ["--plan", "--auto-approve", "true", ...(model ? ["--model", model] : []), prompt] }),
    },
  });
  ctx.commands.register("cline.configure", () => cline.configure());
  return { chatAgents: { cline } };
}
