import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(packageRoot, "web", "set_get_groups.js");
let source = readFileSync(sourcePath, "utf8");

class FakeElement {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.listeners = new Map();
    this.removed = false;
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  insertBefore(child, reference) {
    const index = this.children.indexOf(reference);
    child.parentElement = this;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
  }

  querySelector(selector) {
    const matches = (element) => {
      if (selector === ".litemenu-entry") {
        return String(element.className).split(/\s+/).includes("litemenu-entry");
      }
      if (selector === "[data-astral-set-get-entry]") {
        return element.dataset?.astralSetGetEntry === "true";
      }
      return false;
    };
    const visit = (element) => {
      for (const child of element.children || []) {
        if (matches(child)) return child;
        const nested = visit(child);
        if (nested) return nested;
      }
      return null;
    };
    return visit(this);
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  dispatch(type) {
    const event = {
      preventDefault() {},
      stopPropagation() {},
    };
    for (const callback of this.listeners.get(type) || []) callback(event);
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(
      (child) => child !== this,
    );
    this.parentElement = null;
    this.removed = true;
  }
}

class FakeRenderingContext {
  constructor() {
    this.calls = [];
    this.strokeStyle = "";
    this.lineWidth = 1;
    this.lineCap = "butt";
    this.lineJoin = "miter";
    this.fillStyle = "";
    this.font = "";
    this.textAlign = "left";
    this.textBaseline = "alphabetic";
    this.globalAlpha = 1;
  }

  record(name, ...args) {
    this.calls.push([name, ...args]);
  }

  save() {
    this.record("save");
  }

  restore() {
    this.record("restore");
  }

  beginPath() {
    this.record("beginPath");
  }

  moveTo(...args) {
    this.record("moveTo", ...args);
  }

  lineTo(...args) {
    this.record("lineTo", ...args);
  }

  bezierCurveTo(...args) {
    this.record("bezierCurveTo", ...args);
  }

  stroke() {
    this.record("stroke", this.strokeStyle);
  }

  arc(...args) {
    this.record("arc", ...args);
  }

  fill() {
    this.record("fill", this.fillStyle);
  }

  fillText(...args) {
    this.record("fillText", this.fillStyle, this.textAlign, ...args);
  }

  count(name) {
    return this.calls.filter(([callName]) => callName === name).length;
  }
}

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
    this.size = [200, 80];
    this.flags = { collapsed: false };
    this.strokeStyles = {};
    this.selected = false;
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

  removeOutput(index) {
    this.outputs.splice(index, 1);
  }

  getInputPos(index) {
    const pos = this.inputs[index]?.pos;
    if (!pos) return null;
    return [
      (Number(this.pos?.[0]) || 0) + pos[0],
      (Number(this.pos?.[1]) || 0) + pos[1],
    ];
  }

  getOutputPos(index) {
    const pos = this.outputs[index]?.pos;
    if (!pos) return null;
    return [
      (Number(this.pos?.[0]) || 0) + pos[0],
      (Number(this.pos?.[1]) || 0) + pos[1],
    ];
  }

  _setConcreteSlots() {
    this._concreteInputs = [...this.inputs];
    this._concreteOutputs = [...this.outputs];
  }

  drawSlots() {
    this.lastDrawnSlots = {
      inputs: [...(this._concreteInputs || [])],
      outputs: [...(this._concreteOutputs || [])],
    };
  }

  addWidget(type, name, value, callback, options) {
    const widget = { type, name, value, callback, options };
    this.widgets.push(widget);
    return widget;
  }

  computeSize() {
    return [240, 50 + this.inputs.length * 20 + this.outputs.length * 20];
  }

  connect(outputSlot, targetNode, targetSlot, parentId) {
    const output = this.outputs[outputSlot];
    const targetInput = targetNode?.inputs?.[targetSlot];
    if (!output || !targetInput || !this.graph) return false;
    if (targetInput.link != null) this.graph.removeLink(targetInput.link);
    const linkId = this.graph.nextLinkId();
    const link = {
      id: linkId,
      origin_id: this.id,
      origin_slot: outputSlot,
      target_id: targetNode.id,
      target_slot: targetSlot,
      parentId,
      type: output.type,
      resolve: () => ({
        output,
        outputNode: this,
        inputNode: targetNode,
        input: targetInput,
      }),
    };
    this.graph.links.set(linkId, link);
    output.links ||= [];
    output.links.push(linkId);
    targetInput.link = linkId;
    return link;
  }

  serialize() {
    return {
      id: this.id,
      type: this.type,
      pos: [...this.pos],
      size: [...this.size],
      properties: { ...this.properties },
      outputs: this.outputs.map(({ name, type, links }) => ({
        name,
        type,
        links: links?.length ? [...links] : null,
      })),
    };
  }
}

class MockGraph {
  constructor() {
    this._nodes = [];
    this.links = new Map();
    this._nextNodeId = 1;
    this._nextLinkId = 1;
  }

  nextLinkId() {
    const value = this._nextLinkId;
    this._nextLinkId += 1;
    return value;
  }

  add(node) {
    if (node.id == null) {
      node.id = this._nextNodeId;
      this._nextNodeId += 1;
    }
    node.graph = this;
    this._nodes.push(node);
    node.onAdded?.();
    return node;
  }

  getNodeById(id) {
    return this._nodes.find((node) => String(node.id) === String(id)) || null;
  }

  removeLink(id) {
    const link = this.links.get(id);
    if (!link) return;
    const source = this.getNodeById(link.origin_id);
    const target = this.getNodeById(link.target_id);
    const output = source?.outputs?.[link.origin_slot];
    if (output?.links) output.links = output.links.filter((value) => value !== id);
    const input = target?.inputs?.[link.target_slot];
    if (input?.link === id) input.link = null;
    this.links.delete(id);
  }

  change() {}
  setDirtyCanvas() {}
}

class StoreGuardedLink {
  constructor(graph, data) {
    this.graph = graph;
    this.id = data.id;
    this.origin_id = data.origin_id;
    this.origin_slot = data.origin_slot;
    this.target_id = data.target_id;
    this.type = data.type;
    this.parentId = data.parentId;
    this._targetSlot = data.target_slot;
    this.resolve = data.resolve;
  }

  get target_slot() {
    return this._targetSlot;
  }

  set target_slot(value) {
    const nextSlot = Math.trunc(Number(value));
    const occupied = Array.from(this.graph.links.values()).some((link) => (
      link !== this
      && String(link.target_id) === String(this.target_id)
      && Number(link.target_slot) === nextSlot
    ));
    if (occupied) return;
    this._targetSlot = nextSlot;
  }
}

function guardStoredLinks(graph) {
  for (const [id, link] of Array.from(graph.links.entries())) {
    graph.links.set(id, new StoreGuardedLink(graph, link));
  }
}

globalThis.window = globalThis;
globalThis.document = {
  createElement(tag) {
    return new FakeElement(tag);
  },
  querySelectorAll() {
    return [];
  },
};
globalThis.LiteGraph = {
  INPUT: 1,
  OUTPUT: 2,
  NODE_SLOT_HEIGHT: 20,
  NO_TITLE: 1,
  LGraphNode: MockNode,
  ContextMenu: null,
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
let canvasDirtyCalls = 0;
const canvasPromptCalls = [];
const canvasPromptResults = [];
globalThis.app = {
  canvas: {
    graph: null,
    canvas: {
      getBoundingClientRect() {
        return {
          left: 100,
          top: 50,
          width: 800,
          height: 600,
        };
      },
    },
    default_connection_color_byType: {
      MODEL: "#4b8cff",
      CLIP: "#f2cf45",
      IMAGE: "#67d9c5",
      MASK: "#76d572",
      "*": "#ffffff",
    },
    prompt(title, value, callback, event, multiline) {
      canvasPromptCalls.push({
        title,
        value,
        event: {
          clientX: event?.clientX,
          clientY: event?.clientY,
        },
        multiline,
      });
      const result = canvasPromptResults.length
        ? canvasPromptResults.shift()
        : null;
      callback(result);
      return {};
    },
    setDirty() {
      canvasDirtyCalls += 1;
    },
    selectNode() {},
  },
  graph: null,
  configuringGraph: false,
  registerExtension(definition) {
    this.extension = definition;
  },
};

source = source.replace(/^import\s+.*;\s*$/gm, "");
source = source
  .replace(/^export\s+(?=(?:const|let|var|function|class)\b)/gm, "")
  .replace(/^export\s+\{[^}]*\};\s*$/gm, "");
source += `
globalThis.__astralTest = globalThis.__astralSetGetGroups;
`;
vm.runInThisContext(source, { filename: sourcePath });
app.extension?.registerCustomNodes?.();

const api = globalThis.__astralTest;
const {
  SET_GROUP_NODE,
  GET_GROUP_NODE,
  MAX_SET_PORTS,
  MAX_GET_PORTS,
  SET_GROUP_MIN_WIDTH,
  GET_GROUP_MIN_WIDTH,
  NODE_PACKAGE_MODULE,
  AstralSetGroupNode,
  AstralGetGroupNode,
  applySetGetNodeMetadata,
  assignUniquePortNames,
  parsePortNameList,
  getGroupNodeColors,
  getSetGetSideGeometry,
  traceSetGetSide,
  isSetGetBraceStrokePoint,
  getSetGetBraceGeometry,
  traceSetGetBrace,
  drawSetGetNodeOnly,
  installSetGetNodeDrawGuard,
  installConnectionMenuEntries,
  typesCompatible,
} = api;

const otherNodeDefinition = {
  name: "OtherNode",
  python_module: "custom_nodes.OtherNodes",
};
const setGetNodeDefinitions = [
  { name: SET_GROUP_NODE, python_module: "custom_nodes.frontend_only" },
  { name: GET_GROUP_NODE, python_module: "custom_nodes.frontend_only" },
  otherNodeDefinition,
];
assert.equal(app.extension.beforeRegisterVueAppNodeDefs, applySetGetNodeMetadata);
app.extension.beforeRegisterVueAppNodeDefs(setGetNodeDefinitions);
assert.deepEqual(
  setGetNodeDefinitions.slice(0, 2).map((definition) => ({
    name: definition.name,
    displayName: definition.display_name,
    category: definition.category,
    pythonModule: definition.python_module,
  })),
  [
    {
      name: SET_GROUP_NODE,
      displayName: "SetGroup",
      category: "Assets Astral/Set & Get",
      pythonModule: NODE_PACKAGE_MODULE,
    },
    {
      name: GET_GROUP_NODE,
      displayName: "GetGroup",
      category: "Assets Astral/Set & Get",
      pythonModule: NODE_PACKAGE_MODULE,
    },
  ],
);
assert.equal(otherNodeDefinition.python_module, "custom_nodes.OtherNodes");

assert.deepEqual(
  Array.from(assignUniquePortNames([
    { baseName: "VAE", type: "VAE" },
    { baseName: "VAE", type: "VAE" },
    { baseName: "MODEL", type: "MODEL" },
    { baseName: "VAE", type: "VAE" },
  ])),
  ["VAE1", "VAE2", "MODEL", "VAE3"],
);
assert.equal(typesCompatible("VAE", "VAE"), true);
assert.equal(typesCompatible("*", "IMAGE"), true);
assert.equal(typesCompatible(["MODEL", "CLIP"], "CLIP"), true);
assert.equal(typesCompatible("IMAGE", "VIDEO"), false);
assert.deepEqual(
  getGroupNodeColors(" 主设置组 "),
  getGroupNodeColors("主设置组"),
);

function attachSource(node, slot, sourceNode, linkId) {
  const output = sourceNode.outputs[0];
  sourceNode.graph = node.graph;
  const link = {
    id: linkId,
    origin_id: sourceNode.id,
    origin_slot: 0,
    target_id: node.id,
    target_slot: slot,
    type: output.type,
    resolve: () => ({
      output,
      outputNode: sourceNode,
      inputNode: node,
      input: node.inputs[slot],
    }),
  };
  node.graph.links.set(linkId, link);
  node.inputs[slot].link = linkId;
  node.onConnectionsChange(LiteGraph.INPUT, slot, true, link, output);
  return link;
}

