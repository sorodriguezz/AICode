#!/usr/bin/env node
// Writes latest.json, the feed the app's updater reads
// (https://github.com/<repo>/releases/latest/download/latest.json, see tauri.conf.json), from the
// signatures the release builds produced. Run by .github/workflows/release.yml after every build
// has finished, so the feed lists every platform at once.
//
//   node scripts/updater-manifest.mjs --version 1.2.3 --repo owner/name --dir <folder> [--notes notes.md] [--out latest.json]
//
// <folder> holds the updater archives' signatures, named AICode_<version>_<arch>.app.tar.gz.sig
// (arch: aarch64 or x64), as the release workflow names them.

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const opt = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const version = opt("version");
const repo = opt("repo");
const dir = opt("dir");
const notesFile = opt("notes");
const out = opt("out", "latest.json");
if (!version || !repo || !dir) {
  console.error("usage: updater-manifest.mjs --version 1.2.3 --repo owner/name --dir <folder> [--notes notes.md] [--out latest.json]");
  process.exit(1);
}

// Tauri's updater platform keys, by the arch in our file names.
const PLATFORMS = {
  aarch64: "darwin-aarch64",
  x64: "darwin-x86_64",
};

const platforms = {};
for (const name of readdirSync(dir)) {
  const m = name.match(/^AICode_(.+)_(aarch64|x64)\.app\.tar\.gz\.sig$/);
  if (!m) continue;
  if (m[1] !== version) {
    console.error(`updater-manifest: ${name} is not for version ${version}`);
    process.exit(1);
  }
  const archive = name.replace(/\.sig$/, "");
  platforms[PLATFORMS[m[2]]] = {
    signature: readFileSync(join(dir, name), "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/v${version}/${archive}`,
  };
}
if (!Object.keys(platforms).length) {
  console.error(`updater-manifest: no AICode_${version}_<arch>.app.tar.gz.sig in ${dir}`);
  process.exit(1);
}

const notes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, "utf8").trim() : "";
const manifest = { version, notes, pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), platforms };
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`updater-manifest: ${out} for ${version}: ${Object.keys(platforms).join(", ")}`);
