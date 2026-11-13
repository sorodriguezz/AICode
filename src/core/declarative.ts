// JSON mods: what a mod.json can do with no code at all (see docs/MOD-GUIDE.md). Commands run
// *actions*; views list launchers and notes; status bar items, editor right-click items and
// settings come straight from the manifest.
//
// The core runs the actions on the mod's behalf, the same way a code mod's calls run: every Rust
// call carries the mod's id. Permissions describe what a mod does, for the user (the Mods page
// shows them and asks before enabling it); they do not block anything, as with code mods.

import * as monaco from "monaco-editor";
import { invoke, ModInfo } from "./ipc";
import * as commands from "./commands";
import type { Workbench } from "./workbench";
import type { EditorService } from "./editor";
import type { Workspace } from "./workspace";
import { notify, inputBox, pick, confirm } from "./widgets";
import { h, icon, basename, dirname, isAbsolute, Disposable } from "./ui";
import { onStream } from "./ipc";
import { config } from "./config";
import { openWindow } from "./windows";

export const ACTION_TYPES = ["notify", "insert", "transform", "replace", "newFile", "openFile", "writeFile", "openUrl", "copy", "shell", "ask", "command", "confirm", "window", "setting"] as const;

const NEEDS: Record<string, string[]> = { shell: ["process"], openFile: ["fs:read"], writeFile: ["fs:write", "fs:read"], openUrl: ["open-external"] };

class Cancelled extends Error {}

export interface DeclarativeDeps {
  wb: Workbench;
  editors: EditorService;
  workspace: Workspace;
  /** Gets another enabled mod's exports (activating it), or undefined. */
  modExports: (id: string) => Promise<any>;
  isEnabled: (id: string) => boolean;
}

/**
 * Permissions a mod.json's actions use but do not declare. Nothing is blocked; the author should
 * declare them so the user knows what the mod does (pnpm check:mods reports them).
 */
export function undeclaredPermissions(info: ModInfo): string[] {
  const out = new Set<string>();
  for (const cmd of info.contributes?.commands ?? []) {
    for (const a of Array.isArray(cmd.run) ? cmd.run : cmd.run ? [cmd.run] : []) {
      for (const p of NEEDS[a?.type] ?? []) if (!info.permissions.includes(p)) out.add(p);
    }
  }
  return [...out];
}

/** Problems a mod.json's actions have, for the Mods page and a warning on load. */
export function checkActions(info: ModInfo): string[] {
  const problems: string[] = [];
  for (const cmd of info.contributes?.commands ?? []) {
    if (cmd.run === undefined) continue;
    for (const a of Array.isArray(cmd.run) ? cmd.run : [cmd.run]) {
      if (!a || typeof a !== "object" || !ACTION_TYPES.includes(a.type)) problems.push(`${cmd.id}: unknown action type ${JSON.stringify(a?.type)}`);
      // Permissions are not checked here: they only tell the user (see `undeclaredPermissions`).
    }
  }
  return problems;
}

export class Declarative {
  constructor(private d: DeclarativeDeps) {}

  /** Puts a mod's declarative parts on screen. Returns what to undo. */
  contribute(info: ModInfo): Disposable[] {
    const c = info.contributes ?? {};
    const subs: Disposable[] = [];
    for (const cmd of c.commands ?? []) {
      if (cmd.run === undefined) continue;
      subs.push(commands.register(cmd.id, (...args: any[]) => this.run(info, cmd.run, cmd.title ?? cmd.id, args), { title: cmd.title, category: cmd.category ?? info.name, owner: info.id, hidden: cmd.hidden }));
    }
    for (const item of c.statusBar ?? []) {
      this.resolveStatic(info, item.text ?? "").then((text) => {
        const handle = this.d.wb.addStatus({ id: item.id, text, icon: item.icon, tooltip: item.tooltip, command: item.command, args: item.args, align: item.align === "right" ? "right" : "left", priority: item.priority ?? 0 });
        subs.push({ dispose: handle.dispose });
      });
    }
    for (const v of c.views ?? []) {
      if (!v.items && v.markdown === undefined) continue;
      subs.push(this.d.wb.provideView(v.id, { render: (el) => this.renderView(el, v) }));
    }
    const editor = this.d.editors.editor;
    for (const [i, m] of (c.editorContextMenu ?? []).entries()) {
      if (!m?.command) continue;
      const title = m.title ?? (info.contributes?.commands ?? []).find((x: any) => x.id === m.command)?.title ?? m.command;
      subs.push(
        editor.addAction({
          id: `${info.id}.ctx.${i}.${m.command}`,
          label: title,
          contextMenuGroupId: "9_mods",
          contextMenuOrder: i,
          precondition: m.when === "selection" ? "editorHasSelection" : undefined,
          run: () => {
            commands.execute(m.command).catch((e) => notify("error", String(e)));
          },
        }),
      );
    }
    return subs;
  }

