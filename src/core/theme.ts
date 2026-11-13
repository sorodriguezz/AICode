// AICode color themes: `colors` (workbench keys, each one a `--aicode-*` CSS variable) and
// `tokenColors` (rules by token scope). The built-in one is AICode Dark; a mod adds more with
// `contributes.themes`, pointing at a theme JSON file.

import * as monaco from "monaco-editor";
// VS Code's "2026" default themes (MIT, from the VS Code repository), merged into one file each.
import dark2026 from "./themes/dark-2026.json";
import light2026 from "./themes/light-2026.json";

export interface VsTheme {
  name?: string;
  type?: "dark" | "light" | "hc";
  include?: string;
  colors?: Record<string, string>;
  tokenColors?: { scope?: string | string[]; settings: { foreground?: string; fontStyle?: string } }[];
}

export interface ThemeEntry {
  id: string;
  label: string;
  uiTheme: "vs-dark" | "vs" | "hc-black";
  source: string;
  load: () => Promise<VsTheme>;
}

const DARK_BASE: Record<string, string> = {
  foreground: "#cccccc",
  descriptionForeground: "#9d9d9d",
  errorForeground: "#f85149",
  focusBorder: "#0078d4",
  "icon.foreground": "#cccccc",
  "widget.border": "#313131",
  "widget.shadow": "#0000005c",
  "sash.hoverBorder": "#0078d4",
  "textLink.foreground": "#4daafc",
  "activityBar.background": "#181818",
  "activityBar.border": "#2b2b2b",
  "activityBar.foreground": "#d7d7d7",
  "activityBar.inactiveForeground": "#868686",
  "activityBar.activeBorder": "#0078d4",
  "activityBarBadge.background": "#0078d4",
  "activityBarBadge.foreground": "#ffffff",
  "badge.background": "#616161",
  "badge.foreground": "#f8f8f8",
  "button.background": "#0078d4",
  "button.foreground": "#ffffff",
  "button.border": "#ffffff12",
  "button.hoverBackground": "#026ec1",
  "button.secondaryBackground": "#313131",
  "button.secondaryForeground": "#cccccc",
  "button.secondaryHoverBackground": "#3c3c3c",
  "commandCenter.background": "#1f1f1f",
  "commandCenter.activeBackground": "#2a2a2a",
  "commandCenter.border": "#ffffff1f",
  "commandCenter.foreground": "#cccccc",
  "editor.background": "#181818",
  "editor.foreground": "#cccccc",
  "editorLineNumber.foreground": "#6e7681",
  "editorLineNumber.activeForeground": "#cccccc",
  "editor.lineHighlightBorder": "#ffffff0d",
  "editor.selectionBackground": "#264f78",
  "editor.inactiveSelectionBackground": "#3a3d41",
  "editorCursor.foreground": "#aeafad",
  "editorIndentGuide.background1": "#404040",
  "editorWidget.background": "#202020",
  "editorWidget.foreground": "#cccccc",
  "editorGroupHeader.tabsBackground": "#181818",
  "editorGroupHeader.tabsBorder": "#2b2b2b",
  "editorGutter.background": "#181818",
  "input.background": "#313131",
  "input.border": "#3c3c3c",
  "input.foreground": "#cccccc",
  "input.placeholderForeground": "#989898",
  "inputValidation.infoBackground": "#063b49",
  "inputValidation.infoBorder": "#007acc",
  "inputValidation.warningBackground": "#352a05",
  "keybindingLabel.background": "#8080802b",
  "keybindingLabel.foreground": "#cccccc",
  "keybindingLabel.border": "#33333399",
  "keybindingLabel.bottomBorder": "#44444499",
  "list.activeSelectionBackground": "#04395e",
  "list.inactiveSelectionBackground": "#37373d",
  "list.hoverBackground": "#2a2d2e",
  "list.focusOutline": "#0078d4",
  "list.highlightForeground": "#2aaaff",
  "tree.indentGuidesStroke": "#585858",
  "tree.inactiveIndentGuidesStroke": "#58585866",
  "list.dropBackground": "#383b3d",
  "list.errorForeground": "#f88070",
  "list.warningForeground": "#cca700",
  "gitDecoration.addedResourceForeground": "#81b88b",
  "gitDecoration.modifiedResourceForeground": "#e2c08d",
  "gitDecoration.deletedResourceForeground": "#c74e39",
  "gitDecoration.renamedResourceForeground": "#73c991",
  "gitDecoration.untrackedResourceForeground": "#73c991",
  "gitDecoration.ignoredResourceForeground": "#8c8c8c",
  "gitDecoration.conflictingResourceForeground": "#e4676b",
  "gitDecoration.stageModifiedResourceForeground": "#e2c08d",
  "gitDecoration.stageDeletedResourceForeground": "#c74e39",
  "menu.background": "#1f1f1f",
  "menu.foreground": "#cccccc",
  "menu.border": "#454545",
  "menu.selectionBackground": "#0078d4",
  "menu.selectionForeground": "#ffffff",
  "menu.separatorBackground": "#454545",
  "notifications.background": "#1f1f1f",
  "notifications.foreground": "#cccccc",
  "notifications.border": "#2b2b2b",
  "notificationsInfoIcon.foreground": "#3794ff",
  "notificationsWarningIcon.foreground": "#cca700",
  "notificationsErrorIcon.foreground": "#f14c4c",
  "panel.background": "#181818",
  "panel.border": "#2b2b2b",
  "panelTitle.activeBorder": "#0078d4",
  "panelTitle.activeForeground": "#cccccc",
  "panelTitle.inactiveForeground": "#9d9d9d",
  "pickerGroup.border": "#3c3c3c",
  "quickInput.background": "#222222",
  "quickInput.foreground": "#cccccc",
  "quickInputList.focusBackground": "#04395e",
  "quickInputList.focusForeground": "#ffffff",
  "scrollbarSlider.background": "#79797966",
  "scrollbarSlider.hoverBackground": "#646464b3",
  "sideBar.background": "#181818",
  "sideBar.border": "#2b2b2b",
  "sideBar.foreground": "#cccccc",
  "sideBarSectionHeader.background": "#181818",
  "sideBarSectionHeader.foreground": "#cccccc",
  "sideBarTitle.foreground": "#cccccc",
  "statusBar.background": "#181818",
  "statusBar.border": "#2b2b2b",
  "statusBar.foreground": "#cccccc",
  "statusBarItem.hoverBackground": "#ffffff1f",
  "statusBarItem.remoteBackground": "#0078d4",
  "statusBarItem.remoteForeground": "#ffffff",
  "tab.activeBackground": "#181818",
  "tab.activeForeground": "#ffffff",
  "tab.activeBorderTop": "#0078d4",
  "tab.border": "#2b2b2b",
  "tab.hoverBackground": "#1f1f1f",
  "tab.inactiveBackground": "#181818",
  "tab.inactiveForeground": "#9d9d9d",
  "terminal.background": "#181818",
  "terminal.foreground": "#cccccc",
  "terminalCursor.foreground": "#cccccc",
  "terminal.selectionBackground": "#264f78",
  "testing.iconPassed": "#2ea043",
  "titleBar.activeBackground": "#181818",
  "titleBar.activeForeground": "#cccccc",
  "titleBar.border": "#2b2b2b",
  "toolbar.hoverBackground": "#5a5d5e50",
  "toolbar.activeBackground": "#63666750",
};

