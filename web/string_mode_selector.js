import { app } from "../../scripts/app.js";


export const NODE_TYPE = "String Mode Selector";
export const CONTROL_WIDGET = "selected_string";
export const MAX_PROMPT_COUNT = 20;
export const DEFAULT_PROMPT_COUNT = 1;

const PROMPT_COUNT_PROPERTY = "promptCount";
const ACTIVE_MODE_PROPERTY = "activeMode";
const TITLE_PREFIX = "modeTitle_";
const PROMPT_PREFIX = "modePrompt_";
const MIN_NODE_WIDTH = 240;
const LEGACY_AUTO_WIDTHS = new Set([300, 315, 333]);
const ROW_HEIGHT = 24;
const CONTENT_TOP = 34;
const MODE_TOGGLE_TAG = "__astralStringModeToggle";
const PROMPT_EDITOR_STYLE_ID = "astral-string-mode-prompt-editor-style";
const PROMPT_EDITOR_STYLE_REVISION = "20261120-red-line-input-width";
const SEARCH_AND_REPLACE_PROPERTY = "Node name for S&R";
const ADVANCED_PROPERTY_NAMES = ["aux_id"];
const PROPERTIES_PANEL_WIDTH = "400px";
const PROPERTY_VALUE_WIDTH = "260px";


export function installPromptEditorStyles() {
  const document = globalThis.document;
  if (!document?.head) return false;

  const content = `
    #node-panel[data-astral-string-mode-selector] {
      box-sizing: border-box !important;
      width: ${PROPERTIES_PANEL_WIDTH} !important;
      min-width: ${PROPERTIES_PANEL_WIDTH} !important;
      max-width: ${PROPERTIES_PANEL_WIDTH} !important;
    }

    #node-panel[data-astral-string-mode-selector] .property {
      box-sizing: border-box !important;
      display: grid !important;
      grid-template-columns: minmax(0, 1fr) ${PROPERTY_VALUE_WIDTH} !important;
      column-gap: 6px !important;
      align-items: start !important;
      width: 100% !important;
      min-width: 0 !important;
    }

    #node-panel[data-astral-string-mode-selector] .property_name {
      box-sizing: border-box !important;
      width: 100% !important;
      min-width: 0 !important;
      max-width: 100% !important;
      overflow: hidden !important;
      text-align: left !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
    }

    #node-panel[data-astral-string-mode-selector] .property_value {
      box-sizing: border-box !important;
      display: block !important;
      width: 100% !important;
      min-width: 0 !important;
      max-width: 100% !important;
      field-sizing: normal !important;
      overflow: hidden !important;
    }

    #node-panel[data-astral-string-mode-selector] .property_value input,
    #node-panel[data-astral-string-mode-selector] .property_value textarea,
    #node-panel[data-astral-string-mode-selector] .property_value select {
      box-sizing: border-box !important;
      width: 100% !important;
      min-width: 0 !important;
      max-width: 100% !important;
      field-sizing: normal !important;
    }

    #node-panel[data-astral-string-mode-selector] .property_value,
    #node-panel[data-astral-string-mode-selector] .property_value input,
    #node-panel[data-astral-string-mode-selector] .property_value textarea,
    #node-panel[data-astral-string-mode-selector] .property_value select {
      text-align: left !important;
    }

    #node-panel[data-astral-string-mode-selector] .property[data-property="Node name for S&R"] {
      display: none !important;
    }

    #node-panel[data-astral-string-mode-selector] .property[data-property^="modePrompt_"] .property_value {
      box-sizing: border-box !important;
      width: 100% !important;
      height: calc(5 * 1.5em + 8px) !important;
      min-height: calc(5 * 1.5em + 8px) !important;
      max-height: calc(5 * 1.5em + 8px) !important;
      text-align: left !important;
      line-height: 1.5 !important;
      vertical-align: top !important;
      white-space: pre-wrap !important;
      overflow-x: hidden !important;
      overflow-y: auto !important;
      overflow-wrap: anywhere !important;
      overscroll-behavior: contain !important;
    }

    #node-panel[data-astral-string-mode-selector] .dialog-footer .btn.delete {
      display: none !important;
    }
  `;

  let style = document.getElementById?.(PROMPT_EDITOR_STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = PROMPT_EDITOR_STYLE_ID;
    document.head.append(style);
  }
  style.dataset.astralStyleRevision = PROMPT_EDITOR_STYLE_REVISION;
  if (style.textContent !== content) style.textContent = content;
  return true;
}


