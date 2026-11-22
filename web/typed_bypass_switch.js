import { app } from "../../scripts/app.js";
import { showAstralAlert } from "./astral_dialogs.js";


export const NODE_TYPE = "Typed Bypass Switch";
export const CONTROL_WIDGET = "enabled_slots";

const MODE_ALWAYS = 0;
const MODE_BYPASS = 4;
const MIN_NODE_WIDTH = 440;
const TOGGLE_RIGHT_RESERVE = 88;
const TOGGLE_HIT_WIDTH = 220;
const sourceModeOwners = new WeakMap();


export function normalizeType(type) {
  if (Array.isArray(type)) {
    return type
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .join(",") || "*";
  }
  const value = String(type ?? "").trim();
  return value || "*";
}


export function typesCompatible(targetType, sourceType) {
  const target = normalizeType(targetType);
  const source = normalizeType(sourceType);
  if (target === "*" || source === "*") return true;
  const targets = new Set(target.split(",").map((item) => item.trim()));
  return source
    .split(",")
    .map((item) => item.trim())
    .some((item) => targets.has(item) || targets.has("*") || item === "*");
}


function typeLabel(type) {
  const normalized = normalizeType(type);
  if (normalized === "*") return "ANY";
  return normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.toUpperCase())
    .join(" | ");
}


export function formatPortLabel(type, inputIndex = null) {
  const label = typeLabel(type);
  return inputIndex == null ? label : `${label}${inputIndex + 1}`;
}


export function inputToggleLabel(input, slot = 0) {
  const label = String(
    input?.label
    || input?.localized_name
    || input?.name
    || `INPUT${slot + 1}`,
  ).trim();
  return `Enable ${label || `INPUT${slot + 1}`}`;
}


export function parseEnabledSlots(value) {
  const values = Array.isArray(value)
    ? value
    : String(value ?? "").match(/\d+/g) || [];
  const slots = [];
  for (const raw of values) {
    const slot = Number.parseInt(raw, 10);
    if (Number.isInteger(slot) && slot > 0 && !slots.includes(slot)) {
      slots.push(slot);
    }
  }
  return slots;
}


function graphLink(graph, linkId) {
  if (linkId == null || !graph?.links) return null;
  if (graph.links instanceof Map) return graph.links.get(linkId) || null;
  if (Array.isArray(graph.links)) {
    return graph.links.find((link) => String(link?.id) === String(linkId)) || null;
  }
  return graph.links[linkId] || graph.links[String(linkId)] || null;
}


function sourceInfoForInput(node, slot) {
  const input = node?.inputs?.[slot];
  const graph = node?.graph;
  if (!input || input.link == null || !graph) return null;

  const link = graphLink(graph, input.link);
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
  if (!sourceNode) return null;

  return {
    link,
    input,
    sourceNode,
    originSlot,
    type: normalizeType(output?.type || input.type),
  };
}


function sourceKey(source) {
  return `${source.sourceNode.id}:${source.originSlot}`;
}


export function connectedInputEntries(node) {
  const entries = [];
  for (let slot = 0; slot < (node?.inputs?.length || 0); slot += 1) {
    const source = sourceInfoForInput(node, slot);
    if (!source) continue;
    entries.push({
      slot,
      key: sourceKey(source),
      sourceNode: source.sourceNode,
      originSlot: source.originSlot,
      type: source.type,
      input: source.input,
    });
  }
  return entries;
}


function getControlWidget(node) {
  return node?.widgets?.find((widget) => widget?.name === CONTROL_WIDGET) || null;
}


function hideControlWidget(node) {
  const widget = getControlWidget(node);
  if (!widget || widget.__astralTypedSwitchHidden) return;
  widget.__astralTypedSwitchHidden = true;
  widget.hidden = true;
  widget.computeSize = () => [0, -4];
  widget.draw = () => {};
  widget.mouse = () => false;
  widget.options ||= {};
  widget.options.hidden = true;
  for (const element of [widget.element, widget.domElement, widget.el, widget.container]) {
    if (!element?.style) continue;
    element.style.display = "none";
    element.style.visibility = "hidden";
    element.style.width = "0";
    element.style.height = "0";
    element.style.margin = "0";
    element.style.padding = "0";
  }
}


