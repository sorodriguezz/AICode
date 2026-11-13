// Commands and keybindings. A command can be declared by a mod's manifest before its code is
// loaded: running it activates the mod first (`onCommand:<id>`), then runs what the mod registered.

import { Disposable, toDisposable } from "./ui";
import { rankOf } from "./layers";

export interface CommandInfo {
  id: string;
  title: string;
  category?: string;
  icon?: string;
  /** The mod that declared or registered it; "core" for the editor's own. */
  owner: string;
  /** Hidden from the command palette (still runnable). */
  hidden?: boolean;
}

type Handler = (...args: any[]) => unknown;

const infos = new Map<string, CommandInfo>();
const handlers = new Map<string, Handler>();
let lazyActivator: ((commandId: string) => Promise<boolean>) | null = null;

export function setLazyActivator(fn: (commandId: string) => Promise<boolean>) {
  lazyActivator = fn;
}

export function declare(info: CommandInfo) {
  if (!infos.has(info.id)) infos.set(info.id, info);
}

export function register(id: string, handler: Handler, info?: Partial<CommandInfo>): Disposable {
  handlers.set(id, handler);
  const existing = infos.get(id);
  infos.set(id, { id, title: id, owner: "core", ...existing, ...info } as CommandInfo);
  return toDisposable(() => {
    if (handlers.get(id) === handler) handlers.delete(id);
  });
}

export async function execute(id: string, ...args: any[]): Promise<unknown> {
  let handler = handlers.get(id);
  if (!handler && lazyActivator && (await lazyActivator(id))) handler = handlers.get(id);
  if (!handler) throw new Error(`command not found: ${id}`);
  return handler(...args);
}

export function has(id: string) {
  return handlers.has(id) || infos.has(id);
}

export function all(): CommandInfo[] {
  return [...infos.values()].filter((c) => !c.hidden && (handlers.has(c.id) || c.owner !== "core"));
}

// ---------- keybindings ----------

const isMac = navigator.platform.toLowerCase().includes("mac");

export interface Binding {
  key: string;
  chords: string[];
  command: string;
  args?: unknown;
  when?: () => boolean;
  owner: string;
}

const bindings: Binding[] = [];

const modifierName = (m: string) => (m === "mod" ? (isMac ? "cmd" : "ctrl") : m === "meta" || m === "win" ? "cmd" : m === "option" ? "alt" : m);

/**
 * "cmd+shift+p", "ctrl+`", "cmd+k m" — `mod` is ⌘ on macOS and Ctrl elsewhere. A modifier alone is
 * a chord too, pressed and released with nothing else: "shift shift" is Shift tapped twice
 * (JetBrains' Search Everywhere), "alt alt", "cmd cmd".
 */
export function normalize(key: string): string[] {
  return key
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((chord) => {
      const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
      const keyPart = parts.length === 1 && MODIFIERS.has(modifierName(parts[0])) ? modifierName(parts.pop()!) : parts.pop() ?? "";
      const mods = new Set(parts.map(modifierName));
      const order = ["ctrl", "shift", "alt", "cmd"].filter((m) => mods.has(m));
      return [...order, keyPart].join("+");
    });
}

const MODIFIERS = new Set(["ctrl", "shift", "alt", "cmd"]);
/** A key sequence made only of modifier taps ("shift shift") must be quick, like a double click. */
const TAP_MS = 450;

export function eventChord(e: KeyboardEvent): string {
  let key = e.key.toLowerCase();
  // With ⌥ held, macOS changes e.key ("π" for p); e.code is the physical key.
  if (e.code.startsWith("Key")) key = e.code.slice(3).toLowerCase();
  else if (e.code.startsWith("Digit")) key = e.code.slice(5);
  else if (e.code === "Backquote") key = "`";
  else if (e.code === "Comma") key = ",";
  else if (e.code === "Period") key = ".";
  else if (e.code === "Slash") key = "/";
  else if (e.code === "Equal") key = "=";
  else if (e.code === "Minus") key = "-";
  if (key === " ") key = "space";
  if (key === "escape") key = "escape";
  const mods = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.shiftKey) mods.push("shift");
  if (e.altKey) mods.push("alt");
  if (e.metaKey) mods.push("cmd");
  return [...mods, key].join("+");
}