assert.equal(MAX_SET_PORTS, 30);
assert.equal(MAX_GET_PORTS, 30);
assert.deepEqual(
  Array.from(parsePortNameList(" image, alpha；seed\nimage ")),
  ["image", "alpha", "seed"],
);

function addSource(graph, name, type) {
  const node = graph.add(new MockNode(`${type} Source`));
  node.outputs.push({ name, type, links: [] });
  return node;
}

function createSet(graph, sourceName, type, linkId) {
  const node = new AstralSetGroupNode();
  node.type = SET_GROUP_NODE;
  graph.add(node);
  const source = addSource(graph, sourceName, type);
  attachSource(node, 0, source, linkId);
  return { node, source };
}

function useGraph(graph) {
  app.canvas.graph = graph;
  app.graph = graph;
  return graph;
}

function realOutputEntries(node) {
  return Array.from(node.getRealOutputs(), (output) => [output.name, output.type]);
}

const graph = useGraph(new MockGraph());
const setNode = new AstralSetGroupNode();
setNode.type = SET_GROUP_NODE;
setNode.properties.groupName = "旧设置组";
graph.add(setNode);
assert.equal(setNode.widgets[0].name, "name");
assert.equal(AstralSetGroupNode.title_mode, LiteGraph.NO_TITLE);
assert.equal(setNode.title_mode, LiteGraph.NO_TITLE);
assert.equal(
  Object.getOwnPropertyDescriptor(
    AstralSetGroupNode.prototype,
    "title_mode",
  )?.get instanceof Function,
  true,
  "SetG must override the read-only title mode getter inherited from LGraphNode",
);
assert.equal(
  Object.prototype.hasOwnProperty.call(
    AstralSetGroupNode.prototype,
    "drawBadges",
  ),
  true,
  "SetG must suppress the package badge that draws rectangular text above the brace",
);
assert.equal(setNode.widgets[0].hidden, true);
assert.equal(setNode.widgets[0].options.hidden, true);
assert.equal(setNode.renderingColor, "rgba(0,0,0,0)");
assert.equal(setNode.renderingBgColor, "rgba(0,0,0,0)");
assert.equal(setNode.renderingBoxColor, "rgba(0,0,0,0)");
assert.deepEqual(setNode.strokeStyles, {});
assert.equal(setNode.resizable, false);
assert.equal(SET_GROUP_MIN_WIDTH, 80);
assert.equal(GET_GROUP_MIN_WIDTH, 160);
assert.equal(setNode.size[0], SET_GROUP_MIN_WIDTH);
assert.equal(setNode.size[1], 48);
assert.equal(setNode.inputs.length, 1);
assert.equal(setNode.outputs.length, 0);
assert.equal(setNode.inputs[0].name, "*");
assert.deepEqual(Array.from(setNode.inputs[0].pos), [14, 24]);
const setSide = getSetGetSideGeometry(setNode);
assert.equal(setSide.side, "left");
assert.equal(setSide.edgeX, 0);
assert.equal(setSide.radius, 14);
assert.deepEqual(
  setSide,
  getSetGetBraceGeometry(setNode),
  "The old brace export must remain an alias of the native side-line geometry",
);
const setContext = new FakeRenderingContext();
setNode.onDrawForeground(setContext);
assert.equal(setContext.count("stroke"), 1);
assert.equal(setContext.count("arc"), 2);
assert.equal(setContext.count("moveTo"), 1);
assert.equal(setContext.count("lineTo"), 1);
assert.equal(setContext.count("bezierCurveTo"), 0);
assert.equal(setContext.count("save"), 1);
assert.equal(setContext.count("restore"), 1);
assert.equal(
  setNode.findResizeDirection(0, 0),
  undefined,
  "SetGroup must override native resize hit testing",
);
setNode.resizable = true;
assert.equal(
  setNode.findResizeDirection(0, 0),
  undefined,
  "SetGroup must stay non-resizable even if legacy state enables it",
);
setNode.resizable = false;
const setBraceMidY = (setSide.top + setSide.bottom) / 2;
assert.equal(
  setNode.isPointInside(-3, setBraceMidY),
  true,
  "The SetGroup brace must include 3px of its outer edge in the node hit area",
);
assert.equal(
  setNode.isPointInside(-4, setBraceMidY),
  false,
  "The SetGroup brace hit area must stop after 3px",
);
assert.equal(
  setNode.isPointInside(setSide.radius, -3),
  true,
  "The SetGroup top arc's outer edge must be draggable",
);
assert.equal(
  setNode.isPointInside(setSide.radius, -4),
  false,
  "The SetGroup top arc hit area must stop after 3px",
);
assert.equal(
  isSetGetBraceStrokePoint(setNode, [0, setBraceMidY]),
  true,
  "The SetGroup brace line must use the move cursor hit area",
);
assert.equal(
  isSetGetBraceStrokePoint(setNode, [3, setBraceMidY]),
  true,
  "The SetGroup brace hit area must include 3px to the right",
);
assert.equal(
  isSetGetBraceStrokePoint(setNode, [4, setBraceMidY]),
  false,
  "The SetGroup brace hit area must stop after 3px",
);
assert.equal(
  isSetGetBraceStrokePoint(setNode, [setSide.radius, 3]),
  true,
  "The SetGroup top arc must be included in the move cursor hit area",
);
assert.equal(
  isSetGetBraceStrokePoint(setNode, [setSide.radius, 4]),
  false,
  "The SetGroup top arc hit area must stop after 3px",
);
const setCursorCanvas = {
  canvas: { style: { cursor: "default" } },
  state: { shouldSetCursor: true },
  pointer: { resizeDirection: "SE" },
};
assert.equal(
  setNode.onMouseMove({}, [0, setBraceMidY], setCursorCanvas),
  true,
);
assert.equal(setCursorCanvas.canvas.style.cursor, "move");
assert.equal(setCursorCanvas.pointer.resizeDirection, undefined);
assert.equal(setCursorCanvas.state.shouldSetCursor, false);
await Promise.resolve();
assert.equal(
  setCursorCanvas.state.shouldSetCursor,
  true,
  "SetGroup must restore native cursor handling after the current pointer event",
);
assert.equal(
  setNode.onMouseMove({}, [40, setBraceMidY], setCursorCanvas),
  false,
);
const isolatedCanvas = {
  current_node: "previous-node",
  editor_alpha: 0.8,
  inner_text_font: "12px sans-serif",
  low_quality: false,
  getNodeModeAlpha() {
    return 0.75;
  },
};
const isolatedContext = new FakeRenderingContext();
assert.equal(drawSetGetNodeOnly(isolatedCanvas, setNode, isolatedContext), true);
assert.equal(isolatedCanvas.current_node, "previous-node");
assert.equal(isolatedContext.count("stroke"), 1);
assert.equal(isolatedContext.count("fill"), 1);
assert.equal(isolatedContext.count("fillText"), 0);
assert.equal(isolatedContext.count("fillRect"), 0);
assert.equal(isolatedContext.count("roundRect"), 0);
assert.deepEqual(isolatedContext.calls.find(([name]) => name === "stroke")?.[1], setNode.color);
assert.equal(
  isolatedContext.calls.find(([name]) => name === "fill")?.[1],
  "#797979",
  "An empty SetGroup slot must be a gray dot without a plus label",
);
assert.deepEqual(setNode.lastDrawnSlots.outputs, []);
assert.equal(setNode.outputs.length, 0);
assert.equal(setNode._concreteOutputs.length, 0);
// The port-label hit area now follows the rendered text instead of a fixed
// 96px block, so the press has to sit on the label, not far right of it.
assert.equal(setNode.getSlotInPosition(30, 24)?.input, setNode.inputs[0]);
assert.equal(setNode.getSlotInPosition(90, 24), null);
assert.equal(
  setNode.getSlotInPosition(40, 44),
  null,
  "SetGroup must not have a compatibility output",
);

const colorSet = new AstralSetGroupNode();
colorSet.type = SET_GROUP_NODE;
graph.add(colorSet);
colorSet.color = "#e66b42";
colorSet.updateTitle();
assert.equal(colorSet.color, "#e66b42");
const colorContext = new FakeRenderingContext();
colorSet.onDrawForeground(colorContext);
assert.equal(
  colorContext.calls.find(([name]) => name === "stroke")?.[1],
  "#e66b42",
  "Custom node color must also color the SetG brace",
);
let fallbackDrawCalls = 0;
let fallbackSnapCalls = 0;
function legacyGuardedDrawNode() {
  fallbackDrawCalls += 1;
  return "fallback";
}
legacyGuardedDrawNode.__astralSetGetDrawGuard = true;
globalThis.LGraphCanvas = {
  prototype: {
    drawNode: legacyGuardedDrawNode,
    drawSnapGuide() {
      fallbackSnapCalls += 1;
      return "snap";
    },
  },
};
assert.equal(installSetGetNodeDrawGuard(), true);
assert.equal(
  globalThis.LGraphCanvas.prototype.drawNode.__astralSetGetDrawGuardVersion,
  2,
  "A V1 draw guard must be upgraded to V2",
);
assert.equal(
  globalThis.LGraphCanvas.prototype.drawSnapGuide
    .__astralSetGetDrawSnapGuard,
  true,
  "The snap-guide draw must be guarded separately",
);
assert.equal(
  globalThis.LGraphCanvas.prototype.drawSnapGuide
    .__astralSetGetDrawSnapGuardVersion,
  2,
  "The snap-guide guard must use the ComfyUI (ctx, node) argument order",
);
const ordinaryNode = { type: "OrdinaryNode" };
assert.equal(
  globalThis.LGraphCanvas.prototype.drawNode.call(
    isolatedCanvas,
    ordinaryNode,
    isolatedContext,
  ),
  "fallback",
);
assert.equal(fallbackDrawCalls, 1);
assert.equal(
  globalThis.LGraphCanvas.prototype.drawSnapGuide.call(
    isolatedCanvas,
    isolatedContext,
    ordinaryNode,
  ),
  "snap",
);
assert.equal(fallbackSnapCalls, 1);
assert.equal(
  globalThis.LGraphCanvas.prototype.drawSnapGuide.call(
    isolatedCanvas,
    isolatedContext,
    setNode,
  ),
  undefined,
  "SetGroup/GetGroup must not draw a white snap box while being dragged",
);
assert.equal(fallbackSnapCalls, 1);
assert.equal(
  globalThis.LGraphCanvas.prototype.drawSnapGuide.call(
    isolatedCanvas,
    isolatedContext,
    { type: GET_GROUP_NODE },
  ),
  undefined,
  "GetGroup must not draw a white snap box while being dragged",
);
assert.equal(fallbackSnapCalls, 1);
assert.equal(
  globalThis.LGraphCanvas.prototype.drawSnapGuide.call(
    isolatedCanvas,
    setNode,
  ),
  undefined,
  "The snap-guide compatibility form must still suppress SetGroup/GetGroup",
);
assert.equal(fallbackSnapCalls, 1);
assert.equal(installSetGetNodeDrawGuard(true), true);
assert.equal(
  globalThis.LGraphCanvas.prototype.drawSnapGuide.call(
    isolatedCanvas,
    isolatedContext,
    ordinaryNode,
  ),
  "snap",
);
assert.equal(
  fallbackSnapCalls,
  2,
  "Installing the V2 guard again must be idempotent",
);

const sourceOne = addSource(graph, "images", "IMAGE");
attachSource(setNode, 0, sourceOne, 100);
assert.equal(setNode.properties.portName, "images");
assert.equal(setNode.widgets[0].value, "images");
assert.equal(setNode.inputs[0].name, "images");
assert.equal(setNode.inputs[0].type, "*");
assert.equal(setNode.outputs.length, 0);
assert.equal(setNode.title, "SetGroup_images");
assert.equal(setNode.size[0], SET_GROUP_MIN_WIDTH);
const setSlotContext = new FakeRenderingContext();
assert.equal(
  drawSetGetNodeOnly(isolatedCanvas, setNode, setSlotContext),
  true,
);
const setLabelCall = setSlotContext.calls.find(
  ([name]) => name === "fillText",
);
assert.equal(setLabelCall?.[2], "left");
assert.equal(setLabelCall?.[3], "images");
assert.equal(setLabelCall?.[4], 23);
assert.equal(setLabelCall?.[5], 24.5);
const setFillCalls = setSlotContext.calls.filter(([name]) => name === "fill");
assert.equal(setFillCalls[0]?.[1], "#67d9c5");
assert.equal(setFillCalls[1]?.[1], "#797979");

