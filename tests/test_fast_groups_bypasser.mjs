import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourcePath = path.join(
  packageRoot,
  "web",
  "fast_groups_bypasser.js",
);
let source = readFileSync(sourcePath, "utf8");

source = source.replace(/^import\s+.*;\s*$/gm, "");
source = source
  .replace(/^export\s+(?=(?:const|let|var|function|class)\b)/gm, "")
  .replace(/^export\s+\{[^}]*\};\s*$/gm, "");
source += `
globalThis.__astralTest = globalThis.__astralFastGroupsBypasser;
`;

const timers = new Map();
let nextTimerId = 1;
globalThis.window = {
  setTimeout(callback, delay) {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, { callback, delay });
    return id;
  },
  clearTimeout(id) {
    timers.delete(id);
  },
};
globalThis.document = {
  createElement() {
    return {};
  },
};

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
    this.pos = [0, 0];
    this.size = [140, 60];
    this.mode = 0;
  }

  addOutput(name, type) {
    const output = { name, type, links: [] };
    this.outputs.push(output);
    return output;
  }

  addCustomWidget(widget) {
    this.widgets.push(widget);
    return widget;
  }

  removeWidget(widgetOrIndex) {
    const index = typeof widgetOrIndex === "number"
      ? widgetOrIndex
      : this.widgets.indexOf(widgetOrIndex);
    if (index >= 0) this.widgets.splice(index, 1);
  }

  computeSize(out) {
    const width = Math.max(40, Number(out?.[0]) || 140);
    let height = 48 + this.outputs.length * 20;
    for (const widget of this.widgets) {
      height += Number(widget.computeSize?.(width)?.[1]) || 20;
    }
    return [width, height];
  }

  setSize(size) {
    this.size = [...size];
  }

  setDirtyCanvas() {}

  onAdded() {}
  onRemoved() {}
}

class MockGraph {
  constructor() {
    this.id = "root";
    this._nodes = [];
    this._groups = [];
    this.subgraphs = new Map();
    this._nextNodeId = 1;
    this.changeCalls = 0;
  }

  add(node) {
    if (node.id == null) {
      node.id = this._nextNodeId;
      this._nextNodeId += 1;
    }
    node.graph = this;
    this._nodes.push(node);
    node.onAdded?.(this);
    return node;
  }

  change() {
    this.changeCalls += 1;
  }

  setDirtyCanvas() {}
}

globalThis.LiteGraph = {
  ALWAYS: 0,
  NEVER: 2,
  NODE_WIDGET_HEIGHT: 20,
  WIDGET_BGCOLOR: "#333333",
  WIDGET_OUTLINE_COLOR: "#555555",
  WIDGET_TEXT_COLOR: "#dddddd",
  WIDGET_SECONDARY_TEXT_COLOR: "#aaaaaa",
  LGraphNode: MockNode,
  registered: new Map(),
  registerNodeType(type, nodeClass) {
    this.registered.set(type, nodeClass);
  },
  createNode(type) {
    const NodeClass = this.registered.get(type);
    if (!NodeClass) return null;
    const node = new NodeClass();
    node.type = type;
    return node;
  },
};
globalThis.LGraphCanvas = {
  node_colors: {
    red: { groupcolor: "#883333" },
  },
};

const canvas = {
  graph: null,
  ds: { scale: 1 },
  canvas: { width: 1200, height: 800 },
  centerCalls: [],
  getCurrentGraph() {
    return this.graph;
  },
  centerOnNode(group) {
    this.centerCalls.push(group);
  },
  setZoom() {},
  setDirty() {},
};
globalThis.app = {
  canvas,
  graph: null,
  registerExtension(definition) {
    this.extension = definition;
  },
};

vm.runInThisContext(source, { filename: sourcePath });
app.extension?.registerCustomNodes?.();

