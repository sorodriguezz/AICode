// Local commit message suggestions for Source Control.
const CSS = `
.scm-input { position: relative; }
.lac-ghost {
  position: absolute; pointer-events: none; overflow: hidden; box-sizing: border-box;
  white-space: pre-wrap; overflow-wrap: break-word; color: transparent;
  border-color: transparent !important; background: transparent !important;
}
.lac-ghost .lac-typed { color: transparent; }
.lac-ghost .lac-sugg { color: var(--aicode-editorGhostText-foreground, var(--aicode-descriptionForeground)); opacity: .75; }
.lac-ghost .lac-hint {
  margin-left: 6px; font-size: 10px; padding: 0 4px; border-radius: 3px; vertical-align: 1px;
  color: var(--aicode-descriptionForeground); border: 1px solid var(--aicode-widget-border, rgba(128, 128, 128, .35));
}
@keyframes lac-in { from { opacity: 0; } }
html:not(.no-motion) .lac-ghost .lac-sugg { animation: lac-in var(--motion, 160ms) var(--ease-out, ease-out); }
textarea.lac-has-ghost::placeholder { color: transparent; }
textarea.lac-with-generate { padding-right: 28px !important; }
.scm-input > .lac-generate {
  position: absolute; width: 22px; height: 22px; padding: 0; z-index: 1;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--aicode-descriptionForeground); opacity: .8;
}
.scm-input > .lac-generate:hover:not(:disabled) { opacity: 1; color: var(--aicode-foreground); }
.scm-input > .lac-generate:disabled { opacity: 1; cursor: progress; }
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function activate(ctx) {
  const s = (key, fallback) => ctx.settings.getNow(key, fallback);
  const gitCore = await ctx.mods.get("aicode.git-core");
  const { complete, chat, prepare, codeModel, commitModel, fail, ok, track } = await ctx.mods.get("aicode.local-inference");
  ctx.styles.add(CSS);

  // ---------- commits: context from git ----------
  let gitCache = null; // { at, root, data }
  ctx.subscriptions.push(gitCore.onDidChange(() => { gitCache = null; }));
  const git = async (cwd, args) => {
    const result = await gitCore.git.run(args, { cwd, quiet: true });
    return result.code === 0 ? result.stdout : "";
  };
  const commitContext = async (fresh = false) => {
    const root = await gitCore.repository();
    if (!root) return null;
    if (!fresh && gitCache && gitCache.root === root && Date.now() - gitCache.at < 8000) return gitCache.data;
    let stat = await git(root, ["diff", "--cached", "--stat"]);
    let diff = "";
    let staged = true;
    if (stat.trim()) diff = await git(root, ["diff", "--cached", "-U2", "--no-ext-diff"]);
    else {
      // Nothing staged: the Git mod commits every change in that case, so describe those.
      staged = false;
      stat = await git(root, ["diff", "HEAD", "--stat"]);
      diff = await git(root, ["diff", "HEAD", "-U2", "--no-ext-diff"]);
      const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard"])).trim();
      if (untracked) stat += `\nNew files:\n${untracked.split("\n").slice(0, 30).join("\n")}`;
    }
    const log = (await git(root, ["log", "-n", "15", "--pretty=%s"])).split("\n").map((l) => l.trim()).filter(Boolean);
    const data = { root, stat: stat.trim(), diff: diff.length > 6000 ? `${diff.slice(0, 6000)}\n… (diff truncated)` : diff, log, staged };
    gitCache = { at: Date.now(), root, data };
    return data;
  };

  const styleHint = (log) => {
    const style = s("commitStyle", "auto");
    if (style === "conventional") return "Use Conventional Commits: type(optional scope): subject — types: feat, fix, refactor, perf, docs, style, test, build, ci, chore.";
    if (style === "plain") return "Write a short sentence in the imperative mood, no type prefix.";
    if (!log.length) return "Use Conventional Commits (feat:, fix:, chore:…).";
    return `Follow the exact style of these recent commits of the repository:\n${log.slice(0, 10).map((l) => `- ${l}`).join("\n")}`;
  };

  // ---------- commits: ghost text in the Source Control box ----------
  const ghost = { ta: null, el: null, text: "", timer: null, req: null, seq: 0 };
  const isCommitBox = (el) => el instanceof HTMLTextAreaElement && !!el.closest(".scm-input");

  const clearGhost = () => {
    clearTimeout(ghost.timer);
    ghost.req?.cancel?.();
    ghost.req = null;
    ghost.seq++;
    ghost.text = "";
    ghost.el?.remove();
    ghost.el = null;
    ghost.ta?.classList.remove("lac-has-ghost");
  };

  const paintGhost = () => {
    const ta = ghost.ta;
    if (!ta?.isConnected || !ghost.text) return clearGhost();
    const cs = getComputedStyle(ta);
    const el = ghost.el ?? document.createElement("div");
    el.className = "lac-ghost";
    for (const p of ["font", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderStyle", "textIndent", "tabSize"]) el.style[p] = cs[p];
    Object.assign(el.style, { left: `${ta.offsetLeft}px`, top: `${ta.offsetTop}px`, width: `${ta.offsetWidth}px`, height: `${ta.offsetHeight}px` });
    el.replaceChildren(
      Object.assign(document.createElement("span"), { className: "lac-typed", textContent: ta.value }),
      Object.assign(document.createElement("span"), { className: "lac-sugg", textContent: ghost.text }),
      Object.assign(document.createElement("span"), { className: "lac-hint", textContent: "Tab" }),
    );
    if (!ghost.el) ta.parentElement.append(el);
    ghost.el = el;
    el.scrollTop = ta.scrollTop;
    ta.classList.add("lac-has-ghost");
  };

  const suggestCommit = async (ta) => {
    if (!s("commitInline", true) || document.activeElement !== ta) return;
    if (ta.selectionStart !== ta.value.length || ta.selectionEnd !== ta.value.length) return;
    const typed = ta.value;
    // Only the subject line is continued; the body is the user's.
    if (typed.includes("\n")) return;
    const seq = ++ghost.seq;
    const c = await commitContext();
    if (!c || (!c.stat && !c.diff) || seq !== ghost.seq) return;
    await prepare();
    if (seq !== ghost.seq) return;
    const prompt = [
      c.log.length ? `Recent commit subjects of this repository (newest first):\n${c.log.slice(0, 12).map((l) => `- ${l}`).join("\n")}\n` : "",
      `Files changed:\n${c.stat}\n`,
      `Diff:\n${c.diff}\n`,
      `${styleHint(c.log).split("\n")[0]}`,
      `Subject line for the commit above, in the same style and language as the recent subjects:`,
      `- ${typed}`,
    ].join("\n");
    const req = complete({
      model: codeModel(),
      prompt,
      stop: ["\n", "<|endoftext|>", "<|file_sep|>", "<|im_end|>", "<|fim_prefix|>"],
      maxTokens: 40,
      temperature: Number(s("temperature", 0.1)) || 0,
    });
    ghost.req = req;
    try {
      let text = String(await track(req)).replace(/\r/g, "").split("\n")[0];
      if (seq !== ghost.seq) return;
      ok();
      if (!typed) text = text.replace(/^\s+/, "");
      text = text.replace(/\s+$/, "").slice(0, 120);
      if (!text.trim()) return;
      // Small models sometimes just repeat a subject from the history they were shown: not a suggestion.
      const whole = (typed + text).trim().toLowerCase();
      if (c.log.some((l) => l.trim().toLowerCase() === whole)) return;
      ghost.ta = ta;
      ghost.text = text;
      paintGhost();
    } catch (e) {
      fail(e);
    } finally {
      if (ghost.req === req) ghost.req = null;
    }
  };

  const showSuggestion = (ta) => suggestCommit(ta).catch(fail);
  const schedule = (ta, delay = Number(s("debounceMs", 0)) || 250) => {
    clearGhost();
    ghost.ta = ta;
    ghost.timer = setTimeout(() => showSuggestion(ta), Math.max(150, delay + 150));
  };

  const acceptGhost = (ta, wordOnly = false) => {
    let piece = ghost.text;
    if (wordOnly) piece = piece.match(/^\s*\S+/)?.[0] ?? piece;
    const rest = ghost.text.slice(piece.length);
    const value = ta.value + piece;
    ta.value = value;
    ta.selectionStart = ta.selectionEnd = value.length;
    // The Git mod keeps the message from its own `input` handler.
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    if (rest) {
      ghost.ta = ta;
      ghost.text = rest;
      paintGhost();
    } else clearGhost();
  };

  const onFocusIn = (e) => isCommitBox(e.target) && schedule(e.target, 400);
  const onFocusOut = (e) => isCommitBox(e.target) && clearGhost();
  const onInput = (e) => {
    if (!isCommitBox(e.target)) return;
    if (!e.isTrusted) return; // our own accept, or a generated message
    // Typing the start of the suggestion keeps it instead of asking again.
    if (ghost.text && e.inputType === "insertText" && e.data && ghost.text.startsWith(e.data)) {
      ghost.text = ghost.text.slice(e.data.length);
      if (ghost.text) return paintGhost();
    }
    schedule(e.target);
  };
  const onKey = (e) => {
    if (!isCommitBox(e.target)) return;
    const ta = e.target;
    if (ghost.text && ghost.ta === ta) {
      if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        return acceptGhost(ta);
      }
      if (e.key === "ArrowRight" && (e.metaKey || e.ctrlKey || e.altKey) && ta.selectionStart === ta.value.length) {
        e.preventDefault();
        e.stopPropagation();
        return acceptGhost(ta, true);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        return clearGhost();
      }
    }
    if (e.key === "\\" && e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      triggerCommit();
    }
  };
  const triggerCommit = () => {
    const active = document.activeElement;
    if (!isCommitBox(active)) return;
    clearGhost();
    ghost.ta = active;
    return showSuggestion(active);
  };
  const onScroll = (e) => isCommitBox(e.target) && ghost.el && (ghost.el.scrollTop = e.target.scrollTop);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("scroll", onScroll, true);
  ctx.subscriptions.push({
    dispose: () => {
      clearGhost();
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScroll, true);
    },
  });

  // ---------- commits: the whole message ----------
  const cleanMessage = (text) => {
    let t = String(text ?? "").replace(/\r/g, "");
    t = t.replace(/<think>[\s\S]*?<\/think>/g, ""); // reasoning models
    const fence = t.match(/```[a-z]*\n([\s\S]*?)```/);
    if (fence) t = fence[1];
    t = t.replace(/^\s*(commit message|message|subject)\s*:\s*/i, "").trim();
    t = t.replace(/^["'`]+|["'`]+$/g, "").trim();
    return t;
  };

  const findCommitBox = () => document.querySelector(".scm-input textarea");
  const writeCommit = async () => {
    const c = await commitContext(true);
    if (!c) return ctx.window.showInfo("Open a folder with a git repository first.");
    if (!c.stat && !c.diff) return ctx.window.showInfo("There are no changes to describe.");
    await prepare();
    const lang = String(s("commitLanguage", "") || "").trim();
    const system = [
      "You write git commit messages. Reply with only the commit message: no explanations, no quotes, no code fences.",
      "First line: at most 72 characters, imperative mood, describing what the change does and why.",
      "If the change is not trivial, add a blank line and a short body (2-5 bullet points starting with '- ').",
      styleHint(c.log),
      lang ? `Write the message in ${lang}.` : c.log.length ? "Write it in the same language as the recent commits." : "",
    ].filter(Boolean).join("\n");
    const user = `${c.staged ? "Staged changes" : "Changes (nothing is staged; all of these will be committed)"}:\n${c.stat}\n\n${c.diff}`;
    let message;
    try {
      message = cleanMessage(await track(chat({ model: commitModel(), system, user })));
      ok();
    } catch (e) {
      return fail(e, { slot: "commit", explicit: true });
    }
    if (!message) return ctx.window.showWarning("The model returned an empty message.");
    let ta = findCommitBox();
    if (!ta) {
      await ctx.views.reveal("scm");
      for (let i = 0; i < 20 && !(ta = findCommitBox()); i++) await sleep(50);
    }
    if (!ta) {
      ctx.window.copy(message);
      return ctx.window.showInfo("Commit message copied to the clipboard.");
    }
    clearGhost();
    ta.value = message;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
    ta.selectionStart = ta.selectionEnd = message.length;
  };

  let generating = false;
  const generateCommit = async () => {
    if (generating) return;
    generating = true;
    paintButtons();
    try {
      await writeCommit();
    } catch (e) {
      ctx.window.showError(`Could not generate a commit message: ${e.message ?? e}`);
    } finally {
      generating = false;
      paintButtons();
    }
  };

  // ---------- the ✨ button in the Source Control message box ----------
  // The Git mod rebuilds its view often, so the button is put back whenever a message box shows up
  // without one.
  const BUTTON_TITLE = "Generate Commit Message with the local model (Ctrl+Alt+M)";
  const placeButton = (box) => {
    const ta = box.querySelector("textarea");
    if (!ta) return;
    let btn = box.querySelector(":scope > .lac-generate");
    if (!btn) {
      btn = ctx.ui.iconButton(generating ? "loading~spin" : "sparkle", BUTTON_TITLE, (e) => {
        e.preventDefault();
        generateCommit();
      });
      btn.classList.add("lac-generate");
      btn.tabIndex = -1;
      // Keep the focus (and the ghost text) in the box when the button is pressed.
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      box.append(btn);
      ta.classList.add("lac-with-generate");
    }
    // Top-right corner of the textarea, wherever the Git mod's padding puts it.
    btn.style.top = `${ta.offsetTop + Math.max(0, (Math.min(ta.offsetHeight, 30) - 22) / 2)}px`;
    btn.style.right = `${Math.max(0, box.clientWidth - (ta.offsetLeft + ta.offsetWidth)) + 3}px`;
  };
  const paintButtons = () => {
    for (const btn of document.querySelectorAll(".scm-input > .lac-generate")) {
      btn.replaceChildren(ctx.ui.icon(generating ? "loading~spin" : "sparkle"));
      btn.disabled = generating;
      btn.title = generating ? "Writing the commit message…" : BUTTON_TITLE;
    }
  };
  const decorate = () => document.querySelectorAll(".scm-input").forEach(placeButton);
  let frame = null;
  const observer = new MutationObserver(() => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      decorate();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  decorate();
  ctx.subscriptions.push({
    dispose: () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      document.querySelectorAll(".scm-input > .lac-generate").forEach((b) => b.remove());
      document.querySelectorAll("textarea.lac-with-generate").forEach((t) => t.classList.remove("lac-with-generate"));
    },
  });

  ctx.settings.onDidChange(clearGhost);
  ctx.config.watch("*", clearGhost, "aicode.local-inference");
  ctx.commands.register("commitAssistant.trigger", triggerCommit);
  ctx.commands.register("autocomplete.generateCommit", generateCommit);
  return { generateCommit };
}