/**
 * Bindings are kept in layer order (layers.ts: core, bundled mods, the user's mods, the user's own
 * shortcuts), the last one of a rank after the earlier ones: a key matches from the end, so a
 * higher layer wins whatever loaded first.
 */
export function bind(key: string, command: string, owner = "core", args?: unknown, when?: () => boolean): Disposable {
  const b: Binding = { key, chords: normalize(key), command, args, when, owner };
  const rank = rankOf(owner);
  let at = bindings.length;
  while (at > 0 && rankOf(bindings[at - 1].owner) > rank) at--;
  bindings.splice(at, 0, b);
  return toDisposable(() => {
    const i = bindings.indexOf(b);
    if (i >= 0) bindings.splice(i, 1);
  });
}

/** Takes away every key of a command except those of `keepOwner` (a user's shortcut replaces the default). */
export function unbindCommand(command: string, keepOwner?: string): Binding[] {
  const removed: Binding[] = [];
  for (let i = bindings.length - 1; i >= 0; i--) {
    if (bindings[i].command === command && bindings[i].owner !== keepOwner) removed.push(...bindings.splice(i, 1));
  }
  return removed;
}

/** Puts back bindings taken away by unbindCommand. */
export function rebind(list: Binding[]) {
  for (const b of list.reverse()) {
    const rank = rankOf(b.owner);
    const at = bindings.findIndex((x) => rankOf(x.owner) >= rank);
    bindings.splice(at < 0 ? bindings.length : at, 0, b);
  }
}

/** A command the user gave a shortcut of their own: the mods' keys for it are set aside, even ones bound later. */
function overridden(b: Binding): boolean {
  return b.owner !== "user" && bindings.some((x) => x.owner === "user" && x.command === b.command);
}

export function keybindingOwner(command: string): string | undefined {
  for (let i = bindings.length - 1; i >= 0; i--) if (bindings[i].command === command && !overridden(bindings[i])) return bindings[i].owner;
  return undefined;
}

export function keybindingFor(command: string): string | undefined {
  // The most recently bound wins, as it does when a key is pressed.
  for (let i = bindings.length - 1; i >= 0; i--) if (bindings[i].command === command && !overridden(bindings[i])) return bindings[i].key;
  return menuAccelerators[command];
}

/** Accelerators the native menu owns (see `build_menu` in lib.rs). */
const menuAccelerators: Record<string, string> = {
  "file.new": "mod+n",
  "workbench.newWindow": "mod+shift+n",
  "window.close": "mod+shift+w",
  "file.open": "mod+o",
  "file.save": "mod+s",
  "file.saveAs": "mod+shift+s",
  "editor.close": "mod+w",
  "workbench.commandPalette": "mod+shift+p",
  "workbench.quickOpen": "mod+p",
  "workbench.toggleSidebar": "mod+b",
  "workbench.togglePanel": "mod+j",
  "workbench.toggleSecondary": "mod+alt+b",
  "mods.manage": "mod+shift+x",
  "preferences.settings": "mod+,",
  "workbench.reload": "mod+r",
  "editor.zoomIn": "mod+=",
  "editor.zoomOut": "mod+-",
  "editor.zoomReset": "mod+0",
};