const api = globalThis.__astralTest;
const {
  ASTRAL_FAST_GROUPS_BYPASSER,
  FAST_GROUPS_BYPASSER_TITLE,
  FAST_GROUPS_BYPASSER_CATEGORY,
  NODE_PACKAGE_MODULE,
  OUTPUT_NAME,
  MIN_NODE_WIDTH,
  AstralFastGroupsBypasser,
  applyAstralFastGroupsNodeMetadata,
} = api;

assert.equal(
  LiteGraph.registered.get(ASTRAL_FAST_GROUPS_BYPASSER),
  AstralFastGroupsBypasser,
);
assert.equal(app.extension.beforeRegisterVueAppNodeDefs, applyAstralFastGroupsNodeMetadata);

const definitions = [
  {
    name: ASTRAL_FAST_GROUPS_BYPASSER,
    display_name: ASTRAL_FAST_GROUPS_BYPASSER,
    category: "frontend_only",
    python_module: "custom_nodes.frontend_only",
  },
  {
    name: "OtherNode",
    display_name: "OtherNode",
    python_module: "custom_nodes.OtherNodes",
  },
];
app.extension.beforeRegisterVueAppNodeDefs(definitions);
assert.deepEqual(
  {
    displayName: definitions[0].display_name,
    category: definitions[0].category,
    pythonModule: definitions[0].python_module,
  },
  {
    displayName: FAST_GROUPS_BYPASSER_TITLE,
    category: FAST_GROUPS_BYPASSER_CATEGORY,
    pythonModule: NODE_PACKAGE_MODULE,
  },
);
assert.equal(definitions[1].python_module, "custom_nodes.OtherNodes");

const graph = new MockGraph();
app.canvas.graph = graph;
app.graph = graph;

function makeGroup(id, title, childMarkers) {
  const group = {
    id,
    title,
    graph,
    _pos: [id * 100, id * 60],
    _size: [240, 160],
    _bounding: [id * 100, id * 60, 240, 160],
    color: "#883333",
    _children: new Set(),
    recomputeInsideNodes() {
      this._children.clear();
      for (const node of this.graph._nodes) {
        if (childMarkers.includes(node.__groupMarker)) {
          this._children.add(node);
        }
      }
    },
  };
  return group;
}

const shortGroup = makeGroup(1, "快速处理", ["short"]);
const longGroup = makeGroup(
  2,
  "SeedVR2放大与非常长的视频后处理流程",
  ["long"],
);
graph._groups.push(shortGroup, longGroup);

function addGroupNode(marker, mode) {
  const groupedNode = graph.add(new MockNode(marker));
  groupedNode.__groupMarker = marker;
  groupedNode.mode = mode;
  return groupedNode;
}

const shortEnabled = addGroupNode("short", LiteGraph.ALWAYS);
const longEnabled = addGroupNode("long", LiteGraph.ALWAYS);

const node = LiteGraph.createNode(ASTRAL_FAST_GROUPS_BYPASSER);
graph.add(node);
node.refreshWidgets();

assert.equal(node.title, FAST_GROUPS_BYPASSER_TITLE);
assert.deepEqual(
  Array.from(node.outputs, (output) => [output.name, output.type]),
  [[OUTPUT_NAME, "*"]],
);
assert.equal(node.resizable, true);
assert.equal(node._astralRows.length, 2);
assert.equal(
  node._astralRows.some(
    (row) => row.label === "Enable SeedVR2放大与非常长的视频后处理流程",
  ),
  true,
);
assert.equal(node.widgets.every((widget) => widget.computeSize), true);

const initialSize = node.computeSize();
assert.ok(initialSize[0] > MIN_NODE_WIDTH);
assert.ok(initialSize[1] >= 52 + node._astralRows.length * 20);
assert.deepEqual(
  Array.from(node.computeSize(new Float64Array([640, 260]))),
  [640, node.computeSize(new Float64Array([640, 260]))[1]],
  "LiteGraph typed-array sizes must be accepted",
);
assert.equal(
  node._astralRows.some((row) => row.toggled === true),
  true,
);

