// The workbench: title bar, activity bar, the three side parts (primary side bar, secondary side
// bar, panel), the editor area and the status bar. Parts with no views simply are not there — a
// fresh install is a title bar, an editor and a status bar.

import { h, icon, iconButton, clear, Disposable, toDisposable } from "./ui";
import { Emitter } from "./events";
import * as commands from "./commands";
import { keyCaps } from "./commands";
import { contextMenu, type MenuItem } from "./widgets";
import { motionEnabled, play } from "./motion";

export type ViewLocation = "sidebar" | "secondary" | "panel";

export interface ViewDescriptor {
  id: string;
  title: string;
  icon: string;
  location: ViewLocation;
  order: number;
  owner: string;
}

export interface ViewAction {
  icon: string;
  title: string;
  /** Gets the click, so an action can open a menu under its button. */
  run: (e?: MouseEvent) => void;
  /** A ˅ next to the button (VS Code's split buttons, like New Chat's). */
  dropdown?: (e: MouseEvent) => void;
  dropdownTitle?: string;
}

export interface ViewProvider {
  render(container: HTMLElement): void | Disposable | Promise<void | Disposable>;
  actions?: ViewAction[];
  onShow?(): void;
  onHide?(): void;
}

interface ViewEntry {
  desc: ViewDescriptor;
  /** Where the mod put it, before the user moved it. */
  original: ViewDescriptor;
  provider?: ViewProvider;
  host?: HTMLElement;
  rendered: boolean;
  badge: number;
  disposable?: Disposable | void;
}

interface PartState {
  visible: boolean;
  active: string | null;
  size: number;
}

/** "Customize Layout": what VS Code keeps as workbench settings (kept by the profile here). */
export interface LayoutOptions {
  activityBar: boolean;
  statusBar: boolean;
  sidebarSide: "left" | "right";
  panelAlign: "left" | "right" | "center" | "justify";
  quickInput: "top" | "center";
  density: "default" | "compact";
  /** Side bar views whose icon the activity bar leaves out (unchecked in its context menu). */
  hiddenActivity: string[];
}
export const DEFAULT_LAYOUT: LayoutOptions = { activityBar: true, statusBar: true, sidebarSide: "left", panelAlign: "center", quickInput: "top", density: "default", hiddenActivity: [] };

export interface LayoutState {
  sidebar: PartState;
  secondary: PartState;
  panel: PartState;
}

export interface StatusItem {
  id?: string;
  text?: string;
  icon?: string;
  tooltip?: string;
  command?: string;
  args?: unknown[];
  align?: "left" | "right";
  priority?: number;
  accent?: boolean;
  /** Runs on click instead of `command`, with the click (to place a menu by the item). */
  run?: (e: MouseEvent) => void;
  /** Settle in when the text changes (a branch, a count) — not for things that change as you type. */
  animate?: boolean;
}

export interface StatusHandle {
  update(patch: Partial<StatusItem>): void;
  dispose(): void;
}

/** A button in the title bar: left (after back/forward), center (beside the search box) or right. */
export interface TitleItem {
  id?: string;
  icon?: string;
  text?: string;
  /** Tooltip. */
  title?: string;
  command?: string;
  args?: unknown[];
  run?: (e: MouseEvent) => void;
  align?: "left" | "center" | "right";
  order?: number;
  /** Shown pressed (a toggle that is on). */
  checked?: boolean;
}

export interface TitleHandle {
  update(patch: Partial<TitleItem>): void;
  dispose(): void;
}

/** A view placed by a window layout: in a part, in place of the editor, or off the window. */
export type ViewPlace = ViewLocation | "center" | "hidden";

const MIN = { sidebar: 170, secondary: 220, panel: 100 };

export class Workbench {
  readonly root: HTMLElement;
  readonly editorTabs: HTMLElement;
  readonly editorTabsActions: HTMLElement;
  readonly editorSide: HTMLElement;
  readonly editorSideSash: HTMLElement;
  readonly editorBody: HTMLElement;
  /** The path of the active file under the tabs (VS Code's breadcrumbs). */
  readonly editorBreadcrumbs: HTMLElement;
  private activitybar: HTMLElement;
  private activityTop: HTMLElement;
  private parts: Record<ViewLocation, { el: HTMLElement; header: HTMLElement; body: HTMLElement; sash: HTMLElement }>;
  private statusLeft: HTMLElement;
  private statusRight: HTMLElement;
  private commandCenterLabel: HTMLElement;
  private toggles: Record<ViewLocation, HTMLButtonElement>;
  private views = new Map<string, ViewEntry>();
  /** Whether each part is on screen, as last drawn (animations run between the two states). */
  private shown: Record<ViewLocation, boolean> = { sidebar: false, secondary: false, panel: false };
  private animating: Record<ViewLocation, boolean> = { sidebar: false, secondary: false, panel: false };
  private lastActiveActivity: string | null = null;
  private lastBadges = new Map<string, number>();
  /** Off while the window is being put together, so a restored layout does not play open. */
  private motionReady = false;
  private statusItems = new Set<{ item: StatusItem; el: HTMLElement }>();
  private titleItems = new Set<{ item: TitleItem; el: HTMLElement }>();
  private titleHosts!: Record<"left" | "center" | "right", HTMLElement>;
  /** Views taken off the window (workbench.hiddenViews, a layout's "hidden"). */
  private hiddenViews = new Set<string>();
  /** A view shown in place of the editor (a window layout's `center`). */
  private centerView: string | null = null;
  private centerHost!: HTMLElement;
  private editorGroup!: HTMLElement;
  /** The pin (always on top) in the title bar; main.ts shows it and gives it its state. */
  readonly pinButton: HTMLButtonElement;
  /** "Move to New Window" on a view: main.ts opens the window. */
  detachView: ((viewId: string) => void) | null = null;
  readonly onDidChangeLayout = new Emitter<void>();
  /** Where the user dragged views to: kept by the profile. */
  private placement: Record<string, { location: ViewLocation; order: number }> = {};
  readonly onDidChangePlacement = new Emitter<Record<string, { location: ViewLocation; order: number }>>();
  private dropZones!: HTMLElement;
  /** Asked before a view with no provider is shown; the mod host activates its owner. */
  viewActivator: (viewId: string) => Promise<void> = async () => {};

