import type { Disposable } from "./ui";

export interface FileDropSpec {
  /** Hint shown over this target while files from the OS are dragged over it. */
  label?: string;
  drop(paths: string[]): void | Promise<void>;
  hoverClass?: string;
}

/** Native file drops are separate from the workbench's view/tab drags. */
export class FileDropTargets {
  private targets = new Map<HTMLElement, FileDropSpec>();
  private hovered: { el: HTMLElement; spec: FileDropSpec } | null = null;

  add(el: HTMLElement, spec: FileDropSpec): Disposable {
    this.targets.set(el, spec);
    return { dispose: () => {
      if (this.targets.get(el) !== spec) return;
      if (this.hovered?.el === el) this.clear();
      this.targets.delete(el);
    } };
  }

  /** Tauri gives physical pixels; DOM hit testing uses CSS pixels (including on Retina). */
  at(position: { x: number; y: number }, scale = window.devicePixelRatio) {
    let el = document.elementFromPoint(position.x / scale, position.y / scale) as HTMLElement | null;
    while (el) {
      const spec = this.targets.get(el);
      if (spec) return { el, spec };
      el = el.parentElement;
    }
    return null;
  }

  hover(position: { x: number; y: number }) {
    const target = this.at(position);
    this.clear();
    this.hovered = target;
    target?.el.classList.add(target.spec.hoverClass ?? "file-drop-target");
    return target;
  }

  clear() {
    if (this.hovered) this.hovered.el.classList.remove(this.hovered.spec.hoverClass ?? "file-drop-target");
    this.hovered = null;
  }
}

export const fileDrops = new FileDropTargets();
