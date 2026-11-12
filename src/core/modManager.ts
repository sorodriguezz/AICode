// The Mods page: what is installed, what is on in this profile, what each mod may do, and what is
// actually running right now and what it costs. It is a core page, so it works with no mod enabled.

import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke, ModInfo } from "./ipc";
import { h, icon, clear, append, toDisposable } from "./ui";
import { ModHost } from "./mods";
import { EditorService } from "./editor";
import { notify, inputBox, confirm, contextMenu } from "./widgets";
import * as commands from "./commands";
import { Emitter } from "./events";

interface Stats {
  pid: number;
  rss_kb: number | null;
  running: { kind: string; id: number; owner: string; label: string; pid: number | null; rss_kb: number | null }[];
  mcp: { port: number; url: string; owner: string; tools: number } | null;
}

let pendingReload = false;

export function openModManager(host: ModHost, editors: EditorService) {
  editors.openPage({
    title: "Mods",
    icon: "extensions",
    key: "mods",
    restore: "mods",
    render: (root) => {
      let filter = "";
      let installed: ModInfo[] = [];
      let permissions = new Map<string, string>();
      let profile: { name: string; available: string[] } = { name: "default", available: ["default"] };
      let stats: Stats | null = null;

      const page = h("div", { class: "mods-page" });
      root.append(page);

      const refresh = async () => {
        const [list, perms, prof] = await Promise.all([
          invoke<ModInfo[]>("mods_list"),
          invoke<[string, string][]>("mods_permissions"),
          invoke<{ name: string; available: string[] }>("profile_get"),
        ]);
        installed = list;
        permissions = new Map(perms);
        profile = prof;
        render();
      };
      const refreshStats = async () => {
        stats = await invoke<Stats>("resource_stats");
        const table = page.querySelector(".running");
        if (table) table.replaceWith(renderRunning());
      };

      const toggle = async (mod: ModInfo) => {
        if (!mod.enabled && mod.permissions.length) {
          const asks = mod.permissions.map((p) => `• ${permissions.get(p) ?? p}`).join("\n");
          const ok = await confirm(`Enable ${mod.name}?`, `It will be able to:\n${asks}`, "Enable");
          if (!ok) return;
        }
        try {
          const changed = await invoke<string[]>("profile_set_enabled", { id: mod.id, enabled: !mod.enabled });
          const others = changed.filter((c) => c !== mod.id);
          if (others.length) notify("info", `${mod.enabled ? "Also turned off" : "Also turned on"}: ${others.join(", ")}`);
          pendingReload = true;
        } catch (e) {
          notify("error", String(e));
        }
        refresh();
      };

      const runtimeState = (id: string) => host.list().find((m) => m.id === id);

      let firstRender = true;
      let cardIndex = 0;
      const card = (mod: ModInfo) => {
        const rt = runtimeState(mod.id);
        const state = !mod.enabled ? "Off" : rt?.state === "active" ? `Running${rt.loadMs != null ? ` · loaded in ${rt.loadMs} ms` : ""}` : rt?.state === "failed" ? "Failed" : rt?.state === "activating" ? "Starting…" : mod.main ? "Waiting — loads when used" : "Declarative — nothing to run";
        const contributes = mod.contributes ?? {};
        const adds = [
          ...(contributes.views ?? []).map((v: any) => `${v.title} (${v.location ?? "sidebar"})`),
          ...(contributes.themes ?? []).map((t: any) => `theme ${t.label}`),
          ...(contributes.snippets ?? []).map((s: any) => `${s.language} snippets`),
        ];
        const delay = firstRender ? Math.min(cardIndex++, 12) * 30 : 0;
        return h(
          "div",
          { class: firstRender ? "mod-card card-enter" : "mod-card", style: { animationDelay: `${delay}ms` } },
          h("div", { class: "mod-icon" }, icon(mod.icon ?? "extensions")),
          h(
            "div",
            null,
            h("div", { class: "title" }, h("b", null, mod.name), h("span", { class: "muted" }, `v${mod.version}`), h("span", { class: "muted" }, mod.id)),
            h("div", { class: "desc" }, mod.description),
            h(
              "div",
              { class: "meta" },
              h("span", { class: "chip outline", title: mod.source === "profile" ? "Installed only in this profile; exported with it" : mod.source === "shared" ? "Installed for every profile" : "Comes with AICode" }, mod.source === "bundled" ? "bundled" : mod.source === "profile" ? "this profile" : "all profiles"),
              !mod.main ? h("span", { class: "chip outline" }, "declarative") : null,
              ...mod.permissions.map((p) => h("span", { class: "chip", title: permissions.get(p) ?? p }, icon(p.startsWith("fs") ? "file" : p === "pty" ? "terminal" : p === "process" ? "play" : p === "mcp-server" ? "mcp" : "link-external"), p)),
              ...mod.dependencies.map((d) => h("span", { class: "chip outline", title: "Needs this mod" }, icon("package"), d)),
            ),
            adds.length ? h("div", { class: "muted", style: { marginTop: "6px", fontSize: "12px" } }, `Adds: ${adds.join(" · ")}`) : null,
            mod.problems.length ? h("div", { class: "problems" }, mod.problems.join(" · ")) : null,
            rt?.error ? h("div", { class: "problems" }, rt.error) : null,
          ),
          h(
            "div",
            { class: "side-actions" },
            h("button", { class: mod.enabled ? "btn secondary" : "btn", onclick: () => toggle(mod), disabled: !mod.enabled && mod.problems.length > 0 }, mod.enabled ? "Disable" : "Enable"),
            h("span", { class: `state-dot${rt?.state === "active" ? " active" : rt?.state === "failed" ? " failed" : ""}` }, state),
            h(
              "div",
              { class: "row-actions" },
              mod.source !== "bundled" ? h("button", { class: "icon-button", title: "Edit mod.json", onclick: () => editors.openFile(`${mod.dir}/mod.json`) }, icon("edit")) : null,
              h("button", { class: "icon-button", title: "Export to an .aicode-mod file", onclick: () => exportMod(mod) }, icon("export")),
              mod.source !== "bundled"
                ? h("button", { class: "icon-button", title: "Uninstall", onclick: async () => {
                    if (!(await confirm(`Uninstall ${mod.name}?`, `Deletes ${mod.dir}.`, "Uninstall"))) return;
                    try {
                      await invoke("mod_uninstall", { id: mod.id });
                      pendingReload = true;
                    } catch (e) {
                      notify("error", String(e));
                    }
                    refresh();
                  } }, icon("trash"))
                : null,
            ),
          ),
        );
      };

      const renderRunning = () => {
        const s = stats;
        const rows = [
          h("tr", null, h("td", null, "AICode (app process)"), h("td", null, "core"), h("td", null, s ? String(s.pid) : ""), h("td", { class: "num" }, s?.rss_kb ? `${(s.rss_kb / 1024).toFixed(0)} MB` : "—")),
          ...(s?.running ?? []).map((r) =>
            h("tr", null, h("td", null, `${r.kind === "terminal" ? "Terminal" : "Program"}: ${r.label}`), h("td", null, r.owner), h("td", null, r.pid ? String(r.pid) : ""), h("td", { class: "num" }, r.rss_kb ? `${(r.rss_kb / 1024).toFixed(0)} MB` : "—")),
          ),
          s?.mcp ? h("tr", null, h("td", null, `MCP server on ${s.mcp.url} (${s.mcp.tools} tools)`), h("td", null, s.mcp.owner), h("td", null, "—"), h("td", { class: "num" }, "in app")) : null,
        ];
        return h(
          "div",
          { class: "running" },
          h("table", { class: "res-table" }, h("thead", null, h("tr", null, h("th", null, "What"), h("th", null, "Started by"), h("th", null, "PID"), h("th", { class: "num" }, "Memory"))), h("tbody", null, rows)),
          h("p", { class: "muted", style: { fontSize: "12px" } }, "Memory is resident size as the system reports it. The web view runs in system processes of its own (WebKit on macOS), which are not counted here."),
        );
      };

      // Created once so re-renders (each keystroke, state changes) keep focus and caret.
      const search = h("input", { class: "input", placeholder: "Filter mods", oninput: () => { filter = search.value; render(); } }) as HTMLInputElement;

      const render = () => {
        const hadFocus = document.activeElement === search;
        const [selStart, selEnd] = [search.selectionStart, search.selectionEnd];
        clear(page);
        const q = filter.toLowerCase();
        const visible = installed.filter((m) => !q || `${m.name} ${m.id} ${m.description}`.toLowerCase().includes(q));
        const on = visible.filter((m) => m.enabled);
        const off = visible.filter((m) => !m.enabled);
        append(page, [
          h("h1", null, "Mods"),
          h("div", { class: "muted" }, "AICode starts as a notepad. Each mod adds one thing — and only loads when you use it."),
          h(
            "div",
            { class: "mods-toolbar" },
            search,
            h("button", { class: "btn", onclick: async () => { await commands.execute("mods.create"); refresh(); }, title: "A new mod, as one JSON file" }, icon("add"), "Create Mod…"),
            h("button", { class: "btn secondary", onclick: async () => { await commands.execute("mods.installFile"); refresh(); }, title: "An .aicode-mod or a mod.json" }, icon("cloud-download"), "Install from File…"),
            h("button", { class: "btn secondary", onclick: (e: MouseEvent) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              contextMenu(r.left, r.bottom + 2, [
                { label: "Install from Folder…", run: async () => { await commands.execute("mods.installFolder"); refresh(); } },
                { label: "Install This File as Mod", run: async () => { await commands.execute("mods.installCurrentFile"); refresh(); } },
                { separator: true, label: "" },
                { label: "Create Mod with AI…", run: () => commands.execute("mods.createWithAI") },
                { label: "Copy Mod Guide for AI", run: () => commands.execute("mods.copyGuide") },
                { label: "Open Mod Guide", run: () => commands.execute("mods.openGuide") },
                { separator: true, label: "" },
                { label: "Open This Profile's Mods Folder", run: async () => invoke("open_external", { modId: "core", target: await invoke<string>("mods_folder", {}) }) },
                { label: "Open Shared Mods Folder", run: async () => invoke("open_external", { modId: "core", target: await invoke<string>("mods_folder", { scope: "shared" }) }) },
              ]);
            } }, icon("ellipsis"), "More"),
          ),
          h("div", { class: "muted profile-line" }, icon("account"), ` Profile "${profile.name}" — mods you install go into this profile. `, h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); commands.execute("profiles.manage"); } }, "Manage profiles")),
          pendingReload
            ? h("div", { class: "banner" }, icon("info"), h("span", { style: { flex: "1" } }, "Reload the window to apply your changes. Open files and unsaved text are kept."), h("button", { class: "btn", onclick: () => location.reload() }, "Reload Window"))
            : "",
          !installed.some((m) => m.enabled)
            ? h(
                "div",
                { class: "banner" },
                icon("rocket"),
                h("span", { style: { flex: "1" } }, "Want the full editor layout? Turn on Explorer, Search, Source Control, Terminal, AI Chat, Syntax Highlighting, Markdown Preview, MCP Server and CodeFlow in one go."),
                h("button", { class: "btn", onclick: enableDevelopmentSet }, "Enable development set"),
              )
            : "",
          h("h2", null, `Enabled in "${profile.name}" — ${on.length}`),
          on.length ? on.map(card) : h("div", { class: "muted" }, "Nothing yet: this is the plain editor."),
          h("h2", null, `Available — ${off.length}`),
          off.length ? off.map(card) : h("div", { class: "muted" }, "Every installed mod is enabled."),
          h("h2", null, "Running now"),
          renderRunning(),
        ]);
        if (hadFocus) {
          search.focus();
          search.setSelectionRange(selStart, selEnd);
        }
        if (installed.length) firstRender = false;
      };

      const enableDevelopmentSet = async () => {
        const ids = ["aicode.explorer", "aicode.search", "aicode.git", "aicode.terminal", "aicode.agents", "aicode.syntax", "aicode.markdown", "aicode.mcp-server", "aicode.codeflow"].filter((id) => installed.some((m) => m.id === id));
        const asks = [...new Set(installed.filter((m) => ids.includes(m.id)).flatMap((m) => m.permissions))].map((p) => `• ${permissions.get(p) ?? p}`).join("\n");
        if (!(await confirm("Enable the development set?", `Together these mods will be able to:\n${asks}`, "Enable"))) return;
        for (const id of ids) await invoke("profile_set_enabled", { id, enabled: true }).catch((e) => notify("error", String(e)));
        location.reload();
      };

      const exportMod = async (mod: ModInfo) => {
        const path = await saveDialog({ defaultPath: `${mod.id}.aicode-mod`, filters: [{ name: "AICode mod", extensions: ["aicode-mod"] }] });
        if (!path) return;
        try {
          await invoke("mod_export", { id: mod.id, path });
          notify("info", `Exported ${mod.name}. Anyone can install it with Mods → Install from File.`);
        } catch (e) {
          notify("error", String(e));
        }
      };

      refresh().then(refreshStats);
      const timer = setInterval(refreshStats, 2000);
      const sub = host.onDidChangeState.event(() => render());
      const subInstall = onDidInstall.event(() => {
        pendingReload = true;
        refresh();
      });
      return toDisposable(() => {
        clearInterval(timer);
        sub.dispose();
        subInstall.dispose();
      });
    },
  });
}

