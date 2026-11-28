import { app } from "../../scripts/app.js";

export const SET_GROUP_NODE = "AstralSetGroup";
export const GET_GROUP_NODE = "AstralGetGroup";
export const MAX_SET_PORTS = 30;
export const MAX_GET_PORTS = 30;
export const SET_GROUP_MIN_WIDTH = 80;
export const GET_GROUP_MIN_WIDTH = 160;
export const NODE_PACKAGE_MODULE = "custom_nodes.ComfyUI-Astral-Manage";
const ADD_SET_GROUP_MENU_LABEL = "Add SetGroup Node";
const ADD_GET_GROUP_MENU_LABEL = "Add GetGroup Node";
const PLACEHOLDER_PORT_ID = "__placeholder__";
const TRANSPARENT_NODE_COLOR = "rgba(0,0,0,0)";
const DEFAULT_SET_GET_NODE_COLOR = "#ffffff";
const SET_GROUP_WIDTH_VERSION = 3;
const SET_GET_SIDE_RADIUS = 14;
const SET_GROUP_PORT_X = SET_GET_SIDE_RADIUS;
const GET_GROUP_OUTPUT_HIT_INSET = 5;
const GET_GROUP_BRACE_HIT_SLOP = 3;
const SET_GET_MOVE_CURSOR_MARGIN = 3;
const SET_GROUP_PORT_LABEL_OFFSET_X = 9;
const SET_GROUP_PORT_CLICK_DELAY_MS = 360;
const SET_GET_SLOT_RADIUS = 4;
const SET_GET_SLOT_FONT = "12px Inter, sans-serif";
const SET_GET_SLOT_TEXT_COLOR = "#AAA";
const SET_GET_EMPTY_SLOT_COLOR = "#797979";
const SET_GET_DRAW_GUARD_FLAG = "__astralSetGetDrawGuardV2";
const CANVAS_TOOLKIT_PATCH_FLAG = "__ct_patched_v9";
const DRAW_GUARD_TOOLKIT_WAIT_MS = 3000;
const DRAW_GUARD_WATCH_MS = 30000;
const SET_GET_NODE_METADATA = new Map([
  [
    SET_GROUP_NODE,
    {
      display_name: "SetGroup",
      category: "Astral/Set & Get",
      description: "Store multiple named ports and make them available to matching GetGroup nodes.",
    },
  ],
  [
    GET_GROUP_NODE,
    {
      display_name: "GetGroup",
      category: "Astral/Set & Get",
      description: "Enter one or more SetGroup port names to expose the matching values.",
    },
  ],
]);
const GROUP_NODE_COLORS = [
  { color: "#30294d", bgcolor: "#423a68", boxcolor: "#d9c9ff" },
  { color: "#203d3a", bgcolor: "#2f5a54", boxcolor: "#9ff0d7" },
  { color: "#253c4b", bgcolor: "#345468", boxcolor: "#9edcff" },
  { color: "#47351f", bgcolor: "#684f2d", boxcolor: "#ffdd93" },
  { color: "#482832", bgcolor: "#6a3d4b", boxcolor: "#ffc0d2" },
  { color: "#263b2c", bgcolor: "#38553f", boxcolor: "#b9efa7" },
  { color: "#292f52", bgcolor: "#3e4772", boxcolor: "#bbc5ff" },
  { color: "#4a3023", bgcolor: "#6a4633", boxcolor: "#ffc29c" },
  { color: "#432747", bgcolor: "#603866", boxcolor: "#f1baff" },
  { color: "#203c43", bgcolor: "#315760", boxcolor: "#a5ecf5" },
  { color: "#3b3c23", bgcolor: "#575936", boxcolor: "#e2e6a1" },
  { color: "#34353e", bgcolor: "#4d4f5c", boxcolor: "#cfd3e2" },
];


function groupNameHash(groupName) {
  let hash = 2166136261;
  for (const character of String(groupName || "").trim().toLocaleLowerCase()) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}


export function getGroupNodeColors(groupName) {
  return GROUP_NODE_COLORS[groupNameHash(groupName) % GROUP_NODE_COLORS.length];
}


function applyGroupNodeColors(node, groupName) {
  const colors = getGroupNodeColors(groupName);
  node.color = colors.color;
  node.bgcolor = colors.bgcolor;
  node.boxcolor = colors.boxcolor;
  return colors;
}


function getNodeSlotHeight() {
  const height = Number(LiteGraph.NODE_SLOT_HEIGHT);
  return Number.isFinite(height) && height > 0 ? height : 20;
}


function getSetGetSlotLocalY(index) {
  return SET_GET_SIDE_RADIUS + getNodeSlotHeight() * (index + 0.5);
}


let slotLabelMeasureContext;

/** Rendered width of a port label in the node's slot font. Falls back to a
 *  character estimate where no 2D context exists (node-run unit tests). */
function measureSlotLabelWidth(name) {
  const text = String(name ?? "");
  if (!text) return 0;
  if (slotLabelMeasureContext === undefined) {
    try {
      slotLabelMeasureContext = document.createElement("canvas").getContext("2d");
      if (slotLabelMeasureContext) slotLabelMeasureContext.font = SET_GET_SLOT_FONT;
    } catch {
      slotLabelMeasureContext = null;
    }
  }
  if (slotLabelMeasureContext) {
    try {
      return Math.ceil(slotLabelMeasureContext.measureText(text).width);
    } catch {
      /* fall through to the estimate */
    }
  }
  // Rough 12px Inter estimate, only used where no 2D context exists
  // (the node-run unit tests). CJK glyphs are twice as wide as Latin ones.
  let estimate = 0;
  for (const char of text) {
    estimate += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(char) ? 12 : 7;
  }
  return Math.ceil(estimate);
}


/** Clickable width for a port label: the text plus a little slack. A fixed
 *  minimum here used to make short labels swallow most of the node width. */
function slotLabelHitWidth(name) {
  return Math.max(16, measureSlotLabelWidth(name) + 8);
}


function resolveSetGetPointerLocalPosition(node, localPos, event) {
  const canvasX = Number(event?.canvasX);
  const canvasY = Number(event?.canvasY);
  const nodeX = Number(node?.pos?.[0]) || 0;
  const nodeY = Number(node?.pos?.[1]) || 0;
  if (Number.isFinite(canvasX) && Number.isFinite(canvasY)) {
    return [canvasX - nodeX, canvasY - nodeY];
  }
  return [Number(localPos?.[0]), Number(localPos?.[1])];
}


function canvasPromptPositionEvent(event) {
  const clientX = Number(event?.clientX);
  const clientY = Number(event?.clientY);
  if (Number.isFinite(clientX) && Number.isFinite(clientY)) return event;
  let rect = null;
  try {
    rect = app.canvas?.canvas?.getBoundingClientRect?.() || null;
  } catch {
    // Use the viewport origin if the canvas is temporarily unavailable.
  }
  return {
    clientX: (Number(rect?.left) || 0) + (Number(rect?.width) || 0) * 0.5,
    clientY: (Number(rect?.top) || 0) + (Number(rect?.height) || 0) * 0.5,
  };
}


function showCanvasPrompt(
  value,
  event,
  multiline = false,
  title = "Value",
) {
  const prompt = app.canvas?.prompt;
  if (typeof prompt !== "function") {
    console.warn("[Astral]ComfyUI canvas prompt is unavailable.");
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    prompt.call(
      app.canvas,
      title,
      String(value ?? ""),
      (nextValue) => resolve(
        nextValue == null ? null : String(nextValue),
      ),
      canvasPromptPositionEvent(event),
      Boolean(multiline),
    );
  });
}


function getSetGetNodeHeight(portRows) {
  return Math.max(
    2 * SET_GET_SIDE_RADIUS,
    Math.ceil(portRows * getNodeSlotHeight() + 2 * SET_GET_SIDE_RADIUS),
  );
}


function hideSetGetWidget(widget) {
  if (!widget) return;
  try {
    if (widget.hidden !== true) widget.hidden = true;
  } catch {
    // Older frontends only expose options.hidden.
  }
  try {
    if (widget.options && widget.options.hidden !== true) {
      widget.options.hidden = true;
    }
  } catch {
    // Ignore read-only widget option objects from older frontends.
  }
}


function applySetGetNodeStyle(node) {
  if (!isVisibleSetGetColor(node.color)) {
    node.color = DEFAULT_SET_GET_NODE_COLOR;
  }
  if (!node.strokeStyles || Object.keys(node.strokeStyles).length) {
    node.strokeStyles = {};
  }
  for (const widget of node.widgets || []) hideSetGetWidget(widget);
  return node;
}


function isVisibleSetGetColor(value) {
  if (typeof value !== "string") return false;
  const color = value.trim().toLocaleLowerCase();
  return Boolean(
    color
    && color !== "transparent"
    && color !== TRANSPARENT_NODE_COLOR,
  );
}


function connectionColorForType(type, source) {
  const normalizedType = normalizeType(type);
  const typeParts = normalizedType
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const byType = app.canvas?.default_connection_color_byType || {};
  const linkTypeColors = globalThis.LGraphCanvas?.link_type_colors || {};
  const candidates = [
    source?.output?.color_on,
    source?.output?.color_off,
    source?.link?.color,
    byType[normalizedType],
    ...typeParts.map((part) => byType[part]),
    linkTypeColors[normalizedType],
    ...typeParts.map((part) => linkTypeColors[part]),
  ];
  return candidates.find(isVisibleSetGetColor) || null;
}


function setInputConnectionColor(input, source, type) {
  if (!input) return;
  const color = source ? connectionColorForType(type, source) : null;
  if (!color) {
    delete input.color_on;
    delete input.color_off;
    return;
  }
  input.color_on = color;
  input.color_off = color;
}


function setGroupInputGraphPosition(node, index) {
  const input = node?.inputs?.[index];
  if (!input) return null;
  const pos = setGetSlotLocalPosition(node, index, true);
  return [
    (Number(node.pos?.[0]) || 0) + pos[0],
    (Number(node.pos?.[1]) || 0) + pos[1],
  ];
}


function syncSetGroupSlotBounds(node) {
  const slotHeight = getNodeSlotHeight();
  const halfSlot = slotHeight * 0.5;
  for (let index = 0; index < (node?.inputs?.length || 0); index += 1) {
    const input = node.inputs[index];
    const pos = setGroupInputGraphPosition(node, index);
    if (!input || !pos) continue;
    const bounds = [pos[0] - halfSlot, pos[1] - halfSlot, slotHeight, slotHeight];
    const current = input.boundingRect;
    if (current && typeof current === "object") {
      current[0] = bounds[0];
      current[1] = bounds[1];
      current[2] = bounds[2];
      current[3] = bounds[3];
    } else {
      input.boundingRect = bounds;
    }
  }
}


function layoutSetGroupSlots(node) {
  const slotHeight = getNodeSlotHeight();
  const inputs = node.inputs || [];
  syncSetGetNodeHeight(node, inputs.length);
  inputs.forEach((input, index) => {
    input.pos = [
      SET_GROUP_PORT_X,
      SET_GET_SIDE_RADIUS + slotHeight * (index + 0.5),
    ];
    delete input.label;
  });
  syncSetGroupSlotBounds(node);
  applySetGetNodeStyle(node);
}


function layoutGetGroupSlots(node) {
  const slotHeight = getNodeSlotHeight();
  syncSetGetNodeHeight(node, node.outputs?.length || 0);
  // GetGroup is drawn without a background, so a width wider than the labels
  // is an invisible strip that still drags the node. Shrink it on every draw,
  // which also fixes widths saved by older versions of this pack.
  if (typeof node?.contentWidth === "function" && Array.isArray(node.size)) {
    const fitted = node.contentWidth();
    if (Number(node.size[0]) > fitted) node.size[0] = fitted;
  }
  const width = Math.max(
    GET_GROUP_MIN_WIDTH,
    Number(node?.size?.[0]) || GET_GROUP_MIN_WIDTH,
  );
  // Keep LiteGraph's 30px native output hit box just left of the brace edge.
  // Otherwise clicking the brace can start a link drag instead of moving the
  // node, even though the brace itself is drawn as the node frame.
  const portX = Math.max(SET_GET_SIDE_RADIUS, width - SET_GET_SIDE_RADIUS);
  for (let index = 0; index < (node?.outputs?.length || 0); index += 1) {
    const output = node.outputs[index];
    if (!output) continue;
    output.pos = [
      portX,
      SET_GET_SIDE_RADIUS + slotHeight * (index + 0.5),
    ];
  }
  applySetGetNodeStyle(node);
}


function syncSetGetNodeHeight(node, portRows) {
  if (!node) return;
  const height = getSetGetNodeHeight(portRows);
  if (Array.isArray(node.size)) {
    if (node.size[1] !== height) node.size[1] = height;
    return;
  }
  if (node.size && typeof node.size === "object") {
    try {
      node.size[1] = height;
    } catch {
      node.size = [
        Number(node.size[0]) || SET_GROUP_MIN_WIDTH,
        height,
      ];
    }
  }
}


export function getSetGetSideGeometry(node) {
  const side = node?._astralBraceSide === "right" ? "right" : "left";
  const slotRows = Math.max(
    1,
    side === "right"
      ? node?.outputs?.length || 1
      : node?.inputs?.length || 1,
  );
  const size = node?.size || [
    side === "right" ? GET_GROUP_MIN_WIDTH : SET_GROUP_MIN_WIDTH,
    getSetGetNodeHeight(slotRows),
  ];
  const width = Math.max(1, Number(size[0]) || SET_GROUP_MIN_WIDTH);
  const height = getSetGetNodeHeight(slotRows);
  return {
    side,
    edgeX: side === "right" ? width : 0,
    radius: SET_GET_SIDE_RADIUS,
    top: 0,
    bottom: height,
  };
}


export function traceSetGetSide(ctx, geometry) {
  const {
    side,
    edgeX,
    radius,
    top,
    bottom,
  } = geometry;
  ctx.beginPath();
  if (side === "right") {
    ctx.arc(
      edgeX - radius,
      top + radius,
      radius,
      Math.PI * 1.5,
      0,
    );
    ctx.moveTo(edgeX, top + radius);
    ctx.lineTo(edgeX, bottom - radius);
    ctx.arc(
      edgeX - radius,
      bottom - radius,
      radius,
      0,
      Math.PI * 0.5,
    );
  } else {
    ctx.arc(
      edgeX + radius,
      top + radius,
      radius,
      Math.PI,
      Math.PI * 1.5,
    );
    ctx.moveTo(edgeX, top + radius);
    ctx.lineTo(edgeX, bottom - radius);
    ctx.arc(
      edgeX + radius,
      bottom - radius,
      radius,
      Math.PI,
      Math.PI * 0.5,
      true,
    );
  }
}


function distanceSquaredToPoint(x, y, targetX, targetY) {
  const dx = x - targetX;
  const dy = y - targetY;
  return dx * dx + dy * dy;
}


function isPointNearQuarterArc(
  x,
  y,
  centerX,
  centerY,
  radius,
  isInsideQuadrant,
  startX,
  startY,
  endX,
  endY,
  tolerance,
  toleranceSquared,
) {
  const dx = x - centerX;
  const dy = y - centerY;
  if (
    isInsideQuadrant(dx, dy)
    && Math.abs(Math.hypot(dx, dy) - radius) <= tolerance
  ) {
    return true;
  }
  return (
    distanceSquaredToPoint(x, y, startX, startY) <= toleranceSquared
    || distanceSquaredToPoint(x, y, endX, endY) <= toleranceSquared
  );
}


