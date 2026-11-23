import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";


const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(packageRoot, "web", "typed_bypass_switch.js");
let source = readFileSync(sourcePath, "utf8");

class MockNode {
  constructor(title = "Node") {
    this.title = title;
    this.type = this.constructor.name;
    this.id = null;
    this.graph = null;
    this.inputs = [];
    this.outputs = [];
    this.widgets = [];
    this.properties = {};
    this.flags = {};
    this.mode = 0;
    this.pos = [0, 0];
    this.size = [220, 80];
  }

  addInput(name, type) {
    const input = { name, type, link: null };
    this.inputs.push(input);
    return input;
  }

  removeInput(index) {
    this.inputs.splice(index, 1);
  }

  addOutput(name, type) {
    const output = { name, type, links: [] };
    this.outputs.push(output);
    return output;
  }

  computeSize() {
    return [300, 54 + this.inputs.length * 20 + this.outputs.length * 20];
  }

  setSize(size) {
    this.size = [...size];
  }
}


class MockGraph {
  constructor() {
    this.nodes = [];
    this.links = new Map();
    this.nextNodeId = 1;
    this.nextLinkId = 1;
  }

  add(node) {
    if (node.id == null) {
      node.id = this.nextNodeId;
      this.nextNodeId += 1;
    }
    node.graph = this;
    this.nodes.push(node);
    return node;
  }

  getNodeById(id) {
    return this.nodes.find((node) => String(node.id) === String(id)) || null;
  }

  setDirtyCanvas() {}
}


