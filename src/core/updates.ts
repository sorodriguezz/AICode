// Updates, like VS Code's "Check for Updates…". The check and the install run in the core
// (src-tauri/src/updater.rs) against the GitHub release feed; this is what the user sees: the
// "Install and Restart / Later" dialog, progress in the status bar, and the state the Updates
// section of Settings shows.

import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "./ipc";
import { dialog, notify } from "./widgets";
import { Emitter } from "./events";
import type { StatusHandle, StatusItem } from "./workbench";

export interface UpdateInfo {
  version: string;
  current: string;
  notes?: string | null;
  date?: string | null;
}

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "downloading"; info: UpdateInfo; downloaded: number; total?: number | null }
  | { kind: "installing"; info: UpdateInfo }
  | { kind: "restarting"; info: UpdateInfo }
  | { kind: "error"; message: string };

interface Progress {
  downloaded: number;
  total?: number | null;
  phase: "downloading" | "installing" | "restarting";
}

let status: UpdateStatus = { kind: "idle" };
let lastInfo: UpdateInfo | null = null;
let statusItem: StatusHandle | null = null;
const changed = new Emitter<UpdateStatus>();

export const onDidChangeUpdateStatus = changed.event;
export const updateStatus = () => status;
export const appVersion = () => getVersion();

function set(next: UpdateStatus) {
  status = next;
  paintStatusBar();
  changed.fire(next);
}

const percent = (s: { downloaded: number; total?: number | null }) => (s.total ? Math.min(100, Math.round((s.downloaded / s.total) * 100)) : null);

/** The status bar shows an update once there is one, and the download while it runs. */
function paintStatusBar() {
  if (!statusItem) return;
  const s = status;
  const item: Partial<StatusItem> =
    s.kind === "available"
      ? { icon: "cloud-download", text: `Update ${s.info.version}`, tooltip: `AICode ${s.info.version} is available — click to install`, accent: true }
      : s.kind === "downloading"
        ? { icon: "sync codicon-modifier-spin", text: `Downloading update${percent(s) !== null ? ` ${percent(s)}%` : "…"}`, tooltip: `Downloading AICode ${s.info.version}`, accent: false }
        : s.kind === "installing" || s.kind === "restarting"
          ? { icon: "sync codicon-modifier-spin", text: s.kind === "installing" ? "Installing update…" : "Restarting…", tooltip: `Installing AICode ${s.info.version}`, accent: false }
          : { icon: undefined, text: undefined };
  statusItem.update(item);
}

/** Wires progress events and the status bar item. Called once per window. */
export async function initUpdates(addStatus: (item: StatusItem) => StatusHandle) {
  statusItem = addStatus({ id: "update", align: "left", priority: 9_000, run: () => (lastInfo ? promptUpdate(lastInfo) : checkForUpdates()) });
  paintStatusBar();
  // Any window can start the install; every window shows how it goes.
  await listen<Progress>("update-progress", (e) => {
    const info = lastInfo ?? { version: "", current: "" };
    const p = e.payload;
    if (p.phase === "downloading") set({ kind: "downloading", info, downloaded: p.downloaded, total: p.total });
    else set({ kind: p.phase, info });
  });
}

/**
 * Asks the release feed for a newer AICode. `silent` (the check at startup) says nothing unless
 * there is an update; otherwise "up to date" and errors are shown too.
 */
export async function checkForUpdates(opts: { silent?: boolean } = {}): Promise<UpdateInfo | null> {
  if (status.kind === "checking" || status.kind === "downloading" || status.kind === "installing" || status.kind === "restarting") {
    if (!opts.silent && status.kind !== "checking") notify("info", "The update is already being installed.");
    return lastInfo;
  }
  set({ kind: "checking" });
  try {
    const info = await invoke<UpdateInfo | null>("update_check");
    lastInfo = info;
    if (!info) {
      set({ kind: "latest" });
      if (!opts.silent) notify("info", `AICode is up to date (version ${await getVersion()}).`);
      return null;
    }
    set({ kind: "available", info });
    await promptUpdate(info);
    return info;
  } catch (e) {
    const message = String(e);
    set({ kind: "error", message });
    if (opts.silent) console.warn(`update check: ${message}`);
    else notify("error", `Could not check for updates. ${message}`);
    return null;
  }
}

/** "AICode x.y.z is available": Install and Restart, or Later (the status bar keeps offering it). */
export async function promptUpdate(info: UpdateInfo) {
  if (status.kind === "downloading" || status.kind === "installing" || status.kind === "restarting") return;
  const notes = info.notes?.trim();
  const short = notes && notes.length > 700 ? `${notes.slice(0, 700).trimEnd()}…` : notes;
  const answer = await dialog<"install" | "later">({
    title: `AICode ${info.version} is available`,
    message: `You have version ${info.current}.${info.date ? ` Released ${info.date}.` : ""}\n\nAICode restarts to finish; your windows, tabs and unsaved text come back as they were.${short ? `\n\nWhat's new:\n${short}` : ""}`,
    buttons: [
      { label: "Later", value: "later" },
      { label: "Install and Restart", value: "install", primary: true },
    ],
    cancelValue: "later",
  });
  if (answer === "install") await installUpdate();
}

/** Downloads, installs and restarts. On failure the update stays offered. */
export async function installUpdate() {
  if (!lastInfo) return checkForUpdates();
  const info = lastInfo;
  set({ kind: "downloading", info, downloaded: 0, total: null });
  try {
    await invoke("update_install");
  } catch (e) {
    set({ kind: "available", info });
    notify("error", `The update was not installed. ${e}`, [{ label: "Try Again", run: () => installUpdate() }]);
  }
}

/** The check at startup, when Settings → Updates → Check on Startup is on: once per launch. */
export async function checkOnStartup(enabled: boolean) {
  if (!enabled) return;
  if (!(await invoke<boolean>("update_claim_startup_check").catch(() => false))) return;
  // After the window has settled, so it never slows the start.
  setTimeout(() => checkForUpdates({ silent: true }), 5000);
}