const second = createSet(graph, "images", "IMAGE", 101);
second.node.onPortNameChanged("images");
assert.equal(second.node.properties.portName, "images_2");
assert.equal(second.node.title, "SetGroup_images_2");

const sourceAlpha = addSource(graph, "alpha", "MASK");
attachSource(setNode, 1, sourceAlpha, 102);
assert.equal(setNode.inputs.length, 3);
assert.equal(setNode.inputs[2].link, null);
assert.equal(setNode.inputs[2]._astralSetPlaceholder, true);
assert.equal(setNode.outputs.length, 0);
assert.equal(setNode.inputs[0].name, "images");
assert.equal(setNode.inputs[1].name, "alpha");

const mixedTypeGraph = useGraph(new MockGraph());
const mixedTypeSet = new AstralSetGroupNode();
mixedTypeSet.type = SET_GROUP_NODE;
mixedTypeGraph.add(mixedTypeSet);
const mixedModelSource = addSource(mixedTypeGraph, "model_source", "MODEL");
const mixedClipSource = addSource(mixedTypeGraph, "clip_source", "CLIP");
const mixedImageSource = addSource(mixedTypeGraph, "image_source", "IMAGE");
attachSource(mixedTypeSet, 0, mixedModelSource, 1100);
attachSource(mixedTypeSet, 1, mixedClipSource, 1101);
attachSource(mixedTypeSet, 2, mixedImageSource, 1102);
assert.equal(mixedTypeSet.inputs.length, 4);
assert.equal(mixedTypeSet.inputs[3].link, null);
assert.equal(mixedTypeSet.inputs[3]._astralSetPlaceholder, true);
assert.equal(mixedTypeSet.inputs[0].color_on, "#4b8cff");
assert.equal(mixedTypeSet.inputs[0].color_off, "#4b8cff");
assert.equal(mixedTypeSet.inputs[1].color_on, "#f2cf45");
assert.equal(mixedTypeSet.inputs[1].color_off, "#f2cf45");
assert.equal(mixedTypeSet.inputs[2].color_on, "#67d9c5");
assert.equal(mixedTypeSet.inputs[2].color_off, "#67d9c5");
assert.equal(mixedTypeSet.inputs[3].color_on, undefined);
assert.equal(mixedTypeSet.inputs[3].color_off, undefined);
assert.deepEqual(
  mixedTypeSet.getActivePorts().map((port) => [port.name, port.type]),
  [
    ["model_source", "MODEL"],
    ["clip_source", "CLIP"],
    ["image_source", "IMAGE"],
  ],
  "One SetG must expose multiple named ports with different source types at the same time",
);
assert.equal(mixedTypeSet.outputs.length, 0);
assert.equal(mixedTypeSet.size[1], 108);

const mixedTypeGet = new AstralGetGroupNode();
mixedTypeGet.type = GET_GROUP_NODE;
mixedTypeGraph.add(mixedTypeGet);
mixedTypeGet.onPortNamesChanged("model_source, clip_source, image_source");
assert.deepEqual(
  realOutputEntries(mixedTypeGet),
  [
    ["model_source", "MODEL"],
    ["clip_source", "CLIP"],
    ["image_source", "IMAGE"],
  ],
);

const getNode = new AstralGetGroupNode();
getNode.type = GET_GROUP_NODE;
graph.add(getNode);
assert.equal(getNode.widgets[0].name, "ports");
assert.equal(AstralGetGroupNode.title_mode, LiteGraph.NO_TITLE);
assert.equal(getNode.title_mode, LiteGraph.NO_TITLE);
assert.equal(
  Object.getOwnPropertyDescriptor(
    AstralGetGroupNode.prototype,
    "title_mode",
  )?.get instanceof Function,
  true,
  "GetGroup must override the read-only title mode getter inherited from LGraphNode",
);
assert.equal(
  Object.prototype.hasOwnProperty.call(
    AstralGetGroupNode.prototype,
    "drawBadges",
  ),
  true,
  "GetGroup must suppress the package badge that draws rectangular text above the brace",
);
assert.equal(getNode.widgets[0].hidden, true);
assert.equal(getNode.widgets[0].options.hidden, true);
assert.equal(GET_GROUP_MIN_WIDTH, 160);
assert.equal(getNode.title, "GetGroup");
assert.equal(getNode.outputs.length, 1);
assert.equal(getNode.outputs[0]._astralGetPlaceholder, true);
assert.equal(getNode.size[1], 48);
const emptyGetSide = getSetGetSideGeometry(getNode);
assert.equal(emptyGetSide.side, "right");
assert.equal(emptyGetSide.edgeX, GET_GROUP_MIN_WIDTH);
assert.equal(emptyGetSide.radius, 14);
assert.equal(emptyGetSide.top, 0);
assert.equal(emptyGetSide.bottom, getNode.size[1]);
assert.equal(getNode.resizable, false);
assert.equal(
  getNode.findResizeDirection(0, 0),
  undefined,
  "GetGroup must override native resize hit testing",
);
const getBraceMidY = (emptyGetSide.top + emptyGetSide.bottom) / 2;
assert.equal(
  isSetGetBraceStrokePoint(getNode, [emptyGetSide.edgeX, getBraceMidY]),
  true,
  "The GetGroup brace line must use the move cursor hit area",
);
assert.equal(
  isSetGetBraceStrokePoint(getNode, [emptyGetSide.edgeX - 3, getBraceMidY]),
  true,
  "The GetGroup brace hit area must include 3px to the left",
);
assert.equal(
  isSetGetBraceStrokePoint(getNode, [emptyGetSide.edgeX - 4, getBraceMidY]),
  false,
  "The GetGroup brace hit area must stop after 3px",
);
assert.equal(
  isSetGetBraceStrokePoint(
    getNode,
    [emptyGetSide.edgeX - emptyGetSide.radius, 3],
  ),
  true,
  "The GetGroup top arc must be included in the move cursor hit area",
);
const getCursorCanvas = {
  canvas: { style: { cursor: "default" } },
  state: { shouldSetCursor: true },
  pointer: { resizeDirection: "NE" },
};
assert.equal(
  getNode.onMouseMove(
    {},
    [emptyGetSide.edgeX, getBraceMidY],
    getCursorCanvas,
  ),
  true,
);
assert.equal(getCursorCanvas.canvas.style.cursor, "move");
assert.equal(getCursorCanvas.pointer.resizeDirection, undefined);
assert.equal(getCursorCanvas.state.shouldSetCursor, false);
await Promise.resolve();
assert.equal(
  getCursorCanvas.state.shouldSetCursor,
  true,
  "GetGroup must restore native cursor handling after the current pointer event",
);
const emptyGetRight = getNode.pos[0] + getNode.size[0];
assert.equal(
  getNode.isPointInside(emptyGetRight, getNode.pos[1]),
  true,
  "The GetGroup brace's right edge must be part of the node hit area",
);
assert.equal(
  getNode.isPointInside(emptyGetRight + 3, getNode.pos[1]),
  true,
  "The GetGroup brace must include its anti-aliased outer edge",
);
assert.equal(
  getNode.isPointInside(emptyGetRight + 4, getNode.pos[1]),
  false,
  "The GetGroup brace hit slop must not extend into the blank canvas",
);
assert.equal(
  getNode.isPointInside(
    getNode.pos[0] + emptyGetSide.edgeX - emptyGetSide.radius,
    getNode.pos[1] - 3,
  ),
  true,
  "The GetGroup top arc's outer edge must be draggable",
);
assert.equal(
  getNode.isPointInside(
    getNode.pos[0] + emptyGetSide.edgeX - emptyGetSide.radius,
    getNode.pos[1] - 4,
  ),
  false,
  "The GetGroup top arc hit area must stop after 3px",
);
getNode.onPortNamesChanged("ImAgEs，alpha; images");
assert.deepEqual(
  Array.from(getNode.properties.getPortNames),
  ["ImAgEs", "alpha"],
);
assert.deepEqual(
  realOutputEntries(getNode),
  [
    ["images", "IMAGE"],
    ["alpha", "MASK"],
  ],
  "GetG must inherit the real SetG spelling and type for case-insensitive names",
);
assert.equal(getNode.outputs.length, 3);
assert.equal(getNode.outputs[2]._astralGetPlaceholder, true);
assert.equal(getNode.title, "GetGroup_ImAgEs +1");
assert.equal(getNode.size[0], GET_GROUP_MIN_WIDTH);
assert.equal(getNode.size[1], 88);
assert.equal(
  getSetGetSideGeometry(getNode).bottom,
  getNode.size[1],
);
assert.equal(getNode.color, setNode.color);
assert.equal(getNode.bgcolor, setNode.bgcolor);
assert.equal(getNode.boxcolor, setNode.boxcolor);
assert.equal(getNode.getInputLink(0)?.id, 100);
assert.equal(getNode.getInputLink(1)?.id, 102);
assert.equal(getNode.resolveVirtualOutput(1)?.node, sourceAlpha);
assert.equal(getNode.resolveVirtualOutput(1)?.slot, 0);
const getSlotContext = new FakeRenderingContext();
assert.equal(
  drawSetGetNodeOnly(isolatedCanvas, getNode, getSlotContext),
  true,
);
const getLabelCalls = getSlotContext.calls.filter(
  ([name]) => name === "fillText",
);
assert.equal(getLabelCalls.length, 2);
assert.equal(getLabelCalls[0]?.[2], "right");
assert.equal(getLabelCalls[0]?.[3], "images");
assert.equal(getLabelCalls[0]?.[4], GET_GROUP_MIN_WIDTH - 23);
assert.equal(getLabelCalls[1]?.[3], "alpha");
const getFillCalls = getSlotContext.calls.filter(([name]) => name === "fill");
assert.equal(getFillCalls[0]?.[1], "#67d9c5");
assert.equal(getFillCalls[1]?.[1], "#76d572");
assert.equal(getFillCalls[2]?.[1], "#797979");
const getContext = new FakeRenderingContext();
getNode.onDrawForeground(getContext);
assert.equal(getContext.count("stroke"), 1);
assert.equal(getContext.count("arc"), 2);
assert.equal(getContext.count("moveTo"), 1);
assert.equal(getContext.count("lineTo"), 1);
assert.equal(getContext.count("bezierCurveTo"), 0);
getNode.color = "#44aa88";
const recoloredGetContext = new FakeRenderingContext();
getNode.onDrawForeground(recoloredGetContext);
assert.equal(
  recoloredGetContext.calls.find(([name]) => name === "stroke")?.[1],
  "#44aa88",
  "Custom node color must also color the GetG brace",
);
const traceContext = new FakeRenderingContext();
traceSetGetSide(traceContext, getSetGetSideGeometry(getNode));
assert.equal(traceContext.count("beginPath"), 1);
assert.equal(traceContext.count("moveTo"), 1);
assert.equal(traceContext.count("lineTo"), 1);
assert.equal(traceContext.count("arc"), 2);
assert.equal(traceContext.count("bezierCurveTo"), 0);
const aliasTraceContext = new FakeRenderingContext();
traceSetGetBrace(aliasTraceContext, getSetGetBraceGeometry(getNode));
assert.deepEqual(aliasTraceContext.calls, traceContext.calls);
const getMenuOptions = [];
getNode.getExtraMenuOptions(null, getMenuOptions);
assert.equal(
  getMenuOptions.some((option) => option.content === "编辑 GetGroup 端口名"),
  true,
);
assert.equal(
  getMenuOptions.some((option) => option.content === "跳转到对应 SetGroup"),
  false,
  "Jumping must live on the port menu, not GetGroup's node menu",
);