function setControlWidgetValue(node, value) {
  const widget = getControlWidget(node);
  if (!widget) return;
  widget.value = value;
  const index = node.widgets.indexOf(widget);
  if (index >= 0) {
    node.widgets_values ||= [];
    node.widgets_values[index] = value;
  }
}


function removeControlInputs(node) {
  node.inputs ||= [];
  for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
    const input = node.inputs[index];
    if (
      input?.name !== CONTROL_WIDGET
      && input?.widget?.name !== CONTROL_WIDGET
    ) {
      continue;
    }
    if (typeof node.removeInput === "function") {
      node.removeInput(index);
    } else {
      node.inputs.splice(index, 1);
    }
  }
}


function nextInputName(node) {
  const used = new Set((node.inputs || []).map((input) => String(input?.name || "")));
  let index = node.inputs.length + 1;
  while (used.has(`input_${index}`)) {
    index += 1;
  }
  return `input_${index}`;
}


function normalizeDynamicInputNames(node) {
  (node.inputs || []).forEach((input, index) => {
    if (!input) return;
    const name = `input_${index + 1}`;
    if (input.name !== name) input.name = name;
  });
}


function ensureDynamicInputs(node) {
  node.inputs ||= [];
  node.outputs ||= [];
  if (!node.inputs.length) {
    node.addInput("input_1", "*");
  }
  if (!node.outputs.length) {
    node.addOutput("value", "*");
  }

  for (let index = node.inputs.length - 2; index >= 0; index -= 1) {
    if (node.inputs[index]?.link == null) {
      node.removeInput(index);
    }
  }
  if (!node.inputs.length) {
    node.addInput("input_1", "*");
  }
  normalizeDynamicInputNames(node);
  if (node.inputs[node.inputs.length - 1]?.link != null) {
    node.addInput(nextInputName(node), "*");
  }
  normalizeDynamicInputNames(node);
}


function outputHasLinks(node) {
  return (node?.outputs || []).some((output) => (output?.links?.length || 0) > 0);
}


function inferLockedType(node, entries) {
  for (const entry of entries) {
    if (entry.type && entry.type !== "*") return entry.type;
  }

  const stored = normalizeType(node.properties?.astralLockedType);
  if (stored !== "*") return stored;

  for (const output of node.outputs || []) {
    const type = normalizeType(output?.type);
    if (type !== "*") return type;
  }
  for (const input of node.inputs || []) {
    const type = normalizeType(input?.type);
    if (type !== "*") return type;
  }
  return "*";
}


function updateLockedType(node, entries) {
  node.properties ||= {};
  let lockedType = inferLockedType(node, entries);
  if (!entries.length && !outputHasLinks(node)) {
    lockedType = "*";
  }

  if (lockedType === "*") {
    delete node.properties.astralLockedType;
  } else {
    node.properties.astralLockedType = lockedType;
  }

  node.inputs ||= [];
  node.outputs ||= [];
  node.inputs.forEach((input, index) => {
    if (!input) return;
    input.type = lockedType;
    input.label = formatPortLabel(lockedType, index);
    input.localized_name = input.label;
  });
  node.outputs.forEach((output) => {
    if (!output) return;
    output.type = lockedType;
    output.label = formatPortLabel(lockedType);
    output.localized_name = output.label;
  });
  return lockedType;
}


function validStoredSources(node, entries) {
  const current = new Set(entries.map((entry) => entry.key));
  return Array.from(new Set(
    (Array.isArray(node.properties?.enabledSources)
      ? node.properties.enabledSources
      : [])
      .map((key) => String(key))
      .filter((key) => current.has(key)),
  ));
}


function hydrateEnabledSources(node, entries) {
  node.properties ||= {};
  const stored = Array.isArray(node.properties.enabledSources)
    ? node.properties.enabledSources.map((key) => String(key))
    : [];
  let enabled = validStoredSources(node, entries);

  if (stored.length && !enabled.length && entries.length) {
    enabled = [entries[0].key];
  } else if (!node.properties.enabledConfigured && entries.length) {
    if (!enabled.length) {
      const widgetSlots = parseEnabledSlots(getControlWidget(node)?.value);
      enabled = widgetSlots
        .map((slot) => entries[slot - 1]?.key)
        .filter(Boolean);
    }
    if (!enabled.length) enabled = [entries[0].key];
    node.properties.enabledConfigured = true;
  }

  node.properties.enabledSources = Array.from(new Set(enabled));
  return node.properties.enabledSources;
}


