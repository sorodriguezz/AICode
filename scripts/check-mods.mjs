// Validates every bundled mod: the manifest parses, ids match folders, files referenced exist,
// declared views/commands are well-formed, and the entry module at least parses as JavaScript.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "mods");
const PERMS = new Set(["fs:read", "fs:write", "process", "pty", "mcp-server", "open-external"]);
const LOCATIONS = new Set(["sidebar", "secondary", "panel"]);
let problems = 0;
const fail = (mod, msg) => {
  problems++;
  console.error(`✗ ${mod}: ${msg}`);
};
const ids = new Set(readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory()));
for (const dir of ids) {
  const base = join(root, dir);
  let m;
  try {
    m = JSON.parse(readFileSync(join(base, "mod.json"), "utf8"));
  } catch (e) {
    fail(dir, `mod.json: ${e.message}`);
    continue;
  }
  if (m.id !== dir) fail(dir, `id ${m.id} does not match the folder`);
  for (const k of ["name", "version", "description"]) if (!m[k]) fail(dir, `missing ${k}`);
  for (const p of m.permissions ?? []) if (!PERMS.has(p)) fail(dir, `unknown permission ${p}`);
  for (const d of [...(m.dependencies ?? []), ...(m.optionalDependencies ?? [])]) if (!ids.has(d)) fail(dir, `depends on missing ${d}`);
  const c = m.contributes ?? {};
  for (const v of c.views ?? []) {
    if (!v.id || !v.title) fail(dir, `view without id/title`);
    if (v.location && !LOCATIONS.has(v.location)) fail(dir, `view ${v.id}: bad location ${v.location}`);
    if (m.main && !(m.activation ?? []).some((a) => a === `onView:${v.id}` || a === "onStartup" || a === "*")) fail(dir, `view ${v.id} has no activation event that loads it`);
  }
  for (const t of c.themes ?? []) if (!existsSync(join(base, t.path))) fail(dir, `theme file ${t.path} missing`);
  for (const s of c.snippets ?? []) if (!existsSync(join(base, s.path))) fail(dir, `snippet file ${s.path} missing`);
  for (const st of c.styles ?? []) {
    const path = typeof st === "string" ? st : st?.path;
    if (path && !existsSync(join(base, path))) fail(dir, `style file ${path} missing`);
    if (!path && typeof st?.css !== "string" && !Array.isArray(st?.css)) fail(dir, `a style needs "path" or "css"`);
  }
  for (const t of c.titleBar ?? []) if (!t?.command) fail(dir, `title bar item ${t?.id ?? "?"} has no command`);
  if (c.configurationDefaults !== undefined && (typeof c.configurationDefaults !== "object" || Array.isArray(c.configurationDefaults))) fail(dir, `configurationDefaults must be an object`);
  for (const [name, l] of Object.entries(c.windowLayouts ?? {})) {
    if (!l || typeof l !== "object") fail(dir, `window layout ${name} must be an object`);
    for (const [view, place] of Object.entries(l?.views ?? {})) if (!["sidebar", "secondary", "panel", "center", "hidden"].includes(place)) fail(dir, `window layout ${name}: view ${view} has a bad place ${place}`);
  }
  if (m.main) {
    const entry = join(base, m.main);
    if (!existsSync(entry)) fail(dir, `main ${m.main} missing`);
    else {
      try {
        execFileSync(process.execPath, ["--check", "--input-type=module"], { input: readFileSync(entry) });
      } catch (e) {
        fail(dir, `${m.main} does not parse: ${String(e.stderr || e.message).split("\n").slice(0, 4).join(" ")}`);
      }
    }
  }
  if (!problems) console.log(`✓ ${dir}`);
}
process.exit(problems ? 1 : 0);