// Token colors for the built-in dark theme, by scope (Monaco's tokens and TextMate grammars alike).
const DARK: Record<string, string> = { ...DARK_BASE, ...(dark2026.colors as Record<string, string>) };


export const BUILTIN_DARK: ThemeEntry = {
  id: "aicode-dark",
  label: "AICode Dark",
  uiTheme: "vs-dark",
  source: "core",
  load: async () => ({ name: "AICode Dark", type: "dark", colors: DARK, tokenColors: dark2026.tokenColors as VsTheme["tokenColors"] }),
};

/** The light counterpart, built in too so a light profile works without any mod. */
export const BUILTIN_LIGHT: ThemeEntry = {
  id: "aicode-light",
  label: "AICode Light",
  uiTheme: "vs",
  source: "core",
  load: async () => ({ name: "AICode Light", type: "light", colors: LIGHT_FALLBACK, tokenColors: light2026.tokenColors as VsTheme["tokenColors"] }),
};

/** TextMate scope → the token names Monaco's built-in tokenizers produce. */
const SCOPE_TO_MONACO: Record<string, string[]> = {
  comment: ["comment"],
  string: ["string"],
  "constant.numeric": ["number"],
  constant: ["number", "constant"],
  keyword: ["keyword"],
  "keyword.operator": ["operator"],
  "storage.type": ["keyword"],
  storage: ["keyword"],
  "entity.name.type": ["type"],
  "entity.name.class": ["type"],
  "support.type": ["type"],
  "entity.name.tag": ["tag"],
  "entity.other.attribute-name": ["attribute.name"],
  variable: ["variable", "identifier"],
  "variable.other.property": ["key"],
  "support.type.property-name": ["key", "string.key.json"],
  "meta.object-literal.key": ["key"],
  "punctuation.definition.tag": ["delimiter.html"],
  regexp: ["regexp"],
  "string.regexp": ["regexp"],
};