  options: LayoutOptions = { ...DEFAULT_LAYOUT };
  readonly onDidChangeOptions = new Emitter<LayoutOptions>();
  /** A part maximized over the others (the panel over the editor, the secondary side bar over all). */
  private maximized: ViewLocation | null = null;
  private center!: HTMLElement;
  private statusbar!: HTMLElement;
  private mainEl!: HTMLElement;

  state: LayoutState = {
    sidebar: { visible: true, active: null, size: 300 },
    secondary: { visible: true, active: null, size: 340 },
    panel: { visible: false, active: null, size: 260 },
  };

  constructor(mount: HTMLElement) {
    this.commandCenterLabel = h("span", null, "Search");
    const commandCenter = h(
      "div",
      { class: "command-center", title: "Search files and commands", onclick: () => commands.execute("workbench.quickOpen") },
      icon("search"),
      this.commandCenterLabel,
    );
    const back = iconButton("arrow-left", "Go Back", () => commands.execute("editor.navigateBack"));
    const forward = iconButton("arrow-right", "Go Forward", () => commands.execute("editor.navigateForward"));
    this.toggles = {
      sidebar: iconButton("layout-sidebar-left", "Toggle Primary Side Bar", () => this.toggle("sidebar")),
      panel: iconButton("layout-panel", "Toggle Panel", () => this.toggle("panel")),
      secondary: iconButton("layout-sidebar-right", "Toggle Secondary Side Bar", () => this.toggle("secondary")),
    };
    commandCenter.dataset.part = "titleBar.commandCenter";
    this.pinButton = iconButton("pin", "Keep on Top", () => commands.execute("window.toggleAlwaysOnTop"));
    this.pinButton.dataset.part = "titleBar.pin";
    this.pinButton.style.display = "none";
    this.titleHosts = {
      left: h("div", { class: "group title-items", dataset: { part: "titleBar.items", align: "left" } }),
      center: h("div", { class: "group title-items", dataset: { part: "titleBar.items", align: "center" } }),
      right: h("div", { class: "group title-items", dataset: { part: "titleBar.items", align: "right" } }),
    };
    const titlebar = h(
      "div",
      { class: "titlebar", dataset: { part: "titleBar" }, "data-tauri-drag-region": true, ondblclick: (e: MouseEvent) => e.target === titlebar && commands.execute("window.toggleMaximize") },
      h("div", { class: "titlebar-left", "data-tauri-drag-region": true }, h("div", { class: "group", dataset: { part: "titleBar.nav" } }, back, forward), this.titleHosts.left),
      h("div", { class: "titlebar-center", "data-tauri-drag-region": true }, commandCenter, this.titleHosts.center),
      h(
        "div",
        { class: "titlebar-right", "data-tauri-drag-region": true },
        this.titleHosts.right,
        // Right of the search box: the pages VS Code opens as modal editors.
        // Settings live in the status bar's gear (Manage), not up here.
        h("div", { class: "group", dataset: { part: "titleBar.mods" } }, this.pinButton, iconButton("extensions", `Mods (${commands.prettyKey("mod+shift+x").join(" ")})`, () => commands.execute("mods.manage"))),
        h("div", { class: "group", dataset: { part: "titleBar.layoutControls" }, "data-tauri-drag-region": true }, iconButton("layout", "Customize Layout…", () => this.customizeLayout()), this.toggles.sidebar, this.toggles.panel, this.toggles.secondary),
      ),
    );

    this.activityTop = h("div", { class: "group" });
    this.activitybar = h("div", { class: "activitybar", dataset: { drop: "sidebar", part: "activityBar" }, oncontextmenu: (e: MouseEvent) => this.activityMenu(e) }, this.activityTop);

    const partName = { sidebar: "sideBar", secondary: "secondarySideBar", panel: "panel" } as const;
    const makePart = (loc: ViewLocation) => {
      const header = h("div", { class: "part-header", dataset: { part: `${partName[loc]}.header` } });
      const body = h("div", { class: "part-body" });
      const el = h("div", { class: `part ${loc}`, dataset: { drop: loc, part: partName[loc] } }, header, body);
      const sash = h("div", { class: `sash${loc === "panel" ? " horizontal" : ""}`, dataset: { part: "sash" } });
      this.installSash(sash, loc);
      return { el, header, body, sash };
    };
    this.parts = { sidebar: makePart("sidebar"), secondary: makePart("secondary"), panel: makePart("panel") };
    // Every part starts hidden (matching `shown`); the first render shows the ones that are open.
    for (const p of Object.values(this.parts)) {
      p.el.style.display = "none";
      p.sash.style.display = "none";
    }

    this.editorTabs = h("div", { class: "tabs-scroll" });
    this.editorTabsActions = h("div", { class: "tabs-actions", dataset: { part: "tab.actions" } });
    this.editorBody = h("div", { class: "editor-body" });
    this.editorBreadcrumbs = h("div", { class: "breadcrumbs", dataset: { part: "breadcrumbs" }, style: { display: "none" } });
    // Shown while a view is dragged: drop it on an edge of the editor to move it to that part.
    this.dropZones = h(
      "div",
      { class: "view-drop-zones" },
      h("div", { class: "zone left", dataset: { drop: "sidebar", zone: "1" } }, h("span", null, "Primary Side Bar")),
      h("div", { class: "zone bottom", dataset: { drop: "panel", zone: "1" } }, h("span", null, "Panel")),
      h("div", { class: "zone right", dataset: { drop: "secondary", zone: "1" } }, h("span", null, "Secondary Side Bar")),
    );
    // A pane beside the editor (a Markdown preview "to the side"), with its own header and a sash.
    this.editorSide = h("div", { class: "editor-side", dataset: { part: "editorSide" }, style: { display: "none" } });
    this.editorSideSash = h("div", { class: "sash editor-side-sash", style: { display: "none" } });
    const editorMain = h("div", { class: "editor-main" }, h("div", { class: "tabs", dataset: { part: "tabs" } }, this.editorTabs, this.editorTabsActions), this.editorBreadcrumbs, this.editorBody, this.dropZones);
    const editorGroup = h("div", { class: "editor-group", dataset: { part: "editor" } }, editorMain, this.editorSideSash, this.editorSide);
    this.editorGroup = editorGroup;
    // A view in place of the editor (a window layout's `center`, like the Agents window's chat).
    this.centerHost = h("div", { class: "center-view", dataset: { part: "centerView" }, style: { display: "none" } });
    // The main area is a grid, so the panel can sit under the editor only, or reach under the side
    // bars (panel alignment), and the side bars can swap sides.
    const center = h("div", { class: "center" }, editorGroup, this.centerHost);
    this.center = center;

    this.statusLeft = h("div", { class: "side" });
    this.statusRight = h("div", { class: "side" });
    const statusbar = h("div", { class: "statusbar", dataset: { part: "statusBar" } }, this.statusLeft, this.statusRight);
    this.statusbar = statusbar;
    // Manage (settings, profiles, themes…): always first on the left, before the branch.
    this.addStatus({ align: "left", priority: 10_000, icon: "settings-gear", tooltip: "Manage", run: (e) => this.manageMenu(e) });

    const main = h(
      "div",
      { class: "main" },
      this.activitybar,
      this.parts.sidebar.el,
      this.parts.sidebar.sash,
      center,
      this.parts.panel.sash,
      this.parts.panel.el,
      this.parts.secondary.sash,
      this.parts.secondary.el,
    );
    this.mainEl = main;
    this.root = h("div", { class: "workbench" }, titlebar, main, statusbar);
    mount.append(this.root);
    window.addEventListener("resize", () => this.applyLayout());
    // With no mods there are no views: hide the empty parts (and the activity bar) right away.
    this.renderChrome();
  }