const portOrderGraph = useGraph(new MockGraph());
const portOrderSet = new AstralSetGroupNode();
portOrderSet.type = SET_GROUP_NODE;
portOrderGraph.add(portOrderSet);
const portOrderSourceA = addSource(portOrderGraph, "model_port", "MODEL");
const portOrderSourceB = addSource(portOrderGraph, "clip_port", "CLIP");
const portOrderSourceC = addSource(portOrderGraph, "image_port", "IMAGE");
attachSource(portOrderSet, 0, portOrderSourceA, 800);
attachSource(portOrderSet, 1, portOrderSourceB, 801);
attachSource(portOrderSet, 2, portOrderSourceC, 802);
const portOrderIds = Array.from(
  { length: 3 },
  (_value, index) => portOrderSet.getPortId(index),
);
const portOrderGet = new AstralGetGroupNode();
portOrderGet.type = GET_GROUP_NODE;
portOrderGraph.add(portOrderGet);
portOrderGet.onPortNamesChanged("model_port, clip_port, image_port");
const portOrderTarget = portOrderGraph.add(new MockNode("Port Order Target"));
portOrderTarget.addInput("model", "MODEL");
const portOrderGetLink = portOrderGet.connect(0, portOrderTarget, 0);
assert.notEqual(portOrderGetLink.id, null);

portOrderSet.pos = [100, 50];
const portLabelHit = portOrderSet.getSlotInPosition(170, 64);
assert.equal(portLabelHit?.input, portOrderSet.inputs[0]);
assert.equal(portLabelHit?.slot, 0);
const portLabelMenu = portOrderSet.getSlotMenuOptions(portLabelHit);
assert.deepEqual(
  portLabelMenu.filter(Boolean).map((option) => option.title ?? option.content),
  [
    "Disconnect Links",
    "重命名接口",
    "Remove Slot",
  ],
);
assert.equal(portLabelMenu[2], null);
assert.equal(
  portLabelMenu[0].content,
  undefined,
  "Native ComfyUI menu dispatch must not intercept SetGroup's custom disconnect callback",
);
assert.equal(
  portLabelMenu.find((option) => option?.title === "Remove Slot")
    ?.className,
  "danger",
);
assert.deepEqual(
  portOrderSet.getSlotMenuOptions({
    input: portOrderSet.inputs[3],
    slot: 3,
  }),
  [],
  "Empty trailing sockets must not open a slot menu",
);
assert.equal(portOrderSet.movePort(0, 1), true);
assert.deepEqual(
  Array.from(portOrderSet.getActivePorts(), (port) => [port.name, port.type]),
  [
    ["clip_port", "CLIP"],
    ["model_port", "MODEL"],
    ["image_port", "IMAGE"],
  ],
);
const portOrderCenters = () => Array.from(portOrderSet.inputs, (input) => [
  input.boundingRect[0] + input.boundingRect[2] * 0.5,
  input.boundingRect[1] + input.boundingRect[3] * 0.5,
]);
assert.equal(portOrderSet.properties.portIds[0], portOrderIds[1]);
assert.equal(portOrderSet.properties.portIds[1], portOrderIds[0]);
assert.equal(portOrderSet.inputs[0].pos[1], 24);
assert.equal(portOrderSet.inputs[1].pos[1], 44);
assert.deepEqual(portOrderSet.getInputPos(0), [114, 74]);
assert.deepEqual(portOrderSet.getSlotPosition(0, true), [114, 74]);
assert.deepEqual(portOrderCenters(), [
  [114, 74],
  [114, 94],
  [114, 114],
  [114, 134],
]);
assert.equal(portOrderGraph.links.get(800).target_slot, 1);
assert.equal(portOrderGraph.links.get(801).target_slot, 0);
assert.equal(portOrderGet.getResolvedPort(0)?.portId, portOrderIds[0]);
assert.equal(portOrderGet.getInputLink(0)?.id, 800);
assert.equal(portOrderTarget.inputs[0].link, portOrderGetLink.id);

assert.equal(portOrderSet.movePort(1, -1), true);
assert.deepEqual(
  Array.from(portOrderSet.getActivePorts(), (port) => [port.name, port.type]),
  [
    ["model_port", "MODEL"],
    ["clip_port", "CLIP"],
    ["image_port", "IMAGE"],
  ],
);
assert.equal(portOrderSet.properties.portIds[0], portOrderIds[0]);
assert.equal(portOrderSet.properties.portIds[1], portOrderIds[1]);
assert.equal(portOrderSet.properties.portIds[2], portOrderIds[2]);
assert.equal(portOrderSet.inputs[0].pos[1], 24);
assert.equal(portOrderSet.inputs[1].pos[1], 44);
assert.equal(portOrderGraph.links.get(800).target_slot, 0);
assert.equal(portOrderGraph.links.get(801).target_slot, 1);
assert.equal(portOrderGet.getResolvedPort(0)?.slot, 0);
assert.equal(portOrderGet.getInputLink(0)?.id, 800);
assert.equal(portOrderTarget.inputs[0].link, portOrderGetLink.id);

assert.equal(portOrderSet.movePortTo(0, 2), true);
assert.deepEqual(
  Array.from(portOrderSet.getActivePorts(), (port) => port.name),
  ["clip_port", "image_port", "model_port"],
);
assert.equal(portOrderGraph.links.get(800).target_slot, 2);
assert.equal(portOrderGraph.links.get(801).target_slot, 0);
assert.equal(portOrderGraph.links.get(802).target_slot, 1);
assert.equal(portOrderSet.movePortTo(2, 0), true);
assert.deepEqual(
  Array.from(portOrderSet.getActivePorts(), (port) => port.name),
  ["model_port", "clip_port", "image_port"],
);
assert.equal(portOrderSet.insertPortAt, undefined);

const contestedOrderGraph = useGraph(new MockGraph());
const contestedOrderSet = new AstralSetGroupNode();
contestedOrderSet.type = SET_GROUP_NODE;
contestedOrderGraph.add(contestedOrderSet);
const contestedModel = addSource(contestedOrderGraph, "guarded_model", "MODEL");
const contestedClip = addSource(contestedOrderGraph, "guarded_clip", "CLIP");
const contestedImage = addSource(contestedOrderGraph, "guarded_image", "IMAGE");
attachSource(contestedOrderSet, 0, contestedModel, 830);
attachSource(contestedOrderSet, 1, contestedClip, 831);
attachSource(contestedOrderSet, 2, contestedImage, 832);
guardStoredLinks(contestedOrderGraph);
const contestedPosition = [...contestedOrderSet.pos];
assert.equal(
  contestedOrderSet.movePortTo(0, 2),
  true,
  "Reordering must vacate occupied destination slots before committing",
);
assert.deepEqual(
  Array.from(contestedOrderSet.getActivePorts(), (port) => port.name),
  ["guarded_clip", "guarded_image", "guarded_model"],
);
assert.deepEqual(
  Array.from(
    contestedOrderGraph.links.values(),
    (link) => [link.id, link.target_slot],
  ),
  [
    [830, 2],
    [831, 0],
    [832, 1],
  ],
);
assert.deepEqual(contestedOrderSet.pos, contestedPosition);

const slotActionGraph = useGraph(new MockGraph());
const slotActionSet = new AstralSetGroupNode();
slotActionSet.type = SET_GROUP_NODE;
slotActionGraph.add(slotActionSet);
const slotActionModel = addSource(slotActionGraph, "action_model", "MODEL");
const slotActionClip = addSource(slotActionGraph, "action_clip", "CLIP");
const slotActionImage = addSource(slotActionGraph, "action_image", "IMAGE");
attachSource(slotActionSet, 0, slotActionModel, 810);
attachSource(slotActionSet, 1, slotActionClip, 811);
attachSource(slotActionSet, 2, slotActionImage, 812);
const slotActionGet = new AstralGetGroupNode();
slotActionGet.type = GET_GROUP_NODE;
slotActionGraph.add(slotActionGet);
slotActionGet.onPortNamesChanged("action_model, action_clip, action_image");
const clipSlotMenu = slotActionSet.getSlotMenuOptions({
  input: slotActionSet.inputs[1],
  slot: 1,
});
assert.equal(
  clipSlotMenu.find((option) => option?.title === "Disconnect Links")
    ?.callback(),
  true,
);
assert.equal(slotActionSet.inputs.length, 3);
assert.equal(slotActionSet.size[1], 88);
assert.equal(slotActionSet.inputs[1].link, 812);
assert.equal(slotActionSet.inputs[1].name, "action_image");
assert.equal(slotActionSet.inputs[2].link, null);
assert.equal(slotActionSet.inputs[2]._astralSetPlaceholder, true);
assert.equal(slotActionSet.inputs[2].label, undefined);
assert.equal(
  slotActionGraph.links.get(812).target_slot,
  1,
  "Compacting a disconnected middle slot must retarget the following link",
);
assert.deepEqual(
  Array.from(
    slotActionSet.getActivePorts(),
    (port) => [port.name, port.type],
  ),
  [
    ["action_model", "MODEL"],
    ["action_image", "IMAGE"],
  ],
);
assert.deepEqual(
  realOutputEntries(slotActionGet),
  [
    ["action_model", "MODEL"],
    ["action_clip", "CLIP"],
    ["action_image", "IMAGE"],
  ],
);
assert.equal(slotActionGet.getResolvedPort(1), null);

attachSource(slotActionSet, 2, slotActionClip, 813);
const removeSlotMenu = slotActionSet.getSlotMenuOptions({
  input: slotActionSet.inputs[1],
  slot: 1,
});
assert.equal(
  removeSlotMenu.find((option) => option?.title === "Remove Slot")
    ?.callback(),
  true,
);
assert.equal(slotActionSet.inputs.length, 3);
assert.equal(slotActionSet.size[1], 88);
assert.deepEqual(
  Array.from(
    slotActionSet.getActivePorts(),
    (port) => [port.name, port.type],
  ),
  [
    ["action_model", "MODEL"],
    ["action_clip", "CLIP"],
  ],
);
assert.deepEqual(
  realOutputEntries(slotActionGet),
  [
    ["action_model", "MODEL"],
    ["action_clip", "CLIP"],
    ["action_image", "IMAGE"],
  ],
);
assert.equal(slotActionGet.getResolvedPort(2), null);

const staleDisconnectGraph = useGraph(new MockGraph());
const staleDisconnectSet = staleDisconnectGraph.add(new AstralSetGroupNode());
staleDisconnectSet.type = SET_GROUP_NODE;
const staleDisconnectModel = addSource(
  staleDisconnectGraph,
  "stale_model",
  "MODEL",
);
const staleDisconnectClip = addSource(
  staleDisconnectGraph,
  "stale_clip",
  "CLIP",
);
const staleDisconnectImage = addSource(
  staleDisconnectGraph,
  "stale_image",
  "IMAGE",
);
attachSource(staleDisconnectSet, 0, staleDisconnectModel, 820);
attachSource(staleDisconnectSet, 1, staleDisconnectClip, 821);
attachSource(staleDisconnectSet, 2, staleDisconnectImage, 822);
const staleMiddleLink = staleDisconnectGraph.links.get(821);
const staleMiddleInput = staleDisconnectSet.inputs[1];
staleDisconnectSet.onConnectionsChange(
  LiteGraph.INPUT,
  1,
  false,
  staleMiddleLink,
  staleMiddleInput,
);
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(
  staleDisconnectGraph.links.get(821),
  undefined,
  "A disconnect callback must remove a stale link-store entry",
);
assert.equal(staleDisconnectSet.inputs.length, 3);
assert.deepEqual(
  Array.from(
    staleDisconnectSet.getActivePorts(),
    (port) => [port.name, port.type],
  ),
  [
    ["stale_model", "MODEL"],
    ["stale_image", "IMAGE"],
  ],
);
assert.equal(staleDisconnectSet.inputs[2]._astralSetPlaceholder, true);
assert.equal(
  staleDisconnectGraph.links.get(822).target_slot,
  1,
  "Slots after a deferred disconnect must be retargeted",
);

