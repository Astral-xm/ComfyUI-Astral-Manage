import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(packageRoot, "web", "ue", "connections.js");
let source = readFileSync(sourcePath, "utf8");

source = source.replace(/^import\s+[^\n]+\n?/gm, "");
source = source.replace(/^export\s+(?=function\b)/gm, "");
source += `
globalThis.__ueConnectionsTest = { input_changed, fix_inputs };
`;

const i18n = (text) => text;
const context = {
  console,
  setTimeout() {},
  clearTimeout() {},
  i18n,
  app: {
    ui: {
      settings: {
        getSettingValue() {
          return false;
        },
      },
    },
    canvas: {
      default_connection_color_byType: {
        CLIP: "#ff0",
        VAE: "#f00",
      },
    },
  },
  shared: {
    graph_being_configured: false,
  },
  Logger: {
    log() {},
    log_error() {},
    log_info() {},
    log_problem() {},
    log_detail() {},
  },
  get_real_node() {
    return null;
  },
  is_UEnode() {
    return true;
  },
  link_is_from_subgraph_input() {
    return false;
  },
  get_subgraph_input_type() {
    return null;
  },
  ue_callbacks: {
    register_allnode_callback() {},
  },
};
vm.createContext(context);
vm.runInContext(source, context, { filename: sourcePath });

const { input_changed, fix_inputs } = context.__ueConnectionsTest;

function makeNode(inputs, properties = {}) {
  return {
    id: 10,
    graph: {
      links: {},
    },
    inputs,
    properties: {
      ue_properties: {
        fixed_inputs: false,
        ...properties,
      },
    },
    addInput() {
      throw new Error("fixed inputs must not be added");
    },
    removeInput() {
      throw new Error("fixed inputs must not be removed");
    },
  };
}

const disconnected = makeNode([
  {
    name: "anything11",
    label: "CLIP",
    localized_name: "CLIP",
    type: "CLIP",
    color_on: "#ff0",
    link: null,
  },
], {
  keep_inputs: [0],
});
input_changed(disconnected, 0, false, null);
assert.equal(disconnected.inputs[0].label, "anything");
assert.equal(disconnected.inputs[0].localized_name, "anything");
assert.equal(disconnected.inputs[0].type, "*");
assert.equal(disconnected.inputs[0].color_on, undefined);

const fixed = makeNode([
  {
    name: "anything11",
    label: "CLIP",
    localized_name: "CLIP",
    type: "CLIP",
    color_on: "#ff0",
    link: null,
  },
  {
    name: "anything12",
    label: "VAE",
    localized_name: "VAE",
    type: "VAE",
    color_on: "#f00",
    link: null,
  },
], {
  fixed_inputs: true,
  keep_inputs: [0, 1],
});
fix_inputs(fixed, "test");
assert.deepEqual(
  Array.from(fixed.inputs, (input) => input.label),
  ["anything", "anything"],
);
assert.deepEqual(
  Array.from(fixed.inputs, (input) => input.type),
  ["*", "*"],
);
assert.deepEqual(
  Array.from(fixed.inputs, (input) => input.color_on),
  [undefined, undefined],
);

const kept = makeNode([
  {
    name: "anything11",
    label: "CLIP",
    localized_name: "CLIP",
    type: "CLIP",
    color_on: "#ff0",
    link: null,
  },
  {
    name: "anything12",
    label: "VAE",
    localized_name: "VAE",
    type: "VAE",
    color_on: "#f00",
    link: null,
  },
], {
  keep_inputs: [0, 1],
});
kept.addInput = function (name, type, options = {}) {
  this.properties.ue_properties.next_input_index = 12;
  this.inputs.push({
    name,
    type,
    label: options.label,
    localized_name: options.label,
    link: null,
  });
};
fix_inputs(kept, "test");
assert.deepEqual(
  Array.from(kept.inputs, (input) => input.label),
  ["anything", "anything", "anything"],
);
assert.deepEqual(
  Array.from(kept.inputs, (input) => input.type),
  ["*", "*", "*"],
);

console.log("Anything Everywhere connection checks passed.");
