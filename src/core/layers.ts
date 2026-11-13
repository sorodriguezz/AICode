// Who wins when two things set the same thing (a setting, a CSS rule, an icon, a keyboard
// shortcut). Always the same order, left to right, the right one winning:
//
//   app base  →  bundled mods  →  the user's mods  →  the user's configuration
//
// Within the user's mods, a profile's own mods come after the ones shared by every profile. Within
// one rank, mods go by id, so the result never depends on which mod happened to load first.

export const RANK = {
  /** AICode itself (styles.css, the core's settings, its own shortcuts). */
  core: 0,
  /** Mods shipped inside the app. */
  bundled: 1,
  /** The user's mods, shared by every profile (AICode/mods). */
  shared: 2,
  /** The user's mods of this profile (profiles/<name>/mods). */
  profile: 3,
  /** The user's configuration: profile.json settings, keybindings, custom CSS. */
  user: 4,
} as const;

const sources = new Map<string, number>();

/** What main.ts learns from Rust: where each mod comes from. */
export function setModSources(list: { id: string; source: string }[]) {
  sources.clear();
  for (const m of list) sources.set(m.id, (RANK as Record<string, number>)[m.source] ?? RANK.shared);
}

/** The rank of an owner: "core", "user", or a mod's id. */
export function rankOf(owner: string | undefined): number {
  if (!owner || owner === "core") return RANK.core;
  if (owner === "user") return RANK.user;
  return sources.get(owner) ?? RANK.shared;
}

/** Sorts by rank, then by id (stable and independent of load order). */
export function byLayer<T>(items: T[], owner: (item: T) => string): T[] {
  return [...items].sort((a, b) => rankOf(owner(a)) - rankOf(owner(b)) || owner(a).localeCompare(owner(b)));
}

/**
 * Puts a <style> or <link> in <head> at its owner's place: after everything of a lower or equal
 * rank, before anything of a higher one, so a later rank wins at equal specificity whatever the
 * order things were added in.
 */
export function insertStyle(el: HTMLElement, owner: string) {
  const rank = rankOf(owner);
  el.dataset.rank = String(rank);
  el.dataset.owner ??= owner;
  for (const other of Array.from(document.head.querySelectorAll<HTMLElement>("[data-rank]"))) {
    if (other === el) continue;
    const r = Number(other.dataset.rank);
    if (r > rank || (r === rank && (other.dataset.owner ?? "") > owner)) {
      other.before(el);
      return;
    }
  }
  document.head.append(el);
}
