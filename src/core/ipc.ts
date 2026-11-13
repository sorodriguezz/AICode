// The core's calls into Rust. A mod never imports this: it gets the same calls through its `ctx`,
// with its own id attached, so the Rust side can check what the mod declared.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export { invoke, listen };

export interface ModManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  main?: string | null;
  api: number;
  activation: string[];
  permissions: string[];
  dependencies: string[];
  optionalDependencies: string[];
  contributes: any;
  icon?: string | null;
}

export interface ModInfo extends ModManifest {
  source: "bundled" | "shared" | "profile";
  dir: string;
  enabled: boolean;
  problems: string[];
}

export interface TextFile {
  text: string;
  bom: boolean;
  lossy: boolean;
  binary: boolean;
  size: number;
  eol: "\n" | "\r\n";
}

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
}

/**
 * Everything streamed from Rust (program output, terminal output, exits) arrives on one listener
 * per event name and is dispatched by id. Rust can emit before the window has heard the id it
 * returned, so payloads for an id nobody listens to yet wait in a buffer until someone does.
 */
const handlers = new Map<string, Map<number, (payload: any) => void>>();
const early = new Map<string, Map<number, any[]>>();
/** How many payloads each stream delivered (shown by the diagnostics report). */
export const streamCounts: Record<string, number> = {};

export async function prepareStreams() {
  for (const name of ["proc://data", "proc://exit", "pty://data", "pty://exit", "http://head", "http://data", "http://end"]) {
    handlers.set(name, new Map());
    early.set(name, new Map());
    await listen<any>(name, (e) => {
      streamCounts[name] = (streamCounts[name] ?? 0) + 1;
      const id = e.payload.id as number;
      const handler = handlers.get(name)!.get(id);
      if (handler) return handler(e.payload);
      const buf = early.get(name)!;
      if (!buf.has(id)) buf.set(id, []);
      buf.get(id)!.push(e.payload);
      if (buf.size > 200) buf.delete(buf.keys().next().value!);
    });
  }
}

export function onStream(event: string, id: number, handler: (payload: any) => void): () => void {
  const map = handlers.get(event);
  if (!map) throw new Error(`unknown stream ${event}`);
  map.set(id, handler);
  const waiting = early.get(event)!.get(id);
  if (waiting) {
    early.get(event)!.delete(id);
    for (const p of waiting) handler(p);
  }
  return () => map.delete(id);
}