function hex(color: string | undefined): string | undefined {
  return color?.replace(/^#/, "");
}

export function cssVarName(key: string): string {
  return `--aicode-${key.replace(/\./g, "-")}`;
}

let applied = "";

/** The current theme in TextMate's own form (default colors first, then its token rules). */
export interface TmTheme {
  name: string;
  settings: { scope?: string | string[]; settings: { foreground?: string; background?: string; fontStyle?: string } }[];
}
let tmTheme: TmTheme = { name: "", settings: [] };
let monacoBase: monaco.editor.BuiltinTheme = "vs-dark";
let monacoRules: monaco.editor.ITokenThemeRule[] = [];
let monacoColors: Record<string, string> = {};
// Set once TextMate grammars are in use: they color tokens by matching the whole theme (descendant
// selectors and all) and need rules for the colors that produced.
let tmHook: ((theme: TmTheme) => monaco.editor.ITokenThemeRule[]) | null = null;

export function currentTmTheme(): TmTheme {
  return tmTheme;
}

/** Called by the TextMate support: `rules` gives the extra rules for a theme; the theme is redefined now. */
export function setTextMateRules(rules: (theme: TmTheme) => monaco.editor.ITokenThemeRule[]) {
  tmHook = rules;
  defineMonacoTheme();
}

function defineMonacoTheme() {
  const extra = tmHook ? tmHook(tmTheme) : [];
  monaco.editor.defineTheme("aicode", { base: monacoBase, inherit: true, rules: [...monacoRules, ...extra], colors: monacoColors });
  monaco.editor.setTheme("aicode");
}

/** What the configuration adds over any theme (colorCustomizations, token rules, see-through parts). */
export interface ThemeCustomizations {
  colors?: Record<string, string>;
  tokenColors?: VsTheme["tokenColors"];
  /** Colors for the editor only (Monaco), over everything: see-through backgrounds. */
  editorColors?: Record<string, string>;
}
type Customizer = (themeId: string, kind: "dark" | "light", colors: Record<string, string>) => ThemeCustomizations;
let customize: Customizer | null = null;
let lastApplied: { entry: ThemeEntry; theme: VsTheme } | null = null;

/** Sets what goes over every theme, and repaints the current one with it. */
export function setThemeCustomizations(fn: Customizer) {
  customize = fn;
  if (lastApplied) applyTheme(lastApplied.entry, lastApplied.theme);
}

/** The theme on screen now (id and kind), once one is applied. */
export function currentTheme(): { id: string; kind: "dark" | "light" } | null {
  return lastApplied ? { id: lastApplied.entry.id, kind: lastApplied.entry.uiTheme === "vs" ? "light" : "dark" } : null;
}

export function applyTheme(entry: ThemeEntry, theme: VsTheme) {
  lastApplied = { entry, theme };
  const base = entry.uiTheme;
  // Unset keys fall back to the built-in dark/light palette, so a sparse theme still paints
  // every part of the window.
  const fallback = base === "vs" ? LIGHT_FALLBACK : DARK;
  const themed: Record<string, string> = { ...fallback, ...(theme.colors ?? {}) };
  let extra: ThemeCustomizations = {};
  try {
    extra = customize?.(entry.id, base === "vs" ? "light" : "dark", themed) ?? {};
  } catch (e) {
    console.warn("theme customizations", e);
  }
  const colors: Record<string, string> = { ...themed, ...(extra.colors ?? {}) };
  theme = { ...theme, tokenColors: [...(theme.tokenColors ?? []), ...(extra.tokenColors ?? [])] };
  const root = document.documentElement;
  for (const key of applied.split("|")) if (key) root.style.removeProperty(cssVarName(key));
  for (const [key, value] of Object.entries(colors)) root.style.setProperty(cssVarName(key), value);
  applied = Object.keys(colors).join("|");
  root.style.colorScheme = base === "vs" ? "light" : "dark";
  root.dataset.theme = base === "vs" ? "light" : "dark";

  const rules: monaco.editor.ITokenThemeRule[] = [];
  for (const tc of theme.tokenColors ?? []) {
    const scopes = Array.isArray(tc.scope) ? tc.scope : (tc.scope ?? "").split(",").map((s) => s.trim());
    for (const scope of scopes) {
      if (!scope) continue;
      // For Monaco's own tokenizers (languages without a grammar), which match one name by prefix: a
      // descendant selector ("source.ts entity.name") has no equivalent there. Grammars get the full theme.
      if (scope.includes(" ")) continue;
      // The scope itself (TextMate grammars produce it) and the names Monaco's own tokenizers use.
      const targets = [scope, ...(SCOPE_TO_MONACO[scope] ?? [])];
      for (const token of targets) {
        rules.push({ token, foreground: hex(tc.settings.foreground), fontStyle: tc.settings.fontStyle });
      }
    }
  }
  const editorColors: Record<string, string> = {};
  for (const [key, value] of Object.entries(colors)) {
    if (/^(editor|editorCursor|editorLineNumber|editorWidget|editorGutter|editorIndentGuide|editorSuggestWidget|editorHoverWidget|diffEditor|minimap|scrollbarSlider|input|list|focusBorder|widget|menu)/.test(key)) {
      editorColors[key] = value;
    }
  }
  Object.assign(editorColors, extra.editorColors ?? {});
  tmTheme = {
    name: entry.id,
    settings: [
      { settings: { foreground: colors["editor.foreground"], background: editorColors["editor.background"] ?? colors["editor.background"] } },
      ...(theme.tokenColors ?? []),
    ],
  };
  monacoBase = base;
  monacoRules = rules;
  monacoColors = editorColors;
  defineMonacoTheme();
}

const LIGHT_BASE: Record<string, string> = {
  ...DARK_BASE,
  foreground: "#3b3b3b",
  descriptionForeground: "#717171",
  "icon.foreground": "#3b3b3b",
  "widget.border": "#e5e5e5",
  "widget.shadow": "#00000029",
  "activityBar.background": "#f8f8f8",
  "activityBar.border": "#e5e5e5",
  "activityBar.foreground": "#1f1f1f",
  "activityBar.inactiveForeground": "#616161",
  "badge.background": "#cccccc",
  "badge.foreground": "#3b3b3b",
  "button.secondaryBackground": "#e5e5e5",
  "button.secondaryForeground": "#3b3b3b",
  "button.secondaryHoverBackground": "#cccccc",
  "commandCenter.background": "#ffffff",
  "commandCenter.activeBackground": "#f2f2f2",
  "commandCenter.border": "#0000001f",
  "commandCenter.foreground": "#3b3b3b",
  "editor.background": "#ffffff",
  "editor.foreground": "#3b3b3b",
  "editorLineNumber.foreground": "#6e7681",
  "editorLineNumber.activeForeground": "#171184",
  "editor.lineHighlightBorder": "#0000000d",
  "editor.selectionBackground": "#add6ff",
  "editor.inactiveSelectionBackground": "#e5ebf1",
  "editorCursor.foreground": "#000000",
  "editorWidget.background": "#f8f8f8",
  "editorWidget.foreground": "#3b3b3b",
  "editorGroupHeader.tabsBackground": "#f8f8f8",
  "editorGroupHeader.tabsBorder": "#e5e5e5",
  "editorGutter.background": "#ffffff",
  "input.background": "#ffffff",
  "input.border": "#cecece",
  "input.foreground": "#3b3b3b",
  "input.placeholderForeground": "#767676",
  "inputValidation.infoBackground": "#d6ecf2",
  "inputValidation.warningBackground": "#f6f5d2",
  "keybindingLabel.background": "#dddddd66",
  "keybindingLabel.foreground": "#555555",
  "keybindingLabel.border": "#cccccc66",
  "keybindingLabel.bottomBorder": "#bbbbbb66",
  "list.activeSelectionBackground": "#e8e8e8",
  "list.inactiveSelectionBackground": "#e4e6f1",
  "list.hoverBackground": "#f2f2f2",
  "list.highlightForeground": "#0066bf",
  "tree.indentGuidesStroke": "#a9a9a9",
  "tree.inactiveIndentGuidesStroke": "#a9a9a966",
  "list.dropBackground": "#d6ebff",
  "list.errorForeground": "#b01011",
  "list.warningForeground": "#855f00",
  "gitDecoration.addedResourceForeground": "#587c0c",
  "gitDecoration.modifiedResourceForeground": "#895503",
  "gitDecoration.deletedResourceForeground": "#ad0707",
  "gitDecoration.renamedResourceForeground": "#007100",
  "gitDecoration.untrackedResourceForeground": "#007100",
  "gitDecoration.ignoredResourceForeground": "#8e8e90",
  "gitDecoration.conflictingResourceForeground": "#ad0707",
  "gitDecoration.stageModifiedResourceForeground": "#895503",
  "gitDecoration.stageDeletedResourceForeground": "#ad0707",
  "menu.background": "#ffffff",
  "menu.foreground": "#3b3b3b",
  "menu.border": "#cecece",
  "menu.separatorBackground": "#d4d4d4",
  "notifications.background": "#ffffff",
  "notifications.foreground": "#3b3b3b",
  "notifications.border": "#e5e5e5",
  "panel.background": "#f8f8f8",
  "panel.border": "#e5e5e5",
  "panelTitle.activeForeground": "#3b3b3b",
  "panelTitle.inactiveForeground": "#3b3b3b",
  "pickerGroup.border": "#e5e5e5",
  "quickInput.background": "#f8f8f8",
  "quickInput.foreground": "#3b3b3b",
  "quickInputList.focusBackground": "#e8e8e8",
  "quickInputList.focusForeground": "#000000",
  "scrollbarSlider.background": "#64646466",
  "sideBar.background": "#f8f8f8",
  "sideBar.border": "#e5e5e5",
  "sideBar.foreground": "#3b3b3b",
  "sideBarSectionHeader.background": "#f8f8f8",
  "sideBarSectionHeader.foreground": "#3b3b3b",
  "sideBarTitle.foreground": "#3b3b3b",
  "statusBar.background": "#f8f8f8",
  "statusBar.border": "#e5e5e5",
  "statusBar.foreground": "#3b3b3b",
  "statusBarItem.hoverBackground": "#1f1f1f11",
  "tab.activeBackground": "#ffffff",
  "tab.activeForeground": "#3b3b3b",
  "tab.border": "#e5e5e5",
  "tab.hoverBackground": "#ffffff",
  "tab.inactiveBackground": "#f8f8f8",
  "tab.inactiveForeground": "#868686",
  "terminal.background": "#f8f8f8",
  "terminal.foreground": "#3b3b3b",
  "terminalCursor.foreground": "#005fb8",
  "terminal.selectionBackground": "#add6ff",
  "titleBar.activeBackground": "#f8f8f8",
  "titleBar.activeForeground": "#1e1e1e",
  "titleBar.border": "#e5e5e5",
  "toolbar.hoverBackground": "#b8b8b850",
  "toolbar.activeBackground": "#a6a6a650",
};

const LIGHT_FALLBACK: Record<string, string> = { ...LIGHT_BASE, ...(light2026.colors as Record<string, string>) };

export function cssVar(key: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(cssVarName(key)).trim();
}