  setTitle(text: string) {
    this.commandCenterLabel.textContent = text;
  }

  // ---------- views ----------

  registerView(desc: ViewDescriptor): Disposable {
    const moved = this.placement[desc.id];
    this.views.set(desc.id, { desc: moved ? { ...desc, ...moved } : { ...desc }, original: desc, rendered: false, badge: 0 });
    this.renderChrome();
    return toDisposable(() => {
      this.views.get(desc.id)?.host?.remove();
      this.views.delete(desc.id);
      this.renderChrome();
    });
  }

  provideView(id: string, provider: ViewProvider): Disposable {
    const entry = this.views.get(id);
    if (!entry) throw new Error(`no view ${id} is declared — add it to contributes.views`);
    entry.provider = provider;
    if (this.isVisible(id)) this.mountView(entry);
    this.renderChrome();
    return toDisposable(() => {
      if (entry.provider === provider) entry.provider = undefined;
    });
  }

  viewsAt(loc: ViewLocation): ViewDescriptor[] {
    return [...this.views.values()]
      .map((v) => v.desc)
      .filter((d) => d.location === loc && !this.hiddenViews.has(d.id) && d.id !== this.centerView)
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  }

  /** Every view declared, wherever it is (hidden ones included). */
  allViews(): ViewDescriptor[] {
    return [...this.views.values()].map((v) => v.desc);
  }

  /** Takes views off the window (and puts back the ones no longer listed). */
  setHiddenViews(ids: Iterable<string>) {
    const next = new Set(ids);
    if ([...next].sort().join("|") === [...this.hiddenViews].sort().join("|")) return;
    for (const id of next) if (!this.hiddenViews.has(id)) this.views.get(id)?.host && (this.views.get(id)!.host!.style.display = "none");
    this.hiddenViews = next;
    this.renderChrome();
    for (const loc of ["sidebar", "secondary", "panel"] as ViewLocation[]) {
      const id = this.activeAt(loc);
      if (id && this.state[loc].visible) void this.showView(id, false);
    }
  }

  /** Shows a view in place of the editor (null: the editor again). */
  async setCenterView(id: string | null) {
    if (id && !this.views.has(id)) id = null;
    const previous = this.centerView;
    if (previous === id) return;
    this.centerView = id;
    if (previous) {
      const entry = this.views.get(previous);
      if (entry?.host) {
        entry.host.remove();
        entry.provider?.onHide?.();
      }
    }
    this.editorGroup.style.display = id ? "none" : "";
    this.centerHost.style.display = id ? "" : "none";
    this.root.classList.toggle("has-center-view", !!id);
    this.renderChrome();
    if (id) await this.showView(id, false);
  }

  centerViewId() {
    return this.centerView;
  }

  hasView(id: string) {
    return this.views.has(id);
  }

  isVisible(id: string): boolean {
    const entry = this.views.get(id);
    if (!entry) return false;
    if (id === this.centerView) return true;
    if (this.hiddenViews.has(id)) return false;
    const part = this.state[entry.desc.location];
    return part.visible && this.activeAt(entry.desc.location) === id;
  }

  private activeAt(loc: ViewLocation): string | null {
    const list = this.viewsAt(loc);
    const wanted = this.state[loc].active;
    if (wanted && list.some((d) => d.id === wanted)) return wanted;
    return list[0]?.id ?? null;
  }

  async showView(id: string, focus = true) {
    const entry = this.views.get(id);
    if (!entry) return;
    if (id === this.centerView) {
      if (!entry.provider) await this.viewActivator(id);
      this.mountView(entry);
      entry.provider?.onShow?.();
      if (focus) (entry.host?.querySelector("input, textarea, [tabindex]") as HTMLElement | null)?.focus?.();
      return;
    }
    if (this.hiddenViews.has(id)) return;
    const loc = entry.desc.location;
    const previous = this.activeAt(loc);
    this.state[loc].active = id;
    this.state[loc].visible = true;
    if (previous && previous !== id) this.views.get(previous)?.provider?.onHide?.();
    this.renderChrome();
    if (!entry.provider) await this.viewActivator(id);
    this.mountView(entry);
    entry.provider?.onShow?.();
    if (focus) (entry.host?.querySelector("input, textarea, [tabindex]") as HTMLElement | null)?.focus?.();
    this.onDidChangeLayout.fire();
  }

  toggle(loc: ViewLocation) {
    const part = this.state[loc];
    if (!this.viewsAt(loc).length) return;
    part.visible = !part.visible;
    if (part.visible) {
      const id = this.activeAt(loc);
      if (id) this.showView(id, false);
    } else {
      const id = this.activeAt(loc);
      if (id) this.views.get(id)?.provider?.onHide?.();
    }
    this.renderChrome();
    this.onDidChangeLayout.fire();
  }

  setBadge(id: string, count: number) {
    const entry = this.views.get(id);
    if (entry) {
      entry.badge = count;
      this.renderChrome();
    }
  }

  /** Re-render the header of a view's part (its actions changed). */
  refreshActions() {
    this.renderChrome();
  }

