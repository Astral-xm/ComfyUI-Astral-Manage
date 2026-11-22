import { app } from "../../scripts/app.js";

export const ASTRAL_FAST_GROUPS_BYPASSER = "AstralFastGroupsBypasser";
export const FAST_GROUPS_BYPASSER_TITLE = "忽略多框";
export const FAST_GROUPS_BYPASSER_CATEGORY = "Assets Astral/Group Control";
export const NODE_PACKAGE_MODULE = "custom_nodes.ComfyUI-Astral-Manage";

const OUTPUT_NAME = "OPT_CONNECTION";
const MIN_NODE_WIDTH = 220;
const NODE_SIDE_MARGIN = 15;
const ROW_INNER_MARGIN = 10;
const ROW_HEIGHT = Math.max(
  20,
  Number(globalThis.LiteGraph?.NODE_WIDGET_HEIGHT) || 20,
);
const REFRESH_INTERVAL_MS = 600;

const PROPERTY_SORT = "sort";
const PROPERTY_SORT_CUSTOM_ALPHA = "customSortAlphabet";
const PROPERTY_MATCH_COLORS = "matchColors";
const PROPERTY_MATCH_TITLE = "matchTitle";
const PROPERTY_SHOW_NAV = "showNav";
const PROPERTY_SHOW_ALL_GRAPHS = "showAllGraphs";
const PROPERTY_RESTRICTION = "toggleRestriction";

const NODE_METADATA = Object.freeze({
  display_name: FAST_GROUPS_BYPASSER_TITLE,
  category: FAST_GROUPS_BYPASSER_CATEGORY,
  description:
    "List workflow groups and switch every node in a group between enabled and bypassed.",
});

const groupKeys = new WeakMap();
let nextGroupKey = 1;
let measurementCanvas = null;

function color(name, fallback) {
  const value = globalThis.LiteGraph?.[name];
  return value == null ? fallback : value;
}

function isLowQuality() {
  return (
    Number(app.canvas?.ds?.scale ?? 1) <= 0.5
    || Number(app.canvas?.ds?.scale ?? 1) === 0
  );
}

function graphNodeList(graph) {
  return Array.from(graph?._nodes || graph?.nodes || []);
}

function groupList(graph) {
  return Array.from(graph?._groups || graph?.groups || []);
}

function currentGraph() {
  try {
    const graph = app.canvas?.getCurrentGraph?.();
    if (graph) return graph;
  } catch {
    // Some older frontend builds do not expose getCurrentGraph().
  }
  return app.canvas?.graph || app.graph || app.rootGraph || null;
}

function subgraphsOf(graph) {
  const subgraphs = graph?.subgraphs;
  if (!subgraphs) return [];
  if (typeof subgraphs.values === "function") {
    return Array.from(subgraphs.values());
  }
  if (Array.isArray(subgraphs)) return subgraphs;
  return Object.values(subgraphs);
}

function reachableGraphs(root) {
  const graphs = [];
  const seen = new Set();
  const visit = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    graphs.push(graph);
    for (const child of subgraphsOf(graph)) visit(child);
  };
  visit(root);
  return graphs;
}

function stableGroupKey(group) {
  if (!group || (typeof group !== "object" && typeof group !== "function")) {
    return String(group);
  }
  let key = groupKeys.get(group);
  if (!key) {
    key = `group-${nextGroupKey}`;
    nextGroupKey += 1;
    groupKeys.set(group, key);
  }
  return key;
}

function graphId(graph) {
  return String(graph?.id ?? graph?.graph?.id ?? "graph");
}

function isVectorLike(value, minLength = 2) {
  if (!value) return false;
  let length = 0;
  try {
    length = Number(value.length);
  } catch {
    return false;
  }
  if (!Number.isFinite(length) || length < minLength) return false;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return true;
  // Vue reactive proxies wrap LiteGraph's Float64Array size and fail brand checks.
  return /^\[object (?:Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32|Float32|Float64|BigInt64|BigUint64)Array\]$/
    .test(Object.prototype.toString.call(value));
}

function groupKey(group) {
  const id = group?.id ?? group?._id;
  if (id != null) return `${graphId(group?.graph)}:${id}`;
  return stableGroupKey(group);
}

function pointInsideBounds(point, bounds) {
  if (!isVectorLike(point) || !isVectorLike(bounds, 4)) return false;
  return (
    point[0] >= bounds[0]
    && point[0] < bounds[0] + bounds[2]
    && point[1] >= bounds[1]
    && point[1] < bounds[1] + bounds[3]
  );
}

