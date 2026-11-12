import { Disposable, toDisposable } from "./ui";

export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();

  event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
  };

  fire(value: T) {
    for (const l of [...this.listeners]) {
      try {
        l(value);
      } catch (e) {
        console.error(e);
      }
    }
  }
}
