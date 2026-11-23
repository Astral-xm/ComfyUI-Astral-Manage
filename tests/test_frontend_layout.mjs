import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(packageRoot, "web", "asset_management.js");
let source = readFileSync(sourcePath, "utf8");

source = source.replace(/^import\s+.*;\s*$/gm, "");
source += `
globalThis.__astralTest = {
  AstralHeaderWidget,
  AstralButtonWidget,
  AstralLoraRowWidget,
  AstralLoraInfoDialog,
  promptText,
  inlineEditorBounds,
  restoreCanvasCursor,
  resizeNodeToContent,
  restoredNodeSize,
};
`;

const windowListeners = new Map();
globalThis.window = {
  addEventListener(type, callback) {
    const listeners = windowListeners.get(type) || [];
    listeners.push(callback);
    windowListeners.set(type, listeners);
  },
  prompt() {
    return null;
  },
};
const promptCalls = [];
const registeredExtensions = [];
globalThis.app = {
  canvas: {
    prompt(title, value, callback, event) {
      promptCalls.push({ title, value, event });
      callback("0.75");
      return {};
    },
  },
  registerExtension(extension) {
    registeredExtensions.push(extension);
  },
};
globalThis.api = {};
globalThis.LiteGraph = {
  WIDGET_BGCOLOR: "#333",
  WIDGET_OUTLINE_COLOR: "#555",
  WIDGET_SECONDARY_TEXT_COLOR: "#aaa",
  WIDGET_TEXT_COLOR: "#ddd",
};

vm.runInThisContext(source, { filename: sourcePath });

const {
  AstralHeaderWidget,
  AstralButtonWidget,
  AstralLoraRowWidget,
  AstralLoraInfoDialog,
  promptText,
  inlineEditorBounds,
  restoreCanvasCursor,
  resizeNodeToContent,
  restoredNodeSize,
} = globalThis.__astralTest;
const header = new AstralHeaderWidget();
const button = new AstralButtonWidget("+ Add LoRA", () => {});
assert.equal(header.computeSize(440)[1], 20);
assert.equal(button.computeSize(440)[1], 20);

const promptEvent = { type: "pointerdown" };
promptText(promptEvent, "Value", 0.7, (value) => {
  promptCalls.push({ value });
});
assert.deepEqual(promptCalls, [
  {
    title: "Value",
    value: 0.7,
    event: promptEvent,
  },
  { value: "0.75" },
]);

const editorBounds = inlineEditorBounds(
  { pos: [100, 50] },
  { x: 10, y: 30, width: 120, height: 20 },
  {
    canvas: {
      getBoundingClientRect: () => ({ left: 5, top: 7 }),
    },
    ds: { scale: 2, offset: [3, 4] },
  },
);
assert.deepEqual(
  { ...editorBounds },
  { left: 231, top: 175, width: 240, height: 40, scale: 2 },
);

let pointerResetCount = 0;
let canvasDirtyCount = 0;
const restoredCanvas = {
  pointer: {
    isDown: false,
    reset() {
      pointerResetCount += 1;
    },
  },
  state: { shouldSetCursor: false },
  hoveringOver: 1,
  canvas: { style: { cursor: "crosshair" } },
  setDirty() {
    canvasDirtyCount += 1;
  },
};
restoreCanvasCursor(restoredCanvas);
assert.equal(pointerResetCount, 1);
assert.equal(restoredCanvas.state.shouldSetCursor, true);
assert.equal(restoredCanvas.hoveringOver, 0);
assert.equal(restoredCanvas.canvas.style.cursor, "default");
assert.equal(canvasDirtyCount, 1);

const heldCanvas = {
  pointer: {
    isDown: true,
    reset() {
      throw new Error("pointer reset must not run while held");
    },
  },
  state: { shouldSetCursor: false },
  hoveringOver: 1,
  canvas: { style: { cursor: "crosshair" } },
  setDirty() {
    throw new Error("held pointer should be left for ComfyUI");
  },
};
restoreCanvasCursor(heldCanvas);