export function prettyKey(key: string): string[] {
  return normalize(key).map((chord) =>
    chord
      .split("+")
      .map((p) =>
        isMac
          ? ({ cmd: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", enter: "↩", escape: "⎋", backspace: "⌫", up: "↑", down: "↓", left: "←", right: "→", space: "Space" } as Record<string, string>)[p] ?? p.toUpperCase()
          : ({ cmd: "Win", ctrl: "Ctrl", shift: "Shift", alt: "Alt" } as Record<string, string>)[p] ?? p.toUpperCase(),
      )
      .join(isMac ? "" : "+"),
  );
}

/** Each key of a shortcut on its own (⌘, B), the way VS Code draws them in boxes. */
export function keyCaps(key: string): string[] {
  return prettyKey(key).flatMap((chord) => (isMac ? chord.match(/[⌘⇧⌥⌃]|[^⌘⇧⌥⌃]+/g) ?? [chord] : chord.split("+")));
}

/** The command a menu item or a key press just ran, so the other route does not run it again. */
let lastRun = { command: "", at: 0 };

export function runOnce(command: string, args?: unknown) {
  const now = performance.now();
  if (lastRun.command === command && now - lastRun.at < 250) return;
  lastRun = { command, at: now };
  execute(command, ...(args === undefined ? [] : [args])).catch((e) => console.error(e));
}

let pendingChord: { chords: string[]; at: number } | null = null;
let suspended = false;

/** While a shortcut is being recorded, keys go to the recorder, not to commands. */
export function suspendKeys(on: boolean) {
  suspended = on;
}

export function installKeyHandler() {
  /** The modifier pressed with nothing else yet (a tap, if it is released that way). */
  let lone: string | null = null;
  const modifierOf = (e: KeyboardEvent) => ({ Shift: "shift", Control: "ctrl", Alt: "alt", Meta: "cmd" } as Record<string, string>)[e.key];

  /** Runs what `chord` completes (or starts); true when it was used. */
  const handle = (chord: string, e: KeyboardEvent): boolean => {
    const now = performance.now();
    const quick = (p: { chords: string[]; at: number }) => (p.chords.every((c) => MODIFIERS.has(c)) ? now - p.at < TAP_MS : now - p.at < 1500);
    const prefix = pendingChord && quick(pendingChord) ? pendingChord.chords : [];
    const sequence = [...prefix, chord];
    let partial = false;
    for (let i = bindings.length - 1; i >= 0; i--) {
      const b = bindings[i];
      if (b.when && !b.when()) continue;
      if (overridden(b)) continue;
      const match = b.chords.length === sequence.length && b.chords.every((c, j) => c === sequence[j]);
      if (match) {
        e.preventDefault();
        e.stopPropagation();
        pendingChord = null;
        runOnce(b.command, b.args);
        return true;
      }
      if (b.chords.length > sequence.length && b.chords.slice(0, sequence.length).every((c, j) => c === sequence[j])) partial = true;
    }
    // Keys the native menu owns: run them here too (whichever route fires first wins), because a
    // focused web view may see the key before the menu does.
    if (!prefix.length && !MODIFIERS.has(chord)) {
      for (const [command, key] of Object.entries(menuAccelerators)) {
        if (normalize(key)[0] === chord && has(command)) {
          e.preventDefault();
          e.stopPropagation();
          runOnce(command);
          return true;
        }
      }
    }
    if (partial) {
      // A lone modifier starts a sequence without taking the key from anyone.
      if (!MODIFIERS.has(chord)) {
        e.preventDefault();
        e.stopPropagation();
      }
      pendingChord = { chords: sequence, at: now };
      return true;
    }
    pendingChord = null;
    // A tap that led nowhere ("shift", then ⌘P) does not swallow the key after it.
    if (prefix.length && prefix.every((c) => MODIFIERS.has(c))) return handle(chord, e);
    return false;
  };

  window.addEventListener(
    "keydown",
    (e) => {
      if (suspended || e.isComposing) return;
      const mod = modifierOf(e);
      if (mod) {
        // Only one modifier down, and no other key: maybe a tap.
        lone = !e.repeat && [e.ctrlKey, e.shiftKey, e.altKey, e.metaKey].filter(Boolean).length === 1 ? mod : null;
        return;
      }
      lone = null;
      const chord = eventChord(e);
      // A focused widget can keep keys for itself (the terminal's ⌘K): data-own-keys="cmd+k …".
      const owner = (e.target as Element | null)?.closest?.("[data-own-keys]") as HTMLElement | null;
      if (owner && owner.dataset.ownKeys!.split(" ").some((k) => normalize(k)[0] === chord)) return;
      handle(chord, e);
    },
    true,
  );
  window.addEventListener(
    "keyup",
    (e) => {
      const mod = modifierOf(e);
      const tapped = mod && mod === lone;
      lone = null;
      if (suspended || !tapped) return;
      const owner = (e.target as Element | null)?.closest?.("[data-own-keys]") as HTMLElement | null;
      if (owner && owner.dataset.ownKeys!.split(" ").some((k) => normalize(k)[0] === mod)) return;
      handle(mod, e);
    },
    true,
  );
  // Leaving the window in the middle of a tap is not a tap.
  window.addEventListener("blur", () => (lone = null));
}