const getTarget = graph.add(new MockNode("Get Target"));
getTarget.addInput("alpha", "MASK");
const firstGetLinkId = getNode.connect(1, getTarget, 0).id;
assert.notEqual(
  AstralGetGroupNode.prototype.serialize,
  LiteGraph.LGraphNode.prototype.serialize,
  "GetGroup must serialize its live output links",
);
assert.deepEqual(
  getNode.serialize().outputs.map((output) => output.links),
  [null, [firstGetLinkId], null],
);
canvasDirtyCalls = 0;
getNode.refreshFromSetGroup();
assert.equal(
  canvasDirtyCalls,
  0,
  "Refreshing unchanged GetGroup must not mark the workflow dirty",
);
for (const output of getNode.outputs) delete output._astralPortId;
canvasDirtyCalls = 0;
getNode.refreshFromSetGroup();
assert.equal(
  getTarget.inputs[0].link,
  firstGetLinkId,
  "Deserialized GetGroup must preserve links while restoring output identities",
);
assert.equal(canvasDirtyCalls, 0);

getNode.setRequestedNames(["alpha", "ImAgEs"]);
assert.deepEqual(
  realOutputEntries(getNode),
  [
    ["alpha", "MASK"],
    ["images", "IMAGE"],
  ],
);
assert.notEqual(getTarget.inputs[0].link, null);
const reorderedLink = graph.links.get(getTarget.inputs[0].link);
assert.equal(reorderedLink.origin_slot, 0);

const firstPortId = setNode.getPortId(0);
setNode.properties.portNames[firstPortId] = "photo";
setNode.assignPortNames();
setNode.syncEndpoint();
setNode.notifyGetters();
assert.equal(setNode.title, "SetGroup_photo");
assert.equal(
  getNode.getResolvedPort(1)?.name,
  "photo",
  "GetGroup must follow a renamed SetGroup port by its stable port identity",
);
assert.deepEqual(
  Array.from(getNode.getRequestedNames()),
  ["alpha", "photo"],
);
getNode.setRequestedNames(["alpha", "photo"]);
assert.deepEqual(
  realOutputEntries(getNode),
  [
    ["alpha", "MASK"],
    ["photo", "IMAGE"],
  ],
);
assert.equal(getNode.getInputLink(1)?.id, 100);
assert.notEqual(getTarget.inputs[0].link, null);

const mismatchGraph = useGraph(new MockGraph());
const imageSet = createSet(mismatchGraph, "image", "IMAGE", 200);
createSet(mismatchGraph, "video", "VIDEO", 201);
const mismatchGet = new AstralGetGroupNode();
mismatchGet.type = GET_GROUP_NODE;
mismatchGraph.add(mismatchGet);
mismatchGet.onPortNamesChanged("image");
const imageTarget = mismatchGraph.add(new MockNode("Image Target"));
imageTarget.addInput("model", "MODEL");
mismatchGet.connect(0, imageTarget, 0);
assert.notEqual(imageTarget.inputs[0].link, null);
mismatchGet.setRequestedNames(["video"]);
assert.equal(
  imageTarget.inputs[0].link,
  null,
  "A link must be dropped rather than silently connected to an incompatible type",
);
assert.equal(mismatchGet.getInputLink(0)?.id, 201);
assert.equal(imageSet.node.title, "SetGroup_image");

const typeSwapGraph = useGraph(new MockGraph());
const typeSwapSet = new AstralSetGroupNode();
typeSwapSet.type = SET_GROUP_NODE;
typeSwapGraph.add(typeSwapSet);
const modelSource = addSource(typeSwapGraph, "model_source", "MODEL");
attachSource(typeSwapSet, 0, modelSource, 450);
assert.equal(typeSwapSet.inputs[0].type, "*");
assert.equal(typeSwapSet.outputs.length, 0);
typeSwapGraph.removeLink(typeSwapSet.inputs[0].link);
typeSwapSet.onConnectionsChange(LiteGraph.INPUT, 0, false);
assert.equal(typeSwapSet.outputs.length, 0);
const clipSource = addSource(typeSwapGraph, "clip_source", "CLIP");
attachSource(typeSwapSet, 0, clipSource, 451);
assert.equal(
  typeSwapSet.inputs[0].type,
  "*",
  "SetG must keep its input wildcard so the source can be replaced with another type",
);
assert.equal(typeSwapSet.outputs.length, 0);
assert.equal(typeSwapSet.getActivePorts()[0].type, "CLIP");

const incrementGraph = useGraph(new MockGraph());
const modelSet = createSet(incrementGraph, "model_input", "MODEL", 700);
const dynamicGet = new AstralGetGroupNode();
dynamicGet.type = GET_GROUP_NODE;
incrementGraph.add(dynamicGet);
const dynamicModelTarget = incrementGraph.add(new MockNode("Dynamic Model Target"));
dynamicModelTarget.addInput("model", "MODEL");
const dynamicModelLink = dynamicGet.connect(0, dynamicModelTarget, 0);
dynamicGet.onConnectionsChange(LiteGraph.OUTPUT, 0, true, dynamicModelLink);
assert.deepEqual(
  Array.from(dynamicGet.properties.getPortNames),
  ["model_input"],
  "Connecting GetGroup's empty output must bind a matching SetG port",
);
assert.deepEqual(realOutputEntries(dynamicGet), [["model_input", "MODEL"]]);
assert.equal(dynamicGet.outputs.length, 2);
assert.equal(dynamicGet.outputs[1]._astralGetPlaceholder, true);
assert.equal(dynamicModelTarget.inputs[0].link, dynamicModelLink.id);
assert.equal(dynamicGet.getResolvedPort(0)?.setNode, modelSet.node);

const widthMigrationGraph = useGraph(new MockGraph());
const legacyWidthSet = new AstralSetGroupNode();
legacyWidthSet.type = SET_GROUP_NODE;
legacyWidthSet.size = [160, 32];
assert.equal(legacyWidthSet.properties.setGetWidthVersion, undefined);
widthMigrationGraph.add(legacyWidthSet);
assert.equal(legacyWidthSet.size[0], 80);
assert.equal(legacyWidthSet.properties.setGetWidthVersion, 3);

const customWidthSet = new AstralSetGroupNode();
customWidthSet.type = SET_GROUP_NODE;
customWidthSet.size = [260, 32];
widthMigrationGraph.add(customWidthSet);
assert.equal(
  customWidthSet.size[0],
  130,
  "The first load after the width update must halve a user-resized SetGroup",
);
assert.equal(customWidthSet.properties.setGetWidthVersion, 3);
customWidthSet.migrateDefaultWidth();
assert.equal(
  customWidthSet.size[0],
  130,
  "Width migration must not halve the node again on later loads",
);

createSet(incrementGraph, "clip_input", "CLIP", 701);
const placeholderJumpMenu = dynamicGet.getSlotMenuOptions({
  output: dynamicGet.outputs[1],
});
assert.deepEqual(
  placeholderJumpMenu.slice(0, 1).map((entry) => entry.content),
  ["跳转到对应 SetGroup"],
);
assert.equal(placeholderJumpMenu[0].disabled, true);
assert.equal(
  placeholderJumpMenu.some(
    (entry) => entry.content.includes("model_input"),
  ),
  true,
);
assert.equal(
  placeholderJumpMenu.some(
    (entry) => entry.content.includes("clip_input"),
  ),
  true,
);
assert.equal(
  placeholderJumpMenu.some(
    (entry) => entry.content === "选择 SetGroup 端口",
  ),
  false,
);
const placeholderPortChoices = dynamicGet.getPortChoiceOptions(1);
const clipMenuEntry = placeholderPortChoices.find(
  (entry) => entry.content.includes("clip_input"),
);
assert.ok(clipMenuEntry);
assert.equal(clipMenuEntry.disabled, false);
clipMenuEntry.callback();
assert.deepEqual(
  Array.from(dynamicGet.properties.getPortNames),
  ["model_input", "clip_input"],
);
assert.deepEqual(
  realOutputEntries(dynamicGet),
  [
    ["model_input", "MODEL"],
    ["clip_input", "CLIP"],
  ],
);
assert.equal(dynamicGet.outputs.length, 3);
assert.equal(dynamicGet.outputs[2]._astralGetPlaceholder, true);
const boundPortChoices = dynamicGet.getPortChoiceOptions(0);
assert.equal(
  boundPortChoices.find((entry) => entry.content.includes("model_input"))?.content.startsWith("✓"),
  true,
);
assert.equal(
  boundPortChoices.find((entry) => entry.content.includes("clip_input"))?.disabled,
  true,
);

const rebindGraph = useGraph(new MockGraph());
const modelSetOne = createSet(rebindGraph, "model_a", "MODEL", 710);
const modelSetTwo = createSet(rebindGraph, "model_b", "MODEL", 711);
const rebindGet = new AstralGetGroupNode();
rebindGet.type = GET_GROUP_NODE;
rebindGraph.add(rebindGet);
rebindGet.onPortNamesChanged("model_a");
const rebindTarget = rebindGraph.add(new MockNode("Rebind Target"));
rebindTarget.addInput("model", "MODEL");
const preservedLink = rebindGet.connect(0, rebindTarget, 0);
const originalTargetLink = rebindTarget.inputs[0].link;
const rebindMenu = rebindGet.getPortChoiceOptions(0);
const modelSetTwoEntry = rebindMenu.find(
  (entry) => entry.content.includes("model_b"),
);
assert.ok(modelSetTwoEntry);
assert.equal(modelSetTwoEntry.disabled, false);
modelSetTwoEntry.callback();
assert.deepEqual(
  Array.from(rebindGet.properties.getPortNames),
  ["model_b"],
  "Choosing another SetG port must replace the selected output binding",
);
assert.equal(
  rebindTarget.inputs[0].link,
  originalTargetLink,
  "Choosing another compatible SetG port must preserve the existing target link",
);
assert.equal(rebindTarget.inputs[0].link, preservedLink.id);
assert.equal(rebindGet.getResolvedPort(0)?.setNode, modelSetTwo.node);
assert.notEqual(modelSetTwo.node, modelSetOne.node);

const earlyCallbackGraph = useGraph(new MockGraph());
const earlySet = createSet(earlyCallbackGraph, "early_model", "MODEL", 720);
const earlyGet = new AstralGetGroupNode();
earlyGet.type = GET_GROUP_NODE;
earlyCallbackGraph.add(earlyGet);
const earlyTarget = earlyCallbackGraph.add(new MockNode("Early Callback Target"));
earlyTarget.addInput("model", "MODEL");
const earlyLink = earlyGet.connect(0, earlyTarget, 0);
earlyGet.outputs[0].links = [];
earlyGet.onConnectionsChange(LiteGraph.OUTPUT, 0, true, earlyLink);
assert.deepEqual(
  Array.from(earlyGet.properties.getPortNames),
  ["early_model"],
  "The connection callback must identify the target from its link info before output.links is updated",
);
assert.equal(earlyGet.getResolvedPort(0)?.setNode, earlySet.node);
assert.equal(earlyLink.type, "MODEL");
assert.equal(earlyGet.outputs[1]._astralGetPlaceholder, true);

const ambiguousGraph = useGraph(new MockGraph());
const duplicateSetOne = createSet(ambiguousGraph, "duplicate", "IMAGE", 300);
const hintedGet = new AstralGetGroupNode();
hintedGet.type = GET_GROUP_NODE;
ambiguousGraph.add(hintedGet);
hintedGet.onPortNamesChanged("duplicate");
const hintedTarget = ambiguousGraph.add(new MockNode("Hinted Target"));
hintedTarget.addInput("image", "IMAGE");
hintedGet.connect(0, hintedTarget, 0);
const duplicateSetTwo = createSet(ambiguousGraph, "duplicate", "IMAGE", 301);
duplicateSetTwo.node.applyPortName("duplicate", {
  makeUnique: false,
  updatePrimary: true,
  notify: false,
});
duplicateSetTwo.node.syncEndpoint();
duplicateSetTwo.node.notifyGetters();
assert.equal(
  hintedGet.getResolvedPort(0)?.setNode,
  duplicateSetOne.node,
  "A saved SetG identity must disambiguate duplicate port names",
);
assert.equal(duplicateSetTwo.node.title, "SetGroup_duplicate");
const ambiguousGet = new AstralGetGroupNode();
ambiguousGet.type = GET_GROUP_NODE;
ambiguousGraph.add(ambiguousGet);
ambiguousGet.onPortNamesChanged("duplicate");
assert.equal(ambiguousGet.getDesiredPorts()[0].resolved, false);
assert.equal(ambiguousGet.getResolvedPort(0), null);
assert.equal(ambiguousGet.getInputLink(0), null);