  private mountView(entry: ViewEntry) {
    const body = entry.desc.id === this.centerView ? this.centerHost : this.parts[entry.desc.location].body;
    if (!entry.host) entry.host = h("div", { class: "view-host", dataset: { view: entry.desc.id } });
    // A view dragged to another part takes its content along (nothing re-renders).
    if (entry.host.parentElement !== body) body.append(entry.host);
    const wasHidden = entry.host.style.display === "none" || !entry.host.isConnected;
    for (const child of Array.from(body.children) as HTMLElement[]) child.style.display = child === entry.host ? "" : "none";
    if (wasHidden && this.motionReady) play(entry.host, "view-enter");
    if (!entry.rendered && entry.provider) {
      entry.rendered = true;
      Promise.resolve(entry.provider.render(entry.host)).then((d) => (entry.disposable = d)).catch((e) => {
        entry.host!.append(h("div", { class: "notice" }, `This view failed to load: ${e}`));
      });
    } else if (!entry.provider && !entry.host.childElementCount) {
      entry.host.append(h("div", { class: "notice" }, "Loading…"));
    } else if (entry.provider && entry.host.querySelector(":scope > .notice")) {
      entry.host.querySelector(":scope > .notice")?.remove();
    }
  }

  private renderChrome() {
    // Activity bar: one icon per primary side bar view.
    clear(this.activityTop);
    const sidebarViews = this.viewsAt("sidebar");
    const activeSidebar = this.activeAt("sidebar");
    const activeNow = this.state.sidebar.visible ? activeSidebar : null;
    const activityChanged = activeNow !== this.lastActiveActivity;
    this.lastActiveActivity = activeNow;
    const hidden = new Set(this.options.hiddenActivity ?? []);
    for (const d of sidebarViews) {
      if (hidden.has(d.id) && activeNow !== d.id) continue;
      const entry = this.views.get(d.id)!;
      const kb = commands.keybindingFor(`workbench.view.${d.id}`);
      this.activityTop.append(
        h(
          "div",
          {
            class: `activity-item${activeNow === d.id ? " active" : ""}${activeNow === d.id && activityChanged && this.motionReady ? " just-active" : ""}`,
            title: d.title + (kb ? ` (${commands.prettyKey(kb).join(" ")})` : ""),
            dataset: { drop: "sidebar", before: d.id },
            onclick: () => (this.state.sidebar.visible && activeSidebar === d.id ? this.toggle("sidebar") : this.showView(d.id)),
            onmousedown: (e: MouseEvent) => this.dragView(e, d.id),
            oncontextmenu: (e: MouseEvent) => this.activityMenu(e, d.id),
          },
          icon(d.icon),
          entry.badge ? h("span", { class: `badge${this.motionReady && (this.lastBadges.get(d.id) ?? 0) !== entry.badge ? " badge-new" : ""}`, dataset: { part: "activityBar.badge" } }, String(entry.badge)) : null,
        ),
      );
      this.lastBadges.set(d.id, entry.badge);
    }
    const activityShown = sidebarViews.length > 0 && this.options.activityBar;
    this.activitybar.style.display = activityShown ? "" : "none";
    this.root.classList.toggle("no-activitybar", !activityShown);

    for (const loc of ["sidebar", "secondary", "panel"] as ViewLocation[]) {
      const part = this.parts[loc];
      const list = this.viewsAt(loc);
      const shown = list.length > 0 && this.state[loc].visible;
      this.setShown(loc, shown);
      this.toggles[loc].style.display = list.length ? "" : "none";
      // As in VS Code: the icon itself shows the state — filled while the part is open, an
      // outline ("-off") while it is closed — with no highlight behind it.
      const side = loc === "panel" ? "layout-panel" : (loc === "sidebar") === (this.options.sidebarSide === "left") ? "layout-sidebar-left" : "layout-sidebar-right";
      this.toggles[loc].replaceChildren(icon(shown ? side : `${side}-off`));
      this.toggles[loc].setAttribute("aria-pressed", String(shown));
      clear(part.header);
      if (!list.length) continue;
      const activeId = this.activeAt(loc)!;
      const entry = this.views.get(activeId)!;
      const actions = h(
        "div",
        { class: "part-actions" },
        (entry.provider?.actions ?? []).map((a) =>
          a.dropdown
            ? h("span", { class: "split-action" }, iconButton(a.icon, a.title, (e) => a.run(e)), h("button", { class: "icon-button dropdown", title: a.dropdownTitle ?? "More…", onclick: (e: MouseEvent) => a.dropdown!(e) }, icon("chevron-down")))
            : iconButton(a.icon, a.title, (e) => a.run(e)),
        ),
      );
      if (loc === "sidebar") {
        part.header.append(h("div", { class: "part-title", title: "Drag to move this view", onmousedown: (e: MouseEvent) => this.dragView(e, activeId), oncontextmenu: (e: MouseEvent) => this.viewMenu(e, activeId) }, entry.desc.title), actions);
      } else {
        const tabs = h(
          "div",
          { class: "part-tabs" },
          list.map((d) =>
            h(
              "div",
              {
                class: `part-tab${d.id === activeId ? " active" : ""}`,
                dataset: { drop: loc, before: d.id },
                onclick: () => this.showView(d.id),
                onmousedown: (e: MouseEvent) => this.dragView(e, d.id),
                oncontextmenu: (e: MouseEvent) => this.viewMenu(e, d.id),
              },
              d.title,
              this.views.get(d.id)!.badge ? ` (${this.views.get(d.id)!.badge})` : "",
            ),
          ),
        );
        const max = this.maximized === loc;
        actions.append(
          h("span", { class: "action-divider" }),
          iconButton(max ? "screen-normal" : "screen-full", loc === "panel" ? (max ? "Restore Panel Size" : "Maximize Panel Size") : max ? "Restore Secondary Side Bar" : "Maximize Secondary Side Bar", () => this.toggleMaximized(loc as "panel" | "secondary")),
          iconButton("close", loc === "panel" ? "Hide Panel (⌘J)" : "Hide Secondary Side Bar (⌥⌘B)", () => {
            if (this.maximized === loc) this.maximized = null;
            this.toggle(loc);
          }),
        );
        part.header.append(tabs, actions);
      }
    }
    this.applyLayout();
  }

  // ---------- moving views (drag and drop, or the right-click menu) ----------

  /** Where views were moved to, as the profile saved it. Call before mods register views. */
  setPlacement(placement: Record<string, { location: ViewLocation; order: number }> | null | undefined) {
    this.placement = {};
    for (const [id, p] of Object.entries(placement ?? {})) {
      if (p && ["sidebar", "secondary", "panel"].includes(p.location) && typeof p.order === "number") this.placement[id] = { location: p.location, order: p.order };
    }
    for (const entry of this.views.values()) {
      const moved = this.placement[entry.desc.id];
      entry.desc = moved ? { ...entry.original, ...moved } : { ...entry.original };
    }
    this.renderChrome();
  }