const onDidInstall = new Emitter<string>();

interface Installed {
  id: string;
  dir: string;
  permissions: string[];
}

/** After an install: offer to turn it on (showing what it may do) and reload. */
async function afterInstall(r: Installed, opts: { enable?: boolean } = {}) {
  onDidInstall.fire(r.id);
  const perms = new Map(await invoke<[string, string][]>("mods_permissions"));
  const asks = r.permissions.map((p) => `• ${perms.get(p) ?? p}`).join("\n");
  const enable = opts.enable || (await confirm(`Installed ${r.id}. Turn it on?`, r.permissions.length ? `It will be able to:\n${asks}` : "It asks for no permissions.", "Turn On"));
  if (!enable) return;
  if (opts.enable && r.permissions.length && !(await confirm(`Turn on ${r.id}?`, `It will be able to:\n${asks}`, "Turn On"))) return;
  try {
    await invoke("profile_set_enabled", { id: r.id, enabled: true });
    pendingReload = true;
    onDidInstall.fire(r.id);
    notify("info", `${r.id} is on. Reload the window to use it.`, [{ label: "Reload Window", run: () => location.reload() }]);
  } catch (e) {
    notify("error", String(e));
  }
}

const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "mod";

function modTemplate(name: string, id: string, description: string) {
  const short = id.split(".").pop()!;
  return JSON.stringify(
    {
      $schema: "https://aicode.dev/schema/mod.schema.json",
      id,
      name,
      version: "0.1.0",
      description: description || "What this mod does.",
      icon: "sparkle",
      permissions: [],
      contributes: {
        commands: [
          { id: `${short}.hello`, title: "Say Hello", category: name, run: { type: "notify", message: "Hello from ${fileName}!" } },
          { id: `${short}.date`, title: "Insert Date", category: name, run: { type: "insert", text: "${date}" } },
        ],
        views: [
          {
            id: `${short}.view`,
            title: name,
            icon: "sparkle",
            location: "sidebar",
            markdown: "Edit **mod.json** to change this panel. The guide: *Mods → More → Open Mod Guide*.",
            items: [
              { label: "Say hello", icon: "comment", command: `${short}.hello` },
              { label: "Insert date", icon: "calendar", command: `${short}.date` },
            ],
          },
        ],
      },
    },
    null,
    2,
  );
}

