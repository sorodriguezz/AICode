// Profiles and Settings pages. A profile is a space of its own — mods (which are on, and the ones
// installed only in it), settings, keyboard shortcuts, windows and open files — and can be
// exported to one file and imported elsewhere. Settings shows the editor's own preferences and
// those every enabled mod declares, for the active profile.

import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "./ipc";
import { h, icon, clear, toDisposable } from "./ui";
import { EditorService } from "./editor";
import { ModHost } from "./mods";
import { notify, inputBox, confirm, pick } from "./widgets";
import { closeModal } from "./modal";
import * as commands from "./commands";
import type { ThemeEntry } from "./theme";
import { config, type SettingSchema } from "./config";
import { appVersion, checkForUpdates, installUpdate, onDidChangeUpdateStatus, promptUpdate, updateStatus } from "./updates";
import { iconThemes } from "./fileIcons";

export interface ProfileView {
  name: string;
  description: string;
  icon?: string | null;
  enabled: string[];
  keybindings: { key: string; command: string; args?: unknown }[];
  available: string[];
  path: string;
  modsDir: string;
}

interface ProfileSummary {
  name: string;
  description: string;
  icon?: string | null;
  active: boolean;
  enabled: number;
  own: string[];
  keybindings: number;
  windows: number;
}

const NAME_RULE = (v: string) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(v) ? null : "Use letters, digits, '.', '-' and '_'");

/** Every window saves its session and closes; the other profile's windows open. */
export async function switchProfile(name: string) {
  await invoke("profile_switch", { name });
}

async function askSwitch(name: string) {
  if (await confirm(`Switch to "${name}"?`, "Every window of this profile closes (open files and unsaved text are kept) and the windows of the other profile open.", "Switch")) await switchProfile(name);
}

export async function createProfile(): Promise<string | undefined> {
  const list = await invoke<ProfileSummary[]>("profile_list");
  const start = await pick(
    [
      { label: "Empty", description: "a plain notepad: no mods, default settings", icon: "file", value: "" },
      ...list.map((p) => ({ label: `Copy of ${p.name}`, description: `${p.enabled} mods on${p.own.length ? `, ${p.own.length} of its own` : ""}, its settings and shortcuts`, icon: "copy", value: p.name })),
    ],
    { placeholder: "Start the new profile from…" },
  );
  if (!start) return;
  const name = await inputBox({ prompt: "Name of the new profile", placeholder: "writing", validate: NAME_RULE });
  if (!name) return;
  const description = await inputBox({ prompt: "What is it for? (optional — Enter to skip)", placeholder: "Notes and Markdown, no dev tools" });
  try {
    const created = await invoke<string>("profile_create", { name, copyFrom: start.value || null, description: description || null });
    notify("info", `Profile "${created}" created.`, [{ label: "Switch to It", run: () => switchProfile(created) }]);
    return created;
  } catch (e) {
    notify("error", String(e));
  }
}

export async function importProfile(from?: string): Promise<string | undefined> {
  const file = from ?? (await openDialog({ multiple: false, directory: false, filters: [{ name: "AICode profile", extensions: ["aicode-profile", "json"] }] }));
  if (typeof file !== "string") return;
  try {
    const r = await invoke<{ name: string; mods: string[]; missing: string[] }>("profile_import", { path: file });
    const parts = [`Imported profile "${r.name}"${r.mods.length ? ` with ${r.mods.length} mod${r.mods.length === 1 ? "" : "s"} of its own` : ""}.`];
    if (r.missing.length) parts.push(`Not available here (turned on in the file, but not installed): ${r.missing.join(", ")}.`);
    notify(r.missing.length ? "warning" : "info", parts.join("\n"), [{ label: "Switch to It", run: () => switchProfile(r.name) }]);
    return r.name;
  } catch (e) {
    notify("error", `Could not import: ${e}`);
  }
}