const row = new AstralLoraRowWidget("lora_1", {
  on: true,
  lora: "example.safetensors",
  strength: 1,
  triggers: Array.from({ length: 7 }, (_, index) => ({
    enabled: true,
    text: `trigger ${index + 1}`,
  })),
});

assert.equal(row.value.triggers.length, 6);
assert.equal(row.computeSize(440)[1], 20 + 3 * 26);

const trigger0 = row.triggerLayout(440, 0, 0);
const trigger1 = row.triggerLayout(440, 0, 1);
const trigger2 = row.triggerLayout(440, 0, 2);
const trigger3 = row.triggerLayout(440, 0, 3);
const trigger4 = row.triggerLayout(440, 0, 4);
const trigger5 = row.triggerLayout(440, 0, 5);

assert.equal(trigger0.rowY, trigger1.rowY);
assert.equal(trigger2.rowY, trigger3.rowY);
assert.equal(trigger4.rowY, trigger5.rowY);
assert.equal(trigger0.rowY, 20);
assert.equal(trigger2.rowY, 46);
assert.equal(trigger4.rowY, 72);
assert.ok(trigger1.columnX > trigger0.columnX);
assert.ok(trigger0.fieldWidth > 0);
assert.ok(trigger1.fieldWidth > 0);

const mainLayout = row.layout(440, 0);
assert.equal("removeX" in mainLayout, false);
assert.equal(row.draw.toString().includes("layout.removeX"), false);
assert.equal(row.drawTrigger.toString().includes("layout.removeX"), true);

