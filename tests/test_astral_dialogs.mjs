import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";


class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.dataset = {};
    this.listeners = new Map();
    this.className = "";
    this.textContent = "";
    this.id = "";
    this.open = false;
    this.showCalls = 0;
    this.showModalCalls = 0;
    this.closeCalls = 0;
  }

  append(...children) {
    for (const child of children) {
      if (!child) continue;
      child.parent = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      listeners.filter((candidate) => candidate !== listener),
    );
  }

  dispatch(type, event = {}) {
    const payload = {
      target: this,
      preventDefault() {},
      stopPropagation() {},
      ...event,
    };
    for (const listener of this.listeners.get(type) || []) listener(payload);
  }

  contains(candidate) {
    if (!candidate) return false;
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  focus() {}

  select() {}

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  show() {
    this.showCalls += 1;
    this.open = true;
  }

  showModal() {
    this.showModalCalls += 1;
    this.open = true;
  }

  close() {
    this.closeCalls += 1;
    this.open = false;
    this.dispatch("close");
  }
}


class FakeDocument {
  constructor() {
    this.head = new FakeElement("head");
    this.body = new FakeElement("body");
    this.listeners = new Map();
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  querySelector(selector) {
    if (selector === "link[data-assets-astral-dialog-styles]") {
      return this.head.children.find(
        (child) =>
          child.tagName === "LINK" &&
          child.dataset.assetsAstralDialogStyles === "true",
      ) || null;
    }
    return null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      listeners.filter((candidate) => candidate !== listener),
    );
  }

  dispatch(type, event = {}) {
    const payload = {
      target: this.body,
      preventDefault() {},
      stopPropagation() {},
      ...event,
    };
    for (const listener of this.listeners.get(type) || []) listener(payload);
  }
}


function findAll(root, predicate) {
  const matches = [];
  if (predicate(root)) matches.push(root);
  for (const child of root.children) matches.push(...findAll(child, predicate));
  return matches;
}


function buttonByText(dialog, label) {
  const button = findAll(
    dialog,
    (element) => element.tagName === "BUTTON" && element.textContent === label,
  )[0];
  assert.ok(button, `Missing button: ${label}`);
  return button;
}


function click(element) {
  element.dispatch("click", { target: element });
}


const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(packageRoot, "web", "astral_dialogs.js");
const fakeDocument = new FakeDocument();
let nativeDialogCalls = 0;
const rejectNativeDialog = () => {
  nativeDialogCalls += 1;
  throw new Error("Native browser dialog must not be used");
};

globalThis.window = globalThis;
globalThis.document = fakeDocument;
globalThis.alert = rejectNativeDialog;
globalThis.confirm = rejectNativeDialog;
globalThis.prompt = rejectNativeDialog;

const {
  showAstralAlert,
  showAstralConfirm,
  showAstralPrompt,
  showAstralSelect,
  showAstralShortcutRecorder,
} = await import(pathToFileURL(sourcePath).href);

let promptResult = showAstralPrompt({
  title: "重命名会话",
  initialValue: "旧名称",
});
let dialog = fakeDocument.body.children[0];
assert.equal(dialog.tagName, "DIV");
assert.equal(dialog.attributes.role, "dialog");
assert.equal(dialog.attributes["data-assets-astral-dialog"], "true");
assert.equal(dialog.showCalls, 0);
assert.equal(dialog.showModalCalls, 0);
assert.match(dialog.className, /astral-am-dialog/);
const promptInput = findAll(dialog, (element) => element.tagName === "INPUT")[0];
assert.ok(promptInput);
promptInput.value = "新名称";
click(buttonByText(dialog, "确定"));
assert.equal(await promptResult, "新名称");
assert.equal(fakeDocument.body.children.length, 0);

let batchPromptResult = showAstralPrompt({
  title: "批量新增标签",
  multiline: true,
});
dialog = fakeDocument.body.children[0];
const promptTextarea = findAll(
  dialog,
  (element) => element.tagName === "TEXTAREA",
)[0];
assert.ok(promptTextarea);
promptTextarea.value = "标签一\n标签二";
promptTextarea.dispatch("keydown", { key: "Enter", isComposing: false });
assert.equal(fakeDocument.body.children.length, 1);
click(buttonByText(dialog, "确定"));
assert.equal(await batchPromptResult, "标签一\n标签二");