const legacyGraph = useGraph(new MockGraph());
const legacySet = new AstralSetGroupNode();
legacySet.type = SET_GROUP_NODE;
legacySet.properties.groupName = "legacy_root";
legacyGraph.add(legacySet);
legacySet.addInput("*", "*");
const legacySourceOne = addSource(legacyGraph, "legacy_image", "IMAGE");
const legacySourceTwo = addSource(legacyGraph, "legacy_alpha", "MASK");
attachSource(legacySet, 0, legacySourceOne, 400);
attachSource(legacySet, 1, legacySourceTwo, 401);
legacySet.ensurePortIdentities();
legacySet.assignPortNames();
legacySet.applyPortName("legacy_root", {
  makeUnique: false,
  updatePrimary: true,
  notify: false,
});
legacySet.syncEndpoint();
assert.deepEqual(
  Array.from(legacySet.getActivePorts(), (port) => [port.name, port.type]),
  [
    ["legacy_root", "IMAGE"],
    ["legacy_alpha", "MASK"],
  ],
);

const legacyGet = new AstralGetGroupNode();
legacyGet.type = GET_GROUP_NODE;
legacyGet.properties.setGroupId = legacySet.id;
legacyGet.widgets[0].value = String(legacySet.id);
legacyGet.removeOutput(0);
legacyGet.addOutput("legacy_image", "IMAGE");
legacyGet.addOutput("legacy_alpha", "MASK");
legacyGraph.add(legacyGet);
legacyGet.migrateLegacyBinding();
legacyGet.refreshFromSetGroup();
assert.deepEqual(
  Array.from(legacyGet.properties.getPortNames),
  ["legacy_root", "legacy_alpha"],
);
assert.deepEqual(
  realOutputEntries(legacyGet),
  [
    ["legacy_root", "IMAGE"],
    ["legacy_alpha", "MASK"],
  ],
);

const configureGraph = useGraph(new MockGraph());
const configuredSet = new AstralSetGroupNode();
configuredSet.type = SET_GROUP_NODE;
configureGraph.add(configuredSet);
// LiteGraph's configure() replaces the constructor's properties object with
// the saved object. Older SetG data has no portIds or portNames maps.
configuredSet.properties = { groupName: "legacy_configured" };
configuredSet.addOutput("*", "*");
const configuredSource = addSource(configureGraph, "configured_image", "IMAGE");
app.configuringGraph = true;
attachSource(configuredSet, 0, configuredSource, 402);
configuredSet.onConfigure();
await new Promise((resolve) => setTimeout(resolve, 0));
app.configuringGraph = false;
assert.deepEqual(configuredSet.properties.portIds, {
  0: configuredSet.inputs[0]._astralPortId,
});
assert.equal(typeof configuredSet.properties.portNames, "object");
assert.equal(configuredSet.inputs[0].name, "configured_image");
assert.equal(configuredSet.outputs.length, 0);

const reloadGraph = useGraph(new MockGraph());
const reloadModelSource = addSource(reloadGraph, "MODEL", "MODEL");
const reloadClipSource = addSource(reloadGraph, "CLIP", "CLIP");
const reloadSet = new AstralSetGroupNode();
reloadSet.type = SET_GROUP_NODE;
reloadSet.id = 120;
reloadSet.getInputLink = () => null;
let onAddedCompactions = 0;
const compactReloadSetInputs = reloadSet.compactSetInputs;
reloadSet.compactSetInputs = function compactReloadSetInputsForTest(...args) {
  onAddedCompactions += 1;
  return compactReloadSetInputs.call(this, ...args);
};

// Workflow links are restored before the node. Their serialized target slots
// may be stale until configure() restores the matching input.link values.
for (const [id, source, sourceSlot, targetSlot] of [
  [9101, reloadModelSource, 0, 20],
  [9102, reloadClipSource, 0, 21],
]) {
  const output = source.outputs[sourceSlot];
  reloadGraph.links.set(id, {
    id,
    origin_id: source.id,
    origin_slot: sourceSlot,
    target_id: reloadSet.id,
    target_slot: targetSlot,
    type: output.type,
    resolve: () => ({
      output,
      outputNode: source,
      inputNode: reloadSet,
    }),
  });
}

// MockGraph.add() invokes onAdded() before configure() restores saved inputs.
reloadGraph.add(reloadSet);
assert.equal(
  onAddedCompactions,
  0,
  "onAdded() must not compact constructor placeholders before inputs are restored",
);

reloadSet.inputs.splice(
  0,
  reloadSet.inputs.length,
  { name: "*", type: "*", link: 9101 },
  { name: "*", type: "*", link: 9102 },
);
reloadSet.properties = {
  groupName: "reload_group",
  portName: "模型",
  portIds: {
    0: "reload_model_port",
    1: "reload_clip_port",
  },
  portNames: {
    reload_model_port: "模型",
    reload_clip_port: "CLIP",
  },
};

app.configuringGraph = true;
reloadSet.onConfigure();
await new Promise((resolve) => setTimeout(resolve, 0));
app.configuringGraph = false;

assert.equal(reloadSet.inputs[0].link, 9101);
assert.equal(reloadSet.inputs[1].link, 9102);
assert.equal(reloadGraph.links.get(9101).target_slot, 0);
assert.equal(reloadGraph.links.get(9102).target_slot, 1);
assert.equal(reloadSet.inputs[0].name, "模型");
assert.equal(reloadSet.inputs[1].name, "CLIP");
assert.equal(reloadSet.properties.portIds[0], "reload_model_port");
assert.equal(reloadSet.properties.portIds[1], "reload_clip_port");
assert.equal(reloadSet.properties.portNames.reload_model_port, "模型");
assert.equal(reloadSet.properties.portNames.reload_clip_port, "CLIP");
assert.equal(reloadSet.inputs[2]?._astralSetPlaceholder, true);

const lateGraph = useGraph(new MockGraph());
const lateGet = new AstralGetGroupNode();
lateGet.type = GET_GROUP_NODE;
lateGraph.add(lateGet);
lateGet.onPortNamesChanged("late_image");
const lateTarget = lateGraph.add(new MockNode("Late Target"));
lateTarget.addInput("image", "IMAGE");
lateGet.connect(0, lateTarget, 0);
const firstLateLink = lateTarget.inputs[0].link;
assert.notEqual(firstLateLink, null);
const lateSet = createSet(lateGraph, "late_image", "IMAGE", 500);
assert.notEqual(lateTarget.inputs[0].link, null);
assert.notEqual(lateTarget.inputs[0].link, firstLateLink);
assert.equal(lateSet.node.inputs[0].name, "late_image");
assert.equal(lateGet.outputs[0].name, "late_image");
assert.equal(lateGet.outputs[0].type, "IMAGE");
const restoredLateLink = lateGraph.links.get(lateTarget.inputs[0].link);
assert.equal(restoredLateLink.origin_id, lateGet.id);
assert.equal(restoredLateLink.origin_slot, 0);

const capGraph = useGraph(new MockGraph());
const capGet = new AstralGetGroupNode();
capGet.type = GET_GROUP_NODE;
capGraph.add(capGet);
capGet.onPortNamesChanged(
  Array.from({ length: MAX_GET_PORTS + 5 }, (_value, index) => `port_${index + 1}`)
    .join(", "),
);
assert.equal(capGet.properties.getPortNames.length, MAX_GET_PORTS);
assert.equal(capGet.outputs.length, MAX_GET_PORTS);
assert.equal(
  capGet.widgets[0].value,
  Array.from({ length: MAX_GET_PORTS }, (_value, index) => `port_${index + 1}`)
    .join(", "),
);

const canvasPrompt = app.canvas.prompt;
const canvasElement = app.canvas.canvas;
app.canvas = {
  canvas: canvasElement,
  graph: null,
  prompt: canvasPrompt,
  setDirty() {},
  selectNode() {},
};
assert.equal(installConnectionMenuEntries(), false);
assert.equal(app.canvas.__astralSetGetConnectionMenuInstalled, undefined);

class FakeContextMenu {
  constructor(options, menuOptions) {
    this.options = options;
    this.menuOptions = menuOptions;
    FakeContextMenu.last = this;
  }
}

let originalMenuCallbacks = 0;
app.canvas.showConnectionMenu = function () {
  new LiteGraph.ContextMenu(["Add Reroute", "Add Node"], {
    callback() {
      originalMenuCallbacks += 1;
    },
  });
  // ComfyUI versions differ here; the wrapper must not depend on a return value.
};
LiteGraph.ContextMenu = FakeContextMenu;
assert.equal(installConnectionMenuEntries(), true);
assert.equal(app.canvas.__astralSetGetConnectionMenuInstalled, true);
assert.equal(installConnectionMenuEntries(), true);

const outputGraph = useGraph(new MockGraph());
const menuSource = addSource(outputGraph, "IMAGE", "IMAGE");
assert.equal(app.canvas.showConnectionMenu({
  nodeFrom: menuSource,
  slotFrom: 0,
  e: { canvasX: 120, canvasY: 80 },
}), undefined);
const outputMenu = FakeContextMenu.last;
assert.equal(LiteGraph.ContextMenu, FakeContextMenu);
assert.equal(outputMenu.options.includes("添加 设置节点组"), true);
outputMenu.menuOptions.callback("添加 设置节点组", {}, {});
const menuSet = outputGraph._nodes.find((node) => node.type === SET_GROUP_NODE);
assert.ok(menuSet);
assert.equal(menuSource.outputs[0].links.length, 1);
menuSet.onConnectionsChange(LiteGraph.INPUT, 0, true);
assert.equal(menuSet.properties.portName, "IMAGE");

const inputGraph = useGraph(new MockGraph());
const inputSet = inputGraph.add(new AstralSetGroupNode());
inputSet.type = SET_GROUP_NODE;
const inputSource = addSource(inputGraph, "MODEL", "MODEL");
attachSource(inputSet, 0, inputSource, 600);
const inputTarget = inputGraph.add(new MockNode("Target"));
inputTarget.addInput("model", "MODEL");
app.canvas.showConnectionMenu({
  nodeTo: inputTarget,
  slotTo: 0,
  e: { canvasX: 240, canvasY: 160 },
});
const inputMenu = FakeContextMenu.last;
assert.equal(inputMenu.options.includes("获取设置节点组"), true);
inputMenu.menuOptions.callback("获取设置节点组", {}, {});
const inputMenuGet = inputGraph._nodes.find((node) => node.type === GET_GROUP_NODE);
assert.ok(inputMenuGet);
assert.deepEqual(Array.from(inputMenuGet.pos), [240, 160]);
assert.deepEqual(Array.from(inputMenuGet.properties.getPortNames), ["MODEL"]);
assert.notEqual(inputTarget.inputs[0].link, null);
inputMenu.menuOptions.callback("Add Node", {}, {});
assert.equal(originalMenuCallbacks, 1);

const nativePromptGraph = useGraph(new MockGraph());
const nativePromptSet = nativePromptGraph.add(new AstralSetGroupNode());
nativePromptSet.type = SET_GROUP_NODE;
const nativePromptSource = addSource(nativePromptGraph, "native_image", "IMAGE");
attachSource(nativePromptSet, 0, nativePromptSource, 700);
canvasPromptResults.push("renamed_native");
await nativePromptSet.renamePort(0, { clientX: 320, clientY: 180 });
assert.deepEqual(canvasPromptCalls.at(-1), {
  title: "Slot name",
  value: "native_image",
  event: {
    clientX: 320,
    clientY: 180,
  },
  multiline: false,
});
assert.equal(nativePromptSet.inputs[0].name, "renamed_native");
assert.equal(nativePromptSet.title, "SetGroup_renamed_native");