export async function exportProfile(name: string, to?: string) {
  const path = to ?? (await saveDialog({ defaultPath: `${name}.aicode-profile`, filters: [{ name: "AICode profile", extensions: ["aicode-profile"] }] }));
  if (!path) return;
  try {
    const count = await invoke<number>("profile_export", { name, path, includeShared: true });
    notify("info", `Exported "${name}"${count ? ` with ${count} mod${count === 1 ? "" : "s"}` : ""}. Import it with Profiles → Import.`);
  } catch (e) {
    notify("error", String(e));
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line on what a profile holds: "3 mods on · 1 of its own · 2 windows". */
function summaryLine(p: ProfileSummary) {
  return [
    p.enabled ? `${plural(p.enabled, "mod")} on` : "no mods",
    p.own.length ? `${p.own.length} of its own` : "",
    p.keybindings ? plural(p.keybindings, "shortcut") : "",
    plural(p.windows, "window"),
  ].filter(Boolean).join(" · ");
}

export function openProfiles(editors: EditorService) {
  editors.openPage({
    title: "Profiles",
    icon: "account",
    key: "profiles",
    restore: "profiles",
    render: (root) => {
      const page = h("div", { class: "mods-page mods-manager profiles-page" });
      root.append(page);
      let first = true;

      const act = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (e) {
          notify("error", String(e));
        }
        refresh();
      };

      /** Only what applies to that profile: its description can be edited only while it's the
       * active one, and the active one can't be deleted. */
      const moreItems = (p: ProfileSummary) => [
        {
          label: "Rename…",
          icon: "edit",
          run: () =>
            act(async () => {
              const to = await inputBox({ prompt: `New name for "${p.name}"`, value: p.name, validate: NAME_RULE });
              if (to && to !== p.name) await invoke("profile_rename", { from: p.name, to });
            }),
        },
        ...(p.active
          ? [{
              label: p.description ? "Edit Description…" : "Add Description…",
              icon: "note",
              run: () =>
                act(async () => {
                  const d = await inputBox({ prompt: "What is this profile for?", value: p.description, placeholder: "Notes and Markdown, no dev tools" });
                  if (d !== undefined) await invoke("profile_set_info", { description: d });
                }),
            }]
          : []),
        {
          label: "Duplicate…",
          icon: "copy",
          run: () =>
            act(async () => {
              const name = await inputBox({ prompt: `Name of the copy of "${p.name}"`, value: `${p.name}-copy`, validate: NAME_RULE });
              if (name) await invoke("profile_create", { name, copyFrom: p.name, description: p.description || null });
            }),
        },
        { label: "Export…", icon: "export", run: () => exportProfile(p.name) },
        ...(p.active ? [{ separator: true, label: "" }, { label: "Open profile.json", icon: "json", run: () => commands.execute("preferences.openProfileJson") }] : []),
        ...(!p.active
          ? [
              { separator: true, label: "" },
              {
                label: "Delete…",
                icon: "trash",
                run: () =>
                  act(async () => {
                    if (await confirm(`Delete the profile "${p.name}"?`, `Its settings, ${p.own.length ? `its ${plural(p.own.length, "own mod")}, ` : ""}and the unsaved text of its windows are deleted. Export it first to keep a copy.`, "Delete")) await invoke("profile_delete", { name: p.name });
                  }),
              },
            ]
          : []),
      ];
      const more = (p: ProfileSummary, cls = "btn secondary icon-only") =>
        h(
          "button",
          {
            class: cls,
            title: "More Actions…",
            "aria-label": "More Actions",
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              import("./widgets").then((w) => w.contextMenu(r.left - 140, r.bottom + 4, moreItems(p)));
            },
          },
          icon("ellipsis"),
        );

      /** A labelled number, as on the Mods page. */
      const fact = (value: number, label: string, title: string, iconName: string) =>
        h("div", { class: "profile-fact", title }, icon(iconName), h("b", null, String(value)), h("span", null, label));

      /** The profile in use: what it holds and the places to change it. */
      const current = (p: ProfileSummary) =>
        h(
          "section",
          { class: `profile-current${first ? " card-enter" : ""}`, "aria-label": `Current profile: ${p.name}` },
          h(
            "div",
            { class: "profile-current-head" },
            h("div", { class: "mod-icon large on" }, icon(p.icon || "account")),
            h(
              "div",
              { class: "profile-current-name" },
              h("div", { class: "eyebrow" }, "Current profile"),
              h("div", { class: "name" }, p.name),
              p.description
                ? h("div", { class: "desc" }, p.description)
                : h("a", { href: "#", class: "desc add", onclick: (e: Event) => { e.preventDefault(); moreItems(p).find((i) => i.label === "Add Description…")?.run?.(); } }, icon("add"), "Add a description"),
            ),
            more(p),
          ),
          h(
            "div",
            { class: "profile-facts" },
            fact(p.enabled, p.enabled === 1 ? "mod on" : "mods on", "Mods turned on in this profile", "extensions"),
            fact(p.own.length, "of its own", p.own.length ? `Installed only in this profile: ${p.own.join(", ")}` : "No mods installed only in this profile", "package"),
            fact(p.keybindings, p.keybindings === 1 ? "shortcut" : "shortcuts", "Keyboard shortcuts of its own", "record-keys"),
            fact(p.windows, p.windows === 1 ? "window" : "windows", "Windows it opens", "window"),
          ),
          h(
            "div",
            { class: "profile-current-actions" },
            h("button", { class: "btn secondary", onclick: () => commands.execute("mods.manage") }, icon("extensions"), "Mods"),
            h("button", { class: "btn secondary", onclick: () => commands.execute("preferences.settings") }, icon("settings-gear"), "Settings"),
            h("button", { class: "btn secondary", onclick: () => commands.execute("workbench.keybindings") }, icon("record-keys"), "Keyboard Shortcuts"),
            h("div", { class: "toolbar-spacer" }),
            h("button", { class: "btn secondary", onclick: () => exportProfile(p.name) }, icon("export"), "Export…"),
          ),
        );

      /** Another profile: the same size as every other tile, with Switch as its one action. */
      const tile = (p: ProfileSummary, i: number) =>
        h(
          "div",
          {
            class: `mod-tile profile-tile${first ? " card-enter" : ""}`,
            style: { animationDelay: first ? `${Math.min(i + 1, 12) * 30}ms` : "0ms" },
            tabindex: "0",
            onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter" && e.target === e.currentTarget) askSwitch(p.name); },
          },
          h(
            "div",
            { class: "mod-tile-head" },
            h("div", { class: "mod-icon" }, icon(p.icon || "person")),
            h("div", { class: "mod-tile-name" }, h("div", { class: "name", title: p.name }, p.name), h("div", { class: "sub", title: summaryLine(p) }, summaryLine(p))),
            more(p, "icon-button"),
          ),
          h("div", { class: `mod-tile-desc${p.description ? "" : " empty"}` }, p.description || (p.enabled ? "No description." : "A plain notepad.")),
          h(
            "div",
            { class: "mod-tile-foot" },
            p.own.length ? h("span", { class: "state-dot idle", title: p.own.join(", ") }, `${p.own.length} of its own`) : h("span"),
            h("button", { class: "btn", onclick: () => askSwitch(p.name) }, icon("arrow-swap"), "Switch"),
          ),
        );

      const refresh = async () => {
        const list = await invoke<ProfileSummary[]>("profile_list");
        const active = list.find((p) => p.active);
        const others = list.filter((p) => !p.active).sort((a, b) => a.name.localeCompare(b.name));
        const create = async () => ((await createProfile()) ? refresh() : null);
        const importIt = async () => ((await importProfile()) ? refresh() : null);
        const scroller = page.parentElement;
        const top = scroller?.scrollTop ?? 0;
        clear(page);
        page.append(
          h(
            "header",
            { class: "mods-hero" },
            h("div", null, h("h1", null, "Profiles"), h("p", null, "Each profile is a space of its own — mods, settings, keyboard shortcuts, windows and open files. Export one to take it to another machine or share it.")),
            h(
              "div",
              { class: "mods-toolbar profile-toolbar" },
              h("button", { class: "btn", onclick: create }, icon("add"), "New Profile…"),
              h("button", { class: "btn secondary", onclick: importIt }, icon("cloud-download"), "Import…"),
            ),
          ),
          ...(active ? [current(active)] : []),
          h("h2", null, "Other Profiles", others.length ? h("span", { class: "count" }, String(others.length)) : null),
          others.length
            ? h("div", { class: "mod-grid" }, others.map(tile))
            : h(
                "div",
                { class: "mods-empty profile-empty" },
                icon("account"),
                h("b", null, "Only one profile so far"),
                h("span", null, "Make one for another kind of work — writing, a language, a client — each with its own mods and settings. Switching keeps your open files."),
                h("div", { class: "row" }, h("button", { class: "btn", onclick: create }, icon("add"), "New Profile…"), h("button", { class: "btn secondary", onclick: importIt }, icon("cloud-download"), "Import…")),
              ),
        );
        if (scroller) scroller.scrollTop = top;
        first = false;
      };

      refresh();
      return toDisposable(() => {});
    },
  });
}