export function isSetGetBraceStrokePoint(node, localPos, tolerance = 3) {
  const x = Number(localPos?.[0]);
  const y = Number(localPos?.[1]);
  const margin = Math.max(0, Number(tolerance) || 0);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

  const {
    side,
    edgeX,
    radius,
    top,
    bottom,
  } = getSetGetSideGeometry(node);
  const toleranceSquared = margin * margin;

  // The straight section of the brace.
  if (
    Math.abs(x - edgeX) <= margin
    && y >= top + radius - margin
    && y <= bottom - radius + margin
  ) {
    return true;
  }

  const topCenterY = top + radius;
  const bottomCenterY = bottom - radius;
  if (side === "right") {
    const centerX = edgeX - radius;
    return (
      isPointNearQuarterArc(
        x, y, centerX, topCenterY, radius,
        (dx, dy) => dx >= 0 && dy <= 0,
        centerX, top,
        edgeX, topCenterY,
        margin, toleranceSquared,
      )
      || isPointNearQuarterArc(
        x, y, centerX, bottomCenterY, radius,
        (dx, dy) => dx >= 0 && dy >= 0,
        edgeX, bottomCenterY,
        centerX, bottom,
        margin, toleranceSquared,
      )
    );
  }

  const centerX = edgeX + radius;
  return (
    isPointNearQuarterArc(
      x, y, centerX, topCenterY, radius,
      (dx, dy) => dx <= 0 && dy <= 0,
      edgeX, topCenterY,
      centerX, top,
      margin, toleranceSquared,
    )
    || isPointNearQuarterArc(
      x, y, centerX, bottomCenterY, radius,
      (dx, dy) => dx <= 0 && dy >= 0,
      centerX, bottom,
      edgeX, bottomCenterY,
      margin, toleranceSquared,
    )
  );
}


function applySetGetMoveCursor(node, localPos, canvas) {
  const scale = Math.max(1e-6, Number(canvas?.ds?.scale) || 1);
  const hovered = isSetGetBraceStrokePoint(
    node,
    localPos,
    SET_GET_MOVE_CURSOR_MARGIN / scale,
  );
  if (!hovered) return false;

  // LGraphCanvas updates the cursor after node.onMouseMove returns. Pause that
  // update for this pointer event, then restore it in the following microtask.
  if (canvas?.pointer) canvas.pointer.resizeDirection = undefined;
  const canvasState = canvas?.state;
  if (canvasState) {
    canvasState.shouldSetCursor = false;
    queueMicrotask(() => {
      canvasState.shouldSetCursor = true;
    });
  }
  if (canvas?.canvas?.style) canvas.canvas.style.cursor = "move";
  return true;
}


/** ComfyUI paints the canvas cursor as a crosshair whenever a node is hovered.
 *  These two cards are transparent, so inside the drawn frame that reads as a
 *  crosshair far away from the visible card. Keep a plain arrow inside the
 *  node and the move hint only on the brace itself. */
function applySetGetHoverCursor(node, localPos, canvas) {
  if (applySetGetMoveCursor(node, localPos, canvas)) return true;
  const canvasState = canvas?.state;
  if (canvasState) {
    canvasState.shouldSetCursor = false;
    queueMicrotask(() => {
      canvasState.shouldSetCursor = true;
    });
  }
  if (canvas?.canvas?.style && canvas.canvas.style.cursor !== "default") {
    canvas.canvas.style.cursor = "default";
  }
  return false;
}


// Kept as aliases for older frontend bundles that may still call the old export.
export const getSetGetBraceGeometry = getSetGetSideGeometry;
export const traceSetGetBrace = traceSetGetSide;


function drawSetGetSide(ctx, node) {
  if (!ctx || typeof ctx.stroke !== "function") return;
  ctx.save();
  ctx.strokeStyle = isVisibleSetGetColor(node.color)
    ? node.color
    : DEFAULT_SET_GET_NODE_COLOR;
  ctx.lineWidth = node.selected ? 2.5 : 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = 1;
  traceSetGetSide(ctx, getSetGetSideGeometry(node));
  ctx.stroke();
  ctx.restore();
}


function setGetSlotLocalPosition(node, index, isInput) {
  const width = Math.max(
    Number(node?.size?.[0]) || 0,
    isInput ? SET_GROUP_MIN_WIDTH : GET_GROUP_MIN_WIDTH,
  );
  return [
    isInput
      ? SET_GROUP_PORT_X
      : Math.max(SET_GET_SIDE_RADIUS, width - SET_GET_SIDE_RADIUS),
    getSetGetSlotLocalY(index),
  ];
}


function isSetGetPlaceholderSlot(slot, isInput, connected = null) {
  return Boolean(
    isInput
      ? slot?._astralSetPlaceholder || connected === false
      : slot?._astralGetPlaceholder,
  );
}


function setGetSlotColor(node, slot, isInput, connected = null) {
  if (
    !slot
    || isSetGetPlaceholderSlot(slot, isInput, connected)
  ) {
    return null;
  }
  if (isInput) {
    if (connected === false) return null;
    if (isVisibleSetGetColor(slot.color_on)) return slot.color_on;
    if (isVisibleSetGetColor(slot.color_off)) return slot.color_off;
    const source = sourceInfoForInput(node, node.inputs.indexOf(slot));
    return connectionColorForType(source?.type || slot.type, source);
  }
  if (isVisibleSetGetColor(slot.color_on)) return slot.color_on;
  if (isVisibleSetGetColor(slot.color_off)) return slot.color_off;
  const type = normalizeType(slot.type);
  if (type === "*") return null;
  return connectionColorForType(type, { output: slot });
}