globalThis.window = globalThis;
globalThis.alertCalls = 0;
globalThis.showAstralAlert = async () => {
  globalThis.alertCalls += 1;
};
globalThis.alert = () => {
  throw new Error("Native browser alert must not be used");
};
globalThis.LiteGraph = {
  INPUT: 1,
  NODE_SLOT_HEIGHT: 20,
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
source += `
globalThis.__astralTest = globalThis.__astralTypedBypassSwitch;
`;
vm.runInThisContext(source, { filename: sourcePath });

const {
  NODE_TYPE,
  CONTROL_WIDGET,
  normalizeType,
  typesCompatible,
  formatPortLabel,
  inputToggleLabel,
  parseEnabledSlots,
  toggleRect,
  stabilizeTypedSwitch,
  toggleInput,
} = globalThis.__astralTest;

assert.equal(NODE_TYPE, "Typed Bypass Switch");
assert.equal(CONTROL_WIDGET, "enabled_slots");
assert.equal(normalizeType(["MODEL", "CLIP"]), "MODEL,CLIP");
assert.equal(typesCompatible("STRING", "STRING"), true);
assert.equal(typesCompatible("*", "IMAGE"), true);
assert.equal(typesCompatible("STRING", "IMAGE"), false);
assert.equal(formatPortLabel("STRING", 0), "STRING1");
assert.equal(formatPortLabel("image", 2), "IMAGE3");
assert.equal(formatPortLabel("*"), "ANY");
assert.equal(inputToggleLabel({ label: "STRING1" }, 0), "Enable STRING1");
assert.equal(inputToggleLabel({ localized_name: "IMAGE2" }, 1), "Enable IMAGE2");
assert.equal(inputToggleLabel({ name: "input_3" }, 2), "Enable input_3");
assert.equal(inputToggleLabel(null, 4), "Enable INPUT5");
assert.deepEqual(Array.from(parseEnabledSlots("2,1,2,0,x")), [2, 1]);

assert.equal(typeof app.extension?.beforeRegisterNodeDef, "function");
assert.equal(typeof app.extension?.nodeCreated, "function");
app.extension.beforeRegisterNodeDef(MockNode, { name: NODE_TYPE });

function makeSwitchNode(graph) {
  const node = new MockNode("Typed Bypass Switch");
  node.type = NODE_TYPE;
  node.inputs.push({
    name: CONTROL_WIDGET,
    type: "STRING",
    link: null,
    widget: { name: CONTROL_WIDGET },
  });
  node.widgets.push({
    name: CONTROL_WIDGET,
    type: "string",
    value: "",
    options: {},
  });
  graph.add(node);
  node.constructor.comfyClass = NODE_TYPE;
  app.extension.nodeCreated(node);
  clearTimeout(node._astralStabilizeTimer);
  node._astralStabilizeTimer = null;
  stabilizeTypedSwitch(node);
  return node;
}

function addSource(graph, type, mode = 0) {
  const source = graph.add(new MockNode(`${type} Source`));
  source.mode = mode;
  source.outputs.push({ name: type, type, links: [] });
  return source;
}

function attachSource(node, slot, source, linkId) {
  const output = source.outputs[0];
  const link = {
    id: linkId,
    origin_id: source.id,
    origin_slot: 0,
    target_id: node.id,
    target_slot: slot,
    type: output.type,
    resolve: () => ({
      output,
      outputNode: source,
      inputNode: node,
      input: node.inputs[slot],
    }),
  };
  node.graph.links.set(linkId, link);
  node.inputs[slot].link = linkId;
}

const graph = new MockGraph();
const node = makeSwitchNode(graph);
assert.equal(node.inputs.length, 1);
assert.equal(node.outputs.length, 1);
assert.equal(node.inputs[0].name, "input_1");
assert.equal(node.inputs[0].label, "ANY1");
assert.equal(node.outputs[0].label, "ANY");
assert.equal(node.widgets[0].hidden, true);

const stringOne = addSource(graph, "STRING", 2);
const stringTwo = addSource(graph, "STRING", 0);
node.addInput("input_2", "*");
attachSource(node, 0, stringOne, 100);
attachSource(node, 1, stringTwo, 101);

let state = stabilizeTypedSwitch(node);
assert.equal(state.lockedType, "STRING");
assert.deepEqual(Array.from(state.enabledSlots), [1]);
assert.deepEqual(
  Array.from(node.inputs, (input) => input.label),
  ["STRING1", "STRING2", "STRING3"],
);
assert.deepEqual(
  Array.from(node.inputs, (input) => input.name),
  ["input_1", "input_2", "input_3"],
);
assert.equal(node.inputs[2].link, null);
assert.equal(node.outputs[0].label, "STRING");
assert.equal(node.widgets[0].value, "1");
assert.equal(stringOne.mode, 0);
assert.equal(stringTwo.mode, 4);
const firstToggle = toggleRect(node, 0);
assert.ok(
  node.size[0] - (firstToggle.x + firstToggle.width) >= 80,
  "Input toggles must leave the standard output label lane unobstructed",
);

globalThis.alertCalls = 0;
assert.equal(
  node.onConnectInput(2, "IMAGE", { type: "IMAGE" }, null, 0),
  false,
);
assert.equal(globalThis.alertCalls, 1);
assert.equal(
  node.onConnectInput(2, "STRING", { type: "STRING" }, null, 0),
  true,
);

const firstKey = `${stringOne.id}:0`;
const secondKey = `${stringTwo.id}:0`;
node.properties.enabledSources = [firstKey];
node.properties.enabledConfigured = true;
toggleInput(node, 1);
assert.deepEqual(Array.from(node.properties.enabledSources), [firstKey, secondKey]);
assert.equal(stringOne.mode, 0);
assert.equal(stringTwo.mode, 4);
assert.equal(node.widgets[0].value, "1,2");

toggleInput(node, 0);
assert.deepEqual(Array.from(node.properties.enabledSources), [secondKey]);
assert.equal(stringOne.mode, 4);
assert.equal(stringTwo.mode, 0);
assert.equal(node.widgets[0].value, "2");

node.properties.enabledSources = [secondKey, firstKey];
stabilizeTypedSwitch(node);
assert.deepEqual(Array.from(node.properties.enabledSources), [secondKey, firstKey]);
assert.equal(node.widgets[0].value, "1,2");
assert.equal(stringOne.mode, 0);
assert.equal(stringTwo.mode, 4);

toggleInput(node, 0);
assert.deepEqual(Array.from(node.properties.enabledSources), [secondKey]);
assert.equal(stringOne.mode, 4);
assert.equal(stringTwo.mode, 0);

toggleInput(node, 1);
assert.deepEqual(Array.from(node.properties.enabledSources), []);
assert.equal(stringOne.mode, 4);
assert.equal(stringTwo.mode, 4);
assert.equal(node.widgets[0].value, "");

assert.match(source, /enabled_slots/);
assert.match(source, /enabledSources/);
assert.match(source, /MODE_BYPASS = 4/);
assert.match(source, /formatPortLabel\(lockedType, index\)/);
assert.match(source, /output\.label = formatPortLabel\(lockedType\)/);
assert.match(source, /inputToggleLabel\(entry\.input, entry\.slot\)/);
assert.match(source, /stateText = effective \? "yes" : enabled \? "alt" : "no"/);

console.log("Typed bypass switch frontend checks passed.");
