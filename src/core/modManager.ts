// The Mods page: what is installed, what is on in this profile, what each mod may do, and what is
// actually running right now and what it costs. It is a core page, so it works with no mod enabled.

import { open as openDialog, save as saveDialog } from "./dialog";
import { invoke, ModInfo } from "./ipc";
import { h, icon, iconButton, clear, append, toDisposable, Child } from "./ui";
import { ModHost } from "./mods";
import { undeclaredPermissions } from "./declarative";
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

type View = "all" | "enabled" | "available" | "running";

const SOURCE_LABEL: Record<ModInfo["source"], string> = {
  bundled: "Comes with AICode",
  shared: "Installed for every profile",
  profile: "Installed only in this profile (exported with it)",
};

const PERM_ICONS: Record<string, string> = { pty: "terminal", process: "play", "mcp-server": "mcp", network: "globe", secrets: "key", app: "layers", native: "symbol-namespace", "open-external": "link-external" };
const permIcon = (p: string) => (p.startsWith("fs") ? "file" : PERM_ICONS[p] ?? "shield");
/** What the mod declares, plus what its mod.json actions use without declaring it: the user sees all of it. */
const permsOf = (mod: ModInfo) => [...new Set([...mod.permissions, ...undeclaredPermissions(mod)])];
const mb = (kb: number | null | undefined) => (kb ? `${(kb / 1024).toFixed(0)} MB` : "—");
const byName = (a: ModInfo, b: ModInfo) => a.name.localeCompare(b.name);

