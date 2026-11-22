import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";


const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(packageRoot, "web", "string_mode_selector.js");
let source = readFileSync(sourcePath, "utf8");

class MockNode {
  constructor() {
    this.title = "String Mode Selector";
    this.type = "String Mode Selector";
    this.inputs = [];
    this.outputs = [];
    this.widgets = [];
    this.properties = {};
    this.flags = {};
    this.size = [300, 80];
    this.graph = {
      setDirtyCanvas() {},
    };
  }

  addOutput(name, type) {
    const output = { name, type, links: [] };
    this.outputs.push(output);
    return output;
  }

  addWidget(type, name, value, callback, options = {}) {
    const widget = {
      type,
      name,
      value,
      callback,
      options,
      serialize: true,
    };
    this.widgets.push(widget);
    return widget;
  }

  removeWidget(index) {
    this.widgets.splice(index, 1);
  }

  removeInput(index) {
    this.inputs.splice(index, 1);
  }

  computeSize() {
    return [360, 58];
  }

  get innerFontStyle() {
    return "normal 12px Inter";
  }

  setSize(size) {
    this.size = [...size];
  }
}


globalThis.window = globalThis;
globalThis.LiteGraph = {
  WIDGET_TEXT_COLOR: "#ddd",
  WIDGET_SECONDARY_TEXT_COLOR: "#999",
};
globalThis.app = {
  registerExtension(definition) {
    this.extension = definition;
  },
};

source = source.replace(/^import\s+.*;\s*$/gm, "");
source = source
  .replace(/^export\s+(?=(?:const|let|var|function|class)\b)/gm, "")
  .replace(/^export\s+\{[^}]*\};\s*$/gm, "");
vm.runInThisContext(source, { filename: sourcePath });

