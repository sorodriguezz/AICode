#!/usr/bin/env node
// Versions and releases. The version lives in three files that must agree — package.json,
// src-tauri/Cargo.toml (shown in the app) and src-tauri/tauri.conf.json (what the updater compares)
// — plus Cargo.lock. This script keeps them together.
//
//   pnpm release patch|minor|major|1.2.3 [--push]
//       Sets the version everywhere, commits "chore(release): vX.Y.Z" and tags vX.Y.Z.
//       --push also pushes the commit and the tag, which starts .github/workflows/release.yml.
//   pnpm release --check [vX.Y.Z]
//       Fails unless the three files agree (and match the tag, when given). Used by the pipeline.
//   pnpm release --print
//       Prints the current version.
//   pnpm release --sync
//       Copies the version in package.json to the other files and prints it. The Release workflow
//       runs it on every push to main, so bumping package.json alone is enough to release.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  pkg: join(root, "package.json"),
  cargo: join(root, "src-tauri/Cargo.toml"),
  lock: join(root, "src-tauri/Cargo.lock"),
  tauri: join(root, "src-tauri/tauri.conf.json"),
};
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const read = (f) => readFileSync(f, "utf8");
const cargoVersion = (text) => text.match(/^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m)?.[1];

function versions() {
  return {
    "package.json": JSON.parse(read(files.pkg)).version,
    "src-tauri/Cargo.toml": cargoVersion(read(files.cargo)),
    "src-tauri/tauri.conf.json": JSON.parse(read(files.tauri)).version,
  };
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function check(tag) {
  const v = versions();
  const distinct = [...new Set(Object.values(v))];
  if (distinct.length !== 1) fail(`the versions do not agree:\n${Object.entries(v).map(([f, x]) => `  ${f}: ${x}`).join("\n")}\nRun "pnpm release <version>" to set them together.`);
  const version = distinct[0];
  if (!SEMVER.test(version)) fail(`"${version}" is not a version like 1.2.3`);
  if (tag && tag.replace(/^v/, "") !== version) fail(`the tag ${tag} does not match the version in the files (${version}). Tag v${version}, or run "pnpm release ${tag.replace(/^v/, "")}" first.`);
  return version;
}

function bump(current, how) {
  if (SEMVER.test(how)) return how;
  const [maj, min, pat] = current.split(/[.-]/).map(Number);
  if (how === "major") return `${maj + 1}.0.0`;
  if (how === "minor") return `${maj}.${min + 1}.0`;
  if (how === "patch") return `${maj}.${min}.${pat + 1}`;
  fail(`"${how}" is not patch, minor, major or a version like 1.2.3`);
}

function setVersion(next) {
  const pkg = JSON.parse(read(files.pkg));
  pkg.version = next;
  writeFileSync(files.pkg, JSON.stringify(pkg, null, 2) + "\n");

  const tauri = JSON.parse(read(files.tauri));
  tauri.version = next;
  writeFileSync(files.tauri, JSON.stringify(tauri, null, 2) + "\n");

  writeFileSync(files.cargo, read(files.cargo).replace(/^(\[package\][^[]*?^version\s*=\s*")[^"]+(")/m, `$1${next}$2`));
  // The app's own entry in Cargo.lock, so the commit builds with --locked.
  writeFileSync(files.lock, read(files.lock).replace(/(\[\[package\]\]\nname = "aicode"\nversion = ")[^"]+(")/, `$1${next}$2`));
}

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const args = process.argv.slice(2);
if (args.includes("--sync")) {
  const version = JSON.parse(read(files.pkg)).version;
  if (!SEMVER.test(version)) fail(`package.json has "${version}", not a version like 1.2.3`);
  setVersion(version);
  console.log(check());
} else if (args.includes("--print")) {
  console.log(check());
} else if (args.includes("--check")) {
  const tag = args.find((a) => a !== "--check");
  console.log(`release: version ${check(tag)} is consistent${tag ? ` with ${tag}` : ""}`);
} else {
  const how = args.find((a) => !a.startsWith("--"));
  if (!how) fail("usage: pnpm release patch|minor|major|1.2.3 [--push]");
  const current = check();
  const next = bump(current, how);
  if (git("status", "--porcelain")) fail("the working tree has uncommitted changes. Commit or stash them first, so the release commit holds only the version.");
  if (git("tag", "--list", `v${next}`)) fail(`the tag v${next} already exists`);
  setVersion(next);
  check();
  git("add", files.pkg, files.cargo, files.lock, files.tauri);
  git("commit", "-m", `chore(release): v${next}`);
  git("tag", "-a", `v${next}`, "-m", `AICode ${next}`);
  console.log(`release: ${current} → ${next}, committed and tagged v${next}.`);
  if (args.includes("--push")) {
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    git("push", "--atomic", "origin", branch, `v${next}`);
    console.log(`release: pushed ${branch} and v${next}. The Release workflow is building it: https://github.com/sorodriguezz/AICode/actions`);
  } else {
    console.log(`release: push it to build the release:\n  git push --atomic origin HEAD v${next}`);
  }
}
