// "VS Code Icons — Auto (by project)": while it is the file icon theme, each window draws its files
// with the pack its folder calls for — a Spring checkout gets Spring's controllers and
// application.yml, a Nest one its services and modules — and with the General pack when nothing is
// recognised. Only the folder's root is read: a listing and at most a few small manifests.
// The detection is CodeFlow's (src/lib/icons/detectProfile.ts), so both apps agree on a repository.

const AUTO = "vscode-icons-auto";

/** The pack id for a folder's root, or null when nothing is recognised. Backends are asked first. */
export async function detectPack(names, read) {
  const byLower = new Map(names.map((name) => [name.toLowerCase(), name]));
  const has = (name) => byLower.has(name);
  const readRoot = (name) => read(byLower.get(name) ?? name);
  const any = (test) => names.some((name) => test.test(name));

  // .NET: a solution or a project file is the whole signal.
  if (any(/\.(sln|slnx|csproj|fsproj|vbproj)$/i)) return "dotnet";
  // Spring Boot: a Maven or Gradle build that pulls in Boot.
  for (const build of ["pom.xml", "build.gradle", "build.gradle.kts"]) {
    if (!has(build)) continue;
    const text = await readRoot(build);
    if (text && /spring-boot|org\.springframework\.boot/.test(text)) return "spring";
  }
  // Laravel: `artisan` is the tell; the framework in composer.json is the backup.
  if (has("artisan")) return "laravel";
  if (has("composer.json") && (await readRoot("composer.json"))?.includes("laravel/framework")) return "laravel";
  // Python: Django has its own entry point; otherwise the dependency list says which framework.
  if (has("manage.py")) return "django";
  const manifests = names.filter((name) => /^(requirements[^/]*\.(txt|in)|pyproject\.toml|pipfile|setup\.py|setup\.cfg)$/i.test(name)).slice(0, 4);
  for (const name of manifests) {
    const text = ((await read(name)) ?? "").toLowerCase();
    if (/\bfastapi\b/.test(text)) return "fastapi";
    if (/\bdjango\b/.test(text)) return "django";
  }
  // JavaScript and TypeScript: the CLIs' own config files, then the dependencies.
  if (has("angular.json")) return "angular";
  if (has("nest-cli.json")) return "nestjs";
  const deps = has("package.json") ? dependenciesOf(await readRoot("package.json")) : new Set();
  // Angular before Nest: a workspace holding both is mostly components by file count.
  if (deps.has("@angular/core")) return "angular";
  if (deps.has("@nestjs/core")) return "nestjs";
  if (deps.has("next")) return "nextjs";
  if (deps.has("nuxt") || deps.has("vue")) return "vue";
  if (deps.has("react")) return "react";
  if (any(/^next\.config\./i)) return "nextjs";
  if (any(/^nuxt\.config\./i)) return "vue";
  // Bun, last: a React or Vue app installed with Bun is still a React or Vue tree.
  if (has("bun.lock") || has("bun.lockb") || has("bunfig.toml")) return "bun";
  if (deps.has("@types/bun") || deps.has("bun-types")) return "bun";
  return null;
}

function dependenciesOf(json) {
  const names = new Set();
  try {
    const manifest = JSON.parse(json ?? "");
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const block = manifest?.[field];
      if (block && typeof block === "object") for (const name of Object.keys(block)) names.add(name);
    }
  } catch {}
  return names;
}

export async function activate(ctx) {
  const isAuto = () => {
    const id = ctx.config.get("workbench.iconTheme");
    return id === AUTO || id === `aicode.icons/${AUTO}`;
  };
  let watcher = null;
  let generation = 0;

  const follow = async () => {
    const run = ++generation;
    watcher?.dispose();
    watcher = null;
    const folder = ctx.workspace.folder();
    // Detected even while another theme is chosen, so previewing Auto in the picker shows the pack.
    if (!folder) return ctx.workbench.drawIconThemeWith(AUTO, null);
    const entries = await ctx.fs.readDir(folder).catch(() => []);
    const read = async (name) => {
      try {
        const f = await ctx.fs.readText(`${folder}/${name}`);
        return f.binary ? null : f.text;
      } catch {
        return null;
      }
    };
    const pack = await detectPack(entries.map((e) => e.name), read).catch(() => null);
    if (run !== generation) return;
    await ctx.workbench.drawIconThemeWith(AUTO, pack ? `vscode-icons-${pack}` : null);
    // A manifest added or changed at the root (a dependency installed) can change the answer.
    if (!isAuto()) return;
    let timer = 0;
    watcher = ctx.fs.watch(folder, () => {
      clearTimeout(timer);
      timer = setTimeout(follow, 800);
    });
  };

  ctx.workspace.onDidChangeFolder(follow);
  ctx.config.watch("workbench.iconTheme", follow);
  ctx.subscriptions.push({ dispose: () => watcher?.dispose() });
  await follow();
}