const api = globalThis.__astralStringModeSelector;
assert.ok(api);
assert.equal(api.NODE_TYPE, "String Mode Selector");
assert.equal(api.CONTROL_WIDGET, "selected_string");
assert.equal(api.MAX_PROMPT_COUNT, 20);
assert.equal(api.DEFAULT_PROMPT_COUNT, 1);
assert.match(source, /node\.addWidget\(\s*"toggle"/);
assert.match(source, /on: "yes", off: "no"/);
assert.doesNotMatch(source, /widget\.draw\s*=\s*drawModeToggle/);
assert.doesNotMatch(source, /ctx\.arc\(/);
assert.doesNotMatch(source, /node\.color = "#414141"/);

assert.equal(api.clampPromptCount("0"), 1);
assert.equal(api.clampPromptCount("1"), 1);
assert.equal(api.clampPromptCount("12"), 12);
assert.equal(api.clampPromptCount("20"), 20);
assert.equal(api.clampPromptCount("21"), 20);
assert.equal(api.clampPromptCount("not a number"), 1);
assert.deepEqual(api.modePropertyNames(2), {
  title: "modeTitle_2",
  prompt: "modePrompt_2",
});
assert.equal(api.modeIndexFromProperty("modeTitle_20"), 20);
assert.equal(api.modeIndexFromProperty("modePrompt_1"), 1);
assert.equal(api.modeIndexFromProperty("modePrompt_21"), null);

const styleElements = [];
globalThis.document = {
  getElementById(id) {
    return styleElements.find((element) => element.id === id) || null;
  },
  createElement(tag) {
    return { tag, dataset: {} };
  },
  head: {
    append(element) {
      styleElements.push(element);
    },
  },
};
assert.equal(api.installPromptEditorStyles(), true);
assert.equal(styleElements.length, 1);
assert.equal(styleElements[0].id, "astral-string-mode-prompt-editor-style");
assert.match(
  styleElements[0].textContent,
  /data-astral-string-mode-selector\]\s*\{[\s\S]*width:\s*400px !important;[\s\S]*min-width:\s*400px !important;[\s\S]*max-width:\s*400px !important;/,
);
assert.equal(
  styleElements[0].dataset.astralStyleRevision,
  "20261120-red-line-input-width",
);
assert.match(
  styleElements[0].textContent,
  /\.property\s*\{[\s\S]*display:\s*grid !important;[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) 260px !important;/,
);
assert.match(
  styleElements[0].textContent,
  /\.property_value\s*\{[\s\S]*width:\s*100% !important;[\s\S]*min-width:\s*0 !important;[\s\S]*max-width:\s*100% !important;/,
);
assert.match(
  styleElements[0].textContent,
  /\.property_value input,[\s\S]*\.property_value textarea,[\s\S]*\.property_value select\s*\{[\s\S]*width:\s*100% !important;[\s\S]*min-width:\s*0 !important;[\s\S]*field-sizing:\s*normal !important;/,
);
assert.match(
  styleElements[0].textContent,
  /\.property\[data-property="Node name for S&R"\]\s*\{\s*display:\s*none !important;/,
);
assert.match(
  styleElements[0].textContent,
  /data-property\^="modePrompt_"[^{]*\{[\s\S]*height:\s*calc\(5 \* 1\.5em \+ 8px\) !important;/,
);
assert.match(styleElements[0].textContent, /text-align:\s*left !important;/);
assert.match(
  styleElements[0].textContent,
  /height:\s*calc\(5 \* 1\.5em \+ 8px\) !important;/,
);
assert.match(styleElements[0].textContent, /overflow-y:\s*auto !important;/);
assert.match(
  styleElements[0].textContent,
  /\.dialog-footer \.btn\.delete\s*\{\s*display:\s*none !important;/,
);
assert.equal(api.installPromptEditorStyles(), true);
assert.equal(styleElements.length, 1);
delete globalThis.document;

assert.equal(typeof app.extension?.beforeRegisterNodeDef, "function");
app.extension.beforeRegisterNodeDef(MockNode, { name: api.NODE_TYPE });

const node = new MockNode();
assert.equal(node.onGetPropertyInfo("promptCount").label, "模式数量");
node.inputs.push({
  name: api.CONTROL_WIDGET,
  type: "STRING",
  link: null,
});
node.widgets.push({
  name: api.CONTROL_WIDGET,
  type: "string",
  value: "",
  options: {},
});
node.constructor.comfyClass = api.NODE_TYPE;
app.extension.nodeCreated(node);
clearTimeout(node._astralStringModeTimer);
node._astralStringModeTimer = null;
const propertyRows = [
  "Title",
  "Mode",
  "Color",
  "promptCount",
  "modeTitle_1",
  "modePrompt_1",
  "modeTitle_2",
  "modePrompt_2",
  "aux_id",
  "Node name for S&R",
  "ue_properties",
].map((property) => ({ dataset: { property }, parentNode: null }));
const propertyContent = {
  rows: propertyRows,
  insertBefore(row, reference) {
    this.rows.splice(this.rows.indexOf(row), 1);
    this.rows.splice(this.rows.indexOf(reference), 0, row);
  },
};
for (const row of propertyRows) row.parentNode = propertyContent;
const propertyPanel = {
  dataset: {},
  querySelectorAll(selector) {
    assert.equal(selector, ".property");
    return propertyContent.rows;
  },
};
node.onShowCustomPanelInfo(propertyPanel);
assert.equal(propertyPanel.dataset.astralStringModeSelector, "true");
assert.equal(
  node.onAddPropertyToPanel("Node name for S&R", propertyPanel),
  true,
);
assert.deepEqual(
  propertyContent.rows
    .filter((row) => !row.hidden)
    .map((row) => row.dataset.property),
  [
    "Title",
    "Mode",
    "Color",
    "aux_id",
    "promptCount",
    "modeTitle_1",
    "modePrompt_1",
    "modeTitle_2",
    "modePrompt_2",
    "ue_properties",
  ],
);
assert.equal(
  propertyRows.find(
    (row) => row.dataset.property === "Node name for S&R",
  ).hidden,
  true,
);

let state = api.stabilizeStringModeSelector(node);
assert.equal(state.count, 1);
assert.equal(state.activeMode, 1);
assert.equal(node.inputs.length, 0);
assert.equal(node.outputs.length, 1);
assert.equal(node.outputs[0].name, "STRING");
assert.equal(node.outputs[0].label, "STRING");
assert.equal(node.outputs[0].type, "STRING");
assert.equal(node.widgets[0].hidden, true);
let modeToggles = node.widgets.filter(
  (widget) => widget.__astralStringModeToggle,
);
assert.equal(modeToggles.length, 1);
assert.deepEqual(
  modeToggles.map((widget) => widget.label),
  ["Enable 未命名模式 1"],
);
assert.deepEqual(modeToggles.map((widget) => widget.value), [true]);
assert.ok(modeToggles.every((widget) => widget.type === "toggle"));
assert.ok(modeToggles.every((widget) => widget.options.on === "yes"));
assert.ok(modeToggles.every((widget) => widget.options.off === "no"));
assert.ok(modeToggles.every((widget) => widget.serialize === false));
assert.ok(modeToggles.every((widget) => widget.draw === undefined));
assert.deepEqual(node.computeSize(), [240, 58]);
assert.equal(node.properties.promptCount, "1");
assert.equal(node.properties.modeTitle_1, "");
assert.equal(node.properties.modePrompt_1, "");
const requestedSize = [220, 40];
node.onResize(requestedSize);
assert.equal(requestedSize[0], 240);
assert.equal(requestedSize[1], 58);

node.properties.promptCount = "3";
node.onPropertyChanged("promptCount", "3", "1");
node.properties.modeTitle_1 = "普通+风格参考模式";
node.properties.modeTitle_2 = "巨物美学模式";
node.properties.modeTitle_3 = "四视图模式";
state = api.stabilizeStringModeSelector(node);
assert.equal(state.count, 3);
modeToggles = node.widgets.filter(
  (widget) => widget.__astralStringModeToggle,
);
assert.equal(modeToggles.length, 3);
assert.deepEqual(
  modeToggles.map((widget) => widget.label),
  [
    "Enable 普通+风格参考模式",
    "Enable 巨物美学模式",
    "Enable 四视图模式",
  ],
);
assert.deepEqual(
  modeToggles.map((widget) => widget.value),
  [true, false, false],
);
const threeModeSize = [220, 40];
node.onResize(threeModeSize);
assert.equal(threeModeSize[0], 240);
assert.equal(threeModeSize[1], 106);

node.properties.modePrompt_1 = "prompt one,";
node.properties.modePrompt_2 = "prompt two,";
node.properties.modePrompt_3 = "prompt three,";
api.syncSelectedString(node);
assert.equal(node.widgets[0].value, "prompt one,");

assert.equal(api.selectMode(node, 2), true);
assert.equal(node.properties.activeMode, 2);
assert.equal(node.widgets[0].value, "prompt two,");

assert.deepEqual(
  modeToggles.map((widget) => widget.value),
  [false, true, false],
);
modeToggles[2].value = true;
modeToggles[2].callback();
assert.equal(node.properties.activeMode, 3);
assert.equal(node.widgets[0].value, "prompt three,");
assert.deepEqual(
  modeToggles.map((widget) => widget.value),
  [false, false, true],
);
assert.equal(node.widgets[0].value, "prompt three,");

api.selectMode(node, 3);
assert.equal(node.properties.activeMode, 3);
assert.equal(node.widgets[0].value, "prompt three,");

node.properties.promptCount = "20";
node.onPropertyChanged("promptCount", "20", "3");
state = api.stabilizeStringModeSelector(node);
assert.equal(state.count, 20);
assert.equal(api.getModeEntries(node).length, 20);
assert.equal(node.properties.modeTitle_20, "");
assert.equal(node.properties.modePrompt_20, "");
assert.equal(
  node.widgets.filter((widget) => widget.__astralStringModeToggle).length,
  20,
);

node.onPropertyChanged("promptCount", "99", "20");
assert.equal(node.properties.promptCount, "20");
node.onPropertyChanged("promptCount", "0", "20");
assert.equal(node.properties.promptCount, "1");
assert.equal(node.properties.activeMode, 1);
const remainingToggle = node.widgets.find(
  (widget) => widget.__astralStringModeToggle,
);
assert.equal(remainingToggle.label, "Enable 普通+风格参考模式");
assert.equal(remainingToggle.value, true);

console.log("String mode selector frontend checks passed.");