  private renderView(el: HTMLElement, v: any) {
    const root = h("div", { class: "decl-view" });
    if (v.markdown) root.append(renderMarkdown(String(v.markdown)));
    for (const item of v.items ?? []) {
      root.append(
        h(
          "div",
          {
            class: "list-row decl-item",
            title: item.description ?? item.label,
            onclick: () => commands.execute(item.command, ...(Array.isArray(item.args) ? item.args : [])).catch((e) => notify("error", String(e))),
          },
          icon(item.icon ?? "play"),
          h("span", { class: "label" }, item.label),
          item.description ? h("span", { class: "muted description" }, item.description) : null,
        ),
      );
    }
    el.append(root);
  }

  // ---------- running actions ----------

  async run(info: ModInfo, run: any, title: string, _args: any[] = []) {
    const steps: any[] = Array.isArray(run) ? run : [run];
    const vars = new Vars(this.d, info);
    try {
      for (const step of steps) await this.step(info, step, title, vars);
    } catch (e) {
      if (e instanceof Cancelled) return;
      notify("error", `${title}: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async step(info: ModInfo, a: any, title: string, vars: Vars) {
    if (!a || typeof a !== "object") throw new Error("an action must be an object");
    const { editors, workspace } = this.d;
    const text = (s: unknown, mode: Mode = "plain") => vars.expand(String(s ?? ""), mode);
    const resolvePath = (p: string) => (isAbsolute(p) || p.startsWith("~") || !workspace.folder ? p.replace(/^~(?=\/|$)/, vars.home) : `${workspace.folder}/${p}`);
    switch (a.type) {
      case "notify": {
        const level = a.level === "warning" || a.level === "error" ? a.level : "info";
        notify(level, await text(a.message));
        return;
      }
      case "insert": {
        const ed = editors.editor;
        if (!editors.activeText()) throw new Error("no text editor is active");
        const body = await text(a.text, "snippet");
        ed.focus();
        const controller = ed.getContribution("snippetController2") as any;
        if (controller?.insert) controller.insert(body);
        else editors.replaceSelection(body);
        return;
      }
      case "transform": {
        const ed = editors.editor;
        const model = ed.getModel();
        let sel = ed.getSelection();
        if (!model || !sel || !editors.activeText()) throw new Error("no text editor is active");
        if (sel.isEmpty()) sel = new monaco.Selection(sel.startLineNumber, 1, sel.startLineNumber, model.getLineMaxColumn(sel.startLineNumber));
        const fn = TRANSFORMS[a.to];
        if (!fn) throw new Error(`unknown transform ${JSON.stringify(a.to)}`);
        ed.executeEdits(info.id, [{ range: sel, text: fn(model.getValueInRange(sel)), forceMoveMarkers: true }]);
        ed.pushUndoStop();
        return;
      }
      case "replace": {
        const ed = editors.editor;
        const model = ed.getModel();
        if (!model || !editors.activeText()) throw new Error("no text editor is active");
        const find = await text(a.find);
        const replacement = await text(a.replace);
        const flags = a.caseSensitive ? "g" : "gi";
        const re = new RegExp(a.regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags + "m");
        const sel = ed.getSelection();
        const range = a.scope === "selection" && sel && !sel.isEmpty() ? sel : model.getFullModelRange();
        const before = model.getValueInRange(range);
        const after = a.regex ? before.replace(re, replacement) : before.replace(re, () => replacement);
        if (after !== before) {
          ed.executeEdits(info.id, [{ range, text: after }]);
          ed.pushUndoStop();
        }
        return;
      }
      case "newFile": {
        editors.newUntitled(await text(a.text), a.language ?? "plaintext");
        return;
      }
      case "openFile": {
        const path = resolvePath(await text(a.path));
        const st = await invoke<{ exists: boolean }>("fs_stat", { modId: info.id, path });
        if (!st.exists) throw new Error(`${path} does not exist`);
        await editors.openFile(path, { line: a.line ? Number(a.line) : undefined });
        return;
      }
      case "writeFile": {
        const path = resolvePath(await text(a.path));
        const body = await text(a.text);
        const st = await invoke<{ exists: boolean; is_dir: boolean }>("fs_stat", { modId: info.id, path });
        if (st.is_dir) throw new Error(`${path} is a folder`);
        const ifExists = a.ifExists ?? "ask";
        let content: string | null = body;
        if (st.exists) {
          if (ifExists === "keep") content = null;
          else if (ifExists === "append") content = (await invoke<{ text: string }>("fs_read_text", { modId: info.id, path })).text + body;
          else if (ifExists !== "overwrite" && !(await confirm(`Replace ${basename(path)}?`, `${info.name} wants to overwrite ${path}.`, "Replace"))) throw new Cancelled();
        } else {
          await invoke("fs_create", { modId: info.id, path: dirname(path), dir: true }).catch(() => {});
        }
        if (content !== null) await invoke("fs_write_text", { modId: info.id, path, text: content });
        if (a.open) await editors.openFile(path);
        return;
      }
      case "openUrl": {
        const url = await text(a.url, "url");
        if (!/^(https?|mailto):/i.test(url)) throw new Error(`only http(s) and mailto links can be opened: ${url}`);
        await invoke("open_external", { modId: info.id, target: url });
        return;
      }
      case "copy": {
        await invoke("clipboard_write", { text: await text(a.text) });
        notify("info", "Copied to the clipboard.", [], 2000);
        return;
      }
      case "shell": {
        const line = await text(a.command, "shell");
        const cwd = a.cwd ? resolvePath(await text(a.cwd)) : workspace.folder ?? vars.home;
        const name = a.title ? await text(a.title) : title;
        await this.shell(info, line, cwd, a.in ?? "output", name);
        return;
      }
      case "ask": {
        const prompt = await text(a.prompt);
        if (!this.d.isEnabled("aicode.agents")) throw new Error("turn on the AI Chat mod to use ask actions");
        const agents = await this.d.modExports("aicode.agents");
        if (!agents?.ask) throw new Error("this AI Chat mod cannot take prompts");
        await agents.ask(prompt);
        return;
      }
      case "command": {
        const args = Array.isArray(a.args) ? await Promise.all(a.args.map((x: unknown) => (typeof x === "string" ? text(x) : x))) : [];
        await commands.execute(a.command, ...args);
        return;
      }
      case "confirm": {
        const ok = await confirm(await text(a.message), a.detail ? await text(a.detail) : undefined, a.button ?? "Continue");
        if (!ok) throw new Cancelled();
        return;
      }
      case "window": {
        // A new window with a layout (workbench.windowLayouts) or one view, as a JSON mod declares it.
        await openWindow({
          layout: a.layout,
          view: a.view,
          title: a.title ? await text(a.title) : undefined,
          width: a.width,
          height: a.height,
          alwaysOnTop: a.alwaysOnTop,
          settings: a.settings,
        });
        return;
      }
      case "setting": {
        // Changes a setting in the user's profile: a value, a toggle, or the next of a list of values.
        if (typeof a.key !== "string" || !a.key) throw new Error("a setting action needs a key");
        const owner = typeof a.owner === "string" ? a.owner : "core";
        // `path` changes one key inside an object setting ("editor" in workbench.partOpacity).
        const path: string[] = typeof a.path === "string" && a.path ? a.path.split(".") : [];
        const dig = (v: any) => path.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), v);
        const now = dig(config.get(owner, a.key));
        let value: unknown;
        if (a.toggle) value = !now;
        else if (Array.isArray(a.cycle) && a.cycle.length) {
          const i = a.cycle.findIndex((v: unknown) => JSON.stringify(v) === JSON.stringify(now));
          value = a.cycle[(i + 1) % a.cycle.length];
        } else if ("value" in a) value = typeof a.value === "string" ? await text(a.value) : a.value;
        else throw new Error(`the setting action for ${a.key} needs "value", "toggle" or "cycle"`);
        if (path.length) {
          const user = config.userValue(owner, a.key);
          const next: any = user && typeof user === "object" && !Array.isArray(user) ? user : {};
          let at = next;
          for (const k of path.slice(0, -1)) at = at[k] && typeof at[k] === "object" ? at[k] : (at[k] = {});
          at[path[path.length - 1]] = value;
          value = next;
        }
        await config.update(owner, a.key, value);
        return;
      }
      default:
        throw new Error(`unknown action type ${JSON.stringify(a.type)}`);
    }
  }

  private async shell(info: ModInfo, line: string, cwd: string, where: string, name: string) {
    if (where === "terminal" && this.d.isEnabled("aicode.terminal")) {
      const term = await this.d.modExports("aicode.terminal");
      if (term?.open) {
        await term.open({ cwd, command: "/bin/sh", args: ["-c", `${line}; echo; printf '\\033[2m[%s]\\033[0m\\n' "done"; exec "\${SHELL:-/bin/zsh}" -l`], name });
        return;
      }
    }
    const id = await invoke<number>("proc_spawn", { modId: info.id, program: "/bin/sh", args: ["-c", line], cwd });
    if (where === "background") {
      onStream("proc://exit", id, (p) => notify(p.code === 0 ? "info" : "warning", `${name}: ${p.code === 0 ? "done" : `ended with code ${p.code}`}`));
      return;
    }
    // Output: a tab that fills as the program writes.
    const pre = h("pre", { class: "decl-output" });
    const status = h("div", { class: "decl-output-status muted" }, icon("loading", "codicon-modifier-spin"), ` ${line}`);
    let ended = false;
    const offData = onStream("proc://data", id, (p) => {
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
      pre.append(p.stream === "stderr" ? h("span", { class: "stderr" }, p.data) : document.createTextNode(p.data));
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    });
    let offExit: (() => void) | null = null;
    offExit = onStream("proc://exit", id, (p) => {
      ended = true;
      offData();
      offExit?.(); // null when the exit was already buffered: removed just below
      status.replaceChildren(icon(p.code === 0 ? "pass" : "error"), ` ${line} — ${p.code === 0 ? "done" : `exit code ${p.code}`}`);
    });
    if (ended) offExit();
    this.d.editors.openCustom({
      title: `Output: ${name}`,
      icon: "output",
      render: (el) => {
        el.append(h("div", { class: "decl-output-page" }, status, pre));
        return { dispose: () => { if (!ended) invoke("proc_kill", { id }).catch(() => {}); } };
      },
    });
  }

  /** Text that cannot ask anything (status bar labels). */
  private async resolveStatic(info: ModInfo, s: string) {
    if (!/\$\{(input|pick):/.test(s)) return new Vars(this.d, info).expand(s, "plain");
    return s;
  }
}

// ---------- variables ----------

type Mode = "plain" | "shell" | "url" | "snippet";

const shellQuote = (s: string) => (s === "" ? "''" : /^[A-Za-z0-9_\/.,:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const snippetEscape = (s: string) => s.replace(/[\\$}]/g, "\\$&");

class Vars {
  private asked = new Map<string, string>();
  home = "";

  constructor(private d: DeclarativeDeps, private info: ModInfo) {}

  async expand(s: string, mode: Mode): Promise<string> {
    if (!this.home) this.home = await invoke<string>("home_dir").catch(() => "");
    let out = "";
    let i = 0;
    while (i < s.length) {
      if (s.startsWith("$${", i)) {
        out += "${";
        i += 3;
        continue;
      }
      if (s.startsWith("${", i)) {
        const end = s.indexOf("}", i + 2);
        const name = end > 0 ? s.slice(i + 2, end) : "";
        // Snippet tab stops (${1:x}) and snippet variables (${TM_FILENAME}) are the editor's.
        if (end < 0 || /^\d/.test(name) || /^[A-Z_]+(:|$)/.test(name)) {
          out += s.slice(i, end < 0 ? s.length : end + 1);
          i = end < 0 ? s.length : end + 1;
          continue;
        }
        const raw = await this.value(name);
        const isConfig = name.startsWith("config:");
        out += mode === "shell" ? (isConfig ? raw : shellQuote(raw)) : mode === "url" ? encodeURIComponent(raw) : mode === "snippet" ? snippetEscape(raw) : raw;
        i = end + 1;
        continue;
      }
      out += s[i++];
    }
    return out;
  }

  private async value(name: string): Promise<string> {
    const { editors, workspace } = this.d;
    const doc = editors.activeText();
    const path = doc?.path ?? "";
    const ed = editors.editor;
    const sel = doc ? ed.getSelection() : null;
    const model = doc?.model;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const fileName = path ? basename(path) : doc?.title ?? "";
    const dot = fileName.lastIndexOf(".");
    switch (name) {
      case "file": return path;
      case "fileName": return fileName;
      case "fileBase": return dot > 0 ? fileName.slice(0, dot) : fileName;
      case "fileExt": return dot > 0 ? fileName.slice(dot) : "";
      case "fileDir": return path ? dirname(path) : workspace.folder ?? "";
      case "relativeFile": return path && workspace.folder && path.startsWith(workspace.folder + "/") ? path.slice(workspace.folder.length + 1) : path;
      case "workspaceFolder": return workspace.folder ?? "";
      case "workspaceName": return workspace.folder ? basename(workspace.folder) : "";
      case "selection": return model && sel ? model.getValueInRange(sel) : "";
      case "selectionOrLine": return model && sel ? (sel.isEmpty() ? model.getLineContent(sel.startLineNumber) : model.getValueInRange(sel)) : "";
      case "text": return model?.getValue() ?? "";
      case "line": return sel ? String(sel.positionLineNumber) : "";
      case "column": return sel ? String(sel.positionColumn) : "";
      case "language": return model?.getLanguageId() ?? "";
      case "home": return this.home;
      case "date": return date;
      case "time": return time;
      case "datetime": return `${date} ${time}`;
    }
    if (name.startsWith("config:")) {
      // ${config:key} is this mod's setting; ${config:core.<key>} or ${config:<mod id>/<key>} reads others.
      const key = name.slice(7);
      const [owner, k] = key.startsWith("core.") ? ["core", key.slice(5)] : key.includes("/") ? [key.slice(0, key.indexOf("/")), key.slice(key.indexOf("/") + 1)] : [this.info.id, key];
      const declared = owner === this.info.id ? this.info.contributes?.settings?.[k] : undefined;
      const v = config.get(owner, k, declared?.default);
      return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    }
    if (name.startsWith("input:") || name.startsWith("pick:")) {
      if (this.asked.has(name)) return this.asked.get(name)!;
      let answer: string | undefined;
      if (name.startsWith("input:")) {
        const [prompt, value] = name.slice(6).split("|");
        answer = await inputBox({ prompt, value: value ?? "" });
      } else {
        const [prompt, ...options] = name.slice(5).split("|");
        answer = (await pick(options.map((o) => ({ label: o })), { placeholder: prompt }))?.label;
      }
      if (answer === undefined) throw new Cancelled();
      this.asked.set(name, answer);
      return answer;
    }
    throw new Error(`unknown variable \${${name}}`);
  }
}

// ---------- transforms ----------

const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
const lines = (f: (l: string[]) => string[]) => (s: string) => f(s.split("\n")).join("\n");

const TRANSFORMS: Record<string, (s: string) => string> = {
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  title: (s) => s.toLowerCase().replace(/(^|[\s\-_/(])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()),
  camel: (s) => words(s).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(""),
  snake: (s) => words(s).map((w) => w.toLowerCase()).join("_"),
  kebab: (s) => words(s).map((w) => w.toLowerCase()).join("-"),
  trim: lines((l) => l.map((x) => x.trim())),
  sortLines: lines((l) => [...l].sort((a, b) => a.localeCompare(b))),
  sortLinesDesc: lines((l) => [...l].sort((a, b) => b.localeCompare(a))),
  reverseLines: lines((l) => [...l].reverse()),
  uniqueLines: lines((l) => [...new Set(l)]),
};

// ---------- a little Markdown, for view notes ----------

export function renderMarkdown(src: string): HTMLElement {
  const root = h("div", { class: "decl-md" });
  const inline = (s: string): (Node | string)[] => {
    const out: (Node | string)[] = [];
    const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
    let at = 0;
    for (const m of s.matchAll(re)) {
      if (m.index! > at) out.push(s.slice(at, m.index));
      const t = m[0];
      if (t.startsWith("`")) out.push(h("code", null, t.slice(1, -1)));
      else if (t.startsWith("**")) out.push(h("b", null, t.slice(2, -2)));
      else if (t.startsWith("*")) out.push(h("i", null, t.slice(1, -1)));
      else {
        const [, label, href] = t.match(/\[([^\]]+)\]\(([^)]+)\)/)!;
        out.push(h("a", { href: "#", title: href, onclick: (e: Event) => { e.preventDefault(); if (/^https?:/.test(href)) invoke("open_external", { modId: "core", target: href }); } }, label));
      }
      at = m.index! + t.length;
    }
    out.push(s.slice(at));
    return out;
  };
  let list: HTMLElement | null = null;
  for (const para of src.split(/\n/)) {
    const line = para.trimEnd();
    if (/^\s*[-*] /.test(line)) {
      if (!list) root.append((list = h("ul")));
      list.append(h("li", null, inline(line.replace(/^\s*[-*] /, ""))));
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const heading = line.match(/^(#{1,3}) (.*)/);
    if (heading) root.append(h(heading[1].length === 1 ? "h3" : "h4", null, inline(heading[2])));
    else root.append(h("p", null, inline(line)));
  }
  return root;
}
