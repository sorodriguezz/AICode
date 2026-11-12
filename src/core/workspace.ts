// The open folder, if any. The core only remembers it; the explorer, search, terminals and agents
// are the mods that use it.

import { Emitter } from "./events";
import { basename } from "./ui";

export class Workspace {
  folder: string | null = null;
  readonly onDidChange = new Emitter<string | null>();

  set(path: string | null) {
    if (path === this.folder) return;
    this.folder = path;
    this.onDidChange.fire(path);
  }

  get name(): string | null {
    return this.folder ? basename(this.folder) : null;
  }
}