function acquireSourceMode(sourceNode, owner, desiredMode) {
  let owners = sourceModeOwners.get(sourceNode);
  if (!owners) {
    owners = new Map();
    sourceModeOwners.set(sourceNode, owners);
  }
  if (!owners.has(owner)) {
    owners.set(owner, { originalMode: sourceNode.mode ?? MODE_ALWAYS });
  }
  const record = owners.get(owner);
  record.desiredMode = desiredMode;
  sourceNode.mode = desiredMode;
  sourceNode.graph?.setDirtyCanvas?.(true, true);
}


function releaseSourceMode(sourceNode, owner) {
  const owners = sourceModeOwners.get(sourceNode);
  if (!owners) return;
  const record = owners.get(owner);
  owners.delete(owner);
  if (!owners.size) {
    sourceModeOwners.delete(sourceNode);
    if (record) sourceNode.mode = record.originalMode;
  } else {
    const remaining = Array.from(owners.values());
    sourceNode.mode = remaining[remaining.length - 1].desiredMode;
  }
  sourceNode.graph?.setDirtyCanvas?.(true, true);
}


function applySourceModes(node, entries, enabledSources) {
  const managedNodes = node._astralManagedSourceNodes ||= new Map();
  const currentKeys = new Set(entries.map((entry) => entry.key));
  for (const [key, sourceNode] of managedNodes) {
    if (currentKeys.has(key)) continue;
    releaseSourceMode(sourceNode, node);
    managedNodes.delete(key);
  }

  const effective = entries.find((entry) => enabledSources.includes(entry.key)) || null;
  for (const entry of entries) {
    managedNodes.set(entry.key, entry.sourceNode);
    acquireSourceMode(
      entry.sourceNode,
      node,
      effective?.key === entry.key ? MODE_ALWAYS : MODE_BYPASS,
    );
  }
  return effective;
}


function resizeForInputs(node) {
  const computed = node.computeSize?.() || node.size || [MIN_NODE_WIDTH, 80];
  const width = Math.max(MIN_NODE_WIDTH, node.size?.[0] || 0, computed[0] || 0);
  const height = Math.max(node.size?.[1] || 0, computed[1] || 0);
  if (
    Math.abs((node.size?.[0] || 0) - width) > 0.5
    || Math.abs((node.size?.[1] || 0) - height) > 0.5
  ) {
    node.setSize?.([width, height]);
  }
}


export function finishEnabledSources(node, entries) {
  const enabledSources = hydrateEnabledSources(node, entries);
  const enabledSlots = [];
  entries.forEach((entry, index) => {
    if (enabledSources.includes(entry.key)) enabledSlots.push(index + 1);
  });
  setControlWidgetValue(node, enabledSlots.join(","));
  applySourceModes(node, entries, enabledSources);
  return enabledSlots;
}


export function stabilizeTypedSwitch(node) {
  if (!node || node._astralStabilizing) return null;
  node._astralStabilizing = true;
  try {
    node.properties ||= {};
    node.serialize_widgets = true;
    hideControlWidget(node);
    removeControlInputs(node);
    ensureDynamicInputs(node);
    let entries = connectedInputEntries(node);
    const lockedType = updateLockedType(node, entries);
    entries = connectedInputEntries(node);
    const enabledSlots = finishEnabledSources(node, entries);
    resizeForInputs(node);
    node.graph?.setDirtyCanvas?.(true, true);
    return {
      lockedType,
      enabledSlots,
      entries,
    };
  } finally {
    node._astralStabilizing = false;
  }
}


function scheduleStabilize(node, delay = 0) {
  if (!node) return;
  clearTimeout(node._astralStabilizeTimer);
  node._astralStabilizeTimer = setTimeout(() => {
    node._astralStabilizeTimer = null;
    stabilizeTypedSwitch(node);
  }, delay);
}


export function toggleInput(node, slot) {
  const entries = connectedInputEntries(node);
  const entry = entries.find((candidate) => candidate.slot === slot);
  if (!entry) return false;

  const enabled = Array.isArray(node.properties?.enabledSources)
    ? node.properties.enabledSources.map((key) => String(key))
    : [];
  if (enabled.includes(entry.key)) {
    node.properties.enabledSources = enabled.filter((key) => key !== entry.key);
  } else {
    node.properties.enabledSources = [...enabled, entry.key];
  }
  node.properties.enabledConfigured = true;
  stabilizeTypedSwitch(node);
  return true;
}


