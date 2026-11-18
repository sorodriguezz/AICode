// Shell Command: `aicode` in the terminal, as `code` is VS Code's.
//
// The core does the work (src-tauri/src/cli.rs): the command line itself, and writing a small
// script named `aicode` into a folder of the PATH that runs this AICode. This mod decides when:
// at startup it installs the command, or brings it up to date after AICode moved, wherever that
// needs no password; when only /usr/local/bin is left (macOS without Homebrew), it asks once. The
// commands install and remove it by hand, the password asked for if needed.

export async function activate(ctx) {
  const sc = ctx.app.shellCommand;
  // Windows: only terminals opened after the PATH changed see it.
  const isWindows = navigator.platform.toLowerCase().startsWith("win");
  const newTerminal = isWindows ? "Open a new terminal and type" : "In a terminal, type";

  const install = async ({ admin = true, quiet = false } = {}) => {
    try {
      const st = await sc.install({ admin });
      if (st.packaged) {
        if (!quiet) ctx.window.showInfo(`The aicode command is ${st.path}, from AICode's package.`);
        return st;
      }
      if (!st.onPath) {
        ctx.window.showWarning(`Installed ${st.dir}/aicode, but that folder is not on your PATH. Add it (export PATH="${st.dir}:$PATH" in your shell's profile), then aicode works in new terminals.`);
      } else if (!quiet) {
        ctx.window.showInfo(`${newTerminal} aicode . to open a folder in AICode (aicode --help for more).`);
      }
      return st;
    } catch (e) {
      const message = String(e?.message ?? e);
      if (message === "cancelled") return null;
      if (message.startsWith("needs-admin")) {
        ctx.window.showWarning(message.replace(/^needs-admin: /, "Installing the aicode command: "), { label: "Install…", run: () => install() });
        return null;
      }
      ctx.window.showError(`Could not install the aicode command: ${message}`);
      return null;
    }
  };

  ctx.commands.register("shellCommand.install", () => install());

  ctx.commands.register("shellCommand.uninstall", async () => {
    try {
      await sc.uninstall();
      ctx.window.showInfo("The aicode command was removed from your PATH.");
    } catch (e) {
      const message = String(e?.message ?? e);
      if (message !== "cancelled") ctx.window.showError(`Could not remove the aicode command: ${message}`);
    }
  });

  ctx.commands.register("shellCommand.status", async () => {
    const st = await sc.status();
    if (!st.supported) return ctx.window.showInfo(`No aicode command here: ${st.reason}.`);
    if (st.foreign) return ctx.window.showWarning(`${st.path} is another program's aicode, so AICode does not install its own.`);
    if (st.installed) return ctx.window.showInfo(`aicode is ${st.path}. ${newTerminal} aicode --help.`);
    if (st.ours && !st.current) return ctx.window.showWarning(`${st.path} runs a copy of AICode that is no longer there.`, { label: "Update", run: () => install() });
    if (st.ours) return ctx.window.showWarning(`${st.path} is installed, but ${st.dir} is not on your PATH.`);
    ctx.window.showInfo("The aicode command is not installed.", { label: "Install", run: () => install() });
  });

  // ---------- at startup: once per launch, in the first window ----------
  if (!(await sc.claimStartup())) return;
  if (!(await ctx.settings.get("autoInstall", true))) return;
  const st = await sc.status().catch(() => null);
  if (!st?.supported || st.foreign || st.installed) return;
  if (st.ours && !st.current) {
    // AICode moved (or was replaced): the script points to where it was.
    if (!st.needsAdmin) return void install({ admin: false, quiet: true });
    return ctx.window.showWarning("The aicode command points to where AICode used to be.", { label: "Update…", run: () => install() });
  }
  if (st.ours) return; // installed where the PATH does not look: the warning was given when it was written
  if (!st.needsAdmin) {
    const done = await install({ admin: false, quiet: true });
    if (done?.installed && !(await ctx.settings.get("announced", false))) {
      await ctx.settings.set("announced", true);
      ctx.window.showInfo(`The aicode command is ready: ${newTerminal.toLowerCase()} aicode . to open a folder here.`);
    }
    return;
  }
  if (await ctx.settings.get("offered", false)) return;
  await ctx.settings.set("offered", true);
  ctx.window.showInfo(`Install the aicode command, to open folders from the terminal (aicode .)? It goes in ${st.dir}, which needs your password.`, { label: "Install…", run: () => install() });
}
