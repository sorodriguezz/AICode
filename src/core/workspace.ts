// The open folder, if any. The core only remembers it; the explorer, search, terminals and agents
// are the mods that use it.

import { Emitter } from "./events";
import { basename } from "./ui";

export class Workspace {
  folder: string | null = null;
  readonly onDidChange = new Emitter<string | null>();

  /** Asked before the user replaces or closes the open folder; false keeps it (a save prompt was cancelled). */
  beforeReplace: ((next: string | null) => Promise<boolean>) | null = null;

  /** Sets the folder as it is (a restored session): nothing open is touched. */
  set(path: string | null) {
    if (path === this.folder) return;
    this.folder = path;
    this.onDidChange.fire(path);
  }

  /** Opens or closes a folder as the user asked: what was open for the previous folder is closed
   *  first, as VS Code starts afresh. A window without a folder keeps what it has open. */
  async change(path: string | null): Promise<boolean> {
    if (path === this.folder) return true;
    if (this.folder !== null && this.beforeReplace && !(await this.beforeReplace(path))) return false;
    this.set(path);
    return true;
  }

  get name(): string | null {
    return this.folder ? basename(this.folder) : null;
  }
}