let selectResult = showAstralSelect({
  title: "移动标签分类",
  label: "目标分类",
  initialValue: "scene-hair",
  options: [
    { value: "character", label: "人物 / 未分类" },
    { value: "scene-hair", label: "场景 / 发型" },
  ],
});
dialog = fakeDocument.body.children[0];
assert.match(dialog.className, /is-select/);
const dialogSelect = findAll(
  dialog,
  (element) => element.tagName === "SELECT",
)[0];
assert.ok(dialogSelect);
assert.equal(dialogSelect.value, "scene-hair");
dialogSelect.value = "character";
click(buttonByText(dialog, "确定"));
assert.equal(await selectResult, "character");

const defaultShortcut = {
  code: "KeyM",
  ctrl: true,
  alt: true,
  shift: false,
  meta: false,
};
const capturedShortcut = {
  code: "KeyK",
  ctrl: true,
  alt: true,
  shift: false,
  meta: false,
};
let shortcutResult = showAstralShortcutRecorder({
  initialShortcut: defaultShortcut,
  defaultShortcut,
  shortcutFromEvent: () => capturedShortcut,
  validateShortcut: () => "",
  formatShortcut: (shortcut) =>
    Object.entries(shortcut)
      .filter(([key, value]) => key !== "code" && value)
      .map(([key]) => key[0].toUpperCase() + key.slice(1))
      .concat(shortcut.code.replace(/^Key/, ""))
      .join(" + "),
});
dialog = fakeDocument.body.children[0];
assert.match(dialog.className, /is-shortcut/);
const shortcutRecorder = findAll(
  dialog,
  (element) =>
    element.tagName === "DIV" &&
    element.className.includes("astral-am-shortcut-recorder"),
)[0];
assert.ok(shortcutRecorder);
const shortcutPreview = findAll(
  dialog,
  (element) => element.className === "astral-am-shortcut-preview",
)[0];
assert.ok(shortcutPreview);
assert.equal(shortcutPreview.textContent, "Ctrl + Alt + M");
shortcutRecorder.dispatch("keydown", {
  target: shortcutRecorder,
  key: "k",
  code: "KeyK",
  isComposing: false,
});
assert.equal(shortcutPreview.textContent, "Ctrl + Alt + K");
const saveShortcutButton = buttonByText(dialog, "保存");
assert.equal(saveShortcutButton.disabled, false);
click(saveShortcutButton);
assert.deepEqual(await shortcutResult, capturedShortcut);
assert.equal(fakeDocument.body.children.length, 0);

shortcutResult = showAstralShortcutRecorder({
  initialShortcut: defaultShortcut,
  defaultShortcut,
  validateShortcut: () => "",
});
dialog = fakeDocument.body.children[0];
click(buttonByText(dialog, "取消"));
assert.equal(await shortcutResult, null);

let confirmResult = showAstralConfirm({
  title: "删除会话",
  message: "这也是一条测试确认信息。",
});
dialog = fakeDocument.body.children[0];
assert.equal(dialog.tagName, "DIV");
assert.equal(dialog.attributes.role, "alertdialog");
assert.equal(dialog.showCalls, 0);
assert.equal(dialog.showModalCalls, 0);
click(buttonByText(dialog, "确认"));
assert.equal(await confirmResult, true);

confirmResult = showAstralConfirm({ title: "删除会话" });
dialog = fakeDocument.body.children[0];
click(buttonByText(dialog, "取消"));
assert.equal(await confirmResult, false);

const alertResult = showAstralAlert({
  title: "操作失败",
  message: "测试提示信息。",
});
dialog = fakeDocument.body.children[0];
click(buttonByText(dialog, "知道了"));
assert.equal(await alertResult, true);

promptResult = showAstralPrompt({ title: "点击外部关闭" });
dialog = fakeDocument.body.children[0];
const outside = new FakeElement("div");
fakeDocument.dispatch("pointerdown", { target: outside });
assert.equal(await promptResult, null);

assert.equal(nativeDialogCalls, 0);
assert.equal(fakeDocument.head.children.length, 1);
console.log("Astral custom dialog DOM checks passed.");