graph._groups = [shortGroup];
node.refreshWidgets();
const shortOnlyWidth = node.computeSize()[0];
assert.ok(
  initialSize[0] > shortOnlyWidth,
  "A long group name must increase the node width instead of drawing outside it",
);
assert.ok(shortOnlyWidth <= 260, "Short group names must not reserve a huge fixed width");
graph._groups = [shortGroup, longGroup];
node.refreshWidgets();
assert.equal(node._astralRows.length, 2);

node.size = [640, 260];
node.ensureSizeFitsContent();
assert.equal(node.size[0], 640, "Manual horizontal stretching must be preserved");

node.size = new Float64Array([MIN_NODE_WIDTH, 60]);
node.ensureSizeFitsContent();
assert.ok(
  node.size[0] >= node.getMinimumWidth(),
  "A typed-array node size must grow to fit long group names",
);

node.size = new Proxy(
  new Float64Array([MIN_NODE_WIDTH, 60]),
  {
    get(target, property) {
      return Reflect.get(target, property, target);
    },
  },
);
node.ensureSizeFitsContent();
assert.ok(
  node.size[0] >= node.getMinimumWidth(),
  "A Vue-proxied typed-array node size must grow to fit long group names",
);

const longRow = node._astralRows.find(
  (row) => row.group === longGroup,
);
assert.ok(longRow);
assert.equal(longRow.toggled, true);

graph.changeCalls = 0;
const clickedX = 60;
assert.equal(longRow.mouse({ type: "pointerdown", button: 0 }, [clickedX, 10], node), true);
assert.equal(longEnabled.mode, 4, "Clicking an enabled row must bypass its nodes");
assert.equal(graph.changeCalls > 0, true);
assert.equal(longRow.toggled, false);

longRow.mouse({ type: "pointerdown", button: 0 }, [clickedX, 10], node);
assert.equal(longEnabled.mode, LiteGraph.ALWAYS);
assert.equal(longRow.toggled, true);

canvas.centerCalls.length = 0;
longRow.mouse(
  { type: "pointerdown", button: 0 },
  [node.size[0] - 20, 10],
  node,
);
assert.equal(canvas.centerCalls.length, 1);
assert.equal(longRow.toggled, true, "Clicking the navigation arrow must not toggle the group");

node.properties.toggleRestriction = "max one";
longRow.doModeChange(true);
assert.equal(longEnabled.mode, LiteGraph.ALWAYS);
assert.equal(shortEnabled.mode, 4, "Max-one mode must bypass the other groups");

const drawOperations = [];
const context = {
  font: "14px sans-serif",
  fillStyle: "#fff",
  strokeStyle: "#fff",
  textAlign: "left",
  textBaseline: "alphabetic",
  save() {},
  restore() {},
  beginPath() {},
  closePath() {},
  moveTo() {},
  lineTo() {},
  quadraticCurveTo() {},
  roundRect() {},
  fill() {},
  stroke() {},
  clip() {},
  arc() {},
  fillText(text, x, y) {
    drawOperations.push({ text, x, y });
  },
  measureText(text) {
    let width = 0;
    for (const character of Array.from(String(text))) {
      width += character.codePointAt(0) > 0xff ? 14 : 8;
    }
    return { width };
  },
};
for (const row of node._astralRows) {
  row.draw(context, node, node.size[0], 30, 20);
}
assert.ok(drawOperations.length > 0);
assert.equal(
  drawOperations.every((operation) => (
    operation.x >= 15 && operation.x <= node.size[0] - 15
  )),
  true,
  "All row text must be drawn inside the node bounds",
);

assert.match(source, /getMinimumWidth\(\)/);
assert.match(source, /widestLabel/);
assert.match(source, /python_module:\s*NODE_PACKAGE_MODULE/);
assert.match(source, /beforeRegisterVueAppNodeDefs/);
assert.doesNotMatch(source, /custom_nodes\.frontend_only/);

console.log("Fast groups bypasser frontend checks passed.");