/** The element that scrolls the page (a tab's body or the modal's content). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return null;
}

interface Status {
  label: string;
  kind: "on" | "off" | "idle" | "failed";
  detail?: string;
}

/** The Mods page; `query` starts it filtered (the AI Chat opens it on "agent" to list its agents). */
export function openModManager(host: ModHost, editors: EditorService, query = "") {
  editors.openPage({
    title: "Mods",
    icon: "extensions",
    key: "mods",
    restore: "mods",
    render: (root) => {
      let filter = query;
      let view: View = "all";
      /** The mod whose details are open on the right. */
      let selected: string | null = null;
      let installed: ModInfo[] = [];
      let permissions = new Map<string, string>();
      let profile: { name: string; available: string[] } = { name: "default", available: ["default"] };
      let stats: Stats | null = null;

      const page = h("div", { class: "mods-page mods-manager" });
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
      const totalMemory = () => (stats ? (stats.rss_kb ?? 0) + stats.running.reduce((n, r) => n + (r.rss_kb ?? 0), 0) : 0);
      const refreshStats = async () => {
        stats = await invoke<Stats>("resource_stats");
        page.querySelector(".running")?.replaceWith(renderRunning());
        const mem = page.querySelector(".mods-stat.mem b");
        if (mem) mem.textContent = mb(totalMemory());
      };

      const toggle = async (mod: ModInfo) => {
        if (!mod.enabled && permsOf(mod).length) {
          const asks = permsOf(mod).map((p) => `• ${permissions.get(p) ?? p}`).join("\n");
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

      const uninstall = async (mod: ModInfo) => {
        if (!(await confirm(`Uninstall ${mod.name}?`, `Deletes ${mod.dir}.`, "Uninstall"))) return;
        try {
          await invoke("mod_uninstall", { id: mod.id });
          pendingReload = true;
          if (selected === mod.id) selected = null;
        } catch (e) {
          notify("error", String(e));
        }
        refresh();
      };

      const runtimeState = (id: string) => host.list().find((m) => m.id === id);

      const status = (mod: ModInfo): Status => {
        const rt = runtimeState(mod.id);
        if (mod.problems.length) return { label: "Can't load", kind: "failed", detail: mod.problems.join(" · ") };
        if (!mod.enabled) return { label: "Off", kind: "off" };
        if (rt?.state === "failed") return { label: "Failed", kind: "failed", detail: rt.error ? String(rt.error) : undefined };
        if (rt?.state === "active") return { label: rt.loadMs != null ? `Running · ${rt.loadMs} ms` : "Running", kind: "on", detail: rt.loadMs != null ? `Running · loaded in ${rt.loadMs} ms` : "Running" };
        if (rt?.state === "activating") return { label: "Starting…", kind: "idle" };
        return mod.main ? { label: "Loads when used", kind: "idle", detail: "Waiting — it loads the first time you use it" } : { label: "Declarative", kind: "on", detail: "Declarative — nothing to run" };
      };

      const select = (id: string | null) => {
        selected = id;
        render();
        if (id) page.querySelector(".mod-details")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      };

      const switchFor = (mod: ModInfo) => {
        const blocked = !mod.enabled && mod.problems.length > 0;
        return h(
          "button",
          {
            class: `switch${mod.enabled ? " on" : ""}`,
            role: "switch",
            "aria-checked": String(mod.enabled),
            "aria-label": `${mod.enabled ? "Disable" : "Enable"} ${mod.name}`,
            title: blocked ? "Fix its problems to turn it on" : mod.enabled ? `Disable ${mod.name}` : `Enable ${mod.name}`,
            disabled: blocked,
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              toggle(mod);
            },
          },
          h("span", { class: "switch-knob" }),
        );
      };

      // ---------- tiles: every one the same size, the details live in the side panel ----------
      let firstRender = true;
      let tileIndex = 0;
      const tile = (mod: ModInfo) => {
        const st = status(mod);
        const delay = firstRender ? Math.min(tileIndex++, 12) * 30 : 0;
        const isSelected = selected === mod.id;
        return h(
          "div",
          {
            class: `mod-tile${firstRender ? " card-enter" : ""}${isSelected ? " selected" : ""}${mod.enabled ? " enabled" : ""}`,
            style: { animationDelay: `${delay}ms` },
            dataset: { id: mod.id },
            tabindex: "0",
            role: "button",
            "aria-pressed": String(isSelected),
            "aria-label": `${mod.name}, ${st.label}. Show details`,
            onclick: () => select(isSelected ? null : mod.id),
            onkeydown: (e: KeyboardEvent) => {
              if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                e.preventDefault();
                select(isSelected ? null : mod.id);
              }
            },
          },
          h(
            "div",
            { class: "mod-tile-head" },
            h("div", { class: "mod-icon" }, icon(mod.icon ?? "extensions")),
            h("div", { class: "mod-tile-name" }, h("div", { class: "name", title: mod.name }, mod.name), h("div", { class: "sub", title: mod.id }, `v${mod.version} · ${mod.id}`)),
            switchFor(mod),
          ),
          h("div", { class: "mod-tile-desc" }, mod.description),
          h(
            "div",
            { class: "mod-tile-foot" },
            h("span", { class: `state-dot ${st.kind}`, title: st.detail ?? st.label }, st.label),
            h(
              "div",
              { class: "mod-tile-badges" },
              mod.source !== "bundled" ? h("span", { class: "chip outline", title: SOURCE_LABEL[mod.source] }, mod.source === "profile" ? "profile" : "shared") : null,
              permsOf(mod).map((p) => h("span", { class: "perm-badge", title: `${p} — ${permissions.get(p) ?? p}` }, icon(permIcon(p)))),
            ),
          ),
        );
      };

      // ---------- the side panel: everything about one mod ----------
      const details = (mod: ModInfo) => {
        const st = status(mod);
        const rt = runtimeState(mod.id);
        const contributes = mod.contributes ?? {};
        const commandCount = (contributes.commands ?? []).length;
        const adds = [
          ...(contributes.views ?? []).map((v: any) => `${v.title} view (${v.location ?? "sidebar"})`),
          ...(contributes.themes ?? []).map((t: any) => `Theme “${t.label}”`),
          ...(contributes.snippets ?? []).map((s: any) => `${s.language} snippets`),
          commandCount ? `${commandCount} command${commandCount === 1 ? "" : "s"}` : null,
        ].filter(Boolean) as string[];
        const problems = [...mod.problems, ...(rt?.error ? [String(rt.error)] : [])];
        const section = (title: string, ...body: Child[]) => h("section", { class: "mod-details-section" }, h("h3", null, title), ...body);
        return h(
          "aside",
          { class: "mod-details", "aria-label": `${mod.name} details` },
          h(
            "div",
            { class: "mod-details-head" },
            h("div", { class: `mod-icon large${mod.enabled ? " on" : ""}` }, icon(mod.icon ?? "extensions")),
            h("div", { class: "mod-tile-name" }, h("div", { class: "name" }, mod.name), h("div", { class: "sub selectable" }, `v${mod.version} · ${mod.id}`)),
            iconButton("close", "Close Details", () => select(null)),
          ),
          h(
            "div",
            { class: "mod-details-toggle" },
            h("div", null, h("div", null, `${mod.enabled ? "On" : "Off"} in “${profile.name}”`), h("span", { class: `state-dot ${st.kind}` }, st.detail ?? st.label)),
            switchFor(mod),
          ),
          problems.length ? h("div", { class: "mod-details-problem" }, icon("warning"), h("div", null, problems.map((p) => h("div", null, p)))) : null,
          h("p", { class: "mod-details-desc selectable" }, mod.description),
          section(
            "Permissions",
            permsOf(mod).length
              ? h("ul", { class: "perm-list" }, permsOf(mod).map((p) => h("li", null, h("span", { class: "perm-badge" }, icon(permIcon(p))), h("div", null, h("code", null, p), h("div", { class: "muted" }, permissions.get(p) ?? "")))))
              : h("div", { class: "muted" }, "Asks for no permissions."),
          ),
          adds.length ? section("Adds", h("ul", { class: "plain-list" }, adds.map((a) => h("li", null, a)))) : null,
          mod.dependencies.length
            ? section(
                "Needs",
                h(
                  "div",
                  { class: "chips" },
                  mod.dependencies.map((d) => {
                    const dep = installed.find((m) => m.id === d);
                    return h("button", { class: "chip outline", title: dep ? `Show ${dep.name}` : `${d} is not installed`, disabled: !dep, onclick: () => select(d) }, icon("package"), dep?.name ?? d);
                  }),
                ),
              )
            : null,
          section("Installed", h("div", { class: "muted" }, SOURCE_LABEL[mod.source]), h("div", { class: "mod-path selectable", title: mod.dir }, mod.dir)),
          h(
            "div",
            { class: "mod-details-actions" },
            mod.source !== "bundled" ? h("button", { class: "btn secondary", onclick: () => editors.openFile(`${mod.dir}/mod.json`) }, icon("edit"), "Edit mod.json") : null,
            h("button", { class: "btn secondary", onclick: () => exportMod(mod), title: "Save it as an .aicode-mod file anyone can install" }, icon("export"), "Export…"),
            mod.source !== "bundled" ? h("button", { class: "btn secondary danger", onclick: () => uninstall(mod) }, icon("trash"), "Uninstall") : null,
          ),
        );
      };

      const renderRunning = () => {
        const s = stats;
        const rows = [
          h("tr", null, h("td", null, "AICode (app process)"), h("td", null, "core"), h("td", null, s ? String(s.pid) : ""), h("td", { class: "num" }, mb(s?.rss_kb))),
          ...(s?.running ?? []).map((r) =>
            h("tr", null, h("td", null, `${r.kind === "terminal" ? "Terminal" : "Program"}: ${r.label}`), h("td", null, r.owner), h("td", null, r.pid ? String(r.pid) : ""), h("td", { class: "num" }, mb(r.rss_kb))),
          ),
          s?.mcp ? h("tr", null, h("td", null, `MCP server on ${s.mcp.url} (${s.mcp.tools} tools)`), h("td", null, s.mcp.owner), h("td", null, "—"), h("td", { class: "num" }, "in app")) : null,
        ];
        return h(
          "div",
          { class: "running" },
          h("div", { class: "res-card" }, h("table", { class: "res-table" }, h("thead", null, h("tr", null, h("th", null, "What"), h("th", null, "Started by"), h("th", null, "PID"), h("th", { class: "num" }, "Memory"))), h("tbody", null, rows))),
          h("p", { class: "muted res-note" }, "Memory is resident size as the system reports it. The web view runs in system processes of its own (WebKit on macOS), which are not counted here."),
        );
      };

      // Created once so re-renders (each keystroke, state changes) keep focus and caret.
      const search = h("input", { class: "input", placeholder: "Search mods by name, id or description", "aria-label": "Search mods", value: filter, oninput: () => { filter = search.value; render(); } }) as HTMLInputElement;
      const clearFilter = () => {
        filter = search.value = "";
        render();
        search.focus();
      };

      const moreMenu = (e: MouseEvent) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        contextMenu(r.left, r.bottom + 2, [
          { label: "Install from Folder…", icon: "folder", run: async () => { await commands.execute("mods.installFolder"); refresh(); } },
          { label: "Install This File as Mod", icon: "file-code", run: async () => { await commands.execute("mods.installCurrentFile"); refresh(); } },
          { separator: true, label: "" },
          { label: "Create Mod with AI…", icon: "sparkle", run: () => commands.execute("mods.createWithAI") },
          { label: "Copy Mod Guide for AI", icon: "copy", run: () => commands.execute("mods.copyGuide") },
          { label: "Open Mod Guide", icon: "book", run: () => commands.execute("mods.openGuide") },
          { separator: true, label: "" },
          { label: "Open This Profile's Mods Folder", icon: "folder-opened", run: async () => invoke("open_external", { modId: "core", target: await invoke<string>("mods_folder", {}) }) },
          { label: "Open Shared Mods Folder", icon: "folder-library", run: async () => invoke("open_external", { modId: "core", target: await invoke<string>("mods_folder", { scope: "shared" }) }) },
        ]);
      };

      const render = () => {
        const hadFocus = document.activeElement === search;
        const [selStart, selEnd] = [search.selectionStart, search.selectionEnd];
        // Keep keyboard focus on the same tile (or its switch) across the re-render.
        const focusedTile = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>(".mod-tile");
        const focusId = focusedTile?.dataset.id;
        const focusSwitch = !!(document.activeElement as HTMLElement | null)?.classList?.contains("switch");
        // The page is rebuilt on every change: keep where it is scrolled to.
        const scroller = scrollParent(page);
        const scrollTop = scroller?.scrollTop ?? 0;
        // Reserve the scrollbar's room always: the long views (All, Available) scroll and the short
        // ones (Enabled, Running) don't, and the page jumping sideways by its width when switching
        // tabs reads as a jiggle.
        if (scroller) {
          if (CSS.supports("scrollbar-gutter", "stable")) scroller.style.scrollbarGutter = "stable";
          else scroller.style.overflowY = "scroll";
        }
        clear(page);

        const q = filter.trim().toLowerCase();
        const visible = installed.filter((m) => !q || `${m.name} ${m.id} ${m.description}`.toLowerCase().includes(q)).sort(byName);
        const on = visible.filter((m) => m.enabled);
        const off = visible.filter((m) => !m.enabled);
        const sel = selected ? installed.find((m) => m.id === selected) : undefined;
        if (!sel) selected = null;
        const showDetails = !!sel && view !== "running";

        const stat = (value: string, label: string, cls = "") => h("div", { class: `mods-stat ${cls}` }, h("b", null, value), h("span", null, label));
        const hero = h(
          "header",
          { class: "mods-hero" },
          h("div", null, h("h1", null, "Mods"), h("p", null, "AICode starts as a notepad. Each mod adds one thing — and only loads when you use it.")),
          h(
            "div",
            { class: "mods-stats" },
            stat(String(installed.filter((m) => m.enabled).length), "enabled"),
            stat(String(installed.length), "installed"),
            stat(mb(totalMemory()), "in use", "mem"),
          ),
        );

        const toolbar = h(
          "div",
          { class: "mods-toolbar" },
          h("div", { class: "search-box" }, icon("search"), search, filter ? iconButton("close", "Clear Search", clearFilter) : null),
          h("div", { class: "toolbar-spacer" }),
          h("button", { class: "btn", onclick: async () => { await commands.execute("mods.create"); refresh(); }, title: "A new mod, as one JSON file" }, icon("add"), "Create Mod…"),
          h("button", { class: "btn secondary", onclick: async () => { await commands.execute("mods.installFile"); refresh(); }, title: "An .aicode-mod or a mod.json" }, icon("cloud-download"), "Install from File…"),
          h("button", { class: "btn secondary icon-only", title: "More Actions…", "aria-label": "More Actions", onclick: moreMenu }, icon("ellipsis")),
        );

        const tabs: [View, string, number | null][] = [
          ["all", "All", visible.length],
          ["enabled", "Enabled", on.length],
          ["available", "Available", off.length],
          ["running", "Running", null],
        ];
        const tabBar = h(
          "div",
          { class: "mods-tabs" },
          h(
            "div",
            { class: "segmented", role: "tablist", "aria-label": "Show" },
            tabs.map(([v, label, n]) =>
              h("button", { class: `segment${view === v ? " active" : ""}`, role: "tab", "aria-selected": String(view === v), onclick: () => { view = v; render(); } }, label, n != null ? h("span", { class: "count" }, String(n)) : null),
            ),
          ),
          h(
            "div",
            { class: "profile-pill", title: "Mods you install go into this profile" },
            icon("account"),
            h("span", null, "Profile ", h("b", null, profile.name)),
            h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); commands.execute("profiles.manage"); } }, "Manage"),
          ),
        );

        // Pinned to the bottom of the view, so it appearing does not move the tiles under the pointer.
        const reloadBar = pendingReload
          ? h("div", { class: "banner reload-bar" }, icon("info"), h("span", { style: { flex: "1" } }, "Reload the window to apply your changes. Open files and unsaved text are kept."), h("button", { class: "btn", onclick: () => location.reload() }, "Reload Window"))
          : null;

        const empty = (iconName: string, text: string, ...extra: Child[]) => h("div", { class: "mods-empty" }, icon(iconName), h("div", null, text), ...extra);
        const group = (title: string, mods: ModInfo[], emptyText: string) => [
          h("h2", null, title, h("span", { class: "count" }, String(mods.length))),
          mods.length ? h("div", { class: "mod-grid" }, mods.map(tile)) : h("div", { class: "mods-empty small" }, emptyText),
        ];
        let content: Child;
        if (view === "running") content = renderRunning();
        else if (q && !visible.length) content = empty("search", `No mods match “${filter.trim()}”.`, h("button", { class: "btn secondary", onclick: clearFilter }, "Clear Search"));
        else if (view === "enabled") content = group(`Enabled in “${profile.name}”`, on, "Nothing on yet: this is the plain editor.");
        else if (view === "available") content = group("Available", off, "Every installed mod is enabled.");
        // One grid, by name: switching a mod on or off leaves its tile where it is.
        else content = h("div", { class: "mod-grid all" }, visible.map(tile));

        append(page, [
          hero,
          toolbar,
          tabBar,
          h("div", { class: `mods-body${showDetails ? " with-details" : ""}` }, h("div", { class: "mods-main" }, content), showDetails ? details(sel!) : null),
          reloadBar,
        ]);
        if (scroller) scroller.scrollTop = scrollTop;

        if (hadFocus) {
          search.focus({ preventScroll: true });
          search.setSelectionRange(selStart, selEnd);
        } else if (focusId) {
          const t = page.querySelector<HTMLElement>(`.mod-tile[data-id="${CSS.escape(focusId)}"]`);
          (focusSwitch ? t?.querySelector<HTMLElement>(".switch") : t)?.focus({ preventScroll: true });
        }
        if (installed.length) firstRender = false;
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

  commands.register("mods.manage", (query?: unknown) => openModManager(host, editors, typeof query === "string" ? query : ""), { title: "Manage Mods", category: "Mods", owner: "core" });
  editors.restorers.set("mods", () => openModManager(host, editors));
}