// ---------- settings ----------

export interface SettingsDeps {
  host: ModHost;
  editors: EditorService;
  themes: () => ThemeEntry[];
}

/** Settings → Updates: the version, Check for Updates, and what the last check found. */
function updatesRow(): { el: HTMLElement; paint: () => void } {
  const version = h("b", null, "AICode");
  appVersion().then((v) => (version.textContent = `AICode ${v}`)).catch(() => {});
  const statusLine = h("div", { class: "muted update-status" });
  const control = h("div", { class: "setting-control update-actions" });
  const paint = () => {
    const s = updateStatus();
    const busy = s.kind === "checking" || s.kind === "downloading" || s.kind === "installing" || s.kind === "restarting";
    statusLine.textContent =
      s.kind === "checking" ? "Checking for updates…"
      : s.kind === "latest" ? "AICode is up to date."
      : s.kind === "available" ? `Version ${s.info.version} is available.`
      : s.kind === "downloading" ? `Downloading ${s.info.version}${s.total ? ` — ${Math.round((s.downloaded / s.total) * 100)}%` : "…"}`
      : s.kind === "installing" ? `Installing ${s.info.version}…`
      : s.kind === "restarting" ? "Restarting AICode…"
      : s.kind === "error" ? `The last check failed: ${s.message}`
      : "Updates come from the AICode releases on GitHub.";
    clear(control);
    if (s.kind === "available") {
      control.append(
        h("button", { class: "btn secondary", onclick: () => promptUpdate(s.info) }, "Details…"),
        h("button", { class: "btn", onclick: () => installUpdate() }, icon("cloud-download"), "Install and Restart"),
      );
    } else {
      control.append(h("button", { class: "btn secondary", disabled: busy, onclick: () => checkForUpdates() }, icon(busy ? "sync codicon-modifier-spin" : "sync"), s.kind === "checking" ? "Checking…" : "Check for Updates"));
    }
  };
  paint();
  const el = h("div", { class: "setting-row" }, h("div", { class: "setting-label" }, version, h("span", { class: "muted key" }, "update.check"), statusLine), control);
  return { el, paint };
}