function fallbackGroupNodes(group) {
  const graph = group?.graph;
  const bounds = group?._bounding || group?.bounding;
  if (!graph || !isVectorLike(bounds, 4)) return [];
  const result = [];
  for (const node of graphNodeList(graph)) {
    const pos = node?.pos || node?._pos;
    const size = node?.size || node?._size;
    if (!isVectorLike(pos) || !isVectorLike(size)) continue;
    const center = [
      Number(pos[0] || 0) + Number(size[0] || 0) * 0.5,
      Number(pos[1] || 0) + Number(size[1] || 0) * 0.5,
    ];
    if (pointInsideBounds(center, bounds)) result.push(node);
  }
  return result;
}

function groupNodes(group, refresh = true) {
  if (!group) return [];
  if (
    refresh
    && typeof group.recomputeInsideNodes === "function"
    && !app.canvas?.isDragging
  ) {
    try {
      group.recomputeInsideNodes();
    } catch {
      // Fall through to the children/bounds representation.
    }
  }

  let nodes = [];
  if (group._children && typeof group._children.values === "function") {
    nodes = Array.from(group._children.values());
  } else if (Array.isArray(group._children)) {
    nodes = group._children.slice();
  } else if (Array.isArray(group.nodes)) {
    nodes = group.nodes.slice();
  }
  nodes = nodes.filter((node) => node && typeof node === "object");
  if (!nodes.length) {
    const fallback = fallbackGroupNodes(group);
    if (fallback.length && group._children?.add) {
      for (const node of fallback) group._children.add(node);
    }
    if (fallback.length && Array.isArray(group.nodes)) {
      group.nodes.splice(0, group.nodes.length, ...fallback);
    }
    nodes = fallback;
  }
  return nodes;
}

function groupHasEnabledNodes(group, refresh = true) {
  const always = globalThis.LiteGraph?.ALWAYS ?? 0;
  return groupNodes(group, refresh).some((node) => {
    try {
      return node.mode === always;
    } catch {
      return false;
    }
  });
}

function setModeRecursively(nodes, mode) {
  const stack = Array.from(nodes || []);
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    try {
      node.mode = mode;
    } catch {
      continue;
    }
    let nested = null;
    try {
      if (node.isSubgraphNode?.() && node.subgraph?.nodes) {
        nested = node.subgraph.nodes;
      }
    } catch {
      nested = null;
    }
    if (nested) {
      for (const child of Array.from(nested)) stack.push(child);
    }
  }
}

function normalizePropertyColor(value) {
  let normalized = String(value || "").trim().toLocaleLowerCase();
  if (!normalized) return "";
  const palette = globalThis.LGraphCanvas?.node_colors;
  if (palette?.[normalized]) normalized = palette[normalized].groupcolor || normalized;
  normalized = normalized.replace("#", "");
  if (normalized.length === 3) {
    normalized = normalized.replace(/(.)(.)(.)/, "$1$1$2$2$3$3");
  }
  return `#${normalized}`;
}

function groupColor(group) {
  return normalizePropertyColor(group?.color || "");
}

function groupPosition(group) {
  const pos = group?._pos || group?.pos || [0, 0];
  return [Number(pos[0] || 0), Number(pos[1] || 0)];
}

