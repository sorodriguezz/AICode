// Windows opened *as* something: a window layout (`workbench.windowLayouts`, which mods extend
// through their configuration defaults), a single view (the chat in a window of its own), or a tab
// dragged out of another window. Each window is a full AICode window — same mods, its own session —
// arranged by its layout: which views go where, which parts show, its size, always on top, and
// settings that apply to that window only.

import { invoke } from "./ipc";
import { config } from "./config";
import type { LayoutOptions, ViewLocation, ViewPlace } from "./workbench";
import type { DetachedTab } from "./editor";

export interface WindowLayout {
  title?: string;
  width?: number;
  height?: number;
  alwaysOnTop?: boolean;
  /** Customize Layout choices for this window. */
  options?: Partial<LayoutOptions>;
  /** Which parts are open when the window opens. */
  parts?: Partial<Record<ViewLocation, boolean>>;
  sizes?: Partial<Record<ViewLocation, number>>;
  /** A view shown in place of the editor. */
  center?: string;
  /** Where each view goes in this window. */
  views?: Record<string, ViewPlace>;
  /** Parts hidden in this window (as in workbench.hide). */
  hide?: string[];
  /** Core settings for this window only. */
  settings?: Record<string, unknown>;
}

/** What a window was opened as. Kept in its session, so it comes back the same after a restart. */
export interface WindowSpec {
  layout?: string;
  /** A view in place of the editor (and the window's title). */
  view?: string;
  /** Files (or unsaved text) to open the first time, from a tab moved here. */
  files?: DetachedTab[];
  title?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  alwaysOnTop?: boolean;
  settings?: Record<string, unknown>;
}

/** Layouts AICode itself uses: "view" for a view moved to a window, "editor" for a tab moved out. */
const BUILTIN: Record<string, WindowLayout> = {
  view: {
    width: 560,
    height: 760,
    options: { activityBar: false, statusBar: false },
    parts: { sidebar: false, secondary: false, panel: false },
  },
  editor: {
    width: 960,
    height: 720,
    options: { activityBar: false },
    parts: { sidebar: false, secondary: false, panel: false },
  },
};

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Every layout by name: AICode's, then the configuration's (yours and your mods'). */
export function layouts(): Record<string, WindowLayout> {
  const configured = config.core<Record<string, WindowLayout>>("workbench.windowLayouts", {});
  return { ...BUILTIN, ...(isObject(configured) ? configured : {}) };
}

/** The layout a spec stands for, with the spec's own values over it. */
export function resolveLayout(spec: WindowSpec): WindowLayout {
  const base = (spec.layout && layouts()[spec.layout]) || (spec.view ? BUILTIN.view : {});
  const out: WindowLayout = JSON.parse(JSON.stringify(base));
  if (spec.view) out.center = spec.view;
  for (const k of ["title", "width", "height", "alwaysOnTop"] as const) if (spec[k] !== undefined) (out as any)[k] = spec[k];
  if (spec.settings) out.settings = { ...(out.settings ?? {}), ...spec.settings };
  return out;
}

/** Opens a new window as `spec` describes. Returns its label. */
export async function openWindow(spec: WindowSpec): Promise<string> {
  if (spec.layout && !layouts()[spec.layout]) throw new Error(`no window layout named "${spec.layout}" — add it to workbench.windowLayouts`);
  const layout = resolveLayout(spec);
  // What Rust needs when it creates the window (size, title, on top, transparency); the page gets
  // the whole spec back with window_take_spec.
  const full = { ...spec, width: layout.width, height: layout.height, title: layout.title ?? spec.title, alwaysOnTop: layout.alwaysOnTop, settings: layout.settings };
  return invoke<string>("window_new", { paths: [], spec: full });
}
