import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  desiredMediaInputCount,
  isMediaInputConnected,
  mediaInputLabel,
  mediaInputName,
  parseMediaInput,
} from "../web/media_inputs.js";
import {
  applyPromptProcessorPassthrough,
} from "../web/prompt_processor_passthrough.js";
import {
  nextPromptProcessorSize,
} from "../web/prompt_processor_size.js";


const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source = readFileSync(
  path.join(packageRoot, "web", "prompt_processor.js"),
  "utf8",
);
const css = readFileSync(
  path.join(packageRoot, "web", "prompt_processor.css"),
  "utf8",
);

assert.match(
  source,
  /const originalConnectionsChange\s*=\s*node\.onConnectionsChange;/,
);
assert.match(source, /prompt_processor\.css\?v=20261115-5/);
assert.match(
  source,
  /const wrappedConnectionsChange\s*=\s*function\s*\(\)\s*\{[\s\S]*?window\.setTimeout\(\(\)\s*=>\s*\{[\s\S]*?scheduleMediaInputSync\(\);[\s\S]*?syncVisibility\(\);/,
);
assert.match(
  source,
  /node\.onConnectionsChange\s*=\s*wrappedConnectionsChange;/,
);
assert.match(
  source,
  /if\s*\(node\.onConnectionsChange\s*===\s*wrappedConnectionsChange\)\s*\{/,
);
assert.doesNotMatch(source, /invert_expand|反推后扩写|反推并扩写/);
assert.match(source, /currentOperation === "invert"/);
assert.match(
  source,
  /selected\.value === "auto" && mediaConnected/,
);
assert.match(
  source,
  /selected\.value === "auto" && !mediaConnected/,
);
assert.match(
  source,
  /const bottom = createElement\("div", "astral-pp-bottom"\)/,
);
assert.match(
  source,
  /bottom\.append\(serviceField, apiConfigRow, clearLabel\)/,
);
assert.match(
  source,
  /const apiConfigRow = createElement\([\s\S]*?"astral-pp-config-row"/,
);
assert.match(
  source,
  /const clearVram = createElement\("input"\)/,
);
assert.match(source, /clearVram\.type = "checkbox"/);
assert.match(
  source,
  /clearLabel\.append\(clearVram, clearSwitch, clearText\)/,
);
assert.match(
  source,
  /clearLabel\.hidden = String\(service\.value \|\| "api"\) !== "local"/,
);
assert.match(
  source,
  /syncWidget\([\s\S]*?widgets\.clearVram,[\s\S]*?Boolean\(clearVram\.checked\)/,
);
assert.match(
  source,
  /window\.openAssetsAstralApiConfig\?\.\("api"\)/,
);
assert.match(
  css,
  /\.astral-pp-bottom\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*row;[\s\S]*?align-items:\s*flex-end;/,
);
assert.match(source, /const CONTROL_MIN_WIDTH = 150;/);
assert.match(
  source,
  /const clearSwitch = createElement\("span", "astral-pp-switch"\);/,
);
assert.match(
  source,
  /const clearText = createElement\([\s\S]*?"astral-pp-check-label",[\s\S]*?"清理显存",/,
);
assert.match(
  css,
  /\.astral-pp-check input:checked \+ \.astral-pp-switch\s*\{/,
);
assert.match(
  css,
  /\.astral-pp-check input:checked \+ \.astral-pp-switch::after\s*\{[\s\S]*?transform:\s*translateX\(10px\)/,
);
assert.match(
  css,
  /\.astral-pp-service-field\s*\{[\s\S]*?min-width:\s*72px;/,
);
assert.match(
  css,
  /@container\s*\(max-width:\s*240px\)\s*\{[\s\S]*?\.astral-pp-service-field\s*\{[\s\S]*?min-width:\s*48px;/,
);
assert.match(
  css,
  /@container\s*\(max-width:\s*180px\)\s*\{[\s\S]*?\.astral-pp-service-field\s*\{[\s\S]*?min-width:\s*36px;/,
);
assert.match(
  source,
  /getMaxHeight:\s*\(\)\s*=>\s*controlHeight/,
  "The control widget must not grow into unused node space",
);
assert.match(
  source,
  /domWidget\.computeLayoutSize\s*=\s*\(\)\s*=>\s*\(\{[\s\S]*?minHeight:\s*controlHeight,[\s\S]*?maxHeight:\s*controlHeight,/,
  "The DOM widget layout height must stay anchored to the content height",
);
assert.match(
  source,
  /domWidget\.element\.parentElement\?\.classList\.add\([\s\S]*?"astral-pp-widget-shell"[\s\S]*?root\.style\.pointerEvents\s*=\s*"none";/,
);
assert.match(
  css,
  /\.astral-pp-widget-shell\s*\{[\s\S]*?pointer-events:\s*none\s*!important;/,
);
assert.match(
  css,
  /\.astral-pp\s*\{[\s\S]*?pointer-events:\s*none;/,
  "The DOM widget root must pass resize gestures through to the canvas",
);
assert.match(
  css,
  /\.astral-pp\s+:is\(button,\s*select,\s*input,\s*textarea,\s*label,\s*a,\s*\[role="button"\]\)\s*\{[\s\S]*?pointer-events:\s*auto;/,
  "Interactive controls must remain clickable inside the pass-through root",
);
assert.match(
  source,
  /const originalGetWidgetOnPos\s*=\s*node\.getWidgetOnPos;/,
);
assert.match(
  source,
  /const wrappedGetWidgetOnPos\s*=\s*function\s*\(x,\s*y\)\s*\{[\s\S]*?if\s*\(this\.findResizeDirection\?\.\(x,\s*y\)\)\s*return null;[\s\S]*?originalGetWidgetOnPos\?\.apply\(this,\s*arguments\);/,
);
assert.match(
  source,
  /node\.getWidgetOnPos\s*=\s*wrappedGetWidgetOnPos;/,
);
assert.match(
  source,
  /if\s*\(node\.getWidgetOnPos\s*===\s*wrappedGetWidgetOnPos\)\s*\{[\s\S]*?node\.getWidgetOnPos\s*=\s*originalGetWidgetOnPos;/,
);
assert.match(source, /node\.resizable = true;/);
assert.match(
  source,
  /const USER_PROMPT_MAX_HEIGHT = 100000;/,
  "The native prompt widget needs explicit room to absorb vertical space",
);
assert.match(
  source,
  /const originalUserPromptLayout\s*=\s*widgets\.userPrompt\?\.computeLayoutSize;/,
  "The native prompt layout implementation must be preserved",
);
assert.match(
  source,
  /const userPromptBaseHeight\s*=\s*Math\.max\([\s\S]*?Number\(initialUserPromptLayout\.minHeight\)[\s\S]*?50,/,
  "The native prompt must retain a fixed minimum height",
);
assert.match(
  source,
  /widgets\.userPrompt\.computeLayoutSize\s*=\s*wrappedUserPromptLayout;/,
  "The native prompt widget must receive the growable layout",
);
assert.match(
  source,
  /return\s*\{[\s\S]*?\.\.\.layout,[\s\S]*?minHeight:\s*userPromptBaseHeight,[\s\S]*?maxHeight:\s*USER_PROMPT_MAX_HEIGHT,/,
  "Only the native prompt widget may absorb extra vertical space",
);
assert.deepEqual(
  nextPromptProcessorSize({
    current: [300, 300],
    minimum: [150, 300],
    user: [420, 800],
  }),
  [420, 800],
  "A manual resize must survive automatic control fitting",
);
assert.deepEqual(
  nextPromptProcessorSize({
    current: [180, 300],
    minimum: [150, 300],
    restored: [420, 720],
    user: [420, 720],
  }),
  [420, 720],
  "Programmatic setSize calls must not overwrite the user's restored size",
);
assert.deepEqual(
  nextPromptProcessorSize({
    current: [420, 800],
    minimum: [150, 900],
    user: [420, 800],
  }),
  [420, 900],
  "Visible controls may expand the node below the user-selected height",
);
assert.deepEqual(
  nextPromptProcessorSize({
    current: [180, 260],
    minimum: [150, 300],
  }),
  [180, 300],
  "Nodes without a user resize must still initialize from their layout",
);
assert.deepEqual(
  nextPromptProcessorSize({
    restored: [400, 700],
    minimum: [150, 300],
  }),
  [400, 700],
  "A serialized workflow size must be available before layout fitting",
);
assert.match(
  source,
  /const wrappedOnResize = function \(size\) \{[\s\S]*?queueMicrotask\(\(\) => \{[\s\S]*?this\.arrange\?\.\(\);[\s\S]*?this\.setDirtyCanvas\?\.\(true, true\);[\s\S]*?\}\);[\s\S]*?return result;[\s\S]*?\};/,
  "Manual vertical resizing must redistribute space without resetting the node height",
);
assert.doesNotMatch(
  source,
  /const wrappedOnResize = function[\s\S]*?fitControlHeight\(\);[\s\S]*?node\.onResize = wrappedOnResize;/,
  "The resize handler must not force the node back to its minimum height",
);
assert.match(
  source,
  /widgets\.userPrompt\?\.computeLayoutSize === wrappedUserPromptLayout[\s\S]*?delete widgets\.userPrompt\.computeLayoutSize;/,
  "The native prompt layout must be restored when the node is removed",
);
assert.match(
  source,
  /node\.__astralPromptProcessorRestoredSize\s*=\s*normalized/,
);
assert.match(
  source,
  /node\.__astralPromptProcessorUserSize\s*=\s*normalized/,
);
assert.match(
  source,
  /this\.graph\?\._canvas[\s\S]*?this\.graph\?\.list_of_graphcanvas\?\.\[0\][\s\S]*?nodeCanvas\?\.resizing_node === this/,
  "Manual resize detection must support ComfyUI graphs without node.canvas",
);
assert.match(
  source,
  /const originalSetSize = node\.setSize;[\s\S]*?const wrappedSetSize = function \(size\)[\s\S]*?preservePromptProcessorNodeSize\(this, size, \{ user: true \}\);[\s\S]*?return originalSetSize\?\.apply\(this, arguments\);[\s\S]*?node\.setSize = wrappedSetSize;/,
  "Manual setSize calls must preserve the size before ComfyUI can reset it",
);
assert.match(
  source,
  /if \(node\.setSize === wrappedSetSize\) \{\s*node\.setSize = originalSetSize;/,
  "Removing the node must restore its original setSize implementation",
);
assert.match(
  source,
  /const restoredSize\s*=\s*normalizeNodeSize\([\s\S]*?node\.__astralPromptProcessorRestoredSize/,
  "A restored workflow node must use its serialized size",
);
assert.match(
  source,
  /const userSize\s*=\s*normalizeNodeSize\([\s\S]*?node\.__astralPromptProcessorUserSize/,
  "The automatic fit must prefer the user-selected dimensions",
);
assert.match(
  source,
  /nextPromptProcessorSize\(\{[\s\S]*?current:\s*\[currentWidth, currentHeight\][\s\S]*?restored:\s*restoredSize[\s\S]*?user:\s*userSize/,
  "The automatic size fit must combine current, restored, and user sizes",
);
assert.match(
  source,
  /nodeCanvas\?\.resizing_node === node\)\s*\{\s*layoutFrame = window\.requestAnimationFrame\(fitControlHeight\);\s*return;[\s\S]*?node\.setSize\?\.\(\[width, height\]\)/,
  "Automatic fitting must not overwrite dimensions while the node is being resized",
);
assert.match(
  source,
  /preservePromptProcessorNodeSize\(this,\s*configuration\.size,\s*\{[\s\S]*?user:\s*true/,
  "Node configuration must retain the serialized width and height as a user size",
);
assert.match(
  source,
  /loadedGraphNode\(node\)\s*\{[\s\S]*?preservePromptProcessorNodeSize\(node,\s*node\.size,\s*\{\s*user:\s*true\s*\}\)/,
);
assert.match(
  source,
  /node\.onResize\s*=\s*wrappedOnResize/,
);
const parameterChangeHandlers = source.slice(
  source.indexOf('operation.addEventListener("change"'),
  source.indexOf('refresh.addEventListener("click"'),
);
assert.equal(
  parameterChangeHandlers.match(
    /preservePromptProcessorNodeSize\(node, node\.size, \{ user: true \}\);/g,
  )?.length,
  6,
  "Every parameter change must preserve the current user-selected size",
);
assert.match(
  css,
  /\.astral-pp-check input\s*\{[\s\S]*?width:\s*1px;[\s\S]*?opacity:\s*0;/,
);
assert.match(
  css,
  /\.astral-pp-switch\s*\{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*16px;[\s\S]*?border-radius:\s*999px;/,
);
assert.match(
  css,
  /\.astral-pp\s*\{[\s\S]*?align-self:\s*flex-start;[\s\S]*?flex:\s*0\s+0\s+auto;/,
);
assert.match(source, /从图片、视频或音频反推提示词/);
assert.doesNotMatch(source, /图片\s+\$\{number\}\//);
assert.doesNotMatch(source, /MEDIA_INPUT_LABELS/);
assert.match(source, /function syncMediaInputs\(node\)/);
assert.match(
  source,
  /desiredMediaInputCount\(\s*node\.inputs,\s*kind,\s*isConnected,\s*\)/,
);
assert.match(source, /node\.addInput\(/);
assert.match(source, /node\.removeInput\(slot\)/);
assert.match(source, /function updateMediaInputLabels\(node\)/);
assert.match(source, /function reorderMediaInputs\(node\)/);
assert.match(source, /link\.target_slot = slot/);
assert.match(source, /input\.localized_name = label/);
assert.match(
  source,
  /Math\.max\(root\.offsetHeight \|\| 0, root\.scrollHeight \|\| 0\)/,
);
assert.match(source, /Number\(domWidget\.element\?\.offsetHeight\) \|\| 0/);
assert.match(
  source,
  /computedHeight \+ measured - effectiveRenderedHeight/,
);
assert.match(source, /margin:\s*0/);
assert.doesNotMatch(source, /DEBUG_TAG|console\.info/);
assert.doesNotMatch(source, /CONTROL_BASE_HEIGHT/);
assert.match(source, /new ResizeObserver\(\(\) => fitControlHeight\(\)\)/);
assert.match(source, /retryPromptProcessorSetup\(this\)/);
assert.match(source, /loadedGraphNode\(node\)/);
assert.match(source, /nodeData\?\.name !== NODE_TYPE/);
assert.match(source, /window\.setTimeout\(retryInstalledPromptProcessorNodes, 1000\)/);
assert.match(
  source,
  /Object\.is\(widget\.value,\s*value\)[\s\S]*?return false;/,
  "Syncing an unchanged widget must not mark the workflow dirty",
);
assert.doesNotMatch(
  source.slice(
    source.indexOf("const fitControlHeight ="),
    source.indexOf("const scheduleMediaInputSync ="),
  ),
  /setDirtyCanvas/,
  "Layout fitting should only mark dirty when setSize actually changes the node",
);
assert.match(
  source,
  /applyPromptProcessorPassthrough\([\s\S]*?graphForPromptCall\(args\)/,
);
assert.match(source, /retryInstallGraphToPromptHook\(\);/);
assert.match(
  source,
  /graphToPromptHookRetryTimer[\s\S]*?GRAPH_HOOK_RETRY_LIMIT[\s\S]*?GRAPH_HOOK_RETRY_DELAY/,
);
assert.doesNotMatch(
  source,
  /window\.setTimeout\(installGraphToPromptHook, 0\)/,
  "Hook installation must retry until the frontend API is available",
);
assert.match(
  source,
  /function installQueuePromptHook\(\)[\s\S]*?api\.queuePrompt\s*=\s*wrapped;/,
  "The final queue submission path must apply Bypass passthrough",
);
assert.match(
  source,
  /const transformedPrompt = applyQueuePromptPassthrough\(promptData\);[\s\S]*?return original\.apply\(this, \[[\s\S]*?number,[\s\S]*?transformedPrompt,[\s\S]*?options,/,
  "The queue wrapper must submit the transformed prompt and preserve its arguments",
);
assert.match(
  source,
  /retryInstallQueuePromptHook\(\);/,
);
assert.match(
  source,
  /queuePromptHookRetryTimer[\s\S]*?QUEUE_HOOK_RETRY_LIMIT[\s\S]*?QUEUE_HOOK_RETRY_DELAY/,
);

assert.deepEqual(parseMediaInput("image"), {
  kind: "image",
  index: 1,
  name: "image",
});
assert.deepEqual(parseMediaInput({ name: "image_9" }), {
  kind: "image",
  index: 9,
  name: "image_9",
});
assert.equal(parseMediaInput("image_10"), null);
assert.equal(mediaInputName("image", 1), "image");
assert.equal(mediaInputName("image", 2), "image_2");
assert.equal(mediaInputName("video", 2), "video_2");
assert.equal(mediaInputLabel("image", 1), "image1");
assert.equal(mediaInputLabel("image", 2), "image2");
assert.equal(mediaInputLabel("video", 1), "video1");
assert.equal(mediaInputLabel("video", 2), "video2");
assert.equal(mediaInputLabel("audio", 1), "audio1");
assert.equal(mediaInputLabel("audio", 2), "audio2");

const mediaInputs = [
  { name: "image", link: 1 },
  { name: "image_2", link: null },
  { name: "image_3", link: null },
  { name: "video", link: null },
  { name: "video_2", link: null },
  { name: "audio", link: null },
  { name: "audio_2", link: null },
];
assert.equal(desiredMediaInputCount(mediaInputs, "image"), 2);
assert.equal(desiredMediaInputCount(mediaInputs, "video"), 1);
assert.equal(desiredMediaInputCount(mediaInputs, "audio"), 1);
assert.equal(
  desiredMediaInputCount(
    mediaInputs.map((input) =>
      input.name.startsWith("image") ? { ...input, link: 1 } : input,
    ),
    "image",
  ),
  4,
);
assert.equal(
  desiredMediaInputCount(
    [
      { name: "image", link: 1 },
      { name: "video", link: null },
      { name: "audio", link: null },
    ],
    "image",
  ),
  2,
);
assert.equal(
  desiredMediaInputCount(
    Array.from({ length: 9 }, (_, index) => ({
      name: index === 0 ? "image" : `image_${index + 1}`,
      link: 1,
    })),
    "image",
  ),
  9,
);
assert.equal(
  isMediaInputConnected(
    { name: "image" },
    0,
    {
      isInputConnected: (slot) => slot === 0,
    },
  ),
  true,
);

const passthroughProcessor = {
  id: 10,
  type: "Assets Astral Prompt Processor",
  mode: 2,
  inputs: [{ name: "user_prompt", link: 3 }],
  widgets: [{ name: "user_prompt", value: "" }],
  outputs: [{ links: [1] }, { links: [2] }],
};
const upstreamPrompt = {
  id: 9,
  type: "PrimitiveNode",
  mode: 0,
  inputs: [],
  outputs: [{ links: [3] }],
};
const optimizedConsumer = {
  id: 11,
  type: "CLIPTextEncode",
  mode: 0,
  inputs: [{ name: "text" }],
  outputs: [],
};
const reverseConsumer = {
  id: 12,
  type: "CLIPTextEncode",
  mode: 0,
  inputs: [{ name: "text" }],
  outputs: [],
};
const passthroughGraph = {
  _nodes: [
    upstreamPrompt,
    passthroughProcessor,
    optimizedConsumer,
    reverseConsumer,
  ],
  _nodes_by_id: {
    9: upstreamPrompt,
    10: passthroughProcessor,
    11: optimizedConsumer,
    12: reverseConsumer,
  },
  links: {
    1: {
      id: 1,
      origin_id: 10,
      origin_slot: 0,
      target_id: 11,
      target_slot: 0,
    },
    2: {
      id: 2,
      origin_id: 10,
      origin_slot: 1,
      target_id: 12,
      target_slot: 0,
    },
    3: {
      id: 3,
      origin_id: 9,
      origin_slot: 0,
      target_id: 10,
      target_slot: 0,
    },
  },
};
const passthroughResult = {
  output: {
    11: { inputs: {}, class_type: "CLIPTextEncode" },
    12: { inputs: {}, class_type: "CLIPTextEncode" },
  },
};
for (const disabledMode of [2, 4]) {
  passthroughProcessor.mode = disabledMode;
  passthroughResult.output[11].inputs.text = "";
  passthroughResult.output[12].inputs.text = "";
  applyPromptProcessorPassthrough(
    passthroughResult,
    passthroughGraph,
  );
  assert.deepEqual(
    passthroughResult.output[11].inputs.text,
    ["9", 0],
  );
  assert.deepEqual(
    passthroughResult.output[12].inputs.text,
    ["9", 0],
  );
}

const previewProcessor = {
  id: 30,
  type: "Assets Astral Prompt Processor",
  mode: 4,
  inputs: [{ name: "user_prompt", link: 33 }],
  widgets: [{ name: "user_prompt", value: "" }],
  outputs: [{ links: [31] }],
};
const previewUpstream = {
  id: 29,
  type: "PrimitiveStringMultiline",
  mode: 0,
  inputs: [],
  outputs: [{ links: [33] }],
};
const previewAny = {
  id: 31,
  type: "PreviewAny",
  mode: 0,
  inputs: [{ name: "source", link: 31 }],
  outputs: [{ links: [32] }],
};
const previewStore = {
  id: 32,
  type: "AstralSetGroup",
  mode: 0,
  inputs: [{ name: "字符串", link: 32 }],
  outputs: [],
};
const previewGraph = {
  _nodes: [
    previewUpstream,
    previewProcessor,
    previewAny,
    previewStore,
  ],
  links: {
    31: {
      id: 31,
      origin_id: 30,
      origin_slot: 0,
      target_id: 31,
      target_slot: 0,
    },
    32: {
      id: 32,
      origin_id: 31,
      origin_slot: 0,
      target_id: 32,
      target_slot: 0,
    },
    33: {
      id: 33,
      origin_id: 29,
      origin_slot: 0,
      target_id: 30,
      target_slot: 0,
    },
  },
};
const previewResult = {
  output: {
    31: { inputs: {}, class_type: "PreviewAny" },
    32: { inputs: {}, class_type: "AstralSetGroup" },
  },
};
applyPromptProcessorPassthrough(previewResult, previewGraph);
assert.deepEqual(
  previewResult.output[31].inputs.source,
  ["29", 0],
  "Bypassed prompt output must reach PreviewAny as an upstream link",
);

const numericMapProcessor = {
  id: 1242,
  type: "Assets Astral Prompt Processor",
  mode: 4,
  inputs: [{ name: "user_prompt", link: "8879" }],
  widgets: [{ name: "user_prompt", value: "" }],
  outputs: [{ links: ["8881"] }],
};
const numericMapUpstream = {
  id: 1247,
  type: "PrimitiveStringMultiline",
  mode: 0,
  inputs: [],
  outputs: [{ links: [8879] }],
};
const numericMapPreview = {
  id: 1255,
  type: "PreviewAny",
  mode: 0,
  inputs: [{ name: "source", link: "8881" }],
  outputs: [],
};
const numericMapGraph = {
  _nodes: [
    numericMapUpstream,
    numericMapProcessor,
    numericMapPreview,
  ],
  links: new Map([
    [
      8879,
      {
        id: 8879,
        origin_id: 1247,
        origin_slot: 0,
        target_id: 1242,
        target_slot: 0,
      },
    ],
    [
      8881,
      {
        id: 8881,
        origin_id: 1242,
        origin_slot: 0,
        target_id: 1255,
        target_slot: 0,
      },
    ],
  ]),
};
const numericMapResult = {
  output: {
    1255: { inputs: {}, class_type: "PreviewAny" },
  },
};
applyPromptProcessorPassthrough(
  numericMapResult,
  numericMapGraph,
);
assert.deepEqual(
  numericMapResult.output[1255].inputs.source,
  ["1247", 0],
  "Numeric Map keys must resolve string Link IDs",
);

passthroughProcessor.inputs = [
  { name: "user_prompt", link: null },
];
passthroughProcessor.widgets = [
  { name: "user_prompt", value: "portrait, soft light" },
];
for (const disabledMode of [2, 4]) {
  passthroughProcessor.mode = disabledMode;
  passthroughResult.output[11].inputs.text = "";
  passthroughResult.output[12].inputs.text = "";
  applyPromptProcessorPassthrough(
    passthroughResult,
    passthroughGraph,
  );
  assert.equal(
    passthroughResult.output[11].inputs.text,
    "portrait, soft light",
  );
  assert.equal(
    passthroughResult.output[12].inputs.text,
    "portrait, soft light",
  );
}

passthroughProcessor.mode = 0;
passthroughProcessor.inputs = [
  { name: "user_prompt", link: 3 },
];
passthroughProcessor.widgets = [{ name: "user_prompt", value: "" }];
passthroughResult.output[11].inputs.text = "";
passthroughResult.output[12].inputs.text = "";
applyPromptProcessorPassthrough(
  passthroughResult,
  passthroughGraph,
);
assert.equal(passthroughResult.output[11].inputs.text, "");
assert.equal(passthroughResult.output[12].inputs.text, "");

console.log("Prompt processor layout and media input checks passed.");
