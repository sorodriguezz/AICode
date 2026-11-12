// Copies the third-party files bundled mods load at run time into the mods themselves, so each
// mod folder is complete on its own (and installable elsewhere as-is).
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const copies = [
  ["node_modules/@xterm/xterm/lib/xterm.mjs", "mods/aicode.terminal/vendor/xterm.mjs"],
  ["node_modules/@xterm/xterm/css/xterm.css", "mods/aicode.terminal/vendor/xterm.css"],
  ["node_modules/@xterm/addon-fit/lib/addon-fit.mjs", "mods/aicode.terminal/vendor/addon-fit.mjs"],
  ["node_modules/@xterm/xterm/LICENSE", "mods/aicode.terminal/vendor/LICENSE-xterm"],
];
for (const [from, to] of copies) {
  const src = join(root, from);
  if (!existsSync(src)) {
    console.error(`vendor-mods: missing ${from} — run pnpm install`);
    process.exit(1);
  }
  mkdirSync(dirname(join(root, to)), { recursive: true });
  cpSync(src, join(root, to));
}
console.log(`vendor-mods: ${copies.length} files`);
