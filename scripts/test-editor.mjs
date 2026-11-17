// Exercise the actual EditorService methods without constructing Monaco's browser UI.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { addLineBlame } from "../mods/aicode.git/blame.js";

const source = readFileSync(new URL("../src/core/editor.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("editor.ts", source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "EditorService");
const compiled = ts.transpile(declaration.getText(parsed).replace(/^export /, ""), { target: ts.ScriptTarget.ES2022 });

class Model {
  version = 1;
  reads = 0;
  constructor(text, language = "plaintext") { this.text = text; this.language = language; this.eol = text.includes("\r\n") ? "\r\n" : "\n"; }
  getValue() { this.reads++; return this.text; }
  getValueLength() { return this.text.length; }
  getVersionId() { return this.version; }
  getLanguageId() { return this.language; }
  getEOL() { return this.eol; }
  setValue(text) { this.text = text; this.version++; }
  setEOL(eol) { this.eol = eol === 1 ? "\r\n" : "\n"; this.setValue(this.text.replace(/\r?\n/g, this.eol)); }
  dispose() { this.disposed = true; }
}

const event = () => ({ fire() {} });
function harness(text = "original\n", { invoke = async () => {}, saveDialog = async () => "/repo/new.txt" } = {}) {
  const commands = new Map();
  const dependencies = {
    invoke, saveDialog, notify() {}, nextId: 1,
    basename: (path) => path.split("/").at(-1), dirname: () => "/repo",
    detectLanguage: () => "plaintext",
    commands: { register: (id, fn) => commands.set(id, fn), bind() {} },
    monaco: {
      Uri: { file: (path) => path, parse: (path) => path },
      editor: { createModel: (value, language) => new Model(value, language), getModel: () => null, EndOfLineSequence: { LF: 0, CRLF: 1 } },
    },
  };
  const EditorService = vm.runInNewContext(`${compiled}\nEditorService`, dependencies);
  const service = Object.create(EditorService.prototype);
  const doc = { kind: "text", id: "doc-1", path: "/repo/file.txt", title: "file.txt", model: new Model(text), savedText: text, bom: false, lossy: false, preview: false };
  Object.assign(service, {
    docs: [doc], active: doc, dirtyStates: new WeakMap(),
    editor: { saveViewState: () => null, setModel() {} },
    onDidSave: event(), onDidChangeDocs: event(),
    renderTabs() {}, show() {}, activate(next) { this.active = next; },
  });
  return { service, doc, commands };
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

test("editing and manually restoring saved text clears dirty state, including equal-length replacements", () => {
  const { service, doc } = harness("<title>AICode</title>\n");
  assert.equal(service.info(doc).dirty, false);
  doc.model.setValue("<title>AIEdit</title>\n");
  assert.equal(service.info(doc).dirty, true);
  doc.model.setValue("<title>AICode</title>\n");
  assert.equal(service.info(doc).dirty, false);
  doc.model.setValue("<title>AICode!</title>\n");
  assert.equal(service.isDirty(doc), true);
  doc.model.setValue(doc.savedText);
  assert.equal(service.isDirty(doc), false);
  const reads = doc.model.reads;
  service.info(doc);
  service.menuContext();
  assert.equal(doc.model.reads, reads, "repeated status queries reuse the comparison for this model version");
});

test("line endings and invisible whitespace remain real changes until restored", () => {
  const { service, doc } = harness("one\r\ntwo\r\n");
  for (const changed of ["one\ntwo\n", "one \r\ntwo\r\n", "one\r\ntwo"]) {
    doc.model.setValue(changed);
    assert.equal(service.isDirty(doc), true);
    doc.model.setValue(doc.savedText);
    assert.equal(service.isDirty(doc), false);
  }
});

test("untitled documents become clean again after deleting all their text", () => {
  const { service } = harness();
  const doc = service.newUntitled("pasted text");
  assert.equal(service.isDirty(doc), true);
  doc.model.setValue("");
  assert.equal(service.isDirty(doc), false);
});

test("save uses the text written to disk as baseline, preserving edits made during the write", async () => {
  const write = deferred();
  let payload;
  const { service, doc } = harness("old", { invoke: async (command, args) => { assert.equal(command, "fs_write_text"); payload = args; await write.promise; } });
  doc.model.setValue("saved");
  assert.equal(service.isDirty(doc), true);
  const saving = service.save(doc);
  doc.model.setValue("edited while saving");
  write.resolve();
  assert.equal(await saving, true);
  assert.equal(payload.text, "saved");
  assert.equal(service.isDirty(doc), true);
  doc.model.setValue("saved");
  assert.equal(service.isDirty(doc), false);
  await service.save(doc);
  assert.equal(service.isDirty(doc), false);
  doc.model.setValue("old");
  assert.equal(service.isDirty(doc), true, "saving advances the baseline");
});

test("a failed save keeps the previous baseline", async () => {
  const { service, doc } = harness("old", { invoke: async () => { throw new Error("write failed"); } });
  doc.model.setValue("new");
  assert.equal(await service.save(doc), false);
  assert.equal(service.isDirty(doc), true);
  doc.model.setValue("old");
  assert.equal(service.isDirty(doc), false);
});

test("save as preserves edits made during the write, and compares against the actual saved text", async () => {
  const write = deferred(), started = deferred();
  const { service, doc } = harness("initial", { invoke: async (command) => {
    if (command === "home_dir") return "/home";
    assert.equal(command, "fs_write_text"); started.resolve(); await write.promise;
  } });
  doc.path = null;
  doc.savedText = "";
  const saving = service.saveAs(doc);
  await started.promise;
  doc.model.setValue("typed while saving");
  write.resolve();
  assert.equal(await saving, true);
  assert.equal(doc.model.getValue(), "typed while saving");
  assert.equal(service.isDirty(doc), true);
  doc.model.setValue("initial");
  assert.equal(service.isDirty(doc), false);
});

test("renaming a file preserves its saved baseline across the replacement model", () => {
  const { service, doc } = harness("original");
  doc.model.setValue("modified");
  service.movePath("/repo/file.txt", "/repo/renamed.txt");
  assert.equal(doc.path, "/repo/renamed.txt");
  assert.equal(service.isDirty(doc), true);
  doc.model.setValue("original");
  assert.equal(service.isDirty(doc), false);
});

test("Revert File refreshes the comparison baseline from disk", async () => {
  const { service, doc, commands } = harness("original", { invoke: async () => ({ text: "disk changed\n" }) });
  doc.model.setValue("modified");
  service.registerCommands();
  await commands.get("file.revert")();
  assert.equal(service.isDirty(doc), false);
  doc.model.setValue("original");
  assert.equal(service.isDirty(doc), true);
  doc.model.setValue("disk changed\n");
  assert.equal(service.isDirty(doc), false);
});

test("restoring a session compares its buffer with the file baseline rather than trusting the old dirty flag", async () => {
  const { service, doc } = harness("saved text");
  service.openFile = async () => doc;
  await service.restore({ docs: [{ path: doc.path, dirty: true, text: "saved text" }], active: 0 });
  assert.equal(service.isDirty(doc), false);
  await service.restore({ docs: [{ path: doc.path, dirty: true, text: "unsaved text" }], active: 0 });
  assert.equal(service.isDirty(doc), true);
  doc.model.setValue("saved text");
  assert.equal(service.isDirty(doc), false);
});

test("real editor metadata allows Git line authorship to appear; custom tabs remain distinct", async () => {
  const { service, doc } = harness("first\nsecond\n");
  assert.equal(service.activeInfo().editorType, "default");
  assert.equal(service.info({ kind: "custom", id: "preview", title: "Preview", spec: {} }).editorType, "custom");
  const item = { update(patch) { Object.assign(this, patch); }, dispose() {} };
  let calls = 0;
  const ctx = {
    subscriptions: [], statusBar: { add: () => item },
    editor: {
      active: () => service.activeInfo(), model: (id) => service.modelOf(id),
      monacoEditor: () => ({ getModel: () => doc.model, getPosition: () => ({ lineNumber: 1 }), onDidChangeCursorPosition: () => ({ dispose() {} }) }),
      onDidChangeActive() {}, onDidChangeContent() {},
    },
  };
  const shown = deferred();
  const originalUpdate = item.update;
  item.update = function (patch) { originalUpdate.call(this, patch); if (patch.text) shown.resolve(); };
  const blame = addLineBlame(ctx, { run: async () => {
    calls++;
    return { code: 0, stdout: `${"a".repeat(40)} 1 1 1\nauthor Test Author\nauthor-time 1700000000\nsummary Original line\nfilename file.txt\n\tfirst\n` };
  } }, { delay: 0 });
  try {
    blame.setRepository("/repo");
    await Promise.race([shown.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("Line authorship did not appear")), 1000).unref())]);
    assert.equal(calls, 1);
    assert.match(item.text, /^Test Author, /);
    assert.match(item.tooltip, /Original line/);
  } finally { ctx.subscriptions.forEach((sub) => sub.dispose()); }
});