  /** Moves a view to a part, before another view there (or last). */
  moveView(id: string, to: ViewLocation, beforeId?: string) {
    const entry = this.views.get(id);
    if (!entry || beforeId === id) return;
    const from = entry.desc.location;
    const wasActiveThere = this.activeAt(from) === id;
    const list = this.viewsAt(to).filter((d) => d.id !== id);
    const at = beforeId ? list.findIndex((d) => d.id === beforeId) : -1;
    list.splice(at < 0 ? list.length : at, 0, entry.desc);
    const previousAtTarget = this.isVisible(id) ? null : this.activeAt(to);
    list.forEach((d, i) => {
      const e = this.views.get(d.id)!;
      e.desc = { ...e.desc, location: to, order: (i + 1) * 10 };
      this.placement[d.id] = { location: to, order: (i + 1) * 10 };
    });
    if (from !== to && wasActiveThere) this.state[from].active = this.viewsAt(from)[0]?.id ?? null;
    if (previousAtTarget && previousAtTarget !== id) this.views.get(previousAtTarget)?.provider?.onHide?.();
    this.onDidChangePlacement.fire({ ...this.placement });
    this.showView(id, false);
  }

  /** Puts every view back where its mod put it. */
  resetPlacement() {
    this.placement = {};
    for (const entry of this.views.values()) entry.desc = { ...entry.original };
    for (const entry of this.views.values()) if (this.isVisible(entry.desc.id)) this.mountView(entry);
    this.onDidChangePlacement.fire({});
    this.renderChrome();
    this.onDidChangeLayout.fire();
  }

  private viewMenu(e: MouseEvent, id: string) {
    e.preventDefault();
    const entry = this.views.get(id);
    if (!entry) return;
    const names: Record<ViewLocation, string> = { sidebar: "Primary Side Bar", secondary: "Secondary Side Bar", panel: "Panel" };
    const moved = entry.desc.location !== entry.original.location;
    contextMenu(e.clientX, e.clientY, [
      ...(["sidebar", "secondary", "panel"] as ViewLocation[]).filter((l) => l !== entry.desc.location).map((l) => ({ label: `Move to ${names[l]}`, run: () => this.moveView(id, l) })),
      ...(this.detachView ? [{ label: "Move to New Window", run: () => this.detachView!(id) }] : []),
      ...(moved ? [{ separator: true, label: "" }, { label: "Reset Location", run: () => this.moveView(id, entry.original.location) }] : []),
      { separator: true, label: "" },
      { label: "Reset All View Locations", run: () => this.resetPlacement() },
    ]);
  }

  /** Right click on the activity bar, as in VS Code: which icons it shows, and where it goes. */
  private activityMenu(e: MouseEvent, id?: string) {
    e.preventDefault();
    e.stopPropagation();
    const o = this.options;
    const hidden = new Set(o.hiddenActivity ?? []);
    const setHidden = (vid: string, hide: boolean) => {
      const next = new Set(hidden);
      if (hide) next.add(vid);
      else next.delete(vid);
      this.setOptions({ hiddenActivity: [...next] });
    };
    const views = this.viewsAt("sidebar");
    const shownCount = views.filter((d) => !hidden.has(d.id)).length;
    const entry = id ? this.views.get(id) : undefined;
    const names: Record<ViewLocation, string> = { sidebar: "Primary Side Bar", secondary: "Secondary Side Bar", panel: "Panel" };
    const items: MenuItem[] = [];
    if (entry) {
      items.push({ label: `Hide '${entry.desc.title}'`, disabled: shownCount <= 1, run: () => setHidden(entry.desc.id, true) });
      for (const l of ["secondary", "panel"] as ViewLocation[]) items.push({ label: `Move to ${names[l]}`, run: () => this.moveView(entry.desc.id, l) });
      if (this.detachView) items.push({ label: "Move to New Window", run: () => this.detachView!(entry.desc.id) });
      items.push({ separator: true, label: "" });
    }
    for (const d of views) {
      const on = !hidden.has(d.id);
      items.push({
        label: d.title,
        checked: on,
        keybinding: commands.keybindingFor(`workbench.view.${d.id}`),
        // The last icon stays: an empty activity bar has nothing left to right click.
        disabled: on && shownCount <= 1,
        run: () => setHidden(d.id, on),
      });
    }
    items.push(
      { separator: true, label: "" },
      { label: "Hide Activity Bar", run: () => this.setOptions({ activityBar: false }) },
      { label: `Move Primary Side Bar ${o.sidebarSide === "left" ? "Right" : "Left"}`, run: () => this.setOptions({ sidebarSide: o.sidebarSide === "left" ? "right" : "left" }) },
      { separator: true, label: "" },
      { label: "Reset All View Locations", run: () => { this.resetPlacement(); this.setOptions({ hiddenActivity: [] }); } },
    );
    contextMenu(e.clientX, e.clientY, items);
  }