const nativePromptGet = nativePromptGraph.add(new AstralGetGroupNode());
nativePromptGet.type = GET_GROUP_NODE;
canvasPromptResults.push("renamed_native, second");
await nativePromptGet.editPortNames({ clientX: 400, clientY: 220 });
assert.deepEqual(canvasPromptCalls.at(-1), {
  title: "Slot name",
  value: "",
  event: {
    clientX: 400,
    clientY: 220,
  },
  multiline: false,
});
assert.deepEqual(
  Array.from(nativePromptGet.getRequestedNames()),
  ["renamed_native", "second"],
);

const interactionGraph = useGraph(new MockGraph());
const interactionSet = interactionGraph.add(new AstralSetGroupNode());
interactionSet.type = SET_GROUP_NODE;
const interactionSource = addSource(interactionGraph, "port_interaction", "IMAGE");
attachSource(interactionSet, 0, interactionSource, 701);
const nativePointerClicks = [];
const nativePointerClick = (event) => nativePointerClicks.push(event);
const nativePointerDoubleClicks = [];
const nativePointerDoubleClick = (event) => {
  nativePointerDoubleClicks.push(event);
};
const interactionPointer = {
  onClick: nativePointerClick,
  onDoubleClick: nativePointerDoubleClick,
  onDragStart: () => {},
};
app.canvas.pointer = interactionPointer;
const nativePointerDragStart = interactionPointer.onDragStart;
const resetPointer = () => {
  interactionPointer.onClick = nativePointerClick;
  interactionPointer.onDoubleClick = nativePointerDoubleClick;
  interactionPointer.onDragStart = nativePointerDragStart;
};

assert.equal(interactionSet.getPortNameHit([18, 14]), null);
assert.equal(
  interactionSet.onMouseDown({ button: 0 }, [18, 14], app.canvas),
  false,
  "Clicking the side line must fall through to native node dragging",
);
assert.deepEqual(
  interactionSet.getPortNameHit([70, 14]),
  { slot: 0, direction: -1 },
);
assert.deepEqual(
  interactionSet.getPortNameHit([70, 34]),
  { slot: 0, direction: 1 },
);
assert.equal(
  interactionSet.onMouseDown({ button: 0, shiftKey: true }, [70, 14], app.canvas),
  false,
  "Modifier clicks must retain native selection behavior",
);

resetPointer();
assert.equal(
  interactionSet.onMouseDown({ button: 0 }, [70, 14], app.canvas),
  false,
  "Port-name handling must wait for LGraphCanvas to install drag callbacks",
);
await Promise.resolve();
assert.equal(
  typeof interactionPointer.onDragStart,
  "function",
  "Port-name dragging must install a reorder handler",
);
assert.notEqual(
  interactionPointer.onDragStart,
  nativePointerDragStart,
  "Port-name dragging must replace native node dragging",
);
interactionPointer.onClick({ kind: "click" });
assert.equal(interactionSet._astralPendingPortClick?.direction, -1);
assert.equal(nativePointerClicks.length, 1);
const interactionMoveCalls = [];
interactionSet.movePort = (slot, direction) => {
  interactionMoveCalls.push([slot, direction]);
  return true;
};
assert.equal(interactionSet.applyPendingPortClick(), true);
assert.deepEqual(interactionMoveCalls, [[0, -1]]);

resetPointer();
interactionSet.onMouseDown({ button: 0 }, [70, 34], app.canvas);
interactionPointer.onClick({ kind: "click" });
assert.equal(interactionSet._astralPendingPortClick?.direction, 1);
assert.equal(interactionSet.applyPendingPortClick(), true);
assert.deepEqual(interactionMoveCalls, [[0, -1], [0, 1]]);

let renamedByDoubleClick = null;
let renameEventByDoubleClick = null;
interactionSet.renamePort = async (slot, event) => {
  renamedByDoubleClick = slot;
  renameEventByDoubleClick = event;
};
resetPointer();
interactionSet.onMouseDown({ button: 0 }, [70, 14], app.canvas);
interactionPointer.onClick({ kind: "click" });
assert.ok(interactionSet._astralPendingPortClick);
interactionPointer.onDoubleClick({
  kind: "double",
  clientX: 280,
  clientY: 160,
});
await Promise.resolve();
assert.equal(interactionSet._astralPendingPortClick, null);
assert.equal(renamedByDoubleClick, 0);
assert.equal(renameEventByDoubleClick?.clientX, 280);
assert.equal(nativePointerDoubleClicks.length, 1);

const dragReorderGraph = useGraph(new MockGraph());
const dragReorderSet = dragReorderGraph.add(new AstralSetGroupNode());
dragReorderSet.type = SET_GROUP_NODE;
dragReorderSet.pos = [100, 50];
const dragReorderModel = addSource(
  dragReorderGraph,
  "drag_model",
  "MODEL",
);
const dragReorderClip = addSource(
  dragReorderGraph,
  "drag_clip",
  "CLIP",
);
const dragReorderImage = addSource(
  dragReorderGraph,
  "drag_image",
  "IMAGE",
);
attachSource(dragReorderSet, 0, dragReorderModel, 850);
attachSource(dragReorderSet, 1, dragReorderClip, 851);
attachSource(dragReorderSet, 2, dragReorderImage, 852);
const dragPointer = {
  eDown: { canvasX: 170, canvasY: 64 },
  onClick() {},
  onDoubleClick() {},
  onDragStart() {},
};
app.canvas.pointer = dragPointer;
assert.equal(
  dragReorderSet.onMouseDown(
    { button: 0 },
    [70, dragReorderSet.inputs[0].pos[1]],
    app.canvas,
  ),
  false,
);
await Promise.resolve();
assert.equal(
  typeof dragPointer.onDragEnd,
  "function",
  "Port reorder must install a custom drag lifecycle",
);
const dragNodePosition = [...dragReorderSet.pos];
dragPointer.onDragStart(dragPointer, {
  canvasY: dragReorderSet.pos[1] + dragReorderSet.inputs[0].pos[1],
});
assert.ok(dragReorderSet._astralPortDragState);
dragPointer.onDrag({
  canvasY: dragReorderSet.pos[1] + dragReorderSet.inputs[2].pos[1],
});
assert.equal(dragReorderSet._astralPortDragState?.targetSlot, 2);
assert.equal(
  dragPointer.onDragEnd({
    canvasY: dragReorderSet.pos[1] + dragReorderSet.inputs[2].pos[1],
  }),
  true,
);
assert.deepEqual(
  Array.from(dragReorderSet.getActivePorts(), (port) => port.name),
  ["drag_clip", "drag_image", "drag_model"],
);
assert.equal(dragReorderGraph.links.get(850).target_slot, 2);
assert.equal(dragReorderGraph.links.get(851).target_slot, 0);
assert.equal(dragReorderGraph.links.get(852).target_slot, 1);
assert.deepEqual(
  dragReorderSet.pos,
  dragNodePosition,
  "Reordering a port must not move the node",
);

const getReorderGraph = useGraph(new MockGraph());
const getReorderSet = getReorderGraph.add(new AstralSetGroupNode());
getReorderSet.type = SET_GROUP_NODE;
const getReorderModel = addSource(getReorderGraph, "get_model", "MODEL");
const getReorderClip = addSource(getReorderGraph, "get_clip", "CLIP");
const getReorderImage = addSource(getReorderGraph, "get_image", "IMAGE");
attachSource(getReorderSet, 0, getReorderModel, 860);
attachSource(getReorderSet, 1, getReorderClip, 861);
attachSource(getReorderSet, 2, getReorderImage, 862);
const getReorderNode = getReorderGraph.add(new AstralGetGroupNode());
getReorderNode.type = GET_GROUP_NODE;
getReorderNode.onPortNamesChanged("get_model, get_clip, get_image");
const getReorderGraphPos = getReorderNode.pos;
const getReorderWidth = getReorderNode.size[0];
const getReorderBraceX = getReorderGraphPos[0] + getReorderWidth;
const getReorderFirstSlot = getReorderNode.outputs[0];
const nativeOutputHitAt = (x, y) => (
  getReorderNode.outputs.some((_output, index) => {
    const pos = getReorderNode.getOutputPos(index);
    return (
      x >= pos[0] - 15
      && x < pos[0] + 15
      && y >= pos[1] - 10
      && y < pos[1] + 10
    );
  })
);
assert.equal(
  nativeOutputHitAt(
    getReorderGraphPos[0] + getReorderFirstSlot.pos[0],
    getReorderGraphPos[1] + getReorderFirstSlot.pos[1],
  ),
  true,
  "The visible GetGroup output dot must remain connectable",
);
assert.equal(
  nativeOutputHitAt(
    getReorderBraceX,
    getReorderGraphPos[1] + getReorderFirstSlot.pos[1],
  ),
  false,
  "The GetGroup brace must not be swallowed by LiteGraph's output hit box",
);
assert.equal(
  nativeOutputHitAt(
    getReorderBraceX - 1,
    getReorderGraphPos[1] + getReorderFirstSlot.pos[1],
  ),
  false,
  "The visible GetGroup brace stroke must not start a native link drag",
);
assert.deepEqual(
  getReorderNode.getPortNameHit([120, 14]),
  { slot: 0, direction: -1 },
);
assert.deepEqual(
  getReorderNode.getPortNameHit([120, 34]),
  { slot: 0, direction: 1 },
);
assert.equal(
  getReorderNode.getSlotInPosition(120, 14)?.output,
  getReorderNode.outputs[0],
  "GetGroup output names must be hit-testable across their full label",
);
assert.equal(
  getReorderNode.getSlotInPosition(
    getReorderNode.size[0],
    getReorderNode.outputs[0].pos[1],
  ),
  null,
  "GetGroup's right-hand brace must not be captured by the nearby output slot",
);

const getClickPointer = {
  onClick() { this.clickCount = (this.clickCount || 0) + 1; },
  onDoubleClick() {},
  onDragStart() {},
};
app.canvas.pointer = getClickPointer;
const getClickMoveCalls = [];
const getGroupMovePort = getReorderNode.movePort;
getReorderNode.movePort = (slot, direction) => {
  getClickMoveCalls.push([slot, direction]);
  return true;
};
getReorderNode.onMouseDown({ button: 0 }, [120, 14], app.canvas);
await Promise.resolve();
getClickPointer.onClick({ kind: "click" });
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(getClickPointer.clickCount, 1);
assert.ok(getReorderNode._astralPendingPortClick == null);
assert.deepEqual(
  getClickMoveCalls,
  [],
  "A plain GetGroup port-label click must not reorder the port",
);

let getDoubleClickSlot = null;
let getDoubleClickEvent = null;
getReorderNode.showPortChoiceMenu = (slot, event) => {
  getDoubleClickSlot = slot;
  getDoubleClickEvent = event;
  return true;
};
getReorderNode.onMouseDown({ button: 0 }, [120, 34], app.canvas);
getClickPointer.onClick({ kind: "click" });
getClickPointer.onDoubleClick({
  kind: "double",
  clientX: 280,
  clientY: 160,
});
assert.ok(getReorderNode._astralPendingPortClick == null);
assert.equal(getDoubleClickSlot, 0);
assert.equal(getDoubleClickEvent?.clientX, 280);
getReorderNode.movePort = getGroupMovePort;

const nativeNodeDragStart = () => {};
const nativeNodeDrag = () => {};
const getBracePointer = {
  onClick() {},
  onDoubleClick() {},
  onDragStart: nativeNodeDragStart,
  onDrag: nativeNodeDrag,
};
app.canvas.pointer = getBracePointer;
assert.equal(
  getReorderNode.onMouseDown(
    { button: 0 },
    [getReorderNode.size[0], getReorderNode.outputs[0].pos[1]],
    app.canvas,
  ),
  false,
  "Clicking GetGroup's brace must fall through to native node dragging",
);
assert.equal(getBracePointer.onDragStart, nativeNodeDragStart);
assert.equal(getBracePointer.onDrag, nativeNodeDrag);