export function registerModManager(host: ModHost, editors: EditorService) {
  const reg = (id: string, title: string, run: (...a: any[]) => unknown) => commands.register(id, run, { title, category: "Mods", owner: "core" });
  const guide = () => invoke<string>("mod_guide");

  reg("mods.create", "Create Mod…", async () => {
    const name = await inputBox({ prompt: "Name of the new mod", placeholder: "My Tools" });
    if (!name) return;
    const description = await inputBox({ prompt: "What should it do? (optional)", placeholder: "Buttons to run my project's scripts" });
    const id = `my.${slug(name)}`;
    try {
      const r = await invoke<Installed>("mod_install_json", { text: modTemplate(name, id, description ?? "") });
      await invoke("profile_set_enabled", { id: r.id, enabled: true });
      onDidInstall.fire(r.id);
      await editors.openFile(`${r.dir}/mod.json`);
      notify("info", `Created ${r.id} in this profile. Edit mod.json, save, and reload the window to see it. The guide (Mods → More) lists everything a JSON mod can do.`, [
        { label: "Reload Window", run: () => location.reload() },
        { label: "Open Guide", run: () => commands.execute("mods.openGuide") },
      ]);
    } catch (e) {
      notify("error", String(e));
    }
  });
  reg("mods.installFile", "Install from File…", async (from?: string) => {
    const file = typeof from === "string" ? from : await openDialog({ multiple: false, directory: false, filters: [{ name: "AICode mod", extensions: ["aicode-mod", "json"] }] });
    if (typeof file !== "string") return;
    try {
      await afterInstall(await invoke<Installed>("mod_install_file", { path: file }));
    } catch (e) {
      notify("error", `Not a mod: ${e}`);
    }
  });
  reg("mods.installFolder", "Install from Folder…", async () => {
    const dir = await openDialog({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    try {
      await afterInstall(await invoke<Installed>("mod_install_folder", { path: dir }));
    } catch (e) {
      notify("error", `Not a mod: ${e}`);
    }
  });
  reg("mods.installCurrentFile", "Install This File as Mod", async () => {
    const text = editors.activeText()?.model.getValue();
    if (!text?.trim()) return notify("warning", "Open or paste a mod.json in the editor first.");
    // An AI often answers with the JSON inside a ```json block: take what is inside.
    const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
    try {
      await afterInstall(await invoke<Installed>("mod_install_json", { text: fenced ? fenced[1] : text }));
    } catch (e) {
      notify("error", `This is not a mod yet: ${e}`);
    }
  });
  reg("mods.copyGuide", "Copy Mod Guide for AI", async () => {
    await invoke("clipboard_write", { text: await guide() });
    notify("info", "The mod guide is on the clipboard. Paste it into any AI, say what the mod should do, then paste its answer into a new tab and run “Mods: Install This File as Mod”.");
  });
  reg("mods.openGuide", "Open Mod Guide", async () => {
    const text = await guide();
    editors.openCustom({
      title: "Mod Guide",
      icon: "book",
      key: "mod-guide",
      render: (el) => {
        el.append(
          h(
            "div",
            { class: "mods-page guide-page" },
            h(
              "div",
              { class: "mods-toolbar" },
              h("button", { class: "btn", onclick: () => commands.execute("mods.copyGuide") }, icon("copy"), "Copy for AI"),
              h("button", { class: "btn secondary", onclick: () => commands.execute("mods.createWithAI") }, icon("sparkle"), "Create Mod with AI…"),
              h("button", { class: "btn secondary", onclick: () => commands.execute("mods.create") }, icon("add"), "Create Mod…"),
            ),
            h("pre", { class: "guide-text" }, text),
          ),
        );
      },
    });
  });
  reg("mods.createWithAI", "Create Mod with AI…", async () => {
    const want = await inputBox({ prompt: "Describe the mod you want", placeholder: "A panel with buttons to run npm test and npm run build, and ⌘⌥T to run the tests" });
    if (!want) return;
    const prompt = `${await guide()}\n\n---\n\nWrite an AICode mod that does this: ${want}\n\nAnswer with the complete mod.json in one json code block.`;
    if (host.get("aicode.agents")) {
      const agents = (await host.activate("aicode.agents")) as { ask?: (p: string) => Promise<void> } | undefined;
      if (agents?.ask) {
        notify("info", "Asked the AI Chat. When it answers, copy the JSON into a new tab (⌘N) and run “Mods: Install This File as Mod”.");
        await agents.ask(prompt);
        return;
      }
    }
    await invoke("clipboard_write", { text: prompt });
    notify("info", "The guide and your request are on the clipboard: paste them into any AI (ChatGPT, Claude, Gemini…). Paste its answer into a new tab (⌘N) and run “Mods: Install This File as Mod”.", [{ label: "New Tab", run: () => editors.newUntitled("", "json") }]);
  });

  commands.register("mods.manage", () => openModManager(host, editors), { title: "Manage Mods", category: "Mods", owner: "core" });
  editors.restorers.set("mods", () => openModManager(host, editors));
}