  /** Press on a view's icon, tab or title and drag it to the activity bar, a part, or an edge. */
  private dragView(down: MouseEvent, id: string) {
    if (down.button !== 0) return;
    const entry = this.views.get(id);
    if (!entry) return;
    const startX = down.clientX;
    const startY = down.clientY;
    let ghost: HTMLElement | null = null;
    let target: { el: HTMLElement; loc: ViewLocation; before?: string } | null = null;
    const mark = (t: typeof target, after = false) => {
      document.querySelectorAll(".drop-target, .drop-before, .drop-after").forEach((el) => el.classList.remove("drop-target", "drop-before", "drop-after"));
      if (!t) return;
      if (t.before) t.el.classList.add(after ? "drop-after" : "drop-before");
      else t.el.classList.add("drop-target");
    };
    const move = (e: MouseEvent) => {
      if (!ghost) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
        ghost = h("div", { class: "view-drag-ghost" }, icon(entry.desc.icon), h("span", null, entry.desc.title));
        document.body.append(ghost);
        document.body.classList.add("view-dragging");
      }
      ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 10}px)`;
      const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const el = under?.closest("[data-drop]") as HTMLElement | null;
      if (!el) {
        target = null;
        return mark(null);
      }
      const loc = el.dataset.drop as ViewLocation;
      let before = el.dataset.before;
      let after = false;
      if (before) {
        // The second half of an icon or tab: drop after it.
        const r = el.getBoundingClientRect();
        after = loc === "sidebar" && el.classList.contains("activity-item") ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
        if (after) {
          const list = this.viewsAt(loc).filter((d) => d.id !== id);
          const i = list.findIndex((d) => d.id === before);
          before = list[i + 1]?.id;
          if (!before) {
            target = { el, loc };
            mark({ el, loc, before: "x" }, true);
            return;
          }
        }
      }
      target = { el, loc, before };
      mark(target, after);
    };
    const end = (commit: boolean) => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      window.removeEventListener("keydown", key, true);
      mark(null);
      if (!ghost) return;
      ghost.remove();
      document.body.classList.remove("view-dragging");
      // The click that ends a drag (if any) is not a click on the icon.
      const swallow = (e: MouseEvent) => e.stopPropagation();
      window.addEventListener("click", swallow, true);
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      if (commit && target) this.moveView(id, target.loc, target.before);
    };
    const up = () => end(true);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        end(false);
      }
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
    window.addEventListener("keydown", key, true);
  }

  /** Puts every part in its grid cell for the current options (sides, panel alignment, maximized). */
  private placeGrid() {
    if (!this.mainEl) return;
    const o = this.options;
    const left = o.sidebarSide === "left";
    const sb = this.parts.sidebar, sec = this.parts.secondary, pn = this.parts.panel;
    const cols = left ? { act: 1, sb: 2, sbSash: 3, center: 4, secSash: 5, sec: 6 } : { sec: 1, secSash: 2, center: 3, sbSash: 4, sb: 5, act: 6 };
    this.mainEl.style.gridTemplateColumns = left ? "auto auto auto minmax(0, 1fr) auto auto" : "auto auto minmax(0, 1fr) auto auto auto";
    const panelOpen = this.shown.panel;
    const leftPart: ViewLocation = left ? "sidebar" : "secondary";
    const leftStart = left ? 2 : 1;
    const rightEnd = left ? 7 : 6;
    const span = { center: [cols.center, cols.center + 1], left: [leftStart, cols.center + 1], right: [cols.center, rightEnd], justify: [leftStart, rightEnd] }[o.panelAlign];
    // Whether the panel reaches under this side bar (then the side bar stops above it).
    const under = (loc: ViewLocation) =>
      panelOpen && (o.panelAlign === "justify" || (o.panelAlign === "left" && loc === leftPart) || (o.panelAlign === "right" && loc !== leftPart));
    const put = (el: HTMLElement, col: number, rows: string) => {
      el.style.gridColumn = String(col);
      el.style.gridRow = rows;
    };
    put(this.activitybar, cols.act, "1 / 4");
    put(sb.el, cols.sb, under("sidebar") ? "1 / 2" : "1 / 4");
    put(sb.sash, cols.sbSash, under("sidebar") ? "1 / 2" : "1 / 4");
    put(sec.el, cols.sec, under("secondary") ? "1 / 2" : "1 / 4");
    put(sec.sash, cols.secSash, under("secondary") ? "1 / 2" : "1 / 4");
    put(this.center, cols.center, "1 / 2");
    pn.sash.style.gridColumn = `${span[0]} / ${span[1]}`;
    pn.sash.style.gridRow = "2";
    pn.el.style.gridColumn = `${span[0]} / ${span[1]}`;
    pn.el.style.gridRow = "3";
    if (this.maximized === "panel") {
      pn.el.style.gridRow = "1 / 4";
    } else if (this.maximized === "secondary") {
      sec.el.style.gridColumn = `${leftStart} / ${rightEnd}`;
      sec.el.style.gridRow = "1 / 4";
    }
    this.root.classList.toggle("sb-right", !left);
    this.root.classList.toggle("max-panel", this.maximized === "panel");
    this.root.classList.toggle("max-secondary", this.maximized === "secondary");
    this.root.classList.toggle("panel-wide", panelOpen && o.panelAlign !== "center");
  }

  /** Changes layout options (from Customize Layout, the profile, or a command). */
  setOptions(next: Partial<LayoutOptions>, persist = true) {
    this.options = { ...this.options, ...next };
    const o = this.options;
    this.statusbar.style.display = o.statusBar ? "" : "none";
    document.documentElement.dataset.density = o.density;
    this.root.classList.toggle("quick-input-center", o.quickInput === "center");
    this.renderChrome();
    if (persist) this.onDidChangeOptions.fire(this.options);
  }

  /** Maximize (or restore) the panel or the secondary side bar. */
  toggleMaximized(loc: "panel" | "secondary") {
    this.maximized = this.maximized === loc ? null : loc;
    if (this.maximized && !this.state[loc].visible) this.toggle(loc);
    this.renderChrome();
    this.onDidChangeLayout.fire();
  }

  isMaximized(loc: ViewLocation) {
    return this.maximized === loc;
  }

  applyLayout() {
    this.placeGrid();
    const total = window.innerWidth - (this.activitybar.style.display === "none" ? 0 : this.activitybar.offsetWidth || 48);
    const s = this.state;
    s.sidebar.size = Math.max(MIN.sidebar, Math.min(s.sidebar.size, total * 0.6));
    s.secondary.size = Math.max(MIN.secondary, Math.min(s.secondary.size, total * 0.6));
    s.panel.size = Math.max(MIN.panel, Math.min(s.panel.size, window.innerHeight - 200));
    for (const loc of ["sidebar", "secondary", "panel"] as ViewLocation[]) {
      const el = this.parts[loc].el;
      el.style.setProperty("--part-size", `${s[loc].size}px`);
      if (!this.animating[loc] && this.shown[loc]) el.style[loc === "panel" ? "height" : "width"] = `${s[loc].size}px`;
    }
  }

  /** After the first layout: from now on parts animate open and closed. */
  enableMotion() {
    this.motionReady = true;
    for (const loc of ["sidebar", "secondary", "panel"] as ViewLocation[]) this.parts[loc].el.classList.add("sized");
  }

  /** Shows or hides a part, by growing or shrinking it when motion is on. */
  private setShown(loc: ViewLocation, shown: boolean) {
    if (this.shown[loc] === shown) return;
    this.shown[loc] = shown;
    const { el, sash } = this.parts[loc];
    const prop = loc === "panel" ? "height" : "width";
    const size = `${this.state[loc].size}px`;
    sash.style.display = shown ? "" : "none";
    // The activity bar and the side bar form one card while the side bar is open.
    const mark = () => this.root?.classList.toggle(`${loc}-open`, this.shown[loc]);
    if (shown) mark();
    if (!this.motionReady || !motionEnabled()) {
      mark();
      el.style.display = shown ? "" : "none";
      el.style[prop] = size;
      return;
    }
    this.animating[loc] = true;
    el.classList.add("animating");
    el.style.setProperty("--part-size", size);
    if (shown) {
      el.style.display = "";
      el.style[prop] = "0px";
      void el.offsetWidth;
      el.style[prop] = size;
    } else {
      el.style[prop] = `${loc === "panel" ? el.offsetHeight : el.offsetWidth}px`;
      void el.offsetWidth;
      el.style[prop] = "0px";
    }
    const done = () => {
      if (this.shown[loc] !== shown) return; // toggled again mid-way: the newer call finishes
      this.animating[loc] = false;
      el.classList.remove("animating");
      if (!shown) el.style.display = "none";
      mark();
      el.style[prop] = size;
      this.onDidChangeLayout.fire();
    };
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        done();
      }
    };
    el.addEventListener("transitionend", (e) => e.target === el && finish(), { once: true });
    setTimeout(finish, 320);
  }

  private installSash(sash: HTMLElement, loc: ViewLocation) {
    sash.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const start = loc === "panel" ? e.clientY : e.clientX;
      const startSize = this.state[loc].size;
      sash.classList.add("dragging");
      document.body.classList.add("resizing");
      document.body.style.cursor = loc === "panel" ? "ns-resize" : "ew-resize";
      const move = (ev: MouseEvent) => {
        const delta = (loc === "panel" ? ev.clientY : ev.clientX) - start;
        // The part on the left grows to the right; the one on the right (and the panel) the other way.
        const onLeft = loc !== "panel" && (loc === "sidebar") === (this.options.sidebarSide === "left");
        const size = onLeft ? startSize + delta : startSize - delta;
        if (size < MIN[loc] - 60) {
          if (this.state[loc].visible) this.toggle(loc);
          return;
        }
        if (!this.state[loc].visible) this.toggle(loc);
        this.state[loc].size = Math.max(MIN[loc], size);
        this.applyLayout();
      };
      const up = () => {
        sash.classList.remove("dragging");
        document.body.classList.remove("resizing");
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        this.onDidChangeLayout.fire();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
    sash.addEventListener("dblclick", () => {
      this.state[loc].size = loc === "panel" ? 260 : loc === "sidebar" ? 300 : 340;
      this.applyLayout();
    });
  }

  private manageMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Opens upward from the status bar, its bottom just above the button.
    contextMenu(r.left, r.top - 4, [
      { label: "Command Palette…", keybinding: "mod+shift+p", run: () => commands.execute("workbench.commandPalette") },
      { label: "Mods", keybinding: "mod+shift+x", run: () => commands.execute("mods.manage") },
      { separator: true, label: "" },
      { label: "Profiles", run: () => commands.execute("profiles.manage") },
      { label: "Settings", keybinding: "mod+,", run: () => commands.execute("preferences.settings") },
      { label: "Keyboard Shortcuts", run: () => commands.execute("workbench.keybindings") },
      { label: "Color Theme…", run: () => commands.execute("preferences.theme") },
      { separator: true, label: "" },
      { label: "Check for Updates…", run: () => commands.execute("update.check") },
    ], { above: true });
  }

  // ---------- status bar ----------

  addStatus(item: StatusItem): StatusHandle {
    const record = { item: { align: "left", priority: 0, ...item } as StatusItem, el: h("div", { class: "status-item" }) };
    let lastText: string | undefined;
    const paint = () => {
      const it = record.item;
      const changed = this.motionReady && lastText !== undefined && it.text !== lastText && it.animate;
      lastText = it.text;
      clear(record.el);
      if (it.icon) record.el.append(icon(it.icon));
      if (it.text) record.el.append(h("span", null, it.text));
      record.el.title = it.tooltip ?? "";
      record.el.className = `status-item${it.command || it.run ? " clickable" : ""}${it.accent ? " accent" : ""}`;
      record.el.dataset.part = "statusBar.item";
      if (it.id) record.el.dataset.id = it.id;
      record.el.onclick = it.run ? (e) => it.run!(e) : it.command ? () => commands.execute(it.command!, ...(it.args ?? [])) : null;
      record.el.style.display = it.text || it.icon ? "" : "none";
      if (changed) play(record.el, "status-changed");
    };
    paint();
    this.statusItems.add(record);
    this.placeStatus();
    return {
      update: (patch) => {
        Object.assign(record.item, patch);
        paint();
        if (patch.priority !== undefined || patch.align !== undefined) this.placeStatus();
      },
      dispose: () => {
        record.el.remove();
        this.statusItems.delete(record);
      },
    };
  }

  private placeStatus() {
    const sorted = [...this.statusItems].sort((a, b) => (b.item.priority ?? 0) - (a.item.priority ?? 0));
    for (const r of sorted) (r.item.align === "right" ? this.statusRight : this.statusLeft).append(r.el);
  }

  // ---------- title bar ----------

  addTitleItem(item: TitleItem): TitleHandle {
    const record = { item: { align: "right", order: 0, ...item } as TitleItem, el: h("button", { class: "title-item" }) as HTMLElement };
    const paint = () => {
      const it = record.item;
      clear(record.el);
      if (it.icon) record.el.append(icon(it.icon));
      if (it.text) record.el.append(h("span", null, it.text));
      record.el.title = it.title ?? it.text ?? "";
      record.el.setAttribute("aria-label", it.title ?? it.text ?? it.icon ?? "");
      record.el.className = `title-item${it.text ? " with-text" : " icon-button"}${it.checked ? " active" : ""}`;
      record.el.dataset.part = "titleBar.item";
      if (it.id) record.el.dataset.id = it.id;
      record.el.onclick = it.run ? (e) => it.run!(e) : it.command ? () => commands.execute(it.command!, ...(it.args ?? [])).catch((err) => console.error(err)) : null;
      record.el.style.display = it.text || it.icon ? "" : "none";
    };
    paint();
    this.titleItems.add(record);
    this.placeTitleItems();
    return {
      update: (patch) => {
        Object.assign(record.item, patch);
        paint();
        if (patch.order !== undefined || patch.align !== undefined) this.placeTitleItems();
      },
      dispose: () => {
        record.el.remove();
        this.titleItems.delete(record);
      },
    };
  }

  private placeTitleItems() {
    const sorted = [...this.titleItems].sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0));
    for (const r of sorted) this.titleHosts[r.item.align ?? "right"].append(r.el);
  }

  // ---------- persistence ----------

  /** VS Code's "Customize Layout": visibility, positions, alignment, density and modes, applied live. */
  customizeLayout() {
    document.querySelector(".layout-picker")?.remove();
    const o = () => this.options;
    type Row = { icon: string; label: string; checked?: boolean; keys?: string; section?: string; run: () => void };
    const vis = (loc: ViewLocation) => this.viewsAt(loc).length > 0 && this.state[loc].visible;
    const rows = (): Row[] => [
      { section: "Visibility", icon: "layout-activitybar-left", label: "Activity Bar", checked: o().activityBar, run: () => this.setOptions({ activityBar: !o().activityBar }) },
      { icon: o().sidebarSide === "left" ? "layout-sidebar-left" : "layout-sidebar-right", label: "Primary Side Bar", checked: vis("sidebar"), keys: "mod+b", run: () => this.toggle("sidebar") },
      { icon: o().sidebarSide === "left" ? "layout-sidebar-right" : "layout-sidebar-left", label: "Secondary Side Bar", checked: vis("secondary"), keys: "mod+alt+b", run: () => this.toggle("secondary") },
      { icon: "layout-panel", label: "Panel", checked: vis("panel"), keys: "mod+j", run: () => this.toggle("panel") },
      { icon: "layout-statusbar", label: "Status Bar", checked: o().statusBar, run: () => this.setOptions({ statusBar: !o().statusBar }) },
      { section: "Primary Side Bar Position", icon: "layout-sidebar-left", label: "Left", checked: o().sidebarSide === "left", run: () => this.setOptions({ sidebarSide: "left" }) },
      { icon: "layout-sidebar-right", label: "Right", checked: o().sidebarSide === "right", run: () => this.setOptions({ sidebarSide: "right" }) },
      { section: "Panel Alignment", icon: "layout-panel-left", label: "Left", checked: o().panelAlign === "left", run: () => this.setOptions({ panelAlign: "left" }) },
      { icon: "layout-panel-right", label: "Right", checked: o().panelAlign === "right", run: () => this.setOptions({ panelAlign: "right" }) },
      { icon: "layout-panel-center", label: "Center", checked: o().panelAlign === "center", run: () => this.setOptions({ panelAlign: "center" }) },
      { icon: "layout-panel-justify", label: "Justify", checked: o().panelAlign === "justify", run: () => this.setOptions({ panelAlign: "justify" }) },
      { section: "Quick Input Position", icon: "arrow-up", label: "Top", checked: o().quickInput === "top", run: () => this.setOptions({ quickInput: "top" }) },
      { icon: "circle-small", label: "Center", checked: o().quickInput === "center", run: () => this.setOptions({ quickInput: "center" }) },
      { section: "Layout Density", icon: "layout", label: "Default", checked: o().density === "default", run: () => this.setOptions({ density: "default" }) },
      { icon: "layout-centered", label: "Compact", checked: o().density === "compact", run: () => this.setOptions({ density: "compact" }) },
      { section: "Modes", icon: "screen-full", label: "Full Screen", keys: "ctrl+mod+f", run: () => commands.execute("workbench.toggleFullScreen") },
      { icon: "target", label: "Zen Mode", keys: "mod+k z", run: () => { close(); commands.execute("workbench.toggleZenMode"); } },
    ];
    let index = 0;
    const list = h("div", { class: "layout-list", role: "listbox" });
    const paint = () => {
      clear(list);
      rows().forEach((r, i) => {
        list.append(
          h(
            "div",
            {
              class: `layout-row${i === index ? " active" : ""}${r.section && i > 0 ? " first" : ""}`,
              role: "option",
              onmousemove: () => { if (index !== i) { index = i; paint(); } },
              onclick: () => { r.run(); paint(); },
            },
            icon(r.icon),
            h("span", { class: "label" }, r.label),
            r.checked ? icon("check", "check") : null,
            h("span", { class: "grow" }),
            r.keys ? h("span", { class: "keys" }, keyCaps(r.keys).map((k) => h("kbd", null, k))) : null,
            r.section ? h("span", { class: "section" }, r.section) : null,
          ),
        );
      });
    };
    const close = () => {
      picker.remove();
      window.removeEventListener("mousedown", outside, true);
      window.removeEventListener("keydown", onKey, true);
    };
    const outside = (e: MouseEvent) => !picker.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => {
      const n = rows().length;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowDown") index = (index + 1) % n;
      else if (e.key === "ArrowUp") index = (index - 1 + n) % n;
      else if (e.key === "Enter" || e.key === " ") rows()[index].run();
      else return;
      e.preventDefault();
      e.stopPropagation();
      if (picker.isConnected) paint();
    };
    const picker = h(
      "div",
      { class: "quick-input layout-picker", role: "dialog", "aria-label": "Customize Layout" },
      h(
        "div",
        { class: "layout-head" },
        h("span", { class: "title" }, "Customize Layout"),
        iconButton("discard", "Reset to Defaults", () => {
          this.setOptions({ ...DEFAULT_LAYOUT });
          if (this.maximized) this.maximized = null;
          for (const loc of ["sidebar", "secondary"] as ViewLocation[]) if (!this.state[loc].visible && this.viewsAt(loc).length) this.toggle(loc);
          if (this.state.panel.visible) this.toggle("panel");
          paint();
        }),
        iconButton("close", "Close", () => close()),
      ),
      list,
    );
    paint();
    document.body.append(picker);
    setTimeout(() => {
      window.addEventListener("mousedown", outside, true);
      window.addEventListener("keydown", onKey, true);
    });
  }

  snapshot(): LayoutState {
    return JSON.parse(JSON.stringify(this.state));
  }

  restore(state: Partial<LayoutState> | undefined) {
    if (!state) return;
    for (const loc of ["sidebar", "secondary", "panel"] as ViewLocation[]) {
      if (state[loc]) this.state[loc] = { ...this.state[loc], ...state[loc] };
    }
    this.renderChrome();
  }

  /** Shows what should be visible after restore (activating the owners of visible views). */
  async revealVisible() {
    for (const loc of ["sidebar", "secondary", "panel"] as ViewLocation[]) {
      if (!this.state[loc].visible) continue;
      const id = this.activeAt(loc);
      if (id) await this.showView(id, false);
    }
  }
}