export function isEnabledSource(node, key) {
  return (node.properties?.enabledSources || []).map(String).includes(String(key));
}


function effectiveSourceKey(node, entries) {
  return entries.find((entry) => isEnabledSource(node, entry.key))?.key || null;
}


function inputRowY(node, slot) {
  return (
    (slot + 0.7) * (LiteGraph.NODE_SLOT_HEIGHT || 20)
    + (node.constructor?.slot_start_y || 0)
  );
}


export function toggleRect(node, slot) {
  const centerY = inputRowY(node, slot);
  const x = Math.max(96, (node.size?.[0] || MIN_NODE_WIDTH) - TOGGLE_HIT_WIDTH - TOGGLE_RIGHT_RESERVE);
  return {
    x,
    y: centerY - 9,
    width: TOGGLE_HIT_WIDTH,
    height: 18,
  };
}


function insideRect(x, y, rect) {
  return (
    x >= rect.x
    && x <= rect.x + rect.width
    && y >= rect.y
    && y <= rect.y + rect.height
  );
}


function drawInputToggle(ctx, node, entry, effectiveKey) {
  const rect = toggleRect(node, entry.slot);
  const enabled = isEnabledSource(node, entry.key);
  const effective = entry.key === effectiveKey;
  const accent = effective ? "#72bfff" : enabled ? "#d1a85a" : "#777";
  const label = inputToggleLabel(entry.input, entry.slot);
  const stateText = effective ? "yes" : enabled ? "备选" : "no";
  const trackWidth = 24;
  const trackHeight = 12;
  const trackX = rect.x + rect.width - trackWidth - 8;
  const trackY = rect.y + 3;
  const stateX = trackX - 8;

  ctx.save();
  ctx.lineWidth = 1;
  ctx.fillStyle = effective
    ? "rgba(61, 111, 151, 0.52)"
    : "rgba(43, 45, 48, 0.88)";
  ctx.strokeStyle = effective ? "#5898cc" : enabled ? "#7e6a48" : "#5f5f5f";
  ctx.beginPath();
  ctx.roundRect?.(rect.x, rect.y, rect.width, rect.height, 9);
  if (!ctx.roundRect) ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = effective
    ? "#d7efff"
    : enabled
      ? "#f0d58d"
      : (LiteGraph.WIDGET_SECONDARY_TEXT_COLOR || "#aaa");
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, rect.x + 9, rect.y + rect.height / 2, rect.width - 72);

  ctx.fillStyle = accent;
  ctx.textAlign = "right";
  ctx.fillText(stateText, stateX, rect.y + rect.height / 2, 34);

  ctx.fillStyle = effective ? "#4b91d1" : enabled ? "#7b6135" : "#4f4f4f";
  ctx.beginPath();
  ctx.roundRect?.(trackX, trackY, trackWidth, trackHeight, 6);
  if (!ctx.roundRect) ctx.rect(trackX, trackY, trackWidth, trackHeight);
  ctx.fill();

  const knobRadius = 4;
  const knobX = trackX + (enabled ? trackWidth - 6 : 6);
  ctx.fillStyle = enabled ? "#eef7ff" : "#b8b8b8";
  ctx.beginPath();
  ctx.arc(knobX, trackY + trackHeight / 2, knobRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}


function notifyIncompatibleType(lockedType, sourceType) {
  const message = (
    `Typed Bypass Switch 已锁定为 ${typeLabel(lockedType)}，`
    + `不能再接入 ${typeLabel(sourceType)}。`
  );
  void showAstralAlert({
    title: "输入类型不匹配",
    message,
    tone: "warning",
  });
}


function initializeTypedSwitch(node) {
  if (!node) return;
  node.properties ||= {};
  if (!Array.isArray(node.properties.enabledSources)) {
    node.properties.enabledSources = [];
  }
  if (node.properties.enabledConfigured == null) {
    node.properties.enabledConfigured = false;
  }
  node.color = "#253c4b";
  node.bgcolor = "#345468";
  node.boxcolor = "#9edcff";
  hideControlWidget(node);
  scheduleStabilize(node, 0);
}


