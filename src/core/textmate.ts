// TextMate grammars (the regex-based syntax format many editors share) for Monaco, contributed by
// AICode mods through `contributes.grammars`. This module (and the
// Oniguruma regex engine, a WASM file) is only loaded the first time a file whose language has a
// mod-provided grammar is opened; with no such mod, none of it is ever fetched.

import * as monaco from "monaco-editor";
import * as vsctm from "vscode-textmate";
import * as onig from "vscode-oniguruma";
import onigWasmUrl from "vscode-oniguruma/release/onig.wasm?url";
import { currentTmTheme, setTextMateRules, type TmTheme } from "./theme";

export interface GrammarSource {
  scopeName: string;
  url: string;
  path: string;
  language?: string;
  injectTo?: string[];
  embeddedLanguages?: Record<string, string>;
}

let registryPromise: Promise<vsctm.Registry> | null = null;

function registry(sources: Map<string, GrammarSource>): Promise<vsctm.Registry> {
  // A failed start (the WASM did not load) is not cached, so a retry starts over.
  registryPromise ??= (async () => {
    const wasm = await fetch(onigWasmUrl).then((r) => r.arrayBuffer());
    await onig.loadWASM(wasm);
    return new vsctm.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (patterns: string[]) => new onig.OnigScanner(patterns),
        createOnigString: (s: string) => new onig.OnigString(s),
      }),
      loadGrammar: async (scopeName) => {
        const src = sources.get(scopeName);
        if (!src) return null;
        const text = await fetch(src.url).then((r) => {
          if (!r.ok) throw new Error(`${src.path}: ${r.status}`);
          return r.text();
        });
        return vsctm.parseRawGrammar(text, src.path);
      },
      getInjections: (scopeName) => [...sources.values()].filter((s) => s.injectTo?.includes(scopeName)).map((s) => s.scopeName),
    });
  })();
  registryPromise.catch(() => (registryPromise = null));
  return registryPromise;
}

class TmState implements monaco.languages.IState {
  constructor(readonly stack: vsctm.StateStack) {}
  clone() {
    return new TmState(this.stack);
  }
  equals(other: monaco.languages.IState) {
    return other instanceof TmState && other.stack.equals(this.stack);
  }
}

// Colors come from vscode-textmate itself, which matches the theme against each token's whole
// scope stack as VS Code does (descendant selectors like "markup.heading entity.name", parent
// scopes, specificity). Each token is named after the color and font style it resolved to,
// `tm<color id>x<font style>`, plus `.comment`/`.string`/`.regex` so Monaco still knows where
// comments and strings are; the Monaco theme gets one rule per such name.
const attached = new Map<string, vsctm.IGrammar>();
let themedRegistry: vsctm.Registry | null = null;

