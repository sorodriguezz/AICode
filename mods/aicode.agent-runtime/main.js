import { kit } from "./kit.js";

export function activate(ctx) {
  // Read manifests without loading providers until an interface actually needs them.
  const listProviders = async () => {
    const owners = new Set(["agentProviders", "chatAgents"].flatMap((point) => ctx.mods.contributions(point).map((c) => c.mod)));
    const providers = new Map();
    for (const owner of owners) {
      try {
        const exported = await ctx.mods.get(owner);
        for (const agent of Object.values(exported?.agentProviders ?? exported?.chatAgents ?? {})) {
          if (agent?.id && agent.status) providers.set(agent.id, agent);
        }
      } catch (e) {
        console.error(`Agent Runtime: provider ${owner} failed`, e);
      }
    }
    return [...providers.values()];
  };
  return { kit, listProviders };
}