function propertyNameForRow(row) {
  const dataProperty = row?.dataset?.property;
  if (dataProperty) return dataProperty;
  const name = row?.querySelector?.(".property_name")?.textContent?.trim();
  return name || null;
}


function moveAdvancedPropertiesAboveModeCount(panel) {
  const rows = panel?.querySelectorAll?.(".property");
  if (!rows?.length) return false;

  const findRow = (property) => [...rows].find(
    (row) => propertyNameForRow(row) === property,
  );
  const countRow = findRow(PROMPT_COUNT_PROPERTY);
  if (!countRow?.parentNode) return false;

  for (const property of ADVANCED_PROPERTY_NAMES) {
    const row = findRow(property);
    if (row && row !== countRow) {
      countRow.parentNode.insertBefore(row, countRow);
    }
  }
  return true;
}


function hideSearchAndReplaceProperty(panel) {
  const rows = panel?.querySelectorAll?.(".property");
  if (!rows?.length) return false;

  const row = [...rows].find(
    (propertyRow) => propertyNameForRow(propertyRow) === SEARCH_AND_REPLACE_PROPERTY,
  );
  if (!row) return false;
  row.hidden = true;
  return true;
}


export function clampPromptCount(
  value,
  fallback = DEFAULT_PROMPT_COUNT,
) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_PROMPT_COUNT, Math.max(1, parsed));
}


export function modePropertyNames(index) {
  const modeIndex = clampPromptCount(index, 1);
  return {
    title: `${TITLE_PREFIX}${modeIndex}`,
    prompt: `${PROMPT_PREFIX}${modeIndex}`,
  };
}


export function modeIndexFromProperty(name) {
  const match = String(name ?? "").match(
    new RegExp(`^(?:${TITLE_PREFIX}|${PROMPT_PREFIX})(\\d+)$`),
  );
  if (!match) return null;
  const index = Number.parseInt(match[1], 10);
  return index >= 1 && index <= MAX_PROMPT_COUNT ? index : null;
}


function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}


export function getModeCount(node) {
  return clampPromptCount(
    node?.properties?.[PROMPT_COUNT_PROPERTY],
    DEFAULT_PROMPT_COUNT,
  );
}


export function getActiveModeIndex(node) {
  const count = getModeCount(node);
  const parsed = Number.parseInt(
    String(node?.properties?.[ACTIVE_MODE_PROPERTY] ?? "1"),
    10,
  );
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(count, Math.max(1, parsed));
}


function ensureModeProperties(node) {
  node.properties ||= {};
  const count = getModeCount(node);
  node.properties[PROMPT_COUNT_PROPERTY] = String(count);

  for (let index = 1; index <= count; index += 1) {
    const names = modePropertyNames(index);
    if (!hasOwn(node.properties, names.title)) {
      node.properties[names.title] = "";
    }
    if (!hasOwn(node.properties, names.prompt)) {
      node.properties[names.prompt] = "";
    }
  }

  const activeMode = getActiveModeIndex(node);
  node.properties[ACTIVE_MODE_PROPERTY] = activeMode;
  return count;
}


export function getModeEntries(node) {
  const count = ensureModeProperties(node);
  const properties = node.properties;
  const entries = [];
  for (let index = 1; index <= count; index += 1) {
    const names = modePropertyNames(index);
    entries.push({
      index,
      title: String(properties[names.title] ?? ""),
      prompt: String(properties[names.prompt] ?? ""),
      propertyNames: names,
    });
  }
  return entries;
}


function getControlWidget(node) {
  return node?.widgets?.find(
    (widget) => widget?.name === CONTROL_WIDGET,
  ) || null;
}