function rulesFor(reg: vsctm.Registry, theme: TmTheme): monaco.editor.ITokenThemeRule[] {
  reg.setTheme(theme as vsctm.IRawTheme);
  const colors = reg.getColorMap();
  const rules: monaco.editor.ITokenThemeRule[] = [];
  for (let id = 1; id < colors.length; id++) {
    const foreground = colors[id]?.replace(/^#/, "");
    for (let fs = 0; fs < 16; fs++) {
      const style = [fs & 1 ? "italic" : "", fs & 2 ? "bold" : "", fs & 4 ? "underline" : "", fs & 8 ? "strikethrough" : ""].filter(Boolean).join(" ");
      rules.push({ token: `tm${id}x${fs}`, foreground, fontStyle: style });
    }
  }
  // The theme changed: the color ids did too, so every attached language tokenizes again.
  queueMicrotask(() => {
    for (const [language, grammar] of attached) setProvider(language, grammar);
  });
  return rules;
}

const TOKEN_TYPE = ["", ".comment", ".string", ".regex"];

function setProvider(language: string, grammar: vsctm.IGrammar) {
  monaco.languages.setTokensProvider(language, {
    getInitialState: () => new TmState(vsctm.INITIAL),
    tokenize: (line, state) => {
      const result = grammar.tokenizeLine2(line, (state as TmState).stack, 500);
      const tokens: monaco.languages.IToken[] = [];
      const t = result.tokens;
      for (let i = 0; i < t.length; i += 2) {
        const meta = t[i + 1];
        const fs = (meta >>> 11) & 0xf;
        const fg = (meta >>> 15) & 0x1ff;
        const type = (meta >>> 8) & 0x3;
        tokens.push({ startIndex: t[i], scopes: `tm${fg}x${fs}${TOKEN_TYPE[type]}` });
      }
      return { tokens, endState: new TmState(result.ruleStack) };
    },
  });
}

/** Gives `language` its grammar's tokens, replacing Monaco's built-in tokenizer if it had one. */
export async function attachGrammar(language: string, source: GrammarSource, sources: Map<string, GrammarSource>) {
  const reg = await registry(sources);
  const embedded: Record<string, number> = {};
  let n = 1;
  for (const scope of Object.keys(source.embeddedLanguages ?? {})) embedded[scope] = n++;
  let grammar: vsctm.IGrammar | null;
  try {
    grammar = await reg.loadGrammarWithConfiguration(source.scopeName, 0, { embeddedLanguages: embedded });
  } catch (e) {
    // The registry remembers a failed load; start a fresh one for the retry.
    registryPromise = null;
    throw e;
  }
  if (!grammar) throw new Error(`grammar ${source.scopeName} did not load`);
  if (themedRegistry !== reg) {
    themedRegistry = reg;
    reg.setTheme(currentTmTheme() as vsctm.IRawTheme);
    setTextMateRules((theme) => rulesFor(reg, theme));
  }
  attached.set(language, grammar);
  setProvider(language, grammar);
}

/** A mod's language configuration file (comments, brackets, indentation) → Monaco's. */
export function toLanguageConfiguration(raw: any): monaco.languages.LanguageConfiguration {
  const re = (v: any): RegExp | undefined => {
    if (!v) return undefined;
    try {
      return typeof v === "string" ? new RegExp(v) : new RegExp(v.pattern, v.flags);
    } catch {
      return undefined;
    }
  };
  const pairs = (list: any[] | undefined) =>
    list?.map((p) => (Array.isArray(p) ? { open: p[0], close: p[1] } : { open: p.open, close: p.close, notIn: p.notIn }));
  const indentAction = (a: string) =>
    ({ none: monaco.languages.IndentAction.None, indent: monaco.languages.IndentAction.Indent, indentOutdent: monaco.languages.IndentAction.IndentOutdent, outdent: monaco.languages.IndentAction.Outdent } as Record<string, monaco.languages.IndentAction>)[a] ??
    monaco.languages.IndentAction.None;
  const conf: monaco.languages.LanguageConfiguration = {
    comments: raw.comments,
    brackets: raw.brackets,
    autoClosingPairs: pairs(raw.autoClosingPairs) as any,
    surroundingPairs: pairs(raw.surroundingPairs) as any,
    wordPattern: re(raw.wordPattern),
  };
  if (raw.indentationRules) {
    const r = raw.indentationRules;
    conf.indentationRules = {
      increaseIndentPattern: re(r.increaseIndentPattern) ?? /^$/,
      decreaseIndentPattern: re(r.decreaseIndentPattern) ?? /^$/,
      indentNextLinePattern: re(r.indentNextLinePattern),
      unIndentedLinePattern: re(r.unIndentedLinePattern),
    };
  }
  if (raw.folding?.markers) {
    conf.folding = { offSide: raw.folding.offSide, markers: { start: re(raw.folding.markers.start) ?? /^$/, end: re(raw.folding.markers.end) ?? /^$/ } };
  }
  if (Array.isArray(raw.onEnterRules)) {
    conf.onEnterRules = raw.onEnterRules
      .map((r: any) => ({
        beforeText: re(r.beforeText),
        afterText: re(r.afterText),
        previousLineText: re(r.previousLineText),
        action: { indentAction: indentAction(r.action?.indent), appendText: r.action?.appendText, removeText: r.action?.removeText },
      }))
      .filter((r: any) => r.beforeText);
  }
  return conf;
}