function sortGroupsByCustomAlphabet(groups, customAlphabet) {
  const alphabet = customAlphabet
    .replace(/\n/g, "")
    .toLocaleLowerCase();
  const entries = alphabet.includes(",")
    ? alphabet.split(",").map((entry) => entry.trim()).filter(Boolean)
    : Array.from(alphabet).filter((entry) => !/\s/.test(entry));
  if (!entries.length) return groups;

  return groups.slice().sort((left, right) => {
    const leftTitle = String(left.title || "").toLocaleLowerCase();
    const rightTitle = String(right.title || "").toLocaleLowerCase();
    const leftIndex = entries.findIndex((entry) => leftTitle.startsWith(entry));
    const rightIndex = entries.findIndex((entry) => rightTitle.startsWith(entry));
    if (leftIndex >= 0 && rightIndex >= 0 && leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
    if (leftIndex >= 0 && rightIndex < 0) return -1;
    if (leftIndex < 0 && rightIndex >= 0) return 1;
    return leftTitle.localeCompare(rightTitle);
  });
}

function estimateTextWidth(text, fontSize = 14) {
  let width = 0;
  for (const character of Array.from(String(text || ""))) {
    const codePoint = character.codePointAt(0) || 0;
    if (/\s/.test(character)) width += fontSize * 0.32;
    else if (codePoint > 0xff) width += fontSize * 0.95;
    else if (/[MW@#%&]/.test(character)) width += fontSize * 0.82;
    else width += fontSize * 0.57;
  }
  return width;
}

function getMeasurementContext() {
  const direct = app.canvas?.ctx;
  if (direct && typeof direct.measureText === "function") return direct;
  try {
    const context = app.canvas?.canvas?.getContext?.("2d");
    if (context && typeof context.measureText === "function") return context;
  } catch {
    // Use the offscreen canvas below.
  }
  if (measurementCanvas == null) {
    try {
      const canvas = document.createElement("canvas");
      if (typeof canvas?.getContext === "function") measurementCanvas = canvas;
      else measurementCanvas = false;
    } catch {
      measurementCanvas = false;
    }
  }
  if (!measurementCanvas) return null;
  return measurementCanvas.getContext("2d");
}

export function measureTextWidth(text, ctx = null) {
  const context = ctx || getMeasurementContext();
  if (context && typeof context.measureText === "function") {
    const oldFont = context.font;
    try {
      context.font = "14px sans-serif";
      return context.measureText(String(text ?? "")).width;
    } finally {
      context.font = oldFont;
    }
  }
  return estimateTextWidth(text);
}

export function fitText(ctx, text, maxWidth) {
  const value = String(text ?? "");
  const width = Math.max(0, Number(maxWidth) || 0);
  const measure = ctx?.measureText
    ? (part) => ctx.measureText(part).width
    : (part) => estimateTextWidth(part);
  if (measure(value) <= width) return value;
  if (width <= 0) return "";
  const ellipsis = "…";
  const ellipsisWidth = measure(ellipsis);
  if (ellipsisWidth > width) return "";
  const characters = Array.from(value);
  let left = 0;
  let right = characters.length;
  while (left < right) {
    const middle = Math.ceil((left + right) / 2);
    const candidate = `${characters.slice(0, middle).join("")}${ellipsis}`;
    if (measure(candidate) <= width) left = middle;
    else right = middle - 1;
  }
  return `${characters.slice(0, left).join("")}${ellipsis}`;
}

function roundedRect(ctx, x, y, width, height, radius) {
  const safeRadius = Math.max(
    0,
    Math.min(radius, width * 0.5, height * 0.5),
  );
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, width, height, safeRadius);
    return;
  }
  ctx.moveTo(x + safeRadius, y);
  ctx.lineTo(x + width - safeRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  ctx.lineTo(x + width, y + height - safeRadius);
  ctx.quadraticCurveTo(
    x + width,
    y + height,
    x + width - safeRadius,
    y + height,
  );
  ctx.lineTo(x + safeRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  ctx.lineTo(x, y + safeRadius);
  ctx.quadraticCurveTo(x, y, x + safeRadius, y);
  ctx.closePath();
}

function markCanvasDirty() {
  try {
    app.canvas?.setDirty?.(true, true);
  } catch {
    // Canvas may be shutting down.
  }
}

function navigateToGroup(group) {
  const canvas = app.canvas;
  if (!canvas || !group) return;
  try {
    canvas.centerOnNode?.(group);
    const size = group._size || group.size;
    if (
      !isLowQuality()
      && isVectorLike(size)
      && canvas.canvas?.width
      && canvas.canvas?.height
    ) {
      const currentZoom = Number(canvas.ds?.scale || 1);
      const zoomX = Number(canvas.canvas.width) / Math.max(1, Number(size[0]));
      const zoomY = Number(canvas.canvas.height) / Math.max(1, Number(size[1]));
      const targetZoom = Math.min(currentZoom, zoomX - 0.02, zoomY - 0.02);
      if (Number.isFinite(targetZoom) && targetZoom > 0) {
        canvas.setZoom?.(
          targetZoom,
          [canvas.canvas.width / 2, canvas.canvas.height / 2],
        );
      }
    }
  } catch {
    // Navigation is best-effort and must not block toggling other groups.
  }
  markCanvasDirty();
}

class AstralGroupToggleWidget {
  constructor(group, node) {
    this.name = `astral_group_toggle_${groupKey(group)}`;
    this.type = "custom";
    this.value = { toggled: false };
    this.options = {
      on: "yes",
      off: "no",
      serialize: false,
    };
    this.label = "";
    this.group = group;
    this.node = node;
    this.last_y = 0;
    this.__astralGroupRow = true;
  }

  get toggled() {
    return Boolean(this.value?.toggled);
  }

  set toggled(value) {
    this.value ||= {};
    this.value.toggled = Boolean(value);
  }

  setGroup(group) {
    if (!group) return;
    this.group = group;
    this.name = `astral_group_toggle_${groupKey(group)}`;
  }

  computeSize(width) {
    return [Math.max(0, Number(width) || 0), ROW_HEIGHT];
  }

  serializeValue() {
    return { toggled: this.toggled };
  }

  syncFromGroup() {
    this.toggled = groupHasEnabledNodes(this.group);
  }

  doModeChange(force = null, skipOtherNodeCheck = false) {
    const nodes = groupNodes(this.group);
    const hasEnabledNodes = nodes.some(
      (node) => node.mode === (globalThis.LiteGraph?.ALWAYS ?? 0),
    );
    let newValue = force == null ? !hasEnabledNodes : Boolean(force);
    const rows = this.node?._astralRows || [];
    const restriction = String(
      this.node?.properties?.[PROPERTY_RESTRICTION] || "default",
    );

    if (!skipOtherNodeCheck) {
      if (newValue && restriction.includes("one")) {
        for (const row of rows) {
          if (row !== this) row.doModeChange(false, true);
        }
      } else if (
        !newValue
        && restriction === "always one"
        && !rows.some((row) => row !== this && row.toggled)
      ) {
        newValue = true;
      }
    }

    setModeRecursively(
      nodes,
      newValue
        ? (this.node?.modeOn ?? globalThis.LiteGraph?.ALWAYS ?? 0)
        : (this.node?.modeOff ?? 4),
    );
    this.group.__astralHasAnyActiveNode = newValue;
    this.toggled = newValue;
    this.node?.syncGroupRowStates?.();
    try {
      this.node?.graph?.change?.();
    } catch {
      // Mode changes are still visible even if the graph cannot be marked.
    }
    this.node?.graph?.setDirtyCanvas?.(true, true);
    markCanvasDirty();
    return true;
  }

  toggle(value = null) {
    const next = value == null ? !this.toggled : Boolean(value);
    if (next === this.toggled) return false;
    return this.doModeChange(next);
  }

  navStartX() {
    return (
      Number(this.node?.size?.[0] || 0)
      - NODE_SIDE_MARGIN
      - 34
    );
  }

  mouse(event, pos, node) {
    if (event?.type !== "pointerdown") return false;
    if (Number(event?.button || 0) > 0) return false;
    const x = Number(pos?.[0] || 0);
    const showNav = node?.properties?.[PROPERTY_SHOW_NAV] !== false;
    if (showNav && x >= this.navStartX()) {
      navigateToGroup(this.group);
      return true;
    }
    return this.doModeChange();
  }

  draw(ctx, node, width, posY, height) {
    if (!ctx) return;
    const rowWidth = Math.max(0, Number(width) - NODE_SIDE_MARGIN * 2);
    const rowHeight = Math.max(1, Number(height) || ROW_HEIGHT);
    const x = NODE_SIDE_MARGIN;
    const y = Number(posY) || 0;
    const midY = y + rowHeight * 0.5;
    const lowQuality = isLowQuality();
    const showNav = node?.properties?.[PROPERTY_SHOW_NAV] !== false;

    ctx.save();
    ctx.beginPath();
    roundedRect(
      ctx,
      x,
      y,
      rowWidth,
      rowHeight,
      Math.min(rowHeight * 0.5, 14),
    );
    ctx.fillStyle = color("WIDGET_BGCOLOR", "#333");
    ctx.fill();
    if (!lowQuality) {
      ctx.strokeStyle = color("WIDGET_OUTLINE_COLOR", "#555");
      ctx.stroke();
    }
    ctx.clip();

    let cursorRight = x + rowWidth - ROW_INNER_MARGIN;
    if (showNav) {
      const arrowRight = cursorRight - 5;
      const arrowLeft = arrowRight - 22;
      const centerX = (arrowLeft + arrowRight) * 0.5;
      ctx.beginPath();
      ctx.moveTo(centerX - 4, midY - 6);
      ctx.lineTo(centerX + 4, midY);
      ctx.lineTo(centerX - 4, midY + 6);
      ctx.lineTo(centerX - 1, midY);
      ctx.closePath();
      ctx.fillStyle = "#92aec5";
      ctx.fill();
      cursorRight = arrowLeft - 8;
      ctx.beginPath();
      ctx.moveTo(cursorRight, y + 2);
      ctx.lineTo(cursorRight, y + rowHeight - 2);
      ctx.strokeStyle = color("WIDGET_OUTLINE_COLOR", "#555");
      ctx.stroke();
      cursorRight -= 8;
    }

    const toggleRadius = Math.max(6, rowHeight * 0.28);
    const toggleCenterX = cursorRight - toggleRadius;
    cursorRight -= toggleRadius * 2 + 5;

    if (!lowQuality) {
      const onText = String(this.options.on || "yes");
      const offText = String(this.options.off || "no");
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = color(
        this.toggled
          ? "WIDGET_TEXT_COLOR"
          : "WIDGET_SECONDARY_TEXT_COLOR",
        this.toggled ? "#ddd" : "#aaa",
      );
      ctx.fillText(this.toggled ? onText : offText, cursorRight, midY);
      cursorRight -= Math.max(
        measureTextWidth(onText, ctx),
        measureTextWidth(offText, ctx),
      ) + 8;
    }

    ctx.beginPath();
    ctx.arc(toggleCenterX, midY, toggleRadius, 0, Math.PI * 2);
    ctx.fillStyle = this.toggled ? "#8aa5b8" : "#383838";
    ctx.fill();

    if (!lowQuality) {
      const labelX = x + ROW_INNER_MARGIN;
      const labelWidth = Math.max(0, cursorRight - labelX);
      ctx.textAlign = "left";
      ctx.fillStyle = color("WIDGET_TEXT_COLOR", "#ddd");
      ctx.fillText(
        fitText(ctx, this.label, labelWidth),
        labelX,
        midY,
      );
    }
    ctx.restore();
  }
}

class AstralFastGroupsBypasser extends LiteGraph.LGraphNode {
  constructor() {
    super(FAST_GROUPS_BYPASSER_TITLE);
    this.comfyClass = ASTRAL_FAST_GROUPS_BYPASSER;
    this.isVirtualNode = true;
    this.serialize_widgets = false;
    this.resizable = true;
    this.min_width = MIN_NODE_WIDTH;
    this.modeOn = globalThis.LiteGraph?.ALWAYS ?? 0;
    this.modeOff = 4;
    this.color = "#3d3638";
    this.bgcolor = "#4c3034";
    this.boxcolor = "#bd9898";
    this._astralRows = [];
    this._astralRowByKey = new Map();
    this._astralRefreshTimer = null;
    this.properties = this.properties || {};
    this.normalizeProperties();
    this.addOutput(OUTPUT_NAME, "*");
    this.size = this.computeSize();
  }

  normalizeProperties() {
    if (typeof this.properties[PROPERTY_MATCH_COLORS] !== "string") {
      this.properties[PROPERTY_MATCH_COLORS] = "";
    }
    if (typeof this.properties[PROPERTY_MATCH_TITLE] !== "string") {
      this.properties[PROPERTY_MATCH_TITLE] = "";
    }
    if (typeof this.properties[PROPERTY_SHOW_NAV] !== "boolean") {
      this.properties[PROPERTY_SHOW_NAV] = true;
    }
    if (typeof this.properties[PROPERTY_SHOW_ALL_GRAPHS] !== "boolean") {
      this.properties[PROPERTY_SHOW_ALL_GRAPHS] = true;
    }
    if (!["position", "alphanumeric", "custom alphabet"].includes(
      this.properties[PROPERTY_SORT],
    )) {
      this.properties[PROPERTY_SORT] = "position";
    }
    if (typeof this.properties[PROPERTY_SORT_CUSTOM_ALPHA] !== "string") {
      this.properties[PROPERTY_SORT_CUSTOM_ALPHA] = "";
    }
    if (!["default", "max one", "always one"].includes(
      this.properties[PROPERTY_RESTRICTION],
    )) {
      this.properties[PROPERTY_RESTRICTION] = "default";
    }
  }

  getGroups() {
    const activeGraph = currentGraph();
    if (!activeGraph) return [];
    const showAll = this.properties[PROPERTY_SHOW_ALL_GRAPHS] !== false;
    const graphs = showAll ? reachableGraphs(activeGraph) : [activeGraph];
    const matchTitle = String(
      this.properties[PROPERTY_MATCH_TITLE] || "",
    ).trim();
    const filterColors = String(
      this.properties[PROPERTY_MATCH_COLORS] || "",
    )
      .split(",")
      .map(normalizePropertyColor)
      .filter(Boolean);

    let regex = null;
    if (matchTitle) {
      try {
        regex = new RegExp(matchTitle, "i");
      } catch (error) {
        console.warn(
          "[Assets Astral] Invalid group title filter:",
          matchTitle,
          error,
        );
      }
    }

    const groups = [];
    const seen = new Set();
    for (const graph of graphs) {
      for (const group of groupList(graph)) {
        if (!group || seen.has(group)) continue;
        seen.add(group);
        if (!group.graph) group.graph = graph;
        const title = String(group.title || "");
        if (regex && !regex.test(title)) continue;
        if (filterColors.length && !filterColors.includes(groupColor(group))) {
          continue;
        }
        groups.push(group);
      }
    }

    let sort = this.properties[PROPERTY_SORT] || "position";
    if (sort === "custom alphabet") {
      sort = String(
        this.properties[PROPERTY_SORT_CUSTOM_ALPHA] || "",
      ).trim()
        ? "custom alphabet"
        : "alphanumeric";
    }
    if (sort === "alphanumeric") {
      groups.sort((left, right) => (
        String(left.title || "").localeCompare(String(right.title || ""))
        || stableGroupKey(left).localeCompare(stableGroupKey(right))
      ));
    } else if (sort === "custom alphabet") {
      return sortGroupsByCustomAlphabet(
        groups,
        String(this.properties[PROPERTY_SORT_CUSTOM_ALPHA] || ""),
      );
    } else {
      groups.sort((left, right) => {
        const leftPos = groupPosition(left);
        const rightPos = groupPosition(right);
        const leftY = Math.floor(leftPos[1] / 30);
        const rightY = Math.floor(rightPos[1] / 30);
        if (leftY !== rightY) return leftY - rightY;
        const leftX = Math.floor(leftPos[0] / 30);
        const rightX = Math.floor(rightPos[0] / 30);
        return leftX - rightX
          || String(left.title || "").localeCompare(String(right.title || ""));
      });
    }
    return groups;
  }

  getMinimumWidth() {
    const labels = this._astralRows.map((row) => String(row.label || ""));
    const widestLabel = labels.reduce(
      (widest, label) => Math.max(widest, measureTextWidth(label)),
      0,
    );
    const statusWidth = Math.max(
      measureTextWidth("yes"),
      measureTextWidth("no"),
    );
    const navWidth = this.properties[PROPERTY_SHOW_NAV] !== false ? 42 : 0;
    const rowWidth = widestLabel
      ? (
        NODE_SIDE_MARGIN * 2
        + ROW_INNER_MARGIN
        + widestLabel
        + 8
        + statusWidth
        + 8
        + ROW_HEIGHT * 0.56
        + 5
        + navWidth
        + ROW_INNER_MARGIN
      )
      : 0;
    const titleWidth = 24 + measureTextWidth(FAST_GROUPS_BYPASSER_TITLE);
    const outputWidth = 68 + measureTextWidth(OUTPUT_NAME);
    return Math.ceil(Math.max(
      MIN_NODE_WIDTH,
      rowWidth,
      titleWidth,
      outputWidth,
    ));
  }

  computeSize(out) {
    const requestedWidth = isVectorLike(out)
      ? Number(out[0]) || 0
      : 0;
    const width = Math.ceil(Math.max(
      MIN_NODE_WIDTH,
      requestedWidth,
      this.getMinimumWidth(),
    ));
    let baseSize = null;
    try {
      baseSize = super.computeSize?.([width, isVectorLike(out) ? out[1] : 0]);
    } catch {
      baseSize = null;
    }
    const baseHeight = Number(baseSize?.[1]) || 0;
    const minimumHeight = 52 + this._astralRows.length * ROW_HEIGHT + 8;
    return [
      width,
      Math.ceil(Math.max(baseHeight, minimumHeight)),
    ];
  }

  ensureSizeFitsContent() {
    if (!isVectorLike(this.size)) return;
    const computed = this.computeSize([this.size[0], this.size[1]]);
    const width = Math.max(Number(this.size[0]) || 0, computed[0]);
    const height = Math.max(Number(this.size[1]) || 0, computed[1]);
    if (width === this.size[0] && height === this.size[1]) return;
    if (typeof this.setSize === "function") this.setSize([width, height]);
    else this.size = [width, height];
  }

  addRowWidget(row) {
    row.type = "custom";
    row.options ||= {};
    row.options.serialize = false;
    if (typeof this.addCustomWidget === "function") {
      this.addCustomWidget(row);
    } else {
      this.widgets ||= [];
      this.widgets.push(row);
    }
    return row;
  }

  removeRowWidget(row) {
    if (!row) return;
    if (typeof this.removeWidget === "function") {
      try {
        this.removeWidget(row);
        return;
      } catch {
        // Fall through to a direct array removal.
      }
    }
    this.widgets = (this.widgets || []).filter((widget) => widget !== row);
    row.onRemove?.();
  }

  refreshWidgets() {
    this.normalizeProperties();
    const groups = this.getGroups();
    const desiredRows = [];
    const desiredKeys = new Set();
    let changed = false;

    for (const group of groups) {
      const key = groupKey(group);
      desiredKeys.add(key);
      let row = this._astralRowByKey.get(key);
      if (!row) {
        row = new AstralGroupToggleWidget(group, this);
        this.addRowWidget(row);
        changed = true;
      } else {
        row.setGroup(group);
      }
      const nextLabel = `Enable ${String(group.title || "")}`;
      if (row.label !== nextLabel) {
        row.label = nextLabel;
        changed = true;
      }
      const wasToggled = row.toggled;
      row.syncFromGroup();
      if (wasToggled !== row.toggled) changed = true;
      desiredRows.push(row);
    }

    for (const [key, row] of this._astralRowByKey) {
      if (desiredKeys.has(key)) continue;
      this.removeRowWidget(row);
      changed = true;
    }
    this._astralRowByKey = new Map(
      desiredRows.map((row) => [groupKey(row.group), row]),
    );
    this._astralRows = desiredRows;

    const nonRows = (this.widgets || [])
      .filter((widget) => !widget?.__astralGroupRow);
    const nextWidgets = [...nonRows, ...desiredRows];
    const currentWidgets = this.widgets || [];
    if (
      currentWidgets.length !== nextWidgets.length
      || currentWidgets.some((widget, index) => widget !== nextWidgets[index])
    ) {
      this.widgets = nextWidgets;
      changed = true;
    }

    this.ensureSizeFitsContent();
    if (changed) markCanvasDirty();
    return changed;
  }

  syncGroupRowStates() {
    for (const row of this._astralRows) row.syncFromGroup();
  }

  scheduleRefresh(delay = REFRESH_INTERVAL_MS) {
    if (this._astralRefreshTimer != null || !this.graph) return;
    const timerHost = globalThis.window || globalThis;
    const setTimer = timerHost.setTimeout || globalThis.setTimeout;
    if (typeof setTimer !== "function") return;
    this._astralRefreshTimer = setTimer(() => {
      this._astralRefreshTimer = null;
      if (!this.graph) return;
      this.refreshWidgets();
      this.scheduleRefresh();
    }, Math.max(0, Number(delay) || 0));
  }

  stopRefresh() {
    if (this._astralRefreshTimer == null) return;
    const timerHost = globalThis.window || globalThis;
    const clearTimer = timerHost.clearTimeout || globalThis.clearTimeout;
    clearTimer?.(this._astralRefreshTimer);
    this._astralRefreshTimer = null;
  }

  onAdded() {
    super.onAdded?.();
    this.refreshWidgets();
    this.scheduleRefresh(0);
  }

  onConfigure() {
    super.onConfigure?.();
    this.normalizeProperties();
    this.refreshWidgets();
    this.ensureSizeFitsContent();
    this.scheduleRefresh(0);
  }

  onRemoved() {
    this.stopRefresh();
    super.onRemoved?.();
  }

  handleAction(action) {
    const normalized = String(action || "").toLocaleLowerCase();
    const restriction = this.properties[PROPERTY_RESTRICTION];
    if (normalized === "bypass all" || action === "全部旁路") {
      this._astralRows.forEach((row, index) => {
        row.doModeChange(
          restriction === "always one" && index === 0,
          true,
        );
      });
    } else if (normalized === "enable all" || action === "全部启用") {
      this._astralRows.forEach((row, index) => {
        row.doModeChange(
          restriction.includes("one") && index > 0 ? false : true,
          true,
        );
      });
    } else if (normalized === "toggle all" || action === "反转全部") {
      let foundEnabled = false;
      this._astralRows.forEach((row) => {
        const next = restriction.includes("one") && foundEnabled
          ? false
          : !row.toggled;
        foundEnabled ||= next;
        row.doModeChange(next, true);
      });
      if (
        !foundEnabled
        && restriction === "always one"
        && this._astralRows.length
      ) {
        this._astralRows[this._astralRows.length - 1].doModeChange(true, true);
      }
    }
  }

  getExtraMenuOptions(_canvas, options) {
    const menu = Array.isArray(options) ? options : [];
    menu.unshift(
      {
        content: "全部旁路",
        callback: () => this.handleAction("Bypass all"),
      },
      {
        content: "全部启用",
        callback: () => this.handleAction("Enable all"),
      },
      {
        content: "反转全部",
        callback: () => this.handleAction("Toggle all"),
      },
      {
        content: "刷新组列表",
        callback: () => {
          this.refreshWidgets();
          this.scheduleRefresh();
        },
      },
    );
    return menu;
  }
}

AstralFastGroupsBypasser.type = ASTRAL_FAST_GROUPS_BYPASSER;
AstralFastGroupsBypasser.title = FAST_GROUPS_BYPASSER_TITLE;
AstralFastGroupsBypasser.category = FAST_GROUPS_BYPASSER_CATEGORY;
AstralFastGroupsBypasser.comfyClass = ASTRAL_FAST_GROUPS_BYPASSER;
AstralFastGroupsBypasser.exposedActions = [
  "Bypass all",
  "Enable all",
  "Toggle all",
];
AstralFastGroupsBypasser["@matchColors"] = { type: "string" };
AstralFastGroupsBypasser["@matchTitle"] = { type: "string" };
AstralFastGroupsBypasser["@showNav"] = { type: "boolean" };
AstralFastGroupsBypasser["@showAllGraphs"] = { type: "boolean" };
AstralFastGroupsBypasser["@sort"] = {
  type: "combo",
  values: ["position", "alphanumeric", "custom alphabet"],
};
AstralFastGroupsBypasser["@customSortAlphabet"] = { type: "string" };
AstralFastGroupsBypasser["@toggleRestriction"] = {
  type: "combo",
  values: ["default", "max one", "always one"],
};

export function applyAstralFastGroupsNodeMetadata(nodeDefs) {
  if (!Array.isArray(nodeDefs)) return nodeDefs;
  for (const nodeDef of nodeDefs) {
    if (!nodeDef || nodeDef.name !== ASTRAL_FAST_GROUPS_BYPASSER) continue;
    Object.assign(nodeDef, NODE_METADATA, {
      python_module: NODE_PACKAGE_MODULE,
    });
  }
  return nodeDefs;
}

function refreshInstalledNodes() {
  const root = currentGraph();
  for (const graph of reachableGraphs(root)) {
    for (const node of graphNodeList(graph)) {
      if (node?.type === ASTRAL_FAST_GROUPS_BYPASSER) {
        node.refreshWidgets?.();
        node.scheduleRefresh?.();
      }
    }
  }
}

app.registerExtension({
  name: "AssetsAstral.FastGroupsBypasser",
  beforeRegisterVueAppNodeDefs: applyAstralFastGroupsNodeMetadata,
  registerCustomNodes() {
    LiteGraph.registerNodeType(
      ASTRAL_FAST_GROUPS_BYPASSER,
      AstralFastGroupsBypasser,
    );
  },
  nodeCreated(node) {
    if (node?.type === ASTRAL_FAST_GROUPS_BYPASSER) {
      node.refreshWidgets?.();
      node.scheduleRefresh?.();
    }
  },
  loadedGraphNode(node) {
    if (node?.type === ASTRAL_FAST_GROUPS_BYPASSER) {
      node.refreshWidgets?.();
      node.ensureSizeFitsContent?.();
      node.scheduleRefresh?.();
    }
  },
  afterConfigureGraph() {
    refreshInstalledNodes();
  },
});

globalThis.__astralFastGroupsBypasser = {
  ASTRAL_FAST_GROUPS_BYPASSER,
  FAST_GROUPS_BYPASSER_TITLE,
  FAST_GROUPS_BYPASSER_CATEGORY,
  NODE_PACKAGE_MODULE,
  OUTPUT_NAME,
  MIN_NODE_WIDTH,
  ROW_HEIGHT,
  AstralFastGroupsBypasser,
  AstralGroupToggleWidget,
  applyAstralFastGroupsNodeMetadata,
  measureTextWidth,
  fitText,
  groupNodes,
  groupHasEnabledNodes,
};
