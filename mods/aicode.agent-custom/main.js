// Custom agent commands for the AI Chat: any program that takes a message and prints an answer
// (aider, llm, a script of your own…). Each entry of the `commands` setting is one agent:
//   { "id": "aider", "name": "Aider", "program": "aider", "args": ["--message", "{prompt}"] }
// {prompt} becomes the message (with its context) and {model} the model typed in the chat.

const parseLine = (line) => (line.match(/"[^"]*"|\S+/g) ?? []).map((p) => p.replace(/^"|"$/g, ""));

export async function activate(ctx) {
  const { kit } = await ctx.mods.get("aicode.agents");

  let list = await ctx.settings.get("commands", []);
  // Commands added before agents were mods of their own lived in the AI Chat's settings.
  if (!list.length) {
    let old = null;
    try {
      old = ctx.config.getFor("aicode.agents", "customAgents", null);
    } catch {}
    if (Array.isArray(old) && old.length) {
      list = old;
      await ctx.settings.set("commands", list);
    }
  }

  const chatAgents = {};
  for (const def of list) {
    if (!def?.id || !def.program) continue;
    chatAgents[def.id] = kit.defineAgent(ctx, {
      id: def.id,
      name: def.name || def.program,
      icon: "terminal-cmd",
      cli: {
        label: def.program,
        bin: def.program,
        build: ({ prompt, model }) => ({ args: (def.args?.length ? def.args : ["{prompt}"]).map((a) => a.replace("{prompt}", prompt).replace("{model}", model ?? "")) }),
      },
    });
  }

  ctx.commands.register("customAgents.add", async () => {
    const name = await ctx.window.showInputBox({ prompt: "Name of the agent", placeholder: "Aider" });
    if (!name) return;
    const line = await ctx.window.showInputBox({ prompt: "Command line — {prompt} is replaced by the message, {model} by the model field", placeholder: "aider --message {prompt}" });
    if (!line) return;
    const [program, ...args] = parseLine(line);
    if (!program) return;
    const next = [...(await ctx.settings.get("commands", [])), { id: `custom-${Date.now()}`, name, program, args: args.length ? args : ["{prompt}"] }];
    await ctx.settings.set("commands", next);
    ctx.window.showInfo(`${name} added. Reload the window to chat with it.`, { label: "Reload", run: () => location.reload() });
  });
  ctx.commands.register("customAgents.edit", () => ctx.commands.execute("preferences.settings"));

  return { chatAgents };
}
