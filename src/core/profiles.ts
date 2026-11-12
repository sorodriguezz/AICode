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

export function openProfiles(editors: EditorService) {
  editors.openPage({
    title: "Profiles",
    icon: "account",
    key: "profiles",
    restore: "profiles",
    render: (root) => {
      const page = h("div", { class: "mods-page" });
      root.append(page);
      let first = true;

      const refresh = async () => {
        const list = await invoke<ProfileSummary[]>("profile_list");
        clear(page);
        page.append(
          h("h1", null, "Profiles"),
          h("div", { class: "muted" }, "Each profile is a space of its own: which mods are on and the mods installed only in it, settings, keyboard shortcuts, windows and open files. Export one to a file to take it to another machine or share it."),
          h(
            "div",
            { class: "mods-toolbar" },
            h("button", { class: "btn", onclick: async () => ((await createProfile()) ? refresh() : null) }, icon("add"), "New Profile…"),
            h("button", { class: "btn secondary", onclick: async () => ((await importProfile()) ? refresh() : null) }, icon("cloud-download"), "Import Profile…"),
          ),
          ...list.map((p, i) => card(p, i)),
        );
        first = false;
      };

      const card = (p: ProfileSummary, i: number) => {
        const act = async (fn: () => Promise<unknown>) => {
          try {
            await fn();
          } catch (e) {
            notify("error", String(e));
          }
          refresh();
        };
        return h(
          "div",
          { class: `mod-card${first ? " card-enter" : ""}${p.active ? " active-profile" : ""}`, style: { animationDelay: first ? `${Math.min(i, 12) * 30}ms` : "0ms" } },
          h("div", { class: "mod-icon" }, icon(p.icon || (p.active ? "account" : "person"))),
          h(
            "div",
            null,
            h("div", { class: "title" }, h("b", null, p.name), p.active ? h("span", { class: "chip" }, icon("check"), "active") : null),
            h("div", { class: "desc" }, p.description || h("span", { class: "muted" }, p.enabled ? "" : "A plain notepad.")),
            h(
              "div",
              { class: "meta" },
              h("span", { class: "chip outline", title: "Mods turned on" }, icon("extensions"), `${p.enabled} on`),
              p.own.length ? h("span", { class: "chip outline", title: `Installed only in this profile: ${p.own.join(", ")}` }, icon("package"), `${p.own.length} own`) : null,
              p.keybindings ? h("span", { class: "chip outline", title: "Keyboard shortcuts of its own" }, icon("record-keys"), String(p.keybindings)) : null,
              h("span", { class: "chip outline", title: "Windows it opens" }, icon("window"), String(p.windows)),
            ),
          ),
          h(
            "div",
            { class: "side-actions" },
            p.active
              ? h("button", { class: "btn secondary", onclick: () => commands.execute("preferences.settings") }, "Settings")
              : h("button", { class: "btn", onclick: () => askSwitch(p.name) }, "Switch"),
            h("button", { class: "btn secondary", onclick: () => exportProfile(p.name) }, "Export…"),
            h(
              "button",
              {
                class: "icon-button",
                title: "More",
                onclick: (e: MouseEvent) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const items = [
                    {
                      label: "Rename…",
                      run: () =>
                        act(async () => {
                          const to = await inputBox({ prompt: `New name for "${p.name}"`, value: p.name, validate: NAME_RULE });
                          if (to && to !== p.name) await invoke("profile_rename", { from: p.name, to });
                        }),
                    },
                    {
                      label: "Edit Description…",
                      run: () =>
                        act(async () => {
                          if (!p.active) return notify("info", "Switch to the profile to edit its description.");
                          const d = await inputBox({ prompt: "What is this profile for?", value: p.description });
                          if (d !== undefined) await invoke("profile_set_info", { description: d });
                        }),
                    },
                    {
                      label: "Duplicate…",
                      run: () =>
                        act(async () => {
                          const name = await inputBox({ prompt: `Name of the copy of "${p.name}"`, value: `${p.name}-copy`, validate: NAME_RULE });
                          if (name) await invoke("profile_create", { name, copyFrom: p.name, description: p.description || null });
                        }),
                    },
                    ...(p.active ? [{ label: "Open profile.json", run: () => commands.execute("preferences.openProfileJson") }] : []),
                    ...(!p.active
                      ? [
                          { separator: true, label: "" },
                          {
                            label: "Delete…",
                            run: () =>
                              act(async () => {
                                if (await confirm(`Delete the profile "${p.name}"?`, `Its settings, its ${p.own.length} own mod${p.own.length === 1 ? "" : "s"}, and the unsaved text of its windows are deleted. Export it first to keep a copy.`, "Delete")) await invoke("profile_delete", { name: p.name });
                              }),
                          },
                        ]
                      : []),
                  ];
                  import("./widgets").then((w) => w.contextMenu(r.left - 120, r.bottom + 2, items));
                },
              },
              icon("ellipsis"),
            ),
          ),
        );
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
  /** Applies the editor's own settings after one changed. */
  applyCore: (settings: Record<string, any>, changed: string) => void | Promise<void>;
}

type Field = { key: string; label: string; description?: string; type: "number" | "string" | "boolean"; enum?: { value: any; label: string }[]; default: any; min?: number; max?: number };

export const CORE_FIELDS: { section: string; fields: Field[] }[] = [
  {
    section: "Editor",
    fields: [
      { key: "editor.fontSize", label: "Font Size", type: "number", default: navigator.platform.toLowerCase().includes("mac") ? 12 : 14, min: 8, max: 40 },
      { key: "editor.fontFamily", label: "Font Family", type: "string", default: "", description: "Leave empty for Menlo / SF Mono." },
      { key: "editor.lineHeight", label: "Line Height", type: "number", default: 0, min: 0, max: 60, description: "0 picks one from the font size." },
      { key: "editor.wordWrap", label: "Word Wrap", type: "string", default: "off", enum: [{ value: "off", label: "Off" }, { value: "on", label: "On" }, { value: "bounded", label: "At the window edge or 80 columns" }] },
      { key: "editor.minimap", label: "Minimap", type: "boolean", default: true },
      { key: "editor.lineNumbers", label: "Line Numbers", type: "string", default: "on", enum: [{ value: "on", label: "On" }, { value: "relative", label: "Relative" }, { value: "off", label: "Off" }] },
      { key: "editor.renderWhitespace", label: "Show Whitespace", type: "string", default: "selection", enum: [{ value: "none", label: "Never" }, { value: "selection", label: "In the selection" }, { value: "boundary", label: "Except single spaces" }, { value: "all", label: "Always" }] },
      { key: "editor.cursorStyle", label: "Cursor Style", type: "string", default: "line", enum: [{ value: "line", label: "Line" }, { value: "block", label: "Block" }, { value: "underline", label: "Underline" }] },
      { key: "editor.stickyScroll", label: "Sticky Scroll", type: "boolean", default: true, description: "Keeps the enclosing function or block visible at the top." },
      { key: "editor.bracketPairColorization", label: "Colored Bracket Pairs", type: "boolean", default: true },
    ],
  },
  {
    section: "Workbench",
    fields: [
      { key: "theme", label: "Color Theme", type: "string", default: "aicode-dark", enum: [] },
      { key: "workbench.previewEditors", label: "Preview Editors", type: "boolean", default: true, description: "A single click opens a file in a tab the next one replaces (shown in italics)." },
      { key: "workbench.editor.useModal", label: "Open Pages in a Modal", type: "string", default: "some", description: "Settings, Mods, Keyboard Shortcuts and Profiles open over the editor, like VS Code. The modal's header can still move one into a tab.", enum: [{ value: "some", label: "Settings, Mods, Shortcuts and Profiles" }, { value: "off", label: "Off (always in a tab)" }] },
      { key: "workbench.iconTheme", label: "File Icon Theme", type: "string", default: "seti", enum: [{ value: "seti", label: "Seti (Visual Studio Code)" }, { value: "none", label: "None (plain icons)" }] },
      { key: "workbench.iconSize", label: "Icon Size", type: "string", default: "normal", description: "Of the activity bar on the left and the lists in side bars.", enum: [{ value: "normal", label: "Normal (VS Code size)" }, { value: "large", label: "Large" }, { value: "larger", label: "Larger" }] },
      { key: "animations", label: "Animations", type: "boolean", default: true, description: "Also off while macOS Reduce motion is on." },
    ],
  },
];

export function openSettings(deps: SettingsDeps) {
  deps.editors.openPage({
    title: "Settings",
    icon: "settings-gear",
    actions: [{ icon: "go-to-file", title: "Open Settings (JSON)", run: () => { closeModal(); commands.execute("preferences.openProfileJson"); } }],
    key: "settings",
    restore: "settings",
    render: (root) => {
      const page = h("div", { class: "mods-page settings-page" });
      root.append(page);
      let filter = "";

      const control = (owner: string, f: Field, values: Record<string, any>) => {
        const current = f.key in values ? values[f.key] : f.default;
        const save = async (value: any) => {
          try {
            await invoke("settings_set", { modId: owner, key: f.key, value: value === f.default && owner === "core" && f.key !== "theme" ? null : value });
            if (owner === "core") await deps.applyCore(await invoke<Record<string, any>>("settings_get", { modId: "core" }), f.key);
          } catch (e) {
            notify("error", String(e));
          }
        };
        if (f.type === "boolean") {
          return h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!current, onchange: (e: Event) => save((e.target as HTMLInputElement).checked) }), h("span", null, current ? "On" : "Off"));
        }
        if (f.enum?.length) {
          return h(
            "select",
            { class: "input", onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; save(f.type === "number" ? Number(v) : v); } },
            f.enum.map((o) => h("option", { value: String(o.value), selected: String(o.value) === String(current) }, o.label)),
          );
        }
        return h("input", {
          class: "input",
          type: f.type === "number" ? "number" : "text",
          value: current ?? "",
          min: f.min,
          max: f.max,
          spellcheck: false,
          onchange: (e: Event) => {
            const raw = (e.target as HTMLInputElement).value;
            save(f.type === "number" ? (raw === "" ? f.default : Math.max(f.min ?? -Infinity, Math.min(f.max ?? Infinity, Number(raw)))) : raw);
          },
        });
      };

      const row = (owner: string, f: Field, values: Record<string, any>) =>
        h(
          "div",
          { class: "setting-row" },
          h("div", { class: "setting-label" }, h("b", null, f.label), h("span", { class: "muted key" }, owner === "core" ? f.key : `${owner} › ${f.key}`), f.description ? h("div", { class: "muted" }, f.description) : null),
          h("div", { class: "setting-control" }, control(owner, f, values)),
        );

      const matches = (f: Field) => !filter || `${f.label} ${f.key} ${f.description ?? ""}`.toLowerCase().includes(filter);

      const render = async () => {
        const profile = await invoke<ProfileView>("profile_get");
        const core = await invoke<Record<string, any>>("settings_get", { modId: "core" });
        const sections: HTMLElement[] = [];
        for (const s of CORE_FIELDS) {
          const fields = s.fields
            .map((f) => (f.key === "theme" ? { ...f, enum: deps.themes().map((t) => ({ value: t.id, label: `${t.label}${t.source === "core" ? "" : ` — ${t.source}`}` })), default: deps.themes()[0]?.id } : f))
            .filter(matches);
          if (fields.length) sections.push(h("h2", null, s.section), ...fields.map((f) => row("core", f, core)));
        }
        for (const m of deps.host.list()) {
          const declared = m.contributes?.settings;
          if (!declared || typeof declared !== "object") continue;
          const values = await invoke<Record<string, any>>("settings_get", { modId: m.id });
          const fields: Field[] = Object.entries(declared)
            .map(([key, d]: [string, any]) => ({ key, label: d.title ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()), description: d.description, type: d.type === "number" || d.type === "boolean" ? d.type : "string", default: d.default ?? (d.type === "boolean" ? false : d.type === "number" ? 0 : ""), enum: Array.isArray(d.enum) ? d.enum.map((v: any) => ({ value: v, label: String(v) })) : undefined }) as Field)
            .filter(matches);
          if (fields.length) sections.push(h("h2", null, m.name), ...fields.map((f) => row(m.id, f, values)));
        }
        const search = h("input", { class: "input", placeholder: "Search settings", value: filter, oninput: (e: Event) => { filter = (e.target as HTMLInputElement).value.toLowerCase(); render().then(() => (page.querySelector(".mods-toolbar input") as HTMLInputElement | null)?.focus()); } });
        clear(page);
        page.append(
          h("h1", null, "Settings"),
          h("div", { class: "muted" }, `For the profile "${profile.name}". Other profiles keep their own.`),
          h(
            "div",
            { class: "mods-toolbar" },
            search,
            h("button", { class: "btn secondary", onclick: () => commands.execute("profiles.manage") }, icon("account"), "Profiles"),
            h("button", { class: "btn secondary", onclick: () => commands.execute("workbench.keybindings") }, icon("record-keys"), "Keyboard Shortcuts"),
            h("button", { class: "btn secondary", onclick: () => commands.execute("preferences.openProfileJson") }, icon("json"), "Edit as JSON"),
          ),
          ...(sections.length ? sections : [h("div", { class: "muted" }, "No setting matches.")]),
        );
      };
      render();
      return toDisposable(() => {});
    },
  });
}