const getDragGraph = useGraph(new MockGraph());
const getDragSet = getDragGraph.add(new AstralSetGroupNode());
getDragSet.type = SET_GROUP_NODE;
const getDragModel = addSource(getDragGraph, "drag_get_model", "MODEL");
const getDragClip = addSource(getDragGraph, "drag_get_clip", "CLIP");
const getDragImage = addSource(getDragGraph, "drag_get_image", "IMAGE");
attachSource(getDragSet, 0, getDragModel, 870);
attachSource(getDragSet, 1, getDragClip, 871);
attachSource(getDragSet, 2, getDragImage, 872);
const getDragNode = getDragGraph.add(new AstralGetGroupNode());
getDragNode.type = GET_GROUP_NODE;
getDragNode.onPortNamesChanged("drag_get_model, drag_get_clip, drag_get_image");
const getDragTargets = [
  getDragGraph.add(new MockNode("Get Drag Model Target")),
  getDragGraph.add(new MockNode("Get Drag Clip Target")),
  getDragGraph.add(new MockNode("Get Drag Image Target")),
];
getDragTargets.forEach((target) => target.addInput("value", "*"));
getDragTargets.forEach((target, index) => (
  getDragNode.connect(index, target, 0)
));
const getDragPointer = {
  eDown: { canvasX: 250, canvasY: 64 },
  onClick() {},
  onDoubleClick() {},
  onDragStart() {},
};
app.canvas.pointer = getDragPointer;
getDragNode.onMouseDown({ button: 0 }, [120, 14], app.canvas);
await Promise.resolve();
const getDragNodePosition = [...getDragNode.pos];
getDragPointer.onDragStart(getDragPointer, {
  canvasY: getDragNode.pos[1] + getDragNode.outputs[0].pos[1],
});
getDragPointer.onDrag({
  canvasY: getDragNode.pos[1] + getDragNode.outputs[2].pos[1],
});
assert.equal(getDragNode._astralPortDragState?.targetSlot, 2);
assert.equal(
  getDragPointer.onDragEnd({
    canvasY: getDragNode.pos[1] + getDragNode.outputs[2].pos[1],
  }),
  true,
);
assert.deepEqual(
  Array.from(getDragNode.getRequestedNames()),
  ["drag_get_clip", "drag_get_image", "drag_get_model"],
);
assert.deepEqual(
  getDragTargets.map((target) => (
    getDragGraph.links.get(target.inputs[0].link)?.origin_slot
  )),
  [2, 0, 1],
  "Reordering GetGroup ports must move existing output links with their names",
);
assert.deepEqual(getDragNode.pos, getDragNodePosition);

const getChoiceGraph = useGraph(new MockGraph());
const getChoiceSet = getChoiceGraph.add(new AstralSetGroupNode());
getChoiceSet.type = SET_GROUP_NODE;
const getChoiceModel = addSource(getChoiceGraph, "choice_model", "MODEL");
const getChoiceClip = addSource(getChoiceGraph, "choice_clip", "CLIP");
attachSource(getChoiceSet, 0, getChoiceModel, 880);
attachSource(getChoiceSet, 1, getChoiceClip, 881);
const getChoiceNode = getChoiceGraph.add(new AstralGetGroupNode());
getChoiceNode.type = GET_GROUP_NODE;
getChoiceNode.onPortNamesChanged("choice_model");
const getChoiceTarget = getChoiceGraph.add(new MockNode("Get Choice Target"));
getChoiceTarget.addInput("value", "*");
getChoiceNode.connect(0, getChoiceTarget, 0);
assert.equal(
  getChoiceNode.showPortChoiceMenu(0, {
    canvasX: 220,
    canvasY: 140,
  }),
  true,
);
const getChoiceMenu = FakeContextMenu.last;
assert.equal(getChoiceMenu.menuOptions.title, "GetGroup 端口");
const getChoiceClipOption = getChoiceMenu.options.find(
  (option) => option?.content?.includes("choice_clip"),
);
assert.ok(getChoiceClipOption);
assert.equal(getChoiceClipOption.disabled, false);
getChoiceClipOption.callback();
assert.deepEqual(Array.from(getChoiceNode.getRequestedNames()), ["choice_clip"]);
assert.equal(getChoiceNode.outputs[0].type, "CLIP");
assert.notEqual(getChoiceTarget.inputs[0].link, null);
assert.equal(
  getChoiceGraph.links.get(getChoiceTarget.inputs[0].link)?.type,
  "CLIP",
);

const jumpGraph = useGraph(new MockGraph());
const jumpSetA = jumpGraph.add(new AstralSetGroupNode());
jumpSetA.type = SET_GROUP_NODE;
const jumpSourceA = addSource(jumpGraph, "jump_a", "MODEL");
attachSource(jumpSetA, 0, jumpSourceA, 890);
const jumpSetB = jumpGraph.add(new AstralSetGroupNode());
jumpSetB.type = SET_GROUP_NODE;
const jumpSourceB = addSource(jumpGraph, "jump_b", "IMAGE");
attachSource(jumpSetB, 0, jumpSourceB, 891);
const jumpGet = jumpGraph.add(new AstralGetGroupNode());
jumpGet.type = GET_GROUP_NODE;
jumpGet.onPortNamesChanged("jump_a, jump_b");

const jumpNodeMenu = [];
jumpGet.getExtraMenuOptions(null, jumpNodeMenu);
assert.equal(
  jumpNodeMenu.some((option) => option.content === "跳转到对应 SetGroup"),
  false,
  "GetGroup's node context menu must not jump to SetGroup",
);
const jumpPortMenu = jumpGet.getSlotMenuOptions({
  output: jumpGet.outputs[1],
  slot: 1,
});
assert.deepEqual(
  jumpPortMenu.slice(0, 1).map((option) => option.content),
  ["跳转到对应 SetGroup"],
);
assert.equal(jumpPortMenu[0].disabled, false);
assert.equal(
  jumpPortMenu.some((option) => option.content.includes("jump_a")),
  true,
);
assert.equal(
  jumpPortMenu.some((option) => option.content.includes("jump_b")),
  true,
);
assert.equal(
  jumpPortMenu.some((option) => option.content === "选择 SetGroup 端口"),
  false,
);

const jumpCenterCalls = [];
const jumpSelectCalls = [];
app.canvas.centerOnNode = (node) => jumpCenterCalls.push(node);
app.canvas.selectNode = (node, addToSelection) => {
  jumpSelectCalls.push([node, addToSelection]);
};
jumpPortMenu[0].callback();
assert.deepEqual(jumpCenterCalls, [jumpSetB]);
assert.deepEqual(jumpSelectCalls, [[jumpSetB, false]]);

const longRenameGraph = useGraph(new MockGraph());
const longRenameSet = longRenameGraph.add(new AstralSetGroupNode());
longRenameSet.type = SET_GROUP_NODE;
const longRenameSources = [
  ["image1", "IMAGE"],
  ["image2", "IMAGE"],
  ["image3", "IMAGE"],
  ["image4", "IMAGE"],
  ["image5", "IMAGE"],
  ["image6", "IMAGE"],
  ["image7", "IMAGE"],
  ["image8", "IMAGE"],
  ["系统提示词", "STRING"],
  ["随机种2", "INT"],
].map(([name, type], index) => (
  addSource(longRenameGraph, name, type)
));
longRenameSources.forEach((source, index) => {
  attachSource(longRenameSet, index, source, 900 + index);
});
assert.deepEqual(
  Array.from(longRenameSet.getActivePorts(), (port) => port.name),
  [
    "image1",
    "image2",
    "image3",
    "image4",
    "image5",
    "image6",
    "image7",
    "image8",
    "系统提示词",
    "随机种2",
  ],
);

const longRenameGet = longRenameGraph.add(new AstralGetGroupNode());
longRenameGet.type = GET_GROUP_NODE;
longRenameGet.onPortNamesChanged("image1, 系统提示词, 随机种2");
const longRenameTarget = longRenameGraph.add(new MockNode("Long Rename Target"));
longRenameTarget.addInput("value", "INT");
longRenameGet.connect(2, longRenameTarget, 0);
const longRenameIdsBefore = { ...longRenameSet.properties.portIds };
const longRenameTopLinkBefore = longRenameGraph.links.get(
  longRenameSet.inputs[0].link,
).id;
const bottomSlot = longRenameSet.getActivePorts()
  .find((port) => port.name === "随机种2")?.slot;
assert.equal(bottomSlot, 9);
const bottomLabelY = 14 + 20 * (bottomSlot + 0.5);
longRenameSet.pos = [100, 50];
const bottomPointerEvent = {
  button: 0,
  canvasX: 170,
  canvasY: longRenameSet.pos[1] + bottomLabelY,
};
assert.deepEqual(
  longRenameSet.getPortNameHit([70, 14], bottomPointerEvent),
  { slot: 9, direction: 1 },
  "The canvas event position must keep a lower SetGroup label from resolving to image1",
);

const longRenamePointer = {
  onClick() {},
  onDoubleClick() {},
  onDragStart() {},
};
app.canvas.pointer = longRenamePointer;
canvasPromptResults.push("随机种子");
longRenameSet.onMouseDown(
  bottomPointerEvent,
  [70, 14],
  app.canvas,
);
longRenamePointer.onDoubleClick({
  kind: "double",
  clientX: 280,
  clientY: 360,
});
await Promise.resolve();
await Promise.resolve();

assert.equal(longRenameSet.inputs[0].name, "image1");
assert.equal(longRenameSet.inputs[bottomSlot].name, "随机种子");
assert.equal(longRenameSet.title, "SetGroup_image1");
assert.equal(longRenameGraph.links.get(longRenameSet.inputs[0].link).id, longRenameTopLinkBefore);
assert.deepEqual(longRenameSet.properties.portIds, longRenameIdsBefore);
assert.deepEqual(
  Array.from(longRenameGet.getRequestedNames()),
  ["image1", "系统提示词", "随机种子"],
);
assert.equal(longRenameGet.getRealOutputs()[2]?.name, "随机种子");
assert.equal(longRenameGet.getRealOutputs()[2]?.type, "INT");
assert.notEqual(longRenameTarget.inputs[0].link, null);

app.canvas.pointer = interactionPointer;
resetPointer();
interactionSet.onMouseDown({ button: 0 }, [70, 14], app.canvas);
interactionPointer.onClick({ kind: "click" });
assert.ok(interactionSet._astralPendingPortClick);
interactionSet.onRemoved();
assert.equal(interactionSet._astralPendingPortClick, null);
assert.equal(
  interactionSet.getWidgetOnPos(0, 0, true),
  undefined,
  "Hidden widgets must not intercept SetGroup node dragging",
);
assert.equal(
  AstralGetGroupNode.prototype.getWidgetOnPos.call(interactionSet),
  undefined,
  "Hidden widgets must not intercept GetGroup node dragging",
);
app.canvas.pointer = null;

assert.match(source, /resolveVirtualOutput\(slot\)/);
assert.match(source, /getInputLink\(slot\)/);
assert.match(source, /parsePortNameList/);
assert.match(source, /MAX_GET_PORTS/);
assert.match(source, /添加 设置节点组/);
assert.match(source, /获取设置节点组/);
assert.match(source, /custom_nodes\.ComfyUI-Astral-Manage/);
assert.match(source, /beforeRegisterVueAppNodeDefs/);
assert.match(source, /decorateConnectionMenuOptions/);
assert.match(source, /canvas\.__astralSetGetConnectionMenuInstalled/);
assert.match(source, /display_name:\s*"SetGroup"/);
assert.doesNotMatch(source, /display_name:\s*"SetG"/);
assert.doesNotMatch(source, /showAstralPrompt/);
assert.match(source, /app\.canvas\?\.prompt/);
assert.match(source, /"Slot name"/);
assert.doesNotMatch(source, /向上移动端口|向下移动端口/);
assert.doesNotMatch(source, /label\s*=\s*"\+"/);
assert.doesNotMatch(source, /extensionManager\?\.dialog/);
assert.doesNotMatch(source, /insertPortAt|在此端口/);
assert.match(source, /onMouseDown\(event, localPos\)/);
assert.match(source, /getWidgetOnPos\(\)/);
assert.match(source, /schedulePortReorderHandlers/);
assert.match(source, /movePortTo\(slotIndexToMove, targetSlot\)/);

console.log("SetGroup/GetGroup named-port frontend checks passed.");