export function openSettings(deps: SettingsDeps) {
  deps.editors.openPage({
    title: "Settings",
    icon: "settings-gear",
    actions: [
      { icon: "go-to-file", title: "Open Settings (JSON)", run: () => { closeModal(); commands.execute("preferences.openProfileJson"); } },
      { icon: "json", title: "Default Settings (JSON)", run: () => { closeModal(); commands.execute("preferences.openDefaultSettings"); } },
    ],
    key: "settings",
    restore: "settings",
    render: (root) => {
      const page = h("div", { class: "mods-page settings-page" });
      root.append(page);
      let filter = "";
      let onlyModified = false;
      let updates: ReturnType<typeof updatesRow> | null = null;
      const updatesWatch = onDidChangeUpdateStatus(() => updates?.paint());

      const save = async (owner: string, key: string, value: unknown) => {
        try {
          await config.update(owner, key, value);
        } catch (e) {
          notify("error", String(e));
        }
      };

      const control = (owner: string, key: string, s: SettingSchema) => {
        const current = config.get<any>(owner, key);
        const set = (v: unknown) => save(owner, key, JSON.stringify(v) === JSON.stringify(s.default) && key !== "theme" && !config.inspect(owner, key).mods.length ? null : v);
        if (s.type === "boolean") {
          return h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!current, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }), h("span", null, current ? "On" : "Off"));
        }
        if (s.enum?.length) {
          const known = s.enum.some((o) => String(o.value) === String(current));
          return h(
            "select",
            { class: "input", onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; set(s.type === "number" ? Number(v) : v); } },
            known ? null : h("option", { value: String(current ?? ""), selected: true }, String(current ?? "")),
            s.enum.map((o) => h("option", { value: String(o.value), selected: String(o.value) === String(current) }, o.label)),
          );
        }
        if (s.type === "array" || s.type === "object") {
          const empty = s.type === "array" ? !(current as unknown[])?.length : !Object.keys(current ?? {}).length;
          const summary = empty ? (s.type === "array" ? "none" : "nothing set") : JSON.stringify(current).slice(0, 60) + (JSON.stringify(current).length > 60 ? "…" : "");
          return h(
            "div",
            { class: "setting-json" },
            h("code", { class: "muted", title: JSON.stringify(current, null, 2) }, summary),
            h("button", { class: "btn secondary", onclick: () => { closeModal(); commands.execute("preferences.editSettingJson", owner, key); } }, icon("json"), "Edit in JSON"),
          );
        }
        const input = h("input", {
          class: "input",
          type: s.type === "number" ? "number" : "text",
          value: current ?? "",
          min: s.min,
          max: s.max,
          step: s.type === "number" && (s.max ?? 10) <= 1 ? 0.05 : undefined,
          spellcheck: false,
          placeholder: s.format === "color" ? "#rrggbb, rgb(…), or empty" : "",
          onchange: (e: Event) => {
            const raw = (e.target as HTMLInputElement).value;
            set(s.type === "number" ? (raw === "" ? s.default : Math.max(s.min ?? -Infinity, Math.min(s.max ?? Infinity, Number(raw)))) : raw);
          },
        });
        if (s.format !== "color") return input;
        const swatch = h("input", { type: "color", class: "color-swatch", value: /^#[0-9a-f]{6}$/i.test(String(current)) ? current : "#000000", oninput: (e: Event) => { input.value = (e.target as HTMLInputElement).value; }, onchange: (e: Event) => set((e.target as HTMLInputElement).value) });
        return h("div", { class: "setting-color" }, swatch, input);
      };

      /** Where the value comes from, and a way back to the default. */
      const origin = (owner: string, key: string) => {
        const ins = config.inspect(owner, key);
        const bits: (HTMLElement | string)[] = [];
        if (ins.window !== undefined) bits.push(h("span", { class: "chip" }, "this window"));
        if (ins.user !== undefined) bits.push(h("span", { class: "chip user" }, "set by you"));
        else if (ins.mods.length) bits.push(h("span", { class: "chip mod", title: ins.mods.map((m) => `${m.mod}: ${JSON.stringify(m.value)}`).join("\n") }, `set by ${ins.mods.map((m) => deps.host.get(m.mod)?.info.name ?? m.mod).join(", ")}`));
        if (ins.user !== undefined) bits.push(h("a", { href: "#", class: "reset", title: ins.mods.length ? "Back to what the mods set" : "Back to the default", onclick: (e: Event) => { e.preventDefault(); save(owner, key, null); } }, "reset"));
        return bits.length ? h("span", { class: "setting-origin" }, ...bits) : null;
      };

      const row = (owner: string, key: string, s: SettingSchema) =>
        h(
          "div",
          { class: "setting-row" },
          h(
            "div",
            { class: "setting-label" },
            h("div", { class: "setting-title" }, h("b", null, s.title ?? key), origin(owner, key)),
            h("span", { class: "muted key" }, owner === "core" ? key : `${owner} › ${key}`),
            s.description ? h("div", { class: "muted" }, s.description) : null,
            s.applies && s.applies !== "live" ? h("div", { class: "muted applies" }, icon("info"), s.applies === "reload" ? " Applies after Reload Window." : " Applies when the window is reopened.") : null,
          ),
          h("div", { class: "setting-control" }, control(owner, key, s)),
        );

      const matches = (owner: string, key: string, s: SettingSchema) =>
        (!filter || `${s.title ?? ""} ${key} ${s.description ?? ""} ${s.section ?? ""}`.toLowerCase().includes(filter)) &&
        (!onlyModified || (() => { const i = config.inspect(owner, key); return i.user !== undefined || i.mods.length > 0 || i.window !== undefined; })());

      const render = async () => {
        const profile = await invoke<ProfileView>("profile_get");
        const sections: HTMLElement[] = [];
        // The editor's own settings, by section.
        const bySection = new Map<string, [string, SettingSchema][]>();
        for (const [key, raw] of Object.entries(config.schema("core"))) {
          if (raw.hidden) continue;
          const sch = key === "theme" ? { ...raw, enum: deps.themes().map((t) => ({ value: t.id, label: `${t.label}${t.source === "core" ? "" : ` — ${t.source}`}` })), default: deps.themes()[0]?.id }
            : key === "workbench.iconTheme" ? { ...raw, enum: [{ value: "none", label: "None (plain icons)" }, ...iconThemes().map((t) => ({ value: t.id, label: `${t.label} — ${t.source}` }))] }
            : raw;
          if (!matches("core", key, sch)) continue;
          const section = sch.section ?? "Other";
          if (!bySection.has(section)) bySection.set(section, []);
          bySection.get(section)!.push([key, sch]);
        }
        const updatesShown = !onlyModified && (!filter || "check for updates version".includes(filter));
        if (updatesShown && !bySection.has("Updates")) bySection.set("Updates", []);
        for (const [section, list] of bySection) {
          const head = h("h2", null, section);
          if (section === "Updates") {
            updates = updatesShown ? updatesRow() : null;
            if (updates || list.length) sections.push(head, ...(updates ? [updates.el] : []), ...list.map(([k, sc]) => row("core", k, sc)));
            continue;
          }
          sections.push(head, ...list.map(([k, sc]) => row("core", k, sc)));
        }
        // Each enabled mod's.
        for (const m of deps.host.list()) {
          const schema = config.schema(m.id);
          const fields = Object.entries(schema).filter(([k, sc]) => !sc.hidden && matches(m.id, k, sc));
          if (fields.length) sections.push(h("h2", null, m.name), ...fields.map(([k, sc]) => row(m.id, k, sc)));
        }
        const search = h("input", { class: "input", placeholder: "Search settings", value: filter, oninput: (e: Event) => { filter = (e.target as HTMLInputElement).value.toLowerCase(); render().then(() => (page.querySelector(".mods-toolbar input") as HTMLInputElement | null)?.focus()); } });
        const scroll = page.parentElement?.scrollTop ?? 0;
        clear(page);
        page.append(
          h("h1", null, "Settings"),
          h("div", { class: "muted" }, `For the profile "${profile.name}". Other profiles keep their own. Mods can change defaults; your values always win.`),
          h(
            "div",
            { class: "mods-toolbar" },
            search,
            h("label", { class: "check", title: "Only settings you or a mod changed" }, h("input", { type: "checkbox", checked: onlyModified, onchange: (e: Event) => { onlyModified = (e.target as HTMLInputElement).checked; render(); } }), h("span", null, "Modified")),
            h("button", { class: "btn secondary", onclick: () => commands.execute("profiles.manage") }, icon("account"), "Profiles"),
            h("button", { class: "btn secondary", onclick: () => commands.execute("workbench.keybindings") }, icon("record-keys"), "Keyboard Shortcuts"),
            h("button", { class: "btn secondary", onclick: () => commands.execute("preferences.openProfileJson") }, icon("json"), "Edit as JSON"),
          ),
          ...(sections.length ? sections : [h("div", { class: "muted" }, "No setting matches.")]),
        );
        if (page.parentElement) page.parentElement.scrollTop = scroll;
      };
      render();
      // Changes from anywhere (profile.json saved, a command, a mod) show up here.
      let pending = 0;
      const watch = config.onDidChange.event(() => {
        cancelAnimationFrame(pending);
        pending = requestAnimationFrame(() => {
          if (!page.contains(document.activeElement) || (document.activeElement as HTMLElement)?.tagName !== "INPUT" || (document.activeElement as HTMLInputElement).type !== "text") render();
        });
      });
      return toDisposable(() => {
        updatesWatch.dispose();
        watch.dispose();
      });
    },
  });
}