assert.match(source, /import\("\.\.\/\.\.\/rgthree\/common\/dialog\.js"\)/);
assert.doesNotMatch(source, /RgthreeLoraInfoDialog|dialog_info\.js/);
assert.match(source, /this\.createRow\("Recommended strength"/);
assert.match(source, /this\.createRow\("Trigger words"/);
assert.match(source, /this\.createRow\("Civitai",\s*this\.createSourceValue\("civitai",\s*true\)\)/);
assert.match(source, /this\.createRow\("Hugging Face"/);
assert.match(source, /this\.createRow\("ModelScope"/);
assert.doesNotMatch(source, /Civitai URL|Hugging Face URL|ModelScope URL/);
assert.match(source, /No reliable recommended strength found/);
assert.match(source, /No reliable trigger words found/);
assert.match(source, /this\.info\.triggersSource/);
assert.match(source, /Fetch model details/);
assert.match(source, /Exact SHA256 match/);
assert.match(source, /source\.warnings/);
assert.match(source, /appendSourceWarnings\(sourceWrap,\s*source\)/);
assert.match(source, /hashVerificationError/);
assert.match(
  source,
  /button\.addEventListener\("click",\s*\(event\)\s*=>\s*\{[\s\S]*?event\.stopPropagation\(\);[\s\S]*?void this\.fetchInfo\(\);/,
);
assert.match(source, /Fetch failed: /);
assert.match(source, /refresh=\$\{Date\.now\(\)\}/);
assert.match(source, /cache:\s*"no-store"/);
assert.match(source, /showLoraInfoDialog\(this\.value\.lora,\s*this,\s*node\)/);
assert.match(source, /showLoraInfoDialog\(widget\.value\?\.lora,\s*widget,\s*node\)/);
assert.match(source, /function isRightButtonEvent\(event\)/);
assert.match(source, /showLoraWidgetContextMenu\(node,\s*this,\s*event\)/);
assert.match(source, /showLoraWidgetContextMenu\(this,\s*widget,\s*window\.rgthree\?\.lastCanvasMouseEvent\)/);
assert.match(source, /content:\s*"ℹ️ Show Info"/);
assert.match(source, /content:\s*"⬆️ Move Up"/);
assert.match(source, /content:\s*"⬇️ Move Down"/);
assert.match(source, /content:\s*"🗑️ Remove"/);
assert.doesNotMatch(source, /content:\s*"Add Trigger Word"/);
assert.doesNotMatch(source, /content:\s*"Remove LoRA Row"/);
assert.match(source, /function openTriggerInlineEditor\(/);
assert.match(source, /function closeTriggerInlineEditor\(/);
assert.match(source, /function restoreCanvasCursor\(/);
assert.doesNotMatch(source, /function isAstralNodeUnderPointer\(/);
assert.doesNotMatch(source, /function applyAstralNodeCursor\(/);
assert.doesNotMatch(source, /function installAstralCursorOverride\(/);
assert.match(
  source,
  /closeTriggerInlineEditor\([^)]*\)[\s\S]*?editor\.input\.remove\(\);[\s\S]*?restoreCanvasCursor\(\);/, 
);
assert.match(
  source,
  /addTrigger\(node, event\)[\s\S]*?openTriggerInlineEditor\(/,
);
assert.match(
  source,
  /editTrigger\(node, event, index\)[\s\S]*?openTriggerInlineEditor\(/,
);
assert.match(source, /input\.focus\(\{ preventScroll: true \}\)/);
assert.match(
  source,
  /input\.setSelectionRange\(input\.value\.length, input\.value\.length\)/,
);
assert.match(source, /input\.addEventListener\("blur"/);

const preservedSizeNode = {
  size: [390, 266],
  computeSize: () => [390, 184],
  setSize(size) {
    this.size = size;
  },
  graph: { setDirtyCanvas() {} },
  setDirtyCanvas() {},
};
resizeNodeToContent(preservedSizeNode);
assert.deepEqual(preservedSizeNode.size, [390, 266]);

assert.deepEqual(
  restoredNodeSize(
    { size: [440, 240] },
    { size: [390, 200] },
    [440, 280],
  ),
  [390, 200],
);

const loraRowSource = source.slice(
  source.indexOf("class AstralLoraRowWidget"),
  source.indexOf("function findLoraWidgetAt"),
);
assert.doesNotMatch(loraRowSource, /promptText\([^;]*Trigger word/);
assert.match(loraRowSource, /promptText\(event, "Value", this\.value\.strength/);

const infoDialog = Object.create(AstralLoraInfoDialog.prototype);
infoDialog.widget = {
  value: {
    strength: 0.73,
    strengthTwo: 0.42,
    triggers: [],
  },
};
infoDialog.node = {
  computeSize: () => [440, 100],
  setSize() {},
  graph: { setDirtyCanvas() {} },
  setDirtyCanvas() {},
};
infoDialog.info = {
  recommendedStrength: {
    text: "0.8 - 1.2",
    value: 1,
    source: "Hugging Face 模型卡",
  },
  triggers: ["one", "two", "three", "four", "five", "six", "ignored"],
  triggersSource: "Hugging Face 模型卡",
};
infoDialog.applyToWidget();

assert.equal(infoDialog.widget.value.strength, 0.73);
assert.equal(infoDialog.widget.value.strengthTwo, 0.42);
assert.deepEqual(
  infoDialog.widget.value.triggers.map((trigger) => trigger.text),
  ["one", "two", "three", "four", "five", "six"],
);

const cssPath = path.join(packageRoot, "web", "asset_management.css");
const css = readFileSync(cssPath, "utf8");
assert.match(css, /\.astral-info-fetch\s*\{[\s\S]*?display:\s*flex/);
assert.match(css, /\.astral-info-status\.is-error/);
assert.match(css, /\.astral-info-status\.is-warning/);
assert.match(css, /\.astral-info-source-error/);
assert.match(
  css,
  /\.astral-lora-trigger-editor\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*10000;/,
);
assert.match(
  css,
  /\.astral-lora-trigger-editor\s*\{[\s\S]*?box-sizing:\s*border-box;/,
);
assert.match(
  css,
  /\.astral-lora-trigger-editor\s*\{[\s\S]*?cursor:\s*text;/,
);

console.log("Frontend layout checks passed.");