function drawSetGetSlots(ctx, node) {
  if (
    !ctx
    || typeof ctx.arc !== "function"
    || typeof ctx.fill !== "function"
    || typeof ctx.fillText !== "function"
  ) {
    return;
  }
  const slotHeight = getNodeSlotHeight();
  ctx.save();
  try {
    ctx.font = SET_GET_SLOT_FONT;
    ctx.textBaseline = "middle";
    for (const [slots, isInput] of [
      [node.inputs || [], true],
      [node.outputs || [], false],
    ]) {
      for (let index = 0; index < slots.length; index += 1) {
        const slot = slots[index];
        if (!slot || (!isInput && slot.hidden)) continue;
        const [
          x,
          y = SET_GET_SIDE_RADIUS + slotHeight * (index + 0.5),
        ] = setGetSlotLocalPosition(node, index, isInput);
        const connected = isInput
          ? isSetInputConnected(node, index)
          : Boolean(slot?.links?.length);
        const empty = isSetGetPlaceholderSlot(slot, isInput, connected);
        const label = normalizePortName(slot.name);
        ctx.fillStyle = setGetSlotColor(node, slot, isInput, connected)
          || SET_GET_EMPTY_SLOT_COLOR;
        ctx.beginPath();
        ctx.arc(x, y, SET_GET_SLOT_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        if (empty || !label || label === "*") continue;
        ctx.fillStyle = SET_GET_SLOT_TEXT_COLOR;
        ctx.textAlign = isInput ? "left" : "right";
        ctx.fillText(
          label,
          x + (isInput
            ? SET_GROUP_PORT_LABEL_OFFSET_X
            : -SET_GROUP_PORT_LABEL_OFFSET_X),
          y + 0.5,
        );
      }
    }
  } finally {
    ctx.restore();
  }
  node.lastDrawnSlots = {
    inputs: [...(node.inputs || [])],
    outputs: [...(node.outputs || [])],
  };
}


export function drawSetGetNodeOnly(canvas, node, ctx) {
  if (!canvas || !node || !ctx) return false;
  const hadCurrentNode = Object.prototype.hasOwnProperty.call(
    canvas,
    "current_node",
  );
  const previousCurrentNode = canvas.current_node;
  ctx.save();
  try {
    canvas.current_node = node;
    const alpha = typeof canvas.getNodeModeAlpha === "function"
      ? canvas.getNodeModeAlpha(node)
      : canvas.editor_alpha;
    ctx.globalAlpha = Number.isFinite(alpha) ? alpha : 1;
    ctx.shadowColor = "transparent";
    applySetGetNodeStyle(node);
    node.onDrawForeground?.(ctx, canvas, canvas.canvas);
    ctx.shadowColor = "transparent";
    if (canvas.inner_text_font) ctx.font = canvas.inner_text_font;
    node._setConcreteSlots?.();
    node.arrange?.();
    if (node.type === SET_GROUP_NODE) {
      layoutSetGroupSlots(node);
      syncSetGroupSlotBounds(node);
    } else {
      layoutGetGroupSlots(node);
    }
    drawSetGetSlots(ctx, node);
    ctx.textAlign = "left";
    ctx.globalAlpha = 1;
    return true;
  } catch (error) {
    console.warn("[Astral]Failed to draw SetGroup/GetGroup shape", error);
    return false;
  } finally {
    if (hadCurrentNode) canvas.current_node = previousCurrentNode;
    else delete canvas.current_node;
    ctx.restore();
  }
}


export function installSetGetNodeDrawGuard(force = false) {
  const prototype = globalThis.LGraphCanvas?.prototype;
  if (!prototype || typeof prototype.drawNode !== "function") return false;
  const drawNodeIsGuarded = Boolean(
    prototype.drawNode?.__astralSetGetDrawGuard
    && prototype.drawNode?.__astralSetGetDrawGuardVersion >= 2
  );
  if (!drawNodeIsGuarded) {
    const originalDrawNode = prototype.drawNode;
    const guardedDrawNode = function astralSetGetDrawNode(node, ctx) {
      if (
        (node?.type === SET_GROUP_NODE || node?.type === GET_GROUP_NODE)
        && drawSetGetNodeOnly(this, node, ctx)
      ) {
        return;
      }
      return originalDrawNode.apply(this, arguments);
    };
    guardedDrawNode.__astralSetGetDrawGuard = true;
    guardedDrawNode.__astralSetGetDrawGuardVersion = 2;
    prototype.drawNode = guardedDrawNode;
  }

  const installSnapGuideGuard = (target) => {
    if (!target || typeof target.drawSnapGuide !== "function") return;
    const currentDrawSnapGuide = target.drawSnapGuide;
    if (
      currentDrawSnapGuide.__astralSetGetDrawSnapGuard
      && currentDrawSnapGuide.__astralSetGetDrawSnapGuardVersion >= 2
    ) {
      return;
    }
    const guardedDrawSnapGuide = function astralSetGetDrawSnapGuide(ctx, node) {
      // ComfyUI calls drawSnapGuide(ctx, node). Keep the old single-node
      // argument form as a fallback for older LiteGraph builds.
      const snapNode = arguments.length > 1 ? node : ctx;
      if (
        snapNode?.type === SET_GROUP_NODE
        || snapNode?.type === GET_GROUP_NODE
      ) {
        return;
      }
      return currentDrawSnapGuide.apply(this, arguments);
    };
    guardedDrawSnapGuide.__astralSetGetDrawSnapGuard = true;
    guardedDrawSnapGuide.__astralSetGetDrawSnapGuardVersion = 2;
    target.drawSnapGuide = guardedDrawSnapGuide;
  };

  installSnapGuideGuard(prototype);
  if (app.canvas !== prototype) {
    installSnapGuideGuard(app.canvas);
  }

  prototype[SET_GET_DRAW_GUARD_FLAG] = true;
  void force;
  return true;
}


function scheduleSetGetNodeDrawGuard() {
  const startedAt = Date.now();
  let installed = false;
  let toolkitWasReady = false;

  const attempt = () => {
    const prototype = globalThis.LGraphCanvas?.prototype;
    if (!prototype || typeof prototype.drawNode !== "function") {
      if (Date.now() - startedAt < DRAW_GUARD_WATCH_MS) {
        window.setTimeout(attempt, 100);
      }
      return;
    }

    const toolkitReady = Boolean(prototype[CANVAS_TOOLKIT_PATCH_FLAG]);
    const waitedLongEnough = (
      Date.now() - startedAt >= DRAW_GUARD_TOOLKIT_WAIT_MS
    );
    if (!installed && (!toolkitReady && !waitedLongEnough)) {
      window.setTimeout(attempt, 100);
      return;
    }

    const toolkitJustBecameReady = toolkitReady && !toolkitWasReady;
    // CanvasToolkit wraps drawNode late in some load orders. Reinstall the
    // guard outside of it so its selected/hover preview cannot draw a box.
    installed = installSetGetNodeDrawGuard(toolkitJustBecameReady)
      || installed;
    toolkitWasReady = toolkitReady;

    if (Date.now() - startedAt < DRAW_GUARD_WATCH_MS) {
      window.setTimeout(attempt, toolkitReady ? 1000 : 250);
    }
  };

  attempt();
}


function graphNodes(graph) {
  return Array.from(graph?._nodes || graph?.nodes || []);
}


function graphLink(graph, linkId) {
  if (linkId == null || !graph?.links) return null;
  if (graph.links instanceof Map) return graph.links.get(linkId) || null;
  if (Array.isArray(graph.links)) {
    return graph.links.find((link) => String(link?.id) === String(linkId)) || null;
  }
  return graph.links[linkId] || graph.links[String(linkId)] || null;
}


function graphLinkValues(graph) {
  if (!graph?.links) return [];
  if (graph.links instanceof Map) return Array.from(graph.links.values());
  if (Array.isArray(graph.links)) return graph.links;
  return Object.values(graph.links);
}


function inputLinkForSlot(node, slotIndex) {
  const index = Math.trunc(Number(slotIndex));
  const input = node?.inputs?.[index];
  if (!Number.isInteger(index) || !input) return null;

  const overridden = node?._astralInputLinkAssignments?.get(input);
  if (overridden) {
    return graphLink(node.graph, overridden.id ?? overridden) || overridden;
  }

  const graph = node.graph;
  const link = graphLinkValues(graph).find((candidate) => (
    candidate
    && String(candidate.target_id) === String(node.id)
    && Number(candidate.target_slot) === index
  ));
  if (link) return link;

  const hasNativeInputApi = typeof node.getInputLink === "function";
  if (hasNativeInputApi) {
    try {
      const nativeLink = node.getInputLink(index);
      if (nativeLink) return nativeLink;
    } catch {
      // Fall through to legacy slot storage.
    }
  }

  // During workflow configure(), the native slot lookup can temporarily return
  // null before the serialized node inputs are restored. The input's own link
  // ID is still valid at that point, provided the graph link belongs to us.
  const storedLink = graphLink(graph, input.link);
  if (
    storedLink
    && String(storedLink.target_id) === String(node.id)
  ) {
    return storedLink;
  }

  return hasNativeInputApi ? null : storedLink;
}


function isSetInputConnected(node, slotIndex) {
  return Boolean(inputLinkForSlot(node, slotIndex));
}


function linkIdentifier(link) {
  if (Array.isArray(link)) return link[0];
  return link?.id ?? null;
}


function setLinkTargetSlot(link, slotIndex) {
  if (!link) return false;
  const targetSlot = Math.trunc(Number(slotIndex));
  if (!Number.isInteger(targetSlot)) return false;
  if (Array.isArray(link)) {
    link[4] = targetSlot;
    return Number(link[4]) === targetSlot;
  }
  try {
    link.target_slot = targetSlot;
    return Number(link.target_slot) === targetSlot;
  } catch {
    return false;
  }
}


function removeGraphLinkEntry(graph, linkId) {
  if (linkId == null || !graph?.links) return;
  if (typeof graph.links.delete === "function") {
    graph.links.delete(linkId);
    return;
  }
  if (Array.isArray(graph.links)) {
    const index = graph.links.findIndex(
      (link) => String(link?.id) === String(linkId),
    );
    if (index >= 0) graph.links.splice(index, 1);
    return;
  }
  delete graph.links[linkId];
  delete graph.links[String(linkId)];
}


function normalizeType(type) {
  if (Array.isArray(type)) return type.map((item) => String(item)).join(",");
  if (type == null || type === "") return "*";
  return String(type);
}


export function applySetGetNodeMetadata(nodeDefs) {
  if (!Array.isArray(nodeDefs)) return nodeDefs;
  for (const nodeDef of nodeDefs) {
    if (!nodeDef || typeof nodeDef !== "object") continue;
    const metadata = SET_GET_NODE_METADATA.get(nodeDef.name);
    if (!metadata) continue;
    Object.assign(nodeDef, metadata, { python_module: NODE_PACKAGE_MODULE });
  }
  return nodeDefs;
}


export function typesCompatible(targetType, sourceType) {
  const target = normalizeType(targetType);
  const source = normalizeType(sourceType);
  if (target === "*" || source === "*") return true;
  const targetTypes = new Set(target.split(",").map((item) => item.trim()));
  return source
    .split(",")
    .map((item) => item.trim())
    .some((item) => targetTypes.has(item) || item === "*" || targetTypes.has("*"));
}


function sourceInfoForInput(node, slotIndex) {
  const input = node?.inputs?.[slotIndex];
  const graph = node?.graph;
  if (!input || !graph) return null;

  const link = inputLinkForSlot(node, slotIndex);
  if (!link) return null;

  let output = null;
  let sourceNode = null;
  let originSlot = link.origin_slot;
  try {
    const resolved = link.resolve?.(graph);
    output = resolved?.output || resolved?.subgraphOutput || null;
    sourceNode = resolved?.outputNode || resolved?.inputNode || null;
    if (resolved?.outputSlot != null) originSlot = resolved.outputSlot;
  } catch {
    // Older frontend link objects do not expose resolve().
  }

  if (!sourceNode && link.origin_id != null) {
    sourceNode = graph.getNodeById?.(link.origin_id) || null;
  }
  if (!output && sourceNode && originSlot != null) {
    output = sourceNode.outputs?.[originSlot] || null;
  }

  const type = normalizeType(output?.type || input.type);
  const rawName = String(
    output?.label
      || output?.localized_name
      || output?.name
      || type
  ).trim();
  return {
    link,
    sourceNode,
    output,
    originSlot,
    type,
    baseName: rawName && rawName !== "*" ? rawName : type,
  };
}


function cleanPortBaseName(value, type) {
  let name = String(value || "").trim();
  if (!name || name === "*") name = normalizeType(type);
  name = name.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return name || "PORT";
}


export function assignUniquePortNames(entries) {
  const bases = entries.map((entry, index) => (
    cleanPortBaseName(entry.baseName, entry.type || `PORT ${index + 1}`)
  ));
  const customBases = entries.map((entry, index) => (
    entry.customName
      ? cleanPortBaseName(entry.customName, entry.type || `PORT ${index + 1}`)
      : ""
  ));
  const totals = new Map();
  for (const base of bases) {
    const key = base.toLocaleLowerCase();
    totals.set(key, (totals.get(key) || 0) + 1);
  }

  const seen = new Map();
  const used = new Set();
  return bases.map((base, index) => {
    const key = base.toLocaleLowerCase();
    const occurrence = (seen.get(key) || 0) + 1;
    seen.set(key, occurrence);
    let candidate = customBases[index]
      || (totals.get(key) > 1 ? `${base}${occurrence}` : base);
    let suffix = occurrence + 1;
    while (used.has(candidate.toLocaleLowerCase())) {
      candidate = `${base}${suffix}`;
      suffix += 1;
    }
    used.add(candidate.toLocaleLowerCase());
    return candidate;
  });
}


function makeRuntimePortId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    // Fall through to the deterministic-enough fallback.
  }
  return `port-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}


function stableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}


function getCanvas() {
  return app.canvas;
}


function getActiveGraph() {
  return getCanvas()?.graph || app.graph;
}


function refreshGraphGets(graph) {
  for (const node of graphNodes(graph)) {
    if (node?.type === GET_GROUP_NODE) node.refreshFromSetGroup?.();
  }
}


function refreshGetCombos(graph) {
  for (const node of graphNodes(graph)) {
    if (node?.type === GET_GROUP_NODE) node.refreshPortChoices?.();
  }
}


export function parsePortNameList(value) {
  const names = [];
  const seen = new Set();
  for (const part of String(value || "")
    .replace(/[\r\n]+/g, ",")
    .split(/[,，;；]+/)) {
    const name = String(part)
      .replace(/\t+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}


function formatPortNameList(names) {
  return parsePortNameList((names || []).join(", ")).join(", ");
}


function portNameKey(value) {
  return String(value || "").trim().toLocaleLowerCase();
}


function normalizePortName(value) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function isLegacyDefaultGroupName(value) {
  return /^设置组\s+\d+$/u.test(String(value || "").trim());
}


function activeSetPortEntries(graph) {
  const entries = [];
  for (const setNode of graphNodes(graph)) {
    if (setNode?.type !== SET_GROUP_NODE) continue;
    for (const port of setNode.getActivePorts?.() || []) {
      entries.push({
        ...port,
        setNode,
      });
    }
  }
  return entries;
}


function findSetPortEntriesByName(graph, name) {
  const key = portNameKey(name);
  if (!key) return [];
  return activeSetPortEntries(graph)
    .filter((entry) => portNameKey(entry.name) === key);
}


function findSetPortEntryByPortId(graph, portId) {
  if (!portId) return null;
  return activeSetPortEntries(graph)
    .find((entry) => entry.portId === portId) || null;
}


class AstralSetGroupNode extends LiteGraph.LGraphNode {
  static title = "SetGroup";
  static category = "Astral/Set & Get";
  static title_mode = LiteGraph.NO_TITLE ?? 1;

  get title_mode() {
    return LiteGraph.NO_TITLE ?? 1;
  }

  constructor() {
    super("SetGroup");
    this._astralBraceSide = "left";
    this.isVirtualNode = true;
    this.serialize_widgets = true;
    this.ensurePortStorage();
    this.properties.groupName = String(this.properties.groupName || "");
    this.properties.portName = String(this.properties.portName || "");
    this._astralSyncingPort = false;
    this._astralPendingDisconnectedInputs = new Map();
    this.color = DEFAULT_SET_GET_NODE_COLOR;
    this.bgcolor = TRANSPARENT_NODE_COLOR;
    this.boxcolor = TRANSPARENT_NODE_COLOR;
    this.resizable = false;

    const nameWidget = this.addWidget(
      "text",
      "name",
      this.properties.portName,
      (value) => this.onPortNameChanged(value),
      {},
    );
    hideSetGetWidget(nameWidget);
    this.addInput("*", "*");
    this.ensureTrailingSetInput();
    layoutSetGroupSlots(this);
    this.size = this.computeSize();
    applySetGetNodeStyle(this);
  }

  get renderingColor() {
    return TRANSPARENT_NODE_COLOR;
  }

  get renderingBgColor() {
    return TRANSPARENT_NODE_COLOR;
  }

  get renderingBoxColor() {
    return TRANSPARENT_NODE_COLOR;
  }

  getWidgetOnPos() {
    // The name widget is a serialization carrier. Hidden widgets are still
    // returned by LGraphNode.getWidgetOnPos(), which would swallow the native
    // node drag. Return no widget so LGraphCanvas takes its background path
    // and moves this node, its side line and all attached links together.
    return undefined;
  }

  findResizeDirection() {
    return undefined;
  }

  onMouseMove(event, localPos, canvas = app.canvas) {
    return applySetGetHoverCursor(this, localPos, canvas);
  }

  isPointInside(x, y) {
    const inherited = super.isPointInside;
    if (
      typeof inherited === "function"
      && inherited.call(this, x, y)
    ) {
      return true;
    }

    const left = Number(this.pos?.[0]) || 0;
    const top = Number(this.pos?.[1]) || 0;
    const scale = Math.max(1e-6, Number(app.canvas?.ds?.scale) || 1);

    // The left brace is stroked on the node boundary. Include its outer
    // antialiased edge and rounded corners in the same 3px screen-space area.
    return isSetGetBraceStrokePoint(
      this,
      [x - left, y - top],
      SET_GET_MOVE_CURSOR_MARGIN / scale,
    );
  }

  drawBadges() {}

  getInputPos(slot) {
    const pos = setGroupInputGraphPosition(this, slot);
    return pos || super.getInputPos(slot);
  }

  getSlotPosition(slotIndex, isInput) {
    if (isInput) {
      const pos = setGroupInputGraphPosition(this, slotIndex);
      if (pos) return pos;
    }
    const inherited = super.getSlotPosition;
    if (typeof inherited === "function") {
      return inherited.call(this, slotIndex, isInput);
    }
    return null;
  }

  ensurePortStorage() {
    this.properties = this.properties || {};
    if (
      !this.properties.portIds
      || typeof this.properties.portIds !== "object"
      || Array.isArray(this.properties.portIds)
    ) {
      this.properties.portIds = {};
    }
    if (
      !this.properties.portNames
      || typeof this.properties.portNames !== "object"
      || Array.isArray(this.properties.portNames)
    ) {
      this.properties.portNames = {};
    }
    return this.properties;
  }

  removeLegacyOutputs() {
    for (let index = (this.outputs?.length || 0) - 1; index >= 0; index -= 1) {
      this.removeOutput(index);
    }
  }

  computeSize(candidateSize) {
    const requestedWidth = Math.max(
      0,
      Number(candidateSize?.[0]) || 0,
    );
    const inputRows = Math.max(1, this.inputs?.length || 1);
    return [
      Math.max(SET_GROUP_MIN_WIDTH, requestedWidth),
      getSetGetNodeHeight(inputRows),
    ];
  }

  migrateDefaultWidth() {
    const width = Number(this.size?.[0]) || 0;
    const version = Number(this.properties?.setGetWidthVersion) || 0;
    if (version < SET_GROUP_WIDTH_VERSION && width > 0) {
      this.size[0] = Math.max(
        SET_GROUP_MIN_WIDTH,
        Math.round(width / 2),
      );
    }
    this.properties.setGetWidthVersion = SET_GROUP_WIDTH_VERSION;
  }

  resizeToFitContent() {
    const width = Math.max(
      SET_GROUP_MIN_WIDTH,
      Number(this.size?.[0]) || SET_GROUP_MIN_WIDTH,
    );
    const nextSize = this.computeSize([
      width,
      Math.max(1, Number(this.size?.[1]) || 0),
    ]);
    if (typeof this.setSize === "function") this.setSize(nextSize);
    else this.size = nextSize;
  }

  onAdded() {
    this.removeLegacyOutputs();
    this.migrateDefaultWidth();
    layoutSetGroupSlots(this);
    this.updateTitle();
    refreshGetCombos(this.graph);
    refreshGraphGets(this.graph);
  }

  onConfigure() {
    this.removeLegacyOutputs();
    this.ensurePortStorage();
    this.migrateDefaultWidth();
    layoutSetGroupSlots(this);
    setTimeout(() => {
      this.removeLegacyOutputs();
      this.ensurePortStorage();
      this.migrateDefaultWidth();
      this.compactSetInputs();
      layoutSetGroupSlots(this);
      this.ensurePortIdentities();
      this.assignPortNames();
      const activePorts = this.getActivePorts();
      const legacyName = String(this.properties.groupName || "").trim();
      let name = normalizePortName(
        this.properties.portName
        || this.widgets?.[0]?.value
        || activePorts[0]?.name
        || (isLegacyDefaultGroupName(legacyName) ? "" : legacyName)
      );
      if (name) {
        this.applyPortName(name, {
          makeUnique: false,
          updatePrimary: true,
          notify: false,
        });
      }
      this.syncEndpoint();
      refreshGetCombos(this.graph);
      refreshGraphGets(this.graph);
    }, 0);
  }

  onDrawForeground(ctx) {
    applySetGetNodeStyle(this);
    drawSetGetSide(ctx, this);
  }

  getPortNameHit(localPos, event = null) {
    const pointerPos = resolveSetGetPointerLocalPosition(this, localPos, event);
    const x = Number(pointerPos?.[0]);
    const y = Number(pointerPos?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const slotHeight = getNodeSlotHeight();
    const labelStartX = SET_GROUP_PORT_X + SET_GROUP_PORT_LABEL_OFFSET_X;
    for (let index = 0; index < (this.inputs?.length || 0); index += 1) {
      const input = this.inputs[index];
      if (!input || !isSetInputConnected(this, index)) continue;
      const slotY = getSetGetSlotLocalY(index);
      if (Math.abs(y - slotY) > slotHeight * 0.5) {
        continue;
      }
      const labelWidth = slotLabelHitWidth(input.name);
      if (x < labelStartX || x > labelStartX + labelWidth) continue;
      return {
        slot: index,
        direction: y < slotY ? -1 : 1,
      };
    }
    return null;
  }


  cancelPortClickTimer() {
    const pending = this._astralPendingPortClick;
    if (pending?.timer != null) clearTimeout(pending.timer);
    this._astralPendingPortClick = null;
  }


  schedulePortClick(hit, event) {
    this.cancelPortClickTimer();
    const pending = {
      slot: hit.slot,
      direction: hit.direction,
      event,
      timer: null,
    };
    pending.timer = setTimeout(() => {
      if (this._astralPendingPortClick !== pending) return;
      this._astralPendingPortClick = null;
      this.movePort(pending.slot, pending.direction);
    }, SET_GROUP_PORT_CLICK_DELAY_MS);
    this._astralPendingPortClick = pending;
  }


  applyPendingPortClick() {
    const pending = this._astralPendingPortClick;
    if (!pending) return false;
    if (pending.timer != null) clearTimeout(pending.timer);
    this._astralPendingPortClick = null;
    return this.movePort(pending.slot, pending.direction);
  }


  cancelPortPointerFallback() {
    const fallback = this._astralPortPointerFallback;
    if (!fallback) return false;
    fallback.cleanup();
    this._astralPortPointerFallback = null;
    return true;
  }


  installPortReorderHandlers(pointer, hit) {
    if (app.canvas?.pointer !== pointer) return false;
    pointer.onDragStart = (activePointer, event) => {
      this.cancelPortClickTimer();
      this.beginPortReorder(hit.slot, activePointer || pointer, event);
    };
    pointer.onDrag = (event) => this.updatePortReorderTarget(event);
    pointer.onDragEnd = (event) => this.finishPortReorder(event);
    pointer.onDragCancel = () => this.cancelPortReorder();
    return true;
  }


  schedulePortReorderHandlers(pointer, hit) {
    const install = () => {
      if (app.canvas?.pointer !== pointer) return;

      // LGraphCanvas installs its node-drag handlers immediately after
      // onMouseDown returns. Replace them on the next microtask so dragging a
      // port label reorders that port instead of moving the whole node.
      this.installPortReorderHandlers(pointer, hit);
    };

    if (typeof queueMicrotask === "function") {
      queueMicrotask(install);
    } else {
      setTimeout(install, 0);
    }
  }


  installPortPointerFallback(pointer, hit, event) {
    this.cancelPortPointerFallback();
    const pointerId = event?.pointerId;
    const startX = Number(event?.clientX);
    const startY = Number(event?.clientY);
    if (!Number.isFinite(startX) || !Number.isFinite(startY)) return false;
    const threshold = Math.max(
      1,
      Number(LiteGraph?.CanvasPointer?.maxClickDrift) || 6,
    );
    const gesture = {
      pointer,
      hit,
      pointerId,
      startX,
      startY,
      active: false,
      cleanup: null,
    };

    const matchesPointer = (moveEvent) => (
      pointerId == null
      || moveEvent?.pointerId == null
      || moveEvent.pointerId === pointerId
    );
    const onMove = (moveEvent) => {
      if (!matchesPointer(moveEvent)) return;
      const x = Number(moveEvent?.clientX);
      const y = Number(moveEvent?.clientY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (
        !gesture.active
        && Math.hypot(x - gesture.startX, y - gesture.startY) < threshold
      ) {
        return;
      }
      gesture.active = true;
      this.cancelPortClickTimer();
      // Keep the normal CanvasPointer drag callbacks as well. In frontends
      // where pointer capture is lost early, these window listeners still
      // complete the reorder.
      this.installPortReorderHandlers(pointer, hit);
      if (!this._astralPortDragState) {
        this.beginPortReorder(hit.slot, pointer, moveEvent);
      }
      this.updatePortReorderTarget(moveEvent);
    };
    const onFinish = (upEvent) => {
      if (!matchesPointer(upEvent)) return;
      const wasActive = gesture.active;
      this.cancelPortPointerFallback();
      if (!wasActive) return;
      this.cancelPortClickTimer();
      this.finishPortReorder(upEvent);
    };
    const onCancel = () => {
      this.cancelPortPointerFallback();
      this.cancelPortReorder();
    };
    gesture.cleanup = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onFinish, true);
      window.removeEventListener("pointercancel", onCancel, true);
    };
    this._astralPortPointerFallback = gesture;
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onFinish, true);
    window.addEventListener("pointercancel", onCancel, true);
    return true;
  }


  beginPortReorder(sourceSlot, pointer, event) {
    if (this._astralPortDragState?.sourceSlot === sourceSlot) {
      this.updatePortReorderTarget(event);
      return this._astralPortDragState;
    }
    const state = {
      sourceSlot,
      targetSlot: sourceSlot,
      pointer,
    };
    this._astralPortDragState = state;
    app.canvas?.processSelect?.(this, pointer?.eDown || event, true);
    this.updatePortReorderTarget(event);
    this.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
  }


  getPortReorderTargetAtY(localY, fallback = null) {
    const y = Number(localY);
    if (!Number.isFinite(y)) return fallback;
    const candidates = [];
    for (let index = 0; index < (this.inputs?.length || 0); index += 1) {
      if (!isSetInputConnected(this, index)) continue;
      candidates.push({ index, slotY: getSetGetSlotLocalY(index) });
    }
    if (!candidates.length) return fallback;
    candidates.sort((left, right) => left.slotY - right.slotY);
    if (y <= candidates[0].slotY) return candidates[0].index;
    const last = candidates[candidates.length - 1];
    if (y >= last.slotY) return last.index;
    let nearest = candidates[0];
    for (const candidate of candidates) {
      if (
        Math.abs(candidate.slotY - y)
        < Math.abs(nearest.slotY - y)
      ) {
        nearest = candidate;
      }
    }
    return nearest.index;
  }


  updatePortReorderTarget(event) {
    const state = this._astralPortDragState;
    if (!state) return null;
    let canvasY = Number(event?.canvasY);
    if (!Number.isFinite(canvasY)) {
      const clientY = Number(event?.clientY);
      const rect = app.canvas?.canvas?.getBoundingClientRect?.();
      const scale = Number(app.canvas?.ds?.scale);
      const offsetY = Number(app.canvas?.ds?.offset?.[1]);
      if (
        Number.isFinite(clientY)
        && rect
        && Number.isFinite(scale)
        && scale !== 0
        && Number.isFinite(offsetY)
      ) {
        canvasY = (clientY - rect.top) / scale - offsetY;
      }
    }
    if (!Number.isFinite(canvasY)) return state.targetSlot;
    state.targetSlot = this.getPortReorderTargetAtY(
      canvasY - (Number(this.pos?.[1]) || 0),
      state.sourceSlot,
    );
    app.canvas?.setDirty?.(true, true);
    return state.targetSlot;
  }


  finishPortReorder(event) {
    const state = this._astralPortDragState;
    if (!state) return false;
    this.updatePortReorderTarget(event);
    this._astralPortDragState = null;
    app.canvas?.setDirty?.(true, true);
    return state.sourceSlot === state.targetSlot
      ? false
      : this.movePortTo(state.sourceSlot, state.targetSlot);
  }


  cancelPortReorder() {
    if (!this._astralPortDragState) return false;
    this._astralPortDragState = null;
    app.canvas?.setDirty?.(true, true);
    return true;
  }


  onMouseDown(event, localPos) {
    if (
      event?.button !== 0
      || event.shiftKey
      || event.ctrlKey
      || event.metaKey
      || event.altKey
    ) {
      return false;
    }
    const hit = this.getPortNameHit(localPos, event);
    const pointer = app.canvas?.pointer;
    if (!pointer) return false;
    if (hit) {
      const targetInput = this.inputs?.[hit.slot] || null;
      const nativeClick = pointer.onClick;
      const nativeDoubleClick = pointer.onDoubleClick;
      pointer.onClick = (clickEvent) => {
        nativeClick?.(clickEvent);
        this.schedulePortClick(hit, event);
      };
      pointer.onDoubleClick = (doubleClickEvent) => {
        this.cancelPortClickTimer();
        this.cancelPortPointerFallback();
        this.cancelPortReorder();
        nativeDoubleClick?.(doubleClickEvent);
        void this.renamePort(
          hit.slot,
          doubleClickEvent || event,
          targetInput,
        );
      };
      this.schedulePortReorderHandlers(pointer, hit);
      this.installPortPointerFallback(pointer, hit, event);
    }
    // Let LGraphCanvas install its own drag handlers after this callback.
    // Returning false keeps the node, its side line and all connected links on
    // the native multi-item drag path.
    return false;
  }


  onRemoved() {
    this.cancelPortClickTimer();
    this.cancelPortPointerFallback();
    this.cancelPortReorder();
    if (this._astralSetInputSyncTimer != null) {
      clearTimeout(this._astralSetInputSyncTimer);
      this._astralSetInputSyncTimer = null;
    }
    this._astralPendingDisconnectedInputs?.clear();
    const graph = this.graph;
    setTimeout(() => {
      refreshGetCombos(graph);
      refreshGraphGets(graph);
    }, 0);
  }

  onPortNameChanged(value) {
    if (this._astralSyncingPort) return;
    const portId = this.getPrimaryPort()?.portId || null;
    let name = normalizePortName(value);
    if (!name && portId) {
      const source = sourceInfoForInput(
        this,
        this.getActivePorts()[0]?.slot,
      );
      name = cleanPortBaseName(
        source?.baseName,
        source?.type || "PORT",
      );
    }
    if (name) {
      this.applyPortName(name, {
        makeUnique: true,
        updatePrimary: true,
        notify: false,
      });
    } else {
      this.applyPortName("", {
        makeUnique: false,
        updatePrimary: false,
        notify: false,
      });
    }
    this.syncEndpoint();
    this.notifyGetters();
  }

  uniquePortName(value, ignoredPortId) {
    const base = cleanPortBaseName(value, "PORT");
    const used = new Set(
      activeSetPortEntries(this.graph)
        .filter((entry) => entry.portId !== ignoredPortId)
        .map((entry) => portNameKey(entry.name)),
    );
    let candidate = base;
    let suffix = 2;
    while (used.has(portNameKey(candidate))) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  applyPortName(value, options = {}) {
    this.ensurePortStorage();
    let name = normalizePortName(value);
    if (name && options.makeUnique) {
      const primary = this.getPrimaryPort();
      name = this.uniquePortName(name, primary?.portId);
    }
    this._astralSyncingPort = true;
    try {
      this.properties.portName = name;
      if (this.widgets?.[0]) this.widgets[0].value = name;
      if (options.updatePrimary) {
        const primary = this.getPrimaryPort();
        if (primary) this.properties.portNames[primary.portId] = name;
      }
    } finally {
      this._astralSyncingPort = false;
    }
    if (options.updatePrimary) this.assignPortNames();
    this.updateTitle();
  }

  syncEndpoint() {
    const primary = this.getPrimaryPort();
    if (primary) {
      const input = this.inputs?.[primary.slot];
      if (input) {
        input.type = "*";
        input.name = primary.name;
      }
    }
    layoutSetGroupSlots(this);
    this.updateTitle();
  }

  getPrimaryPort() {
    return this.getActivePorts()[0] || null;
  }

  updateTitle() {
    const name = normalizePortName(
      this.getActivePorts()[0]?.name
      || this.properties?.portName
      || "",
    );
    this.title = name ? `SetGroup_${name}` : "SetGroup";
    applySetGetNodeStyle(this);
  }

  getPortId(slotIndex) {
    this.ensurePortStorage();
    const input = this.inputs?.[slotIndex];
    if (!input) return null;
    if (input._astralPortId) return input._astralPortId;
    let portId = this.properties.portIds?.[slotIndex];
    if (!portId) {
      portId = makeRuntimePortId();
      this.properties.portIds[slotIndex] = portId;
    }
    input._astralPortId = portId;
    return portId;
  }

  ensurePortIdentities() {
    for (let index = 0; index < (this.inputs?.length || 0); index += 1) {
      const input = this.inputs[index];
      if (!input || !isSetInputConnected(this, index)) continue;
      const source = sourceInfoForInput(this, index);
      if (!source) continue;
      this.getPortId(index);
      input.type = "*";
    }
  }

  ensureTrailingSetInput() {
    const inputs = this.inputs || [];
    if (inputs.length >= MAX_SET_PORTS) return null;
    const last = inputs[inputs.length - 1];
    if (last && !isSetInputConnected(this, inputs.length - 1)) {
      last.name = "*";
      last.type = "*";
      delete last.label;
      last._astralSetPlaceholder = true;
      setInputConnectionColor(last, null, "*");
      return last;
    }
    const placeholder = this.addInput("*", "*");
    if (!placeholder) return null;
    placeholder.name = "*";
    placeholder.type = "*";
    delete placeholder.label;
    placeholder._astralSetPlaceholder = true;
    setInputConnectionColor(placeholder, null, "*");
    return placeholder;
  }


  captureInputAssignments() {
    const assignments = new Map();
    for (let index = 0; index < (this.inputs?.length || 0); index += 1) {
      const input = this.inputs[index];
      const link = inputLinkForSlot(this, index);
      if (input && link) assignments.set(input, link);
    }
    return assignments;
  }


  rebindInputAssignments(assignments) {
    for (let index = 0; index < (this.inputs?.length || 0); index += 1) {
      const input = this.inputs[index];
      const link = assignments.get(input);
      if (link) setLinkTargetSlot(link, index);
      try {
        input.link = linkIdentifier(link);
      } catch {
        // The graph link store remains authoritative on newer frontends.
      }
    }
  }

  vacateInputAssignments(assignments) {
    const links = Array.from(new Set(assignments.values()));
    for (let index = 0; index < links.length; index += 1) {
      // MoveEndpoint rejects a target slot that another participant still owns.
      // Park every participating link on a unique temporary slot first so the
      // final order can be committed without one-by-one collision failures.
      if (!setLinkTargetSlot(links[index], -(index + 1))) return false;
    }
    return true;
  }


  compactSetInputs() {
    this.ensurePortStorage();
    const originalInputs = [...(this.inputs || [])];
    const assignments = this.captureInputAssignments();
    const pendingDisconnects = this._astralPendingDisconnectedInputs
      || new Map();
    const connected = [];
    const previousSyncing = this._astralSyncingPort;
    this._astralSyncingPort = true;

    try {
      for (let index = 0; index < originalInputs.length; index += 1) {
        const input = originalInputs[index];
        const link = assignments.get(input);
        const pendingLinkId = input
          ? pendingDisconnects.get(input)
          : null;
        const forceDisconnected = Boolean(
          input
          && pendingLinkId != null
          && String(linkIdentifier(link)) === String(pendingLinkId),
        );
        if (input && pendingLinkId != null) {
          pendingDisconnects.delete(input);
        }
        if (!input || !link || forceDisconnected) {
          if (forceDisconnected) {
            // Some frontend callbacks announce a removed link before the
            // graph-link view is updated. Remove that known-stale entry so it
            // cannot be mistaken for a connection after slots are compacted.
            removeGraphLinkEntry(this.graph, pendingLinkId);
          }
          if (input?._astralPortId) {
            delete this.properties.portNames[input._astralPortId];
          }
          continue;
        }
        connected.push({
          input,
          link,
          portId: input._astralPortId || this.getPortId(index),
        });
      }

      const nextInputs = connected.map((entry) => entry.input);
      this.inputs.splice(0, this.inputs.length, ...nextInputs);

      connected.forEach((entry, index) => {
        setLinkTargetSlot(entry.link, index);
        entry.input._astralPortId = entry.portId;
        try {
          entry.input.link = linkIdentifier(entry.link);
        } catch {
          // The graph link store remains authoritative on newer frontends.
        }
      });

      if (nextInputs.length < MAX_SET_PORTS) {
        const placeholder = this.addInput("*", "*");
        if (placeholder) {
          placeholder.name = "*";
          placeholder.type = "*";
          placeholder._astralSetPlaceholder = true;
          delete placeholder._astralPortId;
          delete placeholder.label;
          try {
            placeholder.link = null;
          } catch {
            // Ignore read-only slot storage on newer frontends.
          }
          setInputConnectionColor(placeholder, null, "*");
        }
      }

      return (
        connected.length !== originalInputs.length
        || this.inputs.some((input, index) => input !== originalInputs[index])
      );
    } finally {
      this._astralSyncingPort = previousSyncing;
    }
  }

  scheduleSetInputSync() {
    if (this._astralSetInputSyncTimer != null) {
      clearTimeout(this._astralSetInputSyncTimer);
    }
    this._astralSetInputSyncTimer = setTimeout(() => {
      this._astralSetInputSyncTimer = null;
      if (!this.graph) return;
      const previousSyncing = this._astralSyncingPort;
      this._astralSyncingPort = true;
      try {
        this.refreshAfterPortStructureChange();
      } finally {
        this._astralSyncingPort = previousSyncing;
      }
    }, 0);
  }

  assignPortNames() {
    this.ensurePortStorage();
    this.ensurePortIdentities();
    const entries = [];
    for (let index = 0; index < (this.inputs?.length || 0); index += 1) {
      const input = this.inputs[index];
      setInputConnectionColor(input, null, "*");
      if (!input || !isSetInputConnected(this, index)) continue;
      const source = sourceInfoForInput(this, index);
      const portId = this.getPortId(index);
      entries.push({
        index,
        input,
        portId,
        type: source?.type || input.type || "*",
        baseName: source?.baseName || input.type || `PORT ${index + 1}`,
        customName: this.properties.portNames?.[portId] || "",
      });
    }
    const names = assignUniquePortNames(entries);
    entries.forEach((entry, entryIndex) => {
      entry.input.type = "*";
      entry.input.name = names[entryIndex];
      const source = sourceInfoForInput(this, entry.index);
      setInputConnectionColor(entry.input, source, entry.type);
    });
    return entries;
  }

  getActivePorts() {
    this.ensurePortStorage();
    this.ensurePortIdentities();
    const entries = [];
    for (let index = 0; index < (this.inputs?.length || 0); index += 1) {
      const input = this.inputs[index];
      if (!input || !isSetInputConnected(this, index)) continue;
      const source = sourceInfoForInput(this, index);
      const portId = this.getPortId(index);
      const type = source?.type || input.type || "*";
      const baseName = source?.baseName || type;
      const customName = this.properties.portNames?.[portId] || "";
      entries.push({
        slot: index,
        portId,
        type,
        baseName,
        customName,
        name: cleanPortBaseName(customName || baseName, type),
      });
    }
    const names = assignUniquePortNames(entries);
    entries.forEach((entry, index) => {
      entry.name = names[index];
      const input = this.inputs[entry.slot];
      input.name = entry.name;
      input.type = "*";
      const source = sourceInfoForInput(this, entry.slot);
      setInputConnectionColor(input, source, entry.type);
    });
    return entries;
  }

  getPortSummary() {
    const types = [];
    for (const port of this.getActivePorts()) {
      if (!types.includes(port.type)) types.push(port.type);
    }
    return types.join(" / ");
  }

  notifyGetters() {
    refreshGetCombos(this.graph);
    refreshGraphGets(this.graph);
    app.canvas?.setDirty?.(true, true);
  }

  onConnectionsChange(slotType, slot, isChangeConnect, link) {
    if (this._astralSyncingPort) return;
    if (slotType === LiteGraph.INPUT) {
      if (app.configuringGraph) {
        this.ensurePortIdentities();
        this.syncEndpoint();
        return;
      }
      if (isChangeConnect) {
        this._astralPendingDisconnectedInputs?.delete(this.inputs?.[slot]);
        this.ensurePortIdentities();
        const input = this.inputs?.[slot];
        if (input) {
          input._astralSetPlaceholder = false;
          delete input.label;
        }
        const source = sourceInfoForInput(this, slot);
        if (source && slot === 0) {
          const currentName = normalizePortName(
            this.properties.portName || this.widgets?.[0]?.value,
          );
          const automaticName = !currentName;
          if (automaticName) {
            this.applyPortName(
              cleanPortBaseName(source.baseName, source.type),
              {
                makeUnique: true,
                updatePrimary: true,
                notify: false,
              },
            );
          } else {
            this.applyPortName(currentName, {
              makeUnique: true,
              updatePrimary: true,
              notify: false,
            });
          }
        }
      } else {
        // The graph can call this callback before it removes the link from its
        // link store. Remember the exact input/link pair so the deferred pass
        // removes it even if the store briefly exposes a stale entry.
        const input = this.inputs?.[slot];
        if (input) {
          this._astralPendingDisconnectedInputs ||= new Map();
          this._astralPendingDisconnectedInputs.set(input, link?.id ?? link?.link ?? null);
        }
        this.scheduleSetInputSync();
        return;
      }
      this.compactSetInputs();
      this.refreshInputLinkTargets();
      this.rebuildPortSlotIndex();
      this.assignPortNames();
      this.syncEndpoint();
      this.notifyGetters();
      this.resizeToFitContent();
      return;
    }
    if (slotType === LiteGraph.OUTPUT && !app.configuringGraph) {
      this.syncEndpoint();
      this.notifyGetters();
    }
  }

  async renamePort(slotIndex, event, targetInput = null) {
    const initialIndex = Math.trunc(Number(slotIndex));
    const initialInput = targetInput || this.inputs?.[initialIndex];
    if (
      !Number.isInteger(initialIndex)
      || !initialInput
      || this.inputs?.[initialIndex] !== initialInput
      || !isSetInputConnected(this, initialIndex)
    ) {
      return;
    }
    const portId = this.getPortId(initialIndex);
    const current = initialInput.name || "";
    const value = await showCanvasPrompt(current, event, false, "Slot name");
    if (value == null) return;
    const currentIndex = this.inputs?.indexOf(initialInput) ?? -1;
    if (
      currentIndex < 0
      || !isSetInputConnected(this, currentIndex)
      || this.getPortId(currentIndex) !== portId
    ) {
      return;
    }
    const name = this.uniquePortName(
      normalizePortName(value) || current,
      portId,
    );
    this.properties.portNames[portId] = name;
    if (currentIndex === 0 || !this.properties.portName) {
      this.properties.portName = name;
      if (this.widgets?.[0]) this.widgets[0].value = name;
    }
    this.assignPortNames();
    this.syncEndpoint();
    this.notifyGetters();
    this.resizeToFitContent();
    this.graph?.change?.();
    app.canvas?.setDirty?.(true, true);
  }

  captureInputPortIds() {
    this.ensurePortStorage();
    this.ensurePortIdentities();
    for (let index = 0; index < (this.inputs?.length || 0); index += 1) {
      const input = this.inputs[index];
      const savedPortId = this.properties.portIds?.[index];
      if (input && !input._astralPortId && savedPortId) {
        input._astralPortId = savedPortId;
      }
    }
  }

  rebuildPortSlotIndex() {
    this.ensurePortStorage();
    const slotIds = {};
    for (let index = 0; index < (this.inputs?.length || 0); index += 1) {
      const portId = this.inputs[index]?._astralPortId;
      if (portId) slotIds[index] = portId;
    }
    this.properties.portIds = slotIds;
  }

  refreshInputLinkTargets() {
    for (let index = 0; index < (this.inputs?.length || 0); index += 1) {
      const link = inputLinkForSlot(this, index);
      if (!link) continue;
      setLinkTargetSlot(link, index);
    }
  }

  refreshAfterPortStructureChange() {
    this.ensurePortStorage();
    this.compactSetInputs();
    this.refreshInputLinkTargets();
    this.rebuildPortSlotIndex();
    this.assignPortNames();
    layoutSetGroupSlots(this);
    const primaryName = this.getActivePorts()[0]?.name || "";
    this.properties.portName = primaryName;
    if (this.widgets?.[0]) this.widgets[0].value = primaryName;
    this.syncEndpoint();
    this.resizeToFitContent();
    this.graph?.change?.();
    app.canvas?.setDirty?.(true, true);
    this.notifyGetters();
    return true;
  }

  disconnectInputLinkAtSlot(slotIndex, expectedLinkId = null) {
    const index = Math.trunc(Number(slotIndex));
    const input = this.inputs?.[index];
    const graph = this.graph;
    const inputLink = inputLinkForSlot(this, index);
    const linkId = expectedLinkId
      ?? linkIdentifier(inputLink)
      ?? input?.link;
    if (
      !Number.isInteger(index)
      || !input
      || linkId == null
      || !graph
    ) {
      return false;
    }

    const linkBefore = graphLink(graph, linkId);
    try {
      this.disconnectInput?.(index, true);
    } catch {
      // Continue with link-level and graph-level cleanup.
    }

    let link = graphLink(graph, linkId);
    if (link) {
      try {
        link.disconnect?.(graph, "input");
      } catch {
        // Continue with the graph API and topology cleanup below.
      }
    }
    link = graphLink(graph, linkId);
    if (link) {
      try {
        graph.removeLink?.(link.id ?? linkId);
      } catch {
        // Remove the serialized link entry directly as a last resort.
      }
    }
    link = graphLink(graph, linkId) || linkBefore;
    if (graphLink(graph, linkId)) {
      removeGraphLinkEntry(graph, linkId);
    }

    if (link?.origin_id != null && link.origin_slot != null) {
      const sourceNode = graph.getNodeById?.(link.origin_id);
      const output = sourceNode?.outputs?.[link.origin_slot];
      if (Array.isArray(output?.links)) {
        output.links = output.links.filter(
          (candidate) => String(candidate) !== String(linkId),
        );
      }
    }

    if (input.link != null) {
      try {
        input.link = null;
      } catch {
        // The graph entry is already removed for frontends with a read-only slot.
      }
    }
    return graphLink(graph, linkId) == null;
  }

  disconnectPortAtSlot(slotIndex) {
    const index = Math.trunc(Number(slotIndex));
    const input = this.inputs?.[index];
    const link = inputLinkForSlot(this, index);
    if (!Number.isInteger(index) || !input || !link) return false;
    this.captureInputPortIds();
    const linkId = linkIdentifier(link);
    this.graph?.beforeChange?.();
    this._astralSyncingPort = true;
    try {
      this.disconnectInputLinkAtSlot(index, linkId);
      input.name = "*";
      input.type = "*";
      input._astralSetPlaceholder = true;
      delete input.label;
      setInputConnectionColor(input, null, "*");
      return this.refreshAfterPortStructureChange();
    } finally {
      this._astralSyncingPort = false;
      this.graph?.afterChange?.();
    }
  }

  removePortAtSlot(slotIndex) {
    const index = Math.trunc(Number(slotIndex));
    const input = this.inputs?.[index];
    if (!Number.isInteger(index) || !input) return false;
    this.captureInputPortIds();
    const assignments = this.captureInputAssignments();
    const portId = this.getPortId(index);
    const linkId = linkIdentifier(inputLinkForSlot(this, index));
    this.graph?.beforeChange?.();
    this._astralSyncingPort = true;
    try {
      if (linkId != null) {
        this.disconnectInputLinkAtSlot(index, linkId);
      }
      try {
        this.removeInput?.(index);
      } catch {
        // Use the direct fallback below.
      }
      if (this.inputs[index] === input) this.inputs.splice(index, 1);
      if (portId) delete this.properties.portNames[portId];
      this.rebindInputAssignments(assignments);
      return this.refreshAfterPortStructureChange();
    } finally {
      this._astralSyncingPort = false;
      this.graph?.afterChange?.();
    }
  }

  movePortTo(slotIndexToMove, targetSlot) {
    const from = Math.trunc(Number(slotIndexToMove));
    const to = Math.trunc(Number(targetSlot));
    if (
      !Number.isInteger(from)
      || !Number.isInteger(to)
      || from === to
      || from < 0
      || to < 0
      || from >= (this.inputs?.length || 0)
      || to >= (this.inputs?.length || 0)
      || !isSetInputConnected(this, from)
      || !isSetInputConnected(this, to)
    ) {
      return false;
    }
    this.captureInputPortIds();
    const assignments = this.captureInputAssignments();
    this.graph?.beforeChange?.();
    const previousSyncing = this._astralSyncingPort;
    this._astralSyncingPort = true;
    try {
      const originalInputs = [...this.inputs];
      const nextInputs = [...originalInputs];
      const [moved] = nextInputs.splice(from, 1);
      nextInputs.splice(to, 0, moved);
      const expectedPortIds = nextInputs
        .map((input) => assignments.get(input))
        .filter(Boolean)
        .map((link) => linkIdentifier(link));

      const staged = this.vacateInputAssignments(assignments);
      let committed = staged;
      if (staged) {
        this.inputs.splice(0, this.inputs.length, ...nextInputs);
        committed = nextInputs.every((input, index) => {
          const link = assignments.get(input);
          if (!link) return true;
          const updated = setLinkTargetSlot(link, index);
          try {
            input.link = linkIdentifier(link);
          } catch {
            // The graph link store remains authoritative on newer frontends.
          }
          return updated;
        });
      }

      if (!committed) {
        this.inputs.splice(0, this.inputs.length, ...originalInputs);
        originalInputs.forEach((input, index) => {
          const link = assignments.get(input);
          if (link) setLinkTargetSlot(link, index);
        });
        this.refreshAfterPortStructureChange();
        return false;
      }

      this.refreshAfterPortStructureChange();
      const actualLinkIds = this.getActivePorts().map((port) => {
        const link = inputLinkForSlot(this, port.slot);
        return linkIdentifier(link);
      });
      return (
        actualLinkIds.length === expectedPortIds.length
        && actualLinkIds.every(
          (linkId, index) => String(linkId) === String(expectedPortIds[index]),
        )
      );
    } finally {
      this._astralSyncingPort = previousSyncing;
      this.graph?.afterChange?.();
    }
  }


  movePort(slotIndexToMove, direction) {
    const from = Math.trunc(Number(slotIndexToMove));
    const step = Math.sign(Number(direction));
    if (!Number.isInteger(from) || step === 0) return false;
    return this.movePortTo(from, from + step);
  }

  getSlotInPosition(x, y) {
    const inputs = this.inputs || [];
    const outputs = this.outputs || [];
    const slotHeight = getNodeSlotHeight();
    const hitRadius = 10;

    const hitSlot = (slots, index, isInput) => {
      const slot = slots[index];
      if (!slot || (!isInput && slot.hidden)) return null;
      const pos = graphSlotPosition(this, index, isInput);
      if (!pos) return null;
      if (
        x >= pos[0] - hitRadius
        && x <= pos[0] + hitRadius
        && y >= pos[1] - hitRadius
        && y <= pos[1] + hitRadius
      ) {
        return {
          [isInput ? "input" : "output"]: slot,
          slot: index,
          link_pos: pos,
        };
      }
      return null;
    };

    for (let index = 0; index < inputs.length; index += 1) {
      const found = hitSlot(inputs, index, true);
      if (found) return found;
    }
    for (let index = 0; index < outputs.length; index += 1) {
      const found = hitSlot(outputs, index, false);
      if (found) return found;
    }

    // ComfyUI's native slot hit area only covers the circle. Extend it across
    // the visible port name so right-clicking the label opens SetGroup's slot menu.
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      const pos = graphSlotPosition(this, index, true);
      if (!input || !pos) continue;
      const labelWidth = slotLabelHitWidth(input.name);
      if (
        x >= pos[0]
        && x <= pos[0] + labelWidth
        && Math.abs(y - pos[1]) <= slotHeight * 0.5
      ) {
        return {
          input,
          slot: index,
          link_pos: pos,
        };
      }
    }

    return null;
  }

  getSlotMenuOptions(slot) {
    let inputIndex = slotIndex(this, slot?.input, true);
    if (
      inputIndex < 0
      && !slot?.output
      && Number.isInteger(slot?.slot)
      && this.inputs?.[slot.slot]
    ) {
      inputIndex = slot.slot;
    }
    const input = this.inputs?.[inputIndex];
    if (!input) return null;

    if (!isSetInputConnected(this, inputIndex)) return [];
    return [
      {
        // ComfyUI's canvas menu intercepts this exact English content and
        // requires a native slot descriptor. Keep the visible label in title
        // so our SetGroup-specific callback always runs.
        title: "Disconnect Links",
        value: "astral-disconnect-links",
        callback: () => this.disconnectPortAtSlot(inputIndex),
      },
      {
        content: "Rename Port",
        callback: (_entry, _options, event) => {
          void this.renamePort(inputIndex, event, input);
        },
      },
      null,
      {
        title: "Remove Slot",
        value: "astral-remove-slot",
        className: "danger",
        callback: () => this.removePortAtSlot(inputIndex),
      },
    ];
  }

  getExtraMenuOptions(_canvas, options) {
    const activePorts = this.getActivePorts();
    if (activePorts.length) {
      options.unshift({
        content: "Rename SetGroup Port",
        has_submenu: true,
        submenu: {
          title: "Ports",
          options: activePorts.map((port) => ({
            content: `${port.name}  [${port.type}]`,
            callback: (_entry, _options, event) => {
              void this.renamePort(
                port.slot,
                event,
                this.inputs?.[port.slot] || null,
              );
            },
          })),
        },
      });
    }
    options.unshift({
      content: "Refresh All GetGroup",
      callback: () => this.notifyGetters(),
    });
  }
}


class AstralGetGroupNode extends LiteGraph.LGraphNode {
  static title = "GetGroup";
  static category = "Astral/Set & Get";
  static title_mode = LiteGraph.NO_TITLE ?? 1;

  get title_mode() {
    return LiteGraph.NO_TITLE ?? 1;
  }

  constructor() {
    super("GetGroup");
    this._astralBraceSide = "right";
    this.isVirtualNode = true;
    this.serialize_widgets = true;
    this.properties = this.properties || {};
    this.properties.getPortNames = parsePortNameList(
      Array.isArray(this.properties.getPortNames)
        ? this.properties.getPortNames.join(", ")
        : this.properties.getPortNames,
    );
    this.properties.setGroupId = this.properties.setGroupId ?? null;
    this.properties.setGroupName = String(this.properties.setGroupName || "");
    this._astralRefreshing = false;
    this._astralSyncingNames = false;
    this.color = DEFAULT_SET_GET_NODE_COLOR;
    this.bgcolor = TRANSPARENT_NODE_COLOR;
    this.boxcolor = TRANSPARENT_NODE_COLOR;
    this.resizable = false;

    const portsWidget = this.addWidget(
      "text",
      "ports",
      formatPortNameList(this.properties.getPortNames),
      (value) => this.onPortNamesChanged(value),
      {},
    );
    hideSetGetWidget(portsWidget);
    this.addOutput("*", "*");
    this.outputs[0]._astralGetPlaceholder = true;
    this.size = this.computeSize();
    layoutGetGroupSlots(this);
    applySetGetNodeStyle(this);
  }

  get renderingColor() {
    return TRANSPARENT_NODE_COLOR;
  }

  get renderingBgColor() {
    return TRANSPARENT_NODE_COLOR;
  }

  get renderingBoxColor() {
    return TRANSPARENT_NODE_COLOR;
  }

  getWidgetOnPos() {
    // Keep the hidden port-list widget out of native pointer hit testing.
    // Name dragging must use LGraphCanvas's node drag path.
    return undefined;
  }

  findResizeDirection() {
    return undefined;
  }

  onMouseMove(event, localPos, canvas = app.canvas) {
    return applySetGetHoverCursor(this, localPos, canvas);
  }

  isPointInside(x, y) {
    const inherited = super.isPointInside;
    if (
      typeof inherited === "function"
      && inherited.call(this, x, y)
    ) {
      return true;
    }

    const left = Number(this.pos?.[0]) || 0;
    const top = Number(this.pos?.[1]) || 0;
    const width = Math.max(
      GET_GROUP_MIN_WIDTH,
      Number(this.size?.[0]) || GET_GROUP_MIN_WIDTH,
    );
    const height = getSetGetNodeHeight(this.outputs?.length || 1);
    const right = left + width;
    const bottom = top + height;
    const scale = Math.max(1e-6, Number(app.canvas?.ds?.scale) || 1);

    if (x >= left && x < right && y >= top && y < bottom) {
      return true;
    }

    if (
      isSetGetBraceStrokePoint(
        this,
        [x - left, y - top],
        SET_GET_MOVE_CURSOR_MARGIN / scale,
      )
    ) {
      return true;
    }

    // The right brace is stroked on the node boundary. LiteGraph treats the
    // boundary as exclusive, so include the visible line and its antialiasing
    // without extending the whole node body to the right.
    return (
      x >= right - 1
      && x <= right + GET_GROUP_BRACE_HIT_SLOP
      && y >= top - GET_GROUP_BRACE_HIT_SLOP
      && y <= bottom + GET_GROUP_BRACE_HIT_SLOP
    );
  }

  drawBadges() {}

  serialize() {
    // GetGroup rebuilds its output slots at runtime. Serialize the live outputs so
    // links restored after loading a workflow are written back on save.
    return super.serialize();
  }

  computeSize(candidateSize) {
    const outputRows = Math.max(1, this.outputs?.length || 1);
    // Fit the width to the labels instead of keeping whatever width an old
    // workflow saved: GetGroup draws no background, so every extra pixel is an
    // invisible strip that still belongs to the node and drags it.
    return [this.contentWidth(), getSetGetNodeHeight(outputRows)];
  }

  /** Width the card actually needs: the longest visible port label plus the
   *  port column and the brace radius. */
  contentWidth() {
    let labelWidth = 0;
    for (const slot of this.outputs || []) {
      if (!slot || slot._astralGetPlaceholder || slot.hidden) continue;
      labelWidth = Math.max(labelWidth, measureSlotLabelWidth(slot.name));
    }
    return Math.max(
      GET_GROUP_MIN_WIDTH,
      Math.ceil(
        labelWidth
        + SET_GET_SIDE_RADIUS
        + SET_GROUP_PORT_LABEL_OFFSET_X
        + 8,
      ),
    );
  }

  resizeToFitContent() {
    const nextSize = this.computeSize();
    if (typeof super.setSize === "function") super.setSize(nextSize);
    else this.size = nextSize;
    layoutGetGroupSlots(this);
  }

  setSize(size) {
    const result = typeof super.setSize === "function"
      ? super.setSize(size)
      : (this.size = size);
    layoutGetGroupSlots(this);
    return result;
  }

  getPortNameHit(localPos, event = null) {
    const pointerPos = resolveSetGetPointerLocalPosition(this, localPos, event);
    const x = Number(pointerPos?.[0]);
    const y = Number(pointerPos?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const slotHeight = getNodeSlotHeight();
    const labelAnchorX = (
      (Number(this.size?.[0]) || GET_GROUP_MIN_WIDTH)
      - SET_GROUP_PORT_X
      - SET_GROUP_PORT_LABEL_OFFSET_X
    );
    for (let index = 0; index < (this.outputs?.length || 0); index += 1) {
      const output = this.outputs[index];
      if (!output || output._astralGetPlaceholder) continue;
      const slotY = getSetGetSlotLocalY(index);
      if (Math.abs(y - slotY) > slotHeight * 0.5) {
        continue;
      }
      const labelWidth = slotLabelHitWidth(output.name);
      if (x < labelAnchorX - labelWidth || x > labelAnchorX) continue;
      return {
        slot: index,
        direction: y < slotY ? -1 : 1,
      };
    }
    return null;
  }

  cancelPortClickTimer() {
    const pending = this._astralPendingPortClick;
    if (pending?.timer != null) clearTimeout(pending.timer);
    this._astralPendingPortClick = null;
  }

  cancelPortPointerFallback() {
    const fallback = this._astralPortPointerFallback;
    if (!fallback) return false;
    fallback.cleanup();
    this._astralPortPointerFallback = null;
    return true;
  }

  installPortReorderHandlers(pointer, hit) {
    if (app.canvas?.pointer !== pointer) return false;
    pointer.onDragStart = (activePointer, event) => {
      this.cancelPortClickTimer();
      this.beginPortReorder(hit.slot, activePointer || pointer, event);
    };
    pointer.onDrag = (event) => this.updatePortReorderTarget(event);
    pointer.onDragEnd = (event) => this.finishPortReorder(event);
    pointer.onDragCancel = () => this.cancelPortReorder();
    return true;
  }

  schedulePortReorderHandlers(pointer, hit) {
    const install = () => {
      if (app.canvas?.pointer !== pointer) return;
      this.installPortReorderHandlers(pointer, hit);
    };
    if (typeof queueMicrotask === "function") {
      queueMicrotask(install);
    } else {
      setTimeout(install, 0);
    }
  }

  installPortPointerFallback(pointer, hit, event) {
    this.cancelPortPointerFallback();
    const pointerId = event?.pointerId;
    const startX = Number(event?.clientX);
    const startY = Number(event?.clientY);
    if (!Number.isFinite(startX) || !Number.isFinite(startY)) return false;
    const threshold = Math.max(
      1,
      Number(LiteGraph?.CanvasPointer?.maxClickDrift) || 6,
    );
    const gesture = {
      pointer,
      hit,
      pointerId,
      startX,
      startY,
      active: false,
      cleanup: null,
    };
    const matchesPointer = (moveEvent) => (
      pointerId == null
      || moveEvent?.pointerId == null
      || moveEvent.pointerId === pointerId
    );
    const onMove = (moveEvent) => {
      if (!matchesPointer(moveEvent)) return;
      const x = Number(moveEvent?.clientX);
      const y = Number(moveEvent?.clientY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (
        !gesture.active
        && Math.hypot(x - gesture.startX, y - gesture.startY) < threshold
      ) {
        return;
      }
      gesture.active = true;
      this.cancelPortClickTimer();
      this.installPortReorderHandlers(pointer, hit);
      if (!this._astralPortDragState) {
        this.beginPortReorder(hit.slot, pointer, moveEvent);
      }
      this.updatePortReorderTarget(moveEvent);
    };
    const onFinish = (upEvent) => {
      if (!matchesPointer(upEvent)) return;
      const wasActive = gesture.active;
      this.cancelPortPointerFallback();
      if (!wasActive) return;
      this.cancelPortClickTimer();
      this.finishPortReorder(upEvent);
    };
    const onCancel = () => {
      this.cancelPortPointerFallback();
      this.cancelPortReorder();
    };
    gesture.cleanup = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onFinish, true);
      window.removeEventListener("pointercancel", onCancel, true);
    };
    this._astralPortPointerFallback = gesture;
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onFinish, true);
    window.addEventListener("pointercancel", onCancel, true);
    return true;
  }

  beginPortReorder(sourceSlot, pointer, event) {
    if (this._astralPortDragState?.sourceSlot === sourceSlot) {
      this.updatePortReorderTarget(event);
      return this._astralPortDragState;
    }
    const state = {
      sourceSlot,
      targetSlot: sourceSlot,
      pointer,
    };
    this._astralPortDragState = state;
    app.canvas?.processSelect?.(this, pointer?.eDown || event, true);
    this.updatePortReorderTarget(event);
    this.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
  }

  getPortReorderTargetAtY(localY, fallback = null) {
    const y = Number(localY);
    if (!Number.isFinite(y)) return fallback;
    const candidates = [];
    for (let index = 0; index < (this.outputs?.length || 0); index += 1) {
      const output = this.outputs[index];
      if (!output || output._astralGetPlaceholder) continue;
      candidates.push({ index, slotY: getSetGetSlotLocalY(index) });
    }
    if (!candidates.length) return fallback;
    candidates.sort((left, right) => left.slotY - right.slotY);
    if (y <= candidates[0].slotY) return candidates[0].index;
    const last = candidates[candidates.length - 1];
    if (y >= last.slotY) return last.index;
    let nearest = candidates[0];
    for (const candidate of candidates) {
      if (
        Math.abs(candidate.slotY - y)
        < Math.abs(nearest.slotY - y)
      ) {
        nearest = candidate;
      }
    }
    return nearest.index;
  }

  updatePortReorderTarget(event) {
    const state = this._astralPortDragState;
    if (!state) return null;
    let canvasY = Number(event?.canvasY);
    if (!Number.isFinite(canvasY)) {
      const clientY = Number(event?.clientY);
      const rect = app.canvas?.canvas?.getBoundingClientRect?.();
      const scale = Number(app.canvas?.ds?.scale);
      const offsetY = Number(app.canvas?.ds?.offset?.[1]);
      if (
        Number.isFinite(clientY)
        && rect
        && Number.isFinite(scale)
        && scale !== 0
        && Number.isFinite(offsetY)
      ) {
        canvasY = (clientY - rect.top) / scale - offsetY;
      }
    }
    if (!Number.isFinite(canvasY)) return state.targetSlot;
    state.targetSlot = this.getPortReorderTargetAtY(
      canvasY - (Number(this.pos?.[1]) || 0),
      state.sourceSlot,
    );
    app.canvas?.setDirty?.(true, true);
    return state.targetSlot;
  }

  finishPortReorder(event) {
    const state = this._astralPortDragState;
    if (!state) return false;
    this.updatePortReorderTarget(event);
    this._astralPortDragState = null;
    app.canvas?.setDirty?.(true, true);
    return state.sourceSlot === state.targetSlot
      ? false
      : this.movePortTo(state.sourceSlot, state.targetSlot);
  }

  cancelPortReorder() {
    if (!this._astralPortDragState) return false;
    this._astralPortDragState = null;
    app.canvas?.setDirty?.(true, true);
    return true;
  }

  getSlotInPosition(x, y) {
    const slotHeight = getNodeSlotHeight();
    const hitRadius = 10;
    for (let index = 0; index < (this.outputs?.length || 0); index += 1) {
      const output = this.outputs[index];
      if (!output || output._astralGetPlaceholder) continue;
      const pos = graphSlotPosition(this, index, false);
      if (!pos) continue;
      if (
        x >= pos[0] - hitRadius
        && x <= pos[0] + hitRadius
        && y >= pos[1] - hitRadius
        && y <= pos[1] + hitRadius
      ) {
        return {
          output,
          slot: index,
          link_pos: pos,
        };
      }
    }

    // Keep the right-hand brace outside the slot hit area. The brace is only
    // a visual frame; a left drag on it must move the whole node and its links.
    // The visible port name remains interactive for menu/reorder operations.
    for (let index = 0; index < (this.outputs?.length || 0); index += 1) {
      const output = this.outputs[index];
      if (!output || output._astralGetPlaceholder) continue;
      const pos = graphSlotPosition(this, index, false);
      if (!pos) continue;
      const labelAnchorX = pos[0] - SET_GROUP_PORT_LABEL_OFFSET_X;
      const labelWidth = slotLabelHitWidth(output.name);
      if (
        x >= labelAnchorX - labelWidth
        && x <= labelAnchorX
        && Math.abs(y - pos[1]) <= slotHeight * 0.5
      ) {
        return {
          output,
          slot: index,
          link_pos: pos,
        };
      }
    }
    return null;
  }

  onMouseDown(event, localPos) {
    if (
      event?.button !== 0
      || event.shiftKey
      || event.ctrlKey
      || event.metaKey
      || event.altKey
    ) {
      return false;
    }
    const hit = this.getPortNameHit(localPos, event);
    const pointer = app.canvas?.pointer;
    if (hit && pointer) {
      const nativeDoubleClick = pointer.onDoubleClick;
      pointer.onDoubleClick = (doubleClickEvent) => {
        this.cancelPortClickTimer();
        this.cancelPortPointerFallback();
        this.cancelPortReorder();
        nativeDoubleClick?.(doubleClickEvent);
        this.showPortChoiceMenu(hit.slot, doubleClickEvent || event);
      };
      this.schedulePortReorderHandlers(pointer, hit);
      this.installPortPointerFallback(pointer, hit, event);
    }
    // Returning false keeps the native multi-item node drag path outside labels.
    return false;
  }

  onRemoved() {
    this.cancelPortClickTimer();
    this.cancelPortPointerFallback();
    this.cancelPortReorder();
  }

  getOutputPos(slot) {
    const pos = setGetSlotLocalPosition(this, slot, false);
    return [
      // Keep LiteGraph's native 30px output hit box clear of the brace so a
      // left drag on the white frame reaches native node dragging. Link geometry
      // shares this anchor beside the visible output dot.
      (Number(this.pos?.[0]) || 0)
        + pos[0]
        - GET_GROUP_OUTPUT_HIT_INSET,
      (Number(this.pos?.[1]) || 0) + pos[1],
    ];
  }

  getSetNodes() {
    return graphNodes(this.graph)
      .filter((node) => node?.type === SET_GROUP_NODE)
      .sort((left, right) => (
        stableNumber(left.id) - stableNumber(right.id)
      ));
  }

  getAvailableSetPorts() {
    return activeSetPortEntries(this.graph);
  }

  getRequestedNames() {
    return parsePortNameList(this.properties.getPortNames);
  }


  getRealOutputs() {
    return Array.from(this.outputs || []).filter(
      (output) => !output?._astralGetPlaceholder,
    );
  }


  writeRequestedNames(names) {
    const normalized = parsePortNameList((names || []).join(", "))
      .slice(0, MAX_GET_PORTS);
    this.properties.getPortNames = normalized;
    this._astralSyncingNames = true;
    try {
      if (this.widgets?.[0]) {
        this.widgets[0].value = formatPortNameList(normalized);
      }
    } finally {
      this._astralSyncingNames = false;
    }
    return normalized;
  }


  getOutputTargetTypes(slot, fallbackLink = null) {
    const output = this.outputs?.[slot];
    const types = [];
    const links = [];
    for (const linkId of output?.links || []) {
      const link = graphLink(this.graph, linkId);
      if (link) links.push(link);
    }
    if (fallbackLink) {
      const fallback = typeof fallbackLink === "object"
        ? fallbackLink
        : graphLink(this.graph, fallbackLink);
      if (
        fallback
        && !links.some((link) => String(link.id) === String(fallback.id))
      ) {
        links.push(fallback);
      }
    }
    for (const link of links) {
      let type = null;
      try {
        type = link?.resolve?.(this.graph)?.input?.type || null;
      } catch {
        // Older frontend links are resolved from the target node below.
      }
      const target = this.graph?.getNodeById?.(link?.target_id);
      type = type || target?.inputs?.[link?.target_slot]?.type || null;
      if (type && !types.includes(type)) types.push(type);
    }
    return types;
  }


  isPortCompatibleWithOutput(port, slot) {
    return this.getOutputTargetTypes(slot).every(
      (targetType) => typesCompatible(targetType, port.type),
    );
  }


  findNearestSetPortForType(targetType) {
    const selectedNames = new Set(
      this.getRequestedNames().map((name) => portNameKey(name)),
    );
    const candidates = [];
    for (const port of this.getAvailableSetPorts()) {
      if (selectedNames.has(portNameKey(port.name))) continue;
      if (!typesCompatible(targetType, port.type)) continue;
      const dx = Number(port.setNode.pos?.[0] || 0) - Number(this.pos?.[0] || 0);
      const dy = Number(port.setNode.pos?.[1] || 0) - Number(this.pos?.[1] || 0);
      candidates.push({
        port,
        distance: dx * dx + dy * dy,
      });
    }
    candidates.sort((left, right) => left.distance - right.distance);
    return candidates[0]?.port || null;
  }


  ensureTrailingPlaceholder() {
    const names = this.getRequestedNames();
    const last = this.outputs?.[this.outputs.length - 1];
    if (names.length >= MAX_GET_PORTS) {
      if (last?._astralGetPlaceholder) {
        this.removeOutput(this.outputs.length - 1);
      }
      return false;
    }
    if (!last?._astralGetPlaceholder) {
      this.addOutput("*", "*");
    }
    const placeholder = this.outputs[this.outputs.length - 1];
    placeholder.name = "*";
    placeholder.type = "*";
    placeholder._astralGetPlaceholder = true;
    return true;
  }


  bindPortAtSlot(slot, port, fallbackLink = null) {
    const output = this.outputs?.[slot];
    if (!output || !port?.setNode) return false;
    const names = this.getRequestedNames();
    const selectedIndex = names.findIndex(
      (name) => portNameKey(name) === portNameKey(port.name),
    );
    if (output._astralGetPlaceholder) {
      if (slot !== names.length || selectedIndex >= 0) return false;
      names.push(port.name);
    } else {
      if (slot >= names.length || (selectedIndex >= 0 && selectedIndex !== slot)) {
        return false;
      }
      names[slot] = port.name;
    }

    this.writeRequestedNames(names);
    output.name = port.name;
    output.type = port.type;
    output._astralGetPortName = port.name;
    output._astralPortId = port.portId;
    output._astralSetNodeId = port.setNode.id;
    output._astralSetSlot = port.slot;
    output._astralGetPlaceholder = false;
    const links = [];
    for (const linkId of output.links || []) {
      const link = graphLink(this.graph, linkId);
      if (link) links.push(link);
    }
    if (fallbackLink) {
      const fallback = typeof fallbackLink === "object"
        ? fallbackLink
        : graphLink(this.graph, fallbackLink);
      if (
        fallback
        && !links.some((link) => String(link.id) === String(fallback.id))
      ) {
        links.push(fallback);
      }
    }
    for (const link of links) {
      const target = this.graph?.getNodeById?.(link?.target_id);
      const targetType = target?.inputs?.[link?.target_slot]?.type;
      if (link && typesCompatible(targetType, port.type)) link.type = port.type;
    }
    this.ensureTrailingPlaceholder();
    this.updateTitle();
    this.resizeToFitContent();
    applySetGetNodeStyle(this);
    this.graph?.change?.();
    app.canvas?.setDirty?.(true, true);
    return true;
  }


  setRequestedNames(names, options = {}) {
    this.writeRequestedNames(names);
    if (options.refresh !== false) this.refreshFromSetGroup();
  }

  onPortNamesChanged(value) {
    if (this._astralSyncingNames) return;
    this.setRequestedNames(
      parsePortNameList(value).slice(0, MAX_GET_PORTS),
      { refresh: false },
    );
    this.refreshFromSetGroup();
    app.canvas?.setDirty?.(true, true);
  }

  onRename() {
    this.refreshFromSetGroup();
  }

  onAdded() {
    applySetGetNodeStyle(this);
    setTimeout(() => this.refreshFromSetGroup(), 0);
  }

  onConfigure() {
    applySetGetNodeStyle(this);
    setTimeout(() => {
      applySetGetNodeStyle(this);
      this.migrateLegacyBinding();
      this.refreshFromSetGroup();
    }, 0);
  }

  onConnectionsChange(slotType, slot, isChangeConnect, link) {
    if (
      slotType !== LiteGraph.OUTPUT
      || this._astralRefreshing
      || app.configuringGraph
    ) {
      return;
    }
    const outputIndex = Number(slot);
    const output = this.outputs?.[outputIndex];
    if (!output) return;

    if (isChangeConnect && output._astralGetPlaceholder) {
      const targetType = this.getOutputTargetTypes(outputIndex, link)[0] || "*";
      const selected = this.findNearestSetPortForType(targetType);
      if (selected && this.bindPortAtSlot(outputIndex, selected, link)) return;
    }

    this.ensureTrailingPlaceholder();
    this.resizeToFitContent();
    applySetGetNodeStyle(this);
    app.canvas?.setDirty?.(true, true);
  }

  onDrawForeground(ctx) {
    applySetGetNodeStyle(this);
    drawSetGetSide(ctx, this);
  }

  migrateLegacyBinding() {
    const configuredNames = parsePortNameList(
      this.properties.getPortNames,
    );
    if (configuredNames.length) {
      this.setRequestedNames(configuredNames, { refresh: false });
      return;
    }

    const widgetValue = normalizePortName(this.widgets?.[0]?.value);
    const savedOutputNames = (this.outputs || [])
      .map((output) => normalizePortName(output?.name))
      .filter((name) => name && name !== "*");
    const looksLikeLegacyGroupId = (
      this.properties.setGroupId != null
      && widgetValue === String(this.properties.setGroupId)
    );
    const looksLikeLegacyOutputs = (
      !widgetValue
      && savedOutputNames.length > 0
    );
    if (!looksLikeLegacyGroupId && !looksLikeLegacyOutputs) return;

    let migratedNames = [];
    if (looksLikeLegacyGroupId) {
      const setNode = this.getSetNodes().find(
        (node) => String(node.id) === String(this.properties.setGroupId),
      );
      migratedNames = setNode
        ? (setNode.getActivePorts?.() || []).map((port) => port.name)
        : savedOutputNames;
    } else {
      migratedNames = savedOutputNames;
    }
    this.setRequestedNames(migratedNames, { refresh: false });
  }

  findSavedOutputForName(name) {
    const key = portNameKey(name);
    return (this.outputs || []).find(
      (output) => portNameKey(output._astralGetPortName || output.name) === key,
    ) || null;
  }

  findSetPortForName(name, savedOutput) {
    const entries = activeSetPortEntries(this.graph);
    if (savedOutput?._astralPortId) {
      const identityMatches = entries.filter((entry) => (
        entry.portId === savedOutput._astralPortId
        && (
          savedOutput._astralSetNodeId == null
          || String(entry.setNode.id) === String(savedOutput._astralSetNodeId)
        )
      ));
      if (identityMatches.length === 1) {
        return {
          ...identityMatches[0],
          _astralMatchedByPortId: true,
        };
      }
    }
    const matches = findSetPortEntriesByName(this.graph, name);
    if (!matches.length) return null;
    if (matches.length === 1) return matches[0];
    if (savedOutput?._astralSetNodeId != null) {
      const hinted = matches.find(
        (entry) => (
          String(entry.setNode.id) === String(savedOutput._astralSetNodeId)
          && entry.portId === savedOutput._astralPortId
        ),
      );
      if (hinted) return hinted;
    }
    return null;
  }

  getDesiredPorts() {
    const names = this.getRequestedNames();
    return names.map((requestedName) => {
      const savedOutput = this.findSavedOutputForName(requestedName);
      const matched = this.findSetPortForName(requestedName, savedOutput);
      return {
        // Preserve the source port's spelling when the typed value differs
        // only by case from the matching SetGroup name.
        name: matched?.name || requestedName,
        type: matched?.type || savedOutput?.type || "*",
        portId: matched?.portId || savedOutput?._astralPortId || null,
        setNodeId: matched?.setNode?.id ?? null,
        setSlot: matched?.slot ?? null,
        resolved: Boolean(matched),
        matchedByPortId: Boolean(matched?._astralMatchedByPortId),
      };
    });
  }

  updateTitle() {
    const names = this.getRequestedNames();
    if (!names.length) {
      this.title = "GetGroup";
    } else if (names.length === 1) {
      this.title = `GetGroup_${names[0]}`;
    } else {
      this.title = `GetGroup_${names[0]} +${names.length - 1}`;
    }
    applySetGetNodeStyle(this);
  }

  hasOnlyPlaceholderOutput() {
    return Boolean(
      this.outputs?.length === 1
      && this.outputs[0]?._astralGetPlaceholder,
    );
  }

  collectOutputLinks() {
    const snapshot = [];
    for (const [sourceSlot, output] of (this.outputs || []).entries()) {
      for (const linkId of output.links || []) {
        const link = graphLink(this.graph, linkId);
        if (!link) continue;
        snapshot.push({
          portName: output._astralGetPortName || output.name,
          portId: output._astralPortId || null,
          sourceSlot,
          sourceType: output.type,
          linkId,
          targetId: link.target_id,
          targetSlot: link.target_slot,
          parentId: link.parentId,
          type: link.type,
        });
      }
    }
    return snapshot;
  }

  restoreOutputLinks(snapshot, ports) {
    if (!ports.length) {
      if (!this.hasOnlyPlaceholderOutput()) return;
      for (const saved of snapshot) {
        const target = this.graph?.getNodeById?.(saved.targetId);
        if (!target?.inputs?.[saved.targetSlot]) continue;
        const targetType = target.inputs[saved.targetSlot]?.type;
        if (!typesCompatible(targetType, this.outputs[0].type)) continue;
        try {
          this.connect(0, target, saved.targetSlot, saved.parentId);
        } catch {
          try {
            this.connect(0, target, saved.targetSlot);
          } catch {
            // The target may have been occupied elsewhere.
          }
        }
      }
      return;
    }
    const outputIndexByName = new Map(
      ports.map((port, index) => [portNameKey(port.name), index]),
    );
    const outputIndexByPortId = new Map(
      ports
        .map((port, index) => [port.portId, index])
        .filter(([portId]) => Boolean(portId)),
    );
    for (const saved of snapshot) {
      const target = this.graph?.getNodeById?.(saved.targetId);
      if (!target?.inputs?.[saved.targetSlot]) continue;
      const targetType = target.inputs[saved.targetSlot]?.type;
      let outputIndex = outputIndexByName.get(portNameKey(saved.portName));
      if (outputIndex == null && saved.portId) {
        outputIndex = outputIndexByPortId.get(saved.portId);
      }
      if (
        outputIndex == null
        && ports[saved.sourceSlot]
        && typesCompatible(targetType, ports[saved.sourceSlot].type)
      ) {
        outputIndex = saved.sourceSlot;
      }
      if (
        outputIndex == null
        && saved.portName === "*"
      ) {
        outputIndex = ports.findIndex(
          (port) => typesCompatible(targetType, port.type),
        );
      }
      if (
        outputIndex == null
        || outputIndex < 0
        || !typesCompatible(targetType, ports[outputIndex].type)
      ) {
        continue;
      }
      try {
        this.connect(outputIndex, target, saved.targetSlot, saved.parentId);
      } catch {
        try {
          this.connect(outputIndex, target, saved.targetSlot);
        } catch {
          // The target may have been occupied elsewhere while names changed.
        }
      }
    }
  }

  rebuildOutputs(ports, snapshot = []) {
    this._astralRefreshing = true;
    try {
      for (const saved of snapshot) {
        this.graph?.removeLink?.(saved.linkId);
      }
      while (this.outputs?.length) this.removeOutput(0);
      for (const port of ports) {
        this.addOutput(port.name, port.type);
        const output = this.outputs[this.outputs.length - 1];
        output._astralGetPortName = port.name;
        output._astralPortId = port.portId;
        output._astralSetNodeId = port.setNodeId;
        output._astralSetSlot = port.setSlot;
      }
      if (ports.length < MAX_GET_PORTS) {
        this.addOutput("*", "*");
        this.outputs[this.outputs.length - 1]._astralGetPlaceholder = true;
      }
    } finally {
      this._astralRefreshing = false;
    }
    this.restoreOutputLinks(snapshot, ports);
    this.resizeToFitContent();
    applySetGetNodeStyle(this);
  }

  adoptMatchingOutputs(ports) {
    const realOutputs = this.getRealOutputs();
    if (realOutputs.length !== ports.length) return false;
    const compatible = ports.every((port, index) => (
      portNameKey(realOutputs[index]?.name) === portNameKey(port.name)
      && typesCompatible(realOutputs[index]?.type, port.type)
    ));
    if (!compatible) return false;
    ports.forEach((port, index) => {
      const output = realOutputs[index];
      output._astralGetPortName = port.name;
      output._astralPortId = port.portId;
      output._astralSetNodeId = port.setNodeId;
      output._astralSetSlot = port.setSlot;
      output._astralGetPlaceholder = false;
    });
    this.ensureTrailingPlaceholder();
    return true;
  }

  refreshFromSetGroup() {
    if (this._astralRefreshing) return;
    const ports = this.getDesiredPorts();
    const requestedNames = this.getRequestedNames();
    let requestedNamesChanged = false;
    ports.forEach((port, index) => {
      if (
        port.matchedByPortId
        && port.name
        && portNameKey(port.name) !== portNameKey(requestedNames[index])
      ) {
        requestedNames[index] = port.name;
        requestedNamesChanged = true;
      }
    });
    if (requestedNamesChanged) this.writeRequestedNames(requestedNames);
    this.updateTitle();

    if (!ports.length) {
      if (this.hasOnlyPlaceholderOutput()) {
        this.resizeToFitContent();
        return;
      }
      const snapshot = this.collectOutputLinks();
      this.rebuildOutputs([], snapshot);
      app.canvas?.setDirty?.(true, true);
      return;
    }

    this.adoptMatchingOutputs(ports);
    const structuralSignature = ports
      .map((port) => `${portNameKey(port.name)}:${normalizeType(port.type)}`)
      .join("|");
    const currentSignature = this.getRealOutputs()
      .map((output) => (
        `${portNameKey(output._astralGetPortName || output.name)}:${normalizeType(output.type)}`
      ))
      .join("|");

    if (structuralSignature === currentSignature) {
      this.resizeToFitContent();
      return;
    }

    const snapshot = this.collectOutputLinks();
    this.rebuildOutputs(ports, snapshot);
    this.graph?.change?.();
    app.canvas?.setDirty?.(true, true);
  }

  refreshPortChoices() {
    this.refreshFromSetGroup();
  }

  appendPortName(name) {
    const cleaned = normalizePortName(name);
    if (!cleaned) return;
    const names = this.getRequestedNames();
    if (names.some((entry) => portNameKey(entry) === portNameKey(cleaned))) {
      return;
    }
    if (names.length >= MAX_GET_PORTS) return;
    names.push(cleaned);
    this.setRequestedNames(names);
    app.canvas?.setDirty?.(true, true);
  }

  removePortName(name) {
    const key = portNameKey(name);
    const names = this.getRequestedNames();
    const remaining = names.filter(
      (entry) => portNameKey(entry) !== key,
    );
    if (remaining.length === names.length) return;
    this.setRequestedNames(remaining);
    app.canvas?.setDirty?.(true, true);
  }

  removePortAtSlot(slot) {
    const names = this.getRequestedNames();
    if (slot < 0 || slot >= names.length) return;
    names.splice(slot, 1);
    this.setRequestedNames(names);
    app.canvas?.setDirty?.(true, true);
  }

  movePortTo(slotIndexToMove, targetSlot) {
    const from = Math.trunc(Number(slotIndexToMove));
    const to = Math.trunc(Number(targetSlot));
    const names = this.getRequestedNames();
    if (
      !Number.isInteger(from)
      || !Number.isInteger(to)
      || from === to
      || from < 0
      || to < 0
      || from >= names.length
      || to >= names.length
    ) {
      return false;
    }
    const nextNames = [...names];
    const [moved] = nextNames.splice(from, 1);
    nextNames.splice(to, 0, moved);
    this.setRequestedNames(nextNames);
    const actualNames = this.getRequestedNames();
    return (
      actualNames.length === nextNames.length
      && actualNames.every(
        (name, index) => portNameKey(name) === portNameKey(nextNames[index]),
      )
    );
  }

  movePort(slotIndexToMove, direction) {
    const from = Math.trunc(Number(slotIndexToMove));
    const step = Math.sign(Number(direction));
    if (!Number.isInteger(from) || step === 0) return false;
    return this.movePortTo(from, from + step);
  }

  autoSelectForType(targetType) {
    const currentPorts = this.getDesiredPorts();
    const currentIndex = currentPorts.findIndex(
      (port) => typesCompatible(targetType, port.type),
    );
    if (currentIndex >= 0) return currentIndex;

    const selected = this.findNearestSetPortForType(targetType);
    if (!selected) {
      this.refreshFromSetGroup();
      return currentPorts.length ? 0 : -1;
    }

    const names = this.getRequestedNames();
    names.push(selected.name);
    this.setRequestedNames(names);
    return Math.max(0, this.getRequestedNames().indexOf(selected.name));
  }

  getResolvedPort(slot) {
    const port = this.getDesiredPorts()[slot];
    if (!port) return null;
    if (port.setNodeId != null && port.portId) {
      const byId = findSetPortEntryByPortId(this.graph, port.portId);
      if (
        byId
        && String(byId.setNode.id) === String(port.setNodeId)
      ) {
        return byId;
      }
    }
    return this.findSetPortForName(
      port.name,
      this.findSavedOutputForName(port.name),
    );
  }

  getInputLink(slot) {
    const port = this.getResolvedPort(slot);
    if (!port) return null;
    return inputLinkForSlot(port.setNode, port.slot);
  }

  resolveVirtualOutput(slot) {
    const port = this.getResolvedPort(slot);
    if (!port || port.setNode.graph !== this.graph) return undefined;
    const source = sourceInfoForInput(port.setNode, port.slot);
    if (!source?.sourceNode || source.originSlot == null) return undefined;
    return {
      node: source.sourceNode,
      slot: source.originSlot,
    };
  }

  goToSetGroup(outputIndex = 0) {
    const port = this.getResolvedPort(outputIndex);
    const setNode = port?.setNode;
    if (!setNode) return;
    const canvas = this.canvas || app.canvas;
    canvas?.centerOnNode?.(setNode);
    canvas?.selectNode?.(setNode, false);
    setNode.setDirtyCanvas?.(true, true);
    this.graph?.setDirtyCanvas?.(true, true);
    canvas?.setDirty?.(true, true);
  }

  async editPortNames(event) {
    const value = await showCanvasPrompt(
      formatPortNameList(this.getRequestedNames()),
      event,
      false,
      "Slot name",
    );
    if (value == null) return;
    this.setRequestedNames(
      parsePortNameList(value).slice(0, MAX_GET_PORTS),
    );
    app.canvas?.setDirty?.(true, true);
  }

  getPortChoiceOptions(outputIndex) {
    const names = this.getRequestedNames();
    const availablePorts = this.getAvailableSetPorts();
    const options = [];
    if (availablePorts.length) {
      options.push({
        content: "Select SetGroup Port",
        disabled: true,
      });
      for (const port of availablePorts) {
        const selectedIndex = names.findIndex(
          (name) => portNameKey(name) === portNameKey(port.name),
        );
        const usedElsewhere = selectedIndex >= 0 && selectedIndex !== outputIndex;
        options.push({
          content: `${selectedIndex === outputIndex ? "✓ " : ""}${port.name}  [${port.type}]${usedElsewhere ? "  (used)" : ""}`,
          disabled: usedElsewhere || !this.isPortCompatibleWithOutput(port, outputIndex),
          callback: () => this.bindPortAtSlot(outputIndex, port),
        });
      }
    } else {
      options.push({
        content: "No SetGroup ports available for GetGroup",
        disabled: true,
      });
    }
    return options;
  }

  showPortChoiceMenu(outputIndex, event) {
    if (
      !Number.isInteger(outputIndex)
      || !this.outputs?.[outputIndex]
      || typeof LiteGraph.ContextMenu !== "function"
    ) {
      return false;
    }
    new LiteGraph.ContextMenu(
      this.getPortChoiceOptions(outputIndex),
      {
        event,
        title: "GetGroup Ports",
        className: "dark",
        scale: Math.max(1, Number(app.canvas?.ds?.scale) || 1),
      },
    );
    return true;
  }


  getSlotMenuOptions(slot) {
    let outputIndex = slotIndex(this, slot?.output, false);
    if (outputIndex < 0 && Number.isInteger(slot?.slot)) {
      outputIndex = slot.slot;
    }
    if (outputIndex < 0 || !this.outputs?.[outputIndex]) {
      const original = super.getSlotMenuOptions;
      return typeof original === "function"
        ? original.call(this, slot)
        : null;
    }

    const port = this.getResolvedPort(outputIndex);
    const portChoices = this.getPortChoiceOptions(outputIndex);
    return [
      {
        content: "Go to Matching SetGroup",
        disabled: !port?.setNode,
        callback: () => this.goToSetGroup(outputIndex),
      },
      ...portChoices.filter(
        (option) => option?.content !== "Select SetGroup Port",
      ),
    ];
  }


  getExtraMenuOptions(_canvas, options) {
    const selectedNames = new Set(
      this.getRequestedNames().map((name) => portNameKey(name)),
    );
    const availablePorts = this.getAvailableSetPorts().filter(
      (port) => !selectedNames.has(portNameKey(port.name)),
    );
    if (availablePorts.length) {
      options.unshift({
        content: "Add GetGroup Port",
        has_submenu: true,
        submenu: {
          title: "SetGroup Ports",
          options: availablePorts.map((port) => ({
            content: `${port.name}  [${port.type}]`,
            callback: () => this.appendPortName(port.name),
          })),
        },
      });
    }
    const activeNames = this.getRequestedNames();
    if (activeNames.length) {
      options.unshift({
        content: "Remove GetGroup Port",
        has_submenu: true,
        submenu: {
          title: "Current Port",
          options: activeNames.map((name) => ({
            content: name,
            callback: () => this.removePortName(name),
          })),
        },
      });
    }
    options.unshift(
      {
        content: "Edit GetGroup Port Name",
        callback: (_entry, _options, event) => {
          void this.editPortNames(event);
        },
      },
      {
        content: "Refresh Ports",
        callback: () => {
          this.setRequestedNames(this.getRequestedNames());
        },
      },
    );
  }
}


function slotIndex(node, slot, isInput) {
  if (typeof slot === "number") return slot;
  if (typeof slot === "string") {
    return isInput ? node.findInputSlot?.(slot) : node.findOutputSlot?.(slot);
  }
  if (slot && typeof slot === "object") {
    const list = isInput ? node.inputs : node.outputs;
    const index = Array.isArray(list) ? list.indexOf(slot) : -1;
    if (index >= 0) return index;
    return isInput
      ? node.findInputSlot?.(slot.name)
      : node.findOutputSlot?.(slot.name);
  }
  return -1;
}


function graphSlotPosition(node, index, isInput) {
  const getter = isInput ? node.getInputPos : node.getOutputPos;
  if (typeof getter === "function") {
    try {
      const pos = getter.call(node, index);
      if (
        pos
        && Number.isFinite(Number(pos[0]))
        && Number.isFinite(Number(pos[1]))
      ) {
        return pos;
      }
    } catch {
      // Fall back to the slot's node-relative position below.
    }
  }
  const slot = isInput ? node.inputs?.[index] : node.outputs?.[index];
  if (
    !slot?.pos
    || !Number.isFinite(Number(slot.pos[0]))
    || !Number.isFinite(Number(slot.pos[1]))
  ) {
    return null;
  }
  return [
    (Number(node.pos?.[0]) || 0) + Number(slot.pos[0]),
    (Number(node.pos?.[1]) || 0) + Number(slot.pos[1]),
  ];
}


function connectOutputToNode(sourceNode, sourceSlot, targetNode, targetSlot, rerouteId) {
  const type = sourceNode.outputs?.[sourceSlot]?.type || "*";
  try {
    if (sourceNode.connect?.(sourceSlot, targetNode, targetSlot, rerouteId)) {
      return true;
    }
  } catch {
    // Try the newer type-aware API below.
  }
  try {
    return Boolean(sourceNode.connectByType?.(
      sourceSlot,
      targetNode,
      type,
      { afterRerouteId: rerouteId },
    ));
  } catch {
    return false;
  }
}


function canvasPositionFromMenuEvent(optPass) {
  const canvas = getCanvas();
  const mouse = canvas?.graph_mouse || canvas?.mouse;
  return [
    Number.isFinite(optPass?.e?.canvasX)
      ? optPass.e.canvasX
      : Number(mouse?.[0] || 0),
    Number.isFinite(optPass?.e?.canvasY)
      ? optPass.e.canvasY
      : Number(mouse?.[1] || 0),
  ];
}


function createSetFromOutput(optPass, graph) {
  const sourceNode = optPass.nodeFrom;
  if (!sourceNode) return;
  const sourceSlot = slotIndex(sourceNode, optPass.slotFrom, false);
  if (sourceSlot < 0 && !optPass.slotFrom?.connect) return;
  const node = LiteGraph.createNode(SET_GROUP_NODE);
  if (!node) return;
  node.pos = canvasPositionFromMenuEvent(optPass);
  graph.add(node);
  if (typeof sourceNode.connect === "function" && sourceSlot >= 0) {
    connectOutputToNode(
      sourceNode,
      sourceSlot,
      node,
      0,
      optPass.afterRerouteId,
    );
  } else {
    optPass.slotFrom?.connect?.(
      node.inputs?.[0],
      node,
      optPass.afterRerouteId,
    );
  }
  graph.change?.();
  getCanvas()?.selectNode?.(node, false);
  getCanvas()?.setDirty?.(true, true);
}


function createGetForInput(optPass, graph) {
  const targetNode = optPass.nodeTo;
  const targetSlot = slotIndex(targetNode, optPass.slotTo, true);
  if (!targetNode || targetSlot < 0) return;
  const node = LiteGraph.createNode(GET_GROUP_NODE);
  if (!node) return;
  node.pos = canvasPositionFromMenuEvent(optPass);
  graph.add(node);

  const targetType = targetNode.inputs?.[targetSlot]?.type || "*";
  let outputSlot = node.autoSelectForType?.(targetType);
  if (outputSlot == null || outputSlot < 0) outputSlot = 0;
  if (typeof targetNode.connect === "function") {
    try {
      node.connect(outputSlot, targetNode, targetSlot, optPass.afterRerouteId);
    } catch {
      try {
        node.connect(outputSlot, targetNode, targetSlot);
      } catch {
        // Keep the Get node even if the target rejects the placeholder connection.
      }
    }
  } else {
    optPass.slotTo?.connect?.(
      node.outputs?.[outputSlot],
      node,
      optPass.afterRerouteId,
    );
  }
  graph.change?.();
  getCanvas()?.selectNode?.(node, false);
  getCanvas()?.setDirty?.(true, true);
}


function connectionMenuLabel(optPass) {
  const fromOutput = Boolean(optPass.nodeFrom && optPass.slotFrom != null);
  const fromInput = Boolean(optPass.nodeTo && optPass.slotTo != null);
  if (fromOutput) return ADD_SET_GROUP_MENU_LABEL;
  if (fromInput) return ADD_GET_GROUP_MENU_LABEL;
  return "";
}


function decorateConnectionMenuOptions(options, menuOptions, optPass) {
  const label = connectionMenuLabel(optPass);
  if (!label || !Array.isArray(options)) {
    return { options, menuOptions };
  }
  const augmentedOptions = options.slice();
  const augmentedMenuOptions = menuOptions && typeof menuOptions === "object"
    ? { ...menuOptions }
    : {};
  if (!augmentedOptions.includes(label)) {
    const rerouteIndex = augmentedOptions.indexOf("Add Reroute");
    if (rerouteIndex >= 0) augmentedOptions.splice(rerouteIndex + 1, 0, label);
    else augmentedOptions.push(label);
  }

  const originalCallback = augmentedMenuOptions.callback;
  augmentedMenuOptions.callback = function astralConnectionMenuCallback(value, ...args) {
    if (value === label) {
    const graph = getActiveGraph();
    if (!graph) return;
      if (optPass.nodeFrom && optPass.slotFrom != null) createSetFromOutput(optPass, graph);
      else createGetForInput(optPass, graph);
      return;
    }
    return originalCallback?.call(this, value, ...args);
  };
  return { options: augmentedOptions, menuOptions: augmentedMenuOptions };
}


function installConnectionMenuEntries() {
  const canvas = app.canvas;
  if (!canvas || canvas.__astralSetGetConnectionMenuInstalled) return true;
  if (typeof canvas.showConnectionMenu !== "function") return false;
  const original = canvas.showConnectionMenu.bind(canvas);
  canvas.showConnectionMenu = function astralShowConnectionMenu(optPass) {
    const OriginalContextMenu = LiteGraph.ContextMenu;
    if (typeof OriginalContextMenu !== "function") return original(optPass);

    let interceptActive = true;
    function AstralContextMenu(options, menuOptions) {
      if (!interceptActive) return new OriginalContextMenu(options, menuOptions);
      interceptActive = false;
      LiteGraph.ContextMenu = OriginalContextMenu;
      const decorated = decorateConnectionMenuOptions(options, menuOptions, optPass);
      return new OriginalContextMenu(decorated.options, decorated.menuOptions);
    }
    AstralContextMenu.prototype = OriginalContextMenu.prototype;
    LiteGraph.ContextMenu = AstralContextMenu;
    try {
      return original(optPass);
    } catch (error) {
      console.warn("[Astral]Failed to add Set/Get connection menu entries", error);
      throw error;
    } finally {
      interceptActive = false;
      if (LiteGraph.ContextMenu === AstralContextMenu) {
        LiteGraph.ContextMenu = OriginalContextMenu;
      }
    }
  };
  canvas.__astralSetGetConnectionMenuInstalled = true;
  return true;
}


function retryInstallConnectionMenuEntries() {
  if (installConnectionMenuEntries()) return;
  let attempts = 0;
  const retry = () => {
    if (installConnectionMenuEntries()) return;
    attempts += 1;
    if (attempts < 40) window.setTimeout(retry, 100);
  };
  window.setTimeout(retry, 0);
}


app.registerExtension({
  name: "AssetsAstral.SetGetGroups",
  beforeRegisterVueAppNodeDefs: applySetGetNodeMetadata,
  registerCustomNodes() {
    LiteGraph.registerNodeType(SET_GROUP_NODE, AstralSetGroupNode);
    LiteGraph.registerNodeType(GET_GROUP_NODE, AstralGetGroupNode);
  },
  setup() {
    retryInstallConnectionMenuEntries();
    scheduleSetGetNodeDrawGuard();
  },
});


globalThis.__astralSetGetGroups = {
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
  getSetGetBraceGeometry,
  traceSetGetBrace,
  isSetGetBraceStrokePoint,
  drawSetGetNodeOnly,
  installSetGetNodeDrawGuard,
  typesCompatible,
  decorateConnectionMenuOptions,
  installConnectionMenuEntries,
};