function hideControlWidget(node) {
  const widget = getControlWidget(node);
  if (!widget || widget.__astralStringModeHidden) return;
  widget.__astralStringModeHidden = true;
  widget.hidden = true;
  widget.computeSize = () => [0, -4];
  widget.draw = () => {};
  widget.mouse = () => false;
  widget.options ||= {};
  widget.options.hidden = true;
  for (const element of [
    widget.element,
    widget.domElement,
    widget.el,
    widget.container,
  ]) {
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


function findModeToggleWidgets(node) {
  return (node?.widgets || []).filter(
    (widget) => widget?.[MODE_TOGGLE_TAG],
  );
}


function removeModeToggleWidget(node, widget) {
  const index = node.widgets?.indexOf(widget) ?? -1;
  if (index < 0) return;
  if (typeof node.removeWidget === "function") {
    node.removeWidget(index);
  } else {
    node.widgets.splice(index, 1);
  }
}


function syncModeToggleWidgets(node) {
  if (!node?.widgets) return;
  const entries = getModeEntries(node);
  const activeMode = getActiveModeIndex(node);
  const existing = findModeToggleWidgets(node);

  for (const widget of existing) {
    const index = Number(widget._astralStringModeIndex);
    if (index >= 1 && index <= entries.length) continue;
    removeModeToggleWidget(node, widget);
  }

  for (const entry of entries) {
    let widget = findModeToggleWidgets(node).find(
      (candidate) => candidate._astralStringModeIndex === entry.index,
    );
    const label = `Enable ${entry.title.trim() || `未命名模式 ${entry.index}`}`;
    if (!widget && typeof node.addWidget === "function") {
      widget = node.addWidget(
        "toggle",
        label,
        entry.index === activeMode,
        () => selectMode(node, entry.index),
        { on: "yes", off: "no" },
      );
      if (!widget) continue;
      widget[MODE_TOGGLE_TAG] = true;
      widget._astralStringModeIndex = entry.index;
    }
    if (!widget) continue;

    widget.name = label;
    widget.label = label;
    widget.options = { on: "yes", off: "no" };
    widget.value = entry.index === activeMode;
    widget.callback = () => selectMode(node, entry.index);
    delete widget.draw;

    // The active mode is stored in node.properties. Keeping these visual
    // widgets out of widgets_values prevents stale toggle values from
    // replacing the selected_string widget during workflow serialization.
    widget.serialize = false;
  }
}


function removeInputPorts(node) {
  node.inputs ||= [];
  for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
    if (typeof node.removeInput === "function") {
      node.removeInput(index);
    } else {
      node.inputs.splice(index, 1);
    }
  }
}


function ensureStringOutput(node) {
  node.outputs ||= [];
  if (!node.outputs.length && typeof node.addOutput === "function") {
    node.addOutput("STRING", "STRING");
  }
  const output = node.outputs[0];
  if (!output) return null;
  output.name = "STRING";
  output.label = "STRING";
  output.localized_name = "STRING";
  output.type = "STRING";
  return output;
}


export function syncSelectedString(node) {
  const entries = getModeEntries(node);
  const activeMode = getActiveModeIndex(node);
  const activeEntry = entries[activeMode - 1] || entries[0];
  node.properties[ACTIVE_MODE_PROPERTY] = activeEntry?.index || 1;
  setControlWidgetValue(node, activeEntry?.prompt || "");
  return activeEntry?.prompt || "";
}


function modeRowsHeight(node) {
  return CONTENT_TOP + getModeCount(node) * ROW_HEIGHT;
}


function resizeForModes(node) {
  const computed = node.computeSize?.() || node.size || [MIN_NODE_WIDTH, 90];
  const currentWidth = Number(node.size?.[0]) || 0;
  // Migrate widths introduced by earlier automatic-layout implementations.
  const preservedWidth = [...LEGACY_AUTO_WIDTHS].some(
    (legacyWidth) => Math.abs(currentWidth - legacyWidth) <= 0.5,
  ) ? MIN_NODE_WIDTH : currentWidth;
  const width = Math.max(
    MIN_NODE_WIDTH,
    preservedWidth,
  );
  const height = Math.max(
    modeRowsHeight(node),
    computed[1] || 0,
  );
  if (
    Math.abs((node.size?.[0] || 0) - width) > 0.5
    || Math.abs((node.size?.[1] || 0) - height) > 0.5
  ) {
    node.setSize?.([width, height]);
  }
}


function refreshLegacyPropertiesPanel(node) {
  const canvas = globalThis.LGraphCanvas?.active_canvas;
  if (!canvas?.node_panel || canvas.node_panel.node !== node) return;
  setTimeout(() => {
    if (canvas.node_panel?.node !== node || !node.graph) return;
    canvas.showShowNodePanel(node);
  }, 0);
}


export function stabilizeStringModeSelector(node) {
  if (!node || node._astralStringModeStabilizing) return null;
  node._astralStringModeStabilizing = true;
  try {
    node.properties ||= {};
    node.serialize_widgets = true;
    hideControlWidget(node);
    removeInputPorts(node);
    ensureStringOutput(node);
    const selectedString = syncSelectedString(node);
    syncModeToggleWidgets(node);
    resizeForModes(node);
    node.graph?.setDirtyCanvas?.(true, true);
    return {
      count: getModeCount(node),
      activeMode: getActiveModeIndex(node),
      selectedString,
      entries: getModeEntries(node),
    };
  } finally {
    node._astralStringModeStabilizing = false;
  }
}


function scheduleStabilize(node, delay = 0) {
  if (!node) return;
  clearTimeout(node._astralStringModeTimer);
  node._astralStringModeTimer = setTimeout(() => {
    node._astralStringModeTimer = null;
    stabilizeStringModeSelector(node);
  }, delay);
}


export function selectMode(node, modeIndex) {
  const requested = Number.parseInt(String(modeIndex ?? ""), 10);
  if (!Number.isFinite(requested) || requested < 1) return false;

  const target = Math.min(MAX_PROMPT_COUNT, requested);
  const currentCount = getModeCount(node);
  node.properties[PROMPT_COUNT_PROPERTY] = String(
    Math.max(currentCount, target),
  );
  ensureModeProperties(node);
  node.properties[ACTIVE_MODE_PROPERTY] = target;
  syncSelectedString(node);
  syncModeToggleWidgets(node);
  resizeForModes(node);
  node.graph?.setDirtyCanvas?.(true, true);
  return true;
}


function initializeStringModeSelector(node) {
  if (!node) return;
  node.properties ||= {};
  ensureModeProperties(node);
  hideControlWidget(node);
  scheduleStabilize(node, 0);
}


function propertyLabel(property) {
  if (property === PROMPT_COUNT_PROPERTY) return "模式数量";
  if (property === ACTIVE_MODE_PROPERTY) return "当前模式";
  const match = String(property).match(/(\d+)$/);
  const index = match ? Number.parseInt(match[1], 10) : null;
  if (!index) return null;
  if (property.startsWith(TITLE_PREFIX)) return `模式 ${index} 标题`;
  if (property.startsWith(PROMPT_PREFIX)) return `模式 ${index} 提示词`;
  return null;
}


function addStringModeSelectorMethods(nodeType) {
  const originalComputeSize = nodeType.prototype.computeSize;
  nodeType.prototype.computeSize = function () {
    const size = originalComputeSize?.apply(this, arguments)
      || [MIN_NODE_WIDTH, 90];
    // Native computeSize() multiplies the minimum width by 1.5 whenever a
    // node has widgets. The reference node is 240px wide, so keep the native
    // height calculation while applying that width unconditionally.
    size[0] = MIN_NODE_WIDTH;
    return size;
  };

  const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const result = originalOnNodeCreated?.apply(this, arguments);
    initializeStringModeSelector(this);
    return result;
  };

  const originalConfigure = nodeType.prototype.configure;
  nodeType.prototype.configure = function () {
    const result = originalConfigure?.apply(this, arguments);
    initializeStringModeSelector(this);
    return result;
  };

  const originalOnAdded = nodeType.prototype.onAdded;
  nodeType.prototype.onAdded = function () {
    const result = originalOnAdded?.apply(this, arguments);
    scheduleStabilize(this, 0);
    return result;
  };

  const originalOnRemoved = nodeType.prototype.onRemoved;
  nodeType.prototype.onRemoved = function () {
    clearTimeout(this._astralStringModeTimer);
    return originalOnRemoved?.apply(this, arguments);
  };

  const originalOnResize = nodeType.prototype.onResize;
  nodeType.prototype.onResize = function (size) {
    if (size && Number.isFinite(Number(size[0]))) {
      size[0] = Math.max(MIN_NODE_WIDTH, Number(size[0]));
    }
    if (size && Number.isFinite(Number(size[1]))) {
      size[1] = Math.max(modeRowsHeight(this), Number(size[1]));
    }
    return originalOnResize?.apply(this, arguments);
  };

  const originalOnPropertyChanged = nodeType.prototype.onPropertyChanged;
  nodeType.prototype.onPropertyChanged = function (property, value, previous) {
    const result = originalOnPropertyChanged?.apply(this, arguments);
    if (property === PROMPT_COUNT_PROPERTY) {
      this.properties[PROMPT_COUNT_PROPERTY] = String(
        clampPromptCount(value, DEFAULT_PROMPT_COUNT),
      );
      ensureModeProperties(this);
      syncSelectedString(this);
      syncModeToggleWidgets(this);
      resizeForModes(this);
      refreshLegacyPropertiesPanel(this);
    } else if (property === ACTIVE_MODE_PROPERTY) {
      this.properties[ACTIVE_MODE_PROPERTY] = Math.min(
        getModeCount(this),
        Math.max(1, Number.parseInt(String(value), 10) || 1),
      );
      syncSelectedString(this);
      syncModeToggleWidgets(this);
    } else if (modeIndexFromProperty(property)) {
      syncSelectedString(this);
      syncModeToggleWidgets(this);
    }
    this.graph?.setDirtyCanvas?.(true, true);
    return result;
  };

  const originalOnGetPropertyInfo = nodeType.prototype.onGetPropertyInfo;
  nodeType.prototype.onGetPropertyInfo = function (property) {
    const original = originalOnGetPropertyInfo?.apply(this, arguments) || {};
    const label = propertyLabel(property);
    if (property === PROMPT_COUNT_PROPERTY) {
      return {
        ...original,
        type: "combo",
        widget: "combo",
        label,
        values: Array.from(
          { length: MAX_PROMPT_COUNT },
          (_unused, index) => String(index + 1),
        ),
      };
    }
    if (property === ACTIVE_MODE_PROPERTY) {
      return {
        ...original,
        type: "number",
        label,
      };
    }
    if (label) {
      return {
        ...original,
        type: "string",
        label,
      };
    }
    return original;
  };

  const originalOnAddPropertyToPanel = nodeType.prototype.onAddPropertyToPanel;
  nodeType.prototype.onAddPropertyToPanel = function (property, panel) {
    if (property === SEARCH_AND_REPLACE_PROPERTY) return true;
    const result = originalOnAddPropertyToPanel?.apply(this, arguments);
    if (result) return result;
    if (property === ACTIVE_MODE_PROPERTY) return true;
    const index = modeIndexFromProperty(property);
    return index != null && index > getModeCount(this);
  };

  const originalOnShowCustomPanelInfo = nodeType.prototype.onShowCustomPanelInfo;
  nodeType.prototype.onShowCustomPanelInfo = function (panel) {
    const result = originalOnShowCustomPanelInfo?.apply(this, arguments);
    if (panel?.dataset) {
      panel.dataset.astralStringModeSelector = "true";
    }
    moveAdvancedPropertiesAboveModeCount(panel);
    hideSearchAndReplaceProperty(panel);
    return result;
  };

}


app.registerExtension({
  name: "ComfyUI-Astral-Manage.StringModeSelector",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === NODE_TYPE) {
      addStringModeSelectorMethods(nodeType);
    }
  },
  nodeCreated(node) {
    const comfyClass = node?.constructor?.comfyClass;
    if (node?.type === NODE_TYPE || comfyClass === NODE_TYPE) {
      installPromptEditorStyles();
      initializeStringModeSelector(node);
    }
  },
});


installPromptEditorStyles();


globalThis.__astralStringModeSelector = {
  NODE_TYPE,
  CONTROL_WIDGET,
  MAX_PROMPT_COUNT,
  DEFAULT_PROMPT_COUNT,
  PROMPT_COUNT_PROPERTY,
  ACTIVE_MODE_PROPERTY,
  clampPromptCount,
  modePropertyNames,
  modeIndexFromProperty,
  getModeCount,
  getActiveModeIndex,
  getModeEntries,
  installPromptEditorStyles,
  syncSelectedString,
  syncModeToggleWidgets,
  stabilizeStringModeSelector,
  selectMode,
};
