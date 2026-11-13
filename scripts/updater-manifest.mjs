#!/usr/bin/env node
// Writes latest.json, the feed the app's updater reads
// (https://github.com/<repo>/releases/latest/download/latest.json, see tauri.conf.json), from the
// signatures the release builds produced. Run by .github/workflows/release.yml after every build
// has finished, so the feed lists every platform at once.
//
//   node scripts/updater-manifest.mjs --version 1.2.3 --repo owner/name --dir <folder> [--notes notes.md] [--out latest.json]
//
// <folder> holds the update packages' signatures, as the release workflow names them (arch:
// aarch64 or x64):
//   macOS    AICode_<version>_<arch>.app.tar.gz.sig
//   Windows  AICode_<version>_<arch>-setup.exe.sig   (the NSIS installer is the update)
//   Linux    AICode_<version>_<arch>.AppImage.sig   and, when the bundler signed them,
//            AICode_<version>_<arch>.deb.sig / .rpm.sig  (an app installed from a .deb or .rpm asks
//            for linux-<arch>-deb / -rpm first, and could not install an AppImage in their place)

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

// The update package of each platform, and Tauri's updater key for it by the arch in our names.
const KINDS = [
  { suffix: ".app.tar.gz", os: "darwin" },
  { suffix: "-setup.exe", os: "windows" },
  { suffix: ".AppImage", os: "linux" },
  { suffix: ".deb", os: "linux", installer: "deb" },
  { suffix: ".rpm", os: "linux", installer: "rpm" },
];
const ARCH = { aarch64: "aarch64", x64: "x86_64" };

const platforms = {};
for (const name of readdirSync(dir)) {
  if (!name.startsWith("AICode_") || !name.endsWith(".sig")) continue;
  const archive = name.slice(0, -".sig".length);
  const kind = KINDS.find((k) => archive.endsWith(k.suffix));
  const m = kind && archive.slice(0, -kind.suffix.length).match(/^AICode_(.+)_(aarch64|x64)$/);
  if (!m) continue;
  if (m[1] !== version) {
    console.error(`updater-manifest: ${name} is not for version ${version}`);
    process.exit(1);
  }
  platforms[`${kind.os}-${ARCH[m[2]]}${kind.installer ? `-${kind.installer}` : ""}`] = {
    signature: readFileSync(join(dir, name), "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/v${version}/${archive}`,
  };
}
if (!Object.keys(platforms).length) {
  console.error(`updater-manifest: no update signatures for ${version} in ${dir}`);
  process.exit(1);
}

const notes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, "utf8").trim() : "";
const manifest = { version, notes, pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), platforms };
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`updater-manifest: ${out} for ${version}: ${Object.keys(platforms).join(", ")}`);