function addTypedSwitchMethods(nodeType) {
  const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const result = originalOnNodeCreated?.apply(this, arguments);
    initializeTypedSwitch(this);
    return result;
  };

  const originalConfigure = nodeType.prototype.configure;
  nodeType.prototype.configure = function () {
    const result = originalConfigure?.apply(this, arguments);
    this.properties ||= {};
    hideControlWidget(this);
    scheduleStabilize(this, 0);
    return result;
  };

  const originalOnAdded = nodeType.prototype.onAdded;
  nodeType.prototype.onAdded = function () {
    const result = originalOnAdded?.apply(this, arguments);
    scheduleStabilize(this, 0);
    return result;
  };

  const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
  nodeType.prototype.onConnectionsChange = function (type) {
    const result = originalConnectionsChange?.apply(this, arguments);
    if (type === LiteGraph.INPUT) scheduleStabilize(this, 0);
    return result;
  };

  const originalConnectInput = nodeType.prototype.onConnectInput;
  nodeType.prototype.onConnectInput = function (
    _inputIndex,
    outputType,
    outputSlot,
  ) {
    const entries = connectedInputEntries(this);
    const lockedType = inferLockedType(this, entries);
    const sourceType = normalizeType(outputType || outputSlot?.type);
    if (lockedType !== "*" && !typesCompatible(lockedType, sourceType)) {
      notifyIncompatibleType(lockedType, sourceType);
      return false;
    }
    return originalConnectInput
      ? originalConnectInput.apply(this, arguments)
      : true;
  };

  const originalConnectByTypeOutput = nodeType.prototype.connectByTypeOutput;
  nodeType.prototype.connectByTypeOutput = function (
    slot,
    sourceNode,
    _sourceSlotType,
    options,
  ) {
    const free = this.inputs?.findIndex((input) => input?.link == null) ?? -1;
    if (free >= 0 && typeof sourceNode?.connect === "function") {
      return sourceNode.connect(slot, this, free);
    }
    return originalConnectByTypeOutput?.apply(this, arguments) || null;
  };

  const originalDrawForeground = nodeType.prototype.onDrawForeground;
  nodeType.prototype.onDrawForeground = function (ctx) {
    const result = originalDrawForeground?.apply(this, arguments);
    if (this.flags?.collapsed) return result;
    const entries = connectedInputEntries(this);
    const effectiveKey = effectiveSourceKey(this, entries);
    for (const entry of entries) drawInputToggle(ctx, this, entry, effectiveKey);
    return result;
  };

  const originalMouseDown = nodeType.prototype.onMouseDown;
  nodeType.prototype.onMouseDown = function (event, pos, canvas) {
    if (event?.button === 0 && Array.isArray(pos)) {
      const entries = connectedInputEntries(this);
      for (const entry of entries) {
        if (!insideRect(pos[0], pos[1], toggleRect(this, entry.slot))) continue;
        event.preventDefault?.();
        event.stopPropagation?.();
        toggleInput(this, entry.slot);
        canvas?.setDirty?.(true, true);
        return true;
      }
    }
    return originalMouseDown
      ? originalMouseDown.apply(this, arguments)
      : false;
  };

  const originalOnRemoved = nodeType.prototype.onRemoved;
  nodeType.prototype.onRemoved = function () {
    clearTimeout(this._astralStabilizeTimer);
    const managedNodes = this._astralManagedSourceNodes || new Map();
    for (const sourceNode of managedNodes.values()) {
      releaseSourceMode(sourceNode, this);
    }
    managedNodes.clear();
    return originalOnRemoved?.apply(this, arguments);
  };
}


app.registerExtension({
  name: "ComfyUI-Astral-Manage.TypedBypassSwitch",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === NODE_TYPE) {
      addTypedSwitchMethods(nodeType);
    }
  },
  nodeCreated(node) {
    const comfyClass = node?.constructor?.comfyClass;
    if (node?.type === NODE_TYPE || comfyClass === NODE_TYPE) {
      initializeTypedSwitch(node);
    }
  },
});


globalThis.__astralTypedBypassSwitch = {
  NODE_TYPE,
  CONTROL_WIDGET,
  normalizeType,
  typesCompatible,
  formatPortLabel,
  inputToggleLabel,
  parseEnabledSlots,
  toggleRect,
  connectedInputEntries,
  finishEnabledSources,
  stabilizeTypedSwitch,
  toggleInput,
  isEnabledSource,
};
