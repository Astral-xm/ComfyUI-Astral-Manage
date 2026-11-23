import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  onLanguageChange,
  registerLocalizationRoot,
  translateUiText,
  unregisterLocalizationRoot,
} from "./astral_i18n.js";
import {
  MEDIA_INPUT_LIMITS,
  MEDIA_INPUT_TYPES,
  desiredMediaInputCount,
  isMediaInputConnected,
  mediaInputLabel,
  mediaInputName,
  parseMediaInput,
} from "./media_inputs.js";
import {
  applyPromptProcessorPassthrough,
} from "./prompt_processor_passthrough.js?v=20261115-1";
import {
  nextPromptProcessorSize,
} from "./prompt_processor_size.js?v=20261116-1";

const NODE_TYPE = "Assets Astral Prompt Processor";
const STYLE_URL =
  "/extensions/ComfyUI-Astral-Manage/prompt_processor.css?v=20261115-5";
const CONTROL_WIDGET = "astral_prompt_processor_controls";
const CONTROL_INITIAL_HEIGHT = 184;
const CONTROL_HEIGHT_MARGIN = 2;
// ComfyUI's frontend does not read inputs.<slot>.options from locales, so the
// Chinese option labels are applied to the combo widgets here.
const COMBO_LABELS = Object.freeze({
  operation: {
    auto: "自动",
    expand: "扩写",
    invert: "反推",
  },
  mode: {
    api: "API 模式",
    local: "本地模式",
  },
});

function localeIsZh() {
  try {
    const value = app?.ui?.settings?.getSettingValue?.("Comfy.Locale");
    if (typeof value === "string" && value) {
      return value.toLowerCase().startsWith("zh");
    }
  } catch {
    // Settings are not ready yet; fall back to the document language.
  }
  return String(document?.documentElement?.lang || "")
    .toLowerCase()
    .startsWith("zh");
}

function patchComboLabels(node) {
  for (const widget of node.widgets || []) {
    const labels = COMBO_LABELS[widget.name];
    if (!labels || widget.__astralComboLabels) continue;
    widget.__astralComboLabels = true;
    const options = widget.options || (widget.options = {});
    const previous = options.getOptionLabel;
    options.getOptionLabel = function (value) {
      if (localeIsZh() && Object.prototype.hasOwnProperty.call(labels, value)) {
        return labels[value];
      }
      return previous ? previous(value) : String(value ?? "");
    };
  }
}
const CONTROL_MIN_WIDTH = 150;
const USER_PROMPT_MAX_HEIGHT = 100000;
const SETUP_RETRY_LIMIT = 40;
const SETUP_RETRY_DELAY = 50;
const GRAPH_HOOK_RETRY_LIMIT = 40;
const GRAPH_HOOK_RETRY_DELAY = 50;
const QUEUE_HOOK_RETRY_LIMIT = 40;
const QUEUE_HOOK_RETRY_DELAY = 50;
const MEDIA_INPUT_KIND_ORDER = Object.freeze({
  image: 0,
  video: 1,
  audio: 2,
});

const OPERATIONS = [
  {
    value: "auto",
    zh: "Auto",
    en: "Auto",
    hintZh: "Expand text, or invert connected media",
    hintEn: "Expand text, or invert connected media",
  },
  {
    value: "expand",
    zh: "Expand Prompt",
    en: "Expand prompt",
    hintZh: "Expand only the user prompt",
    hintEn: "Expand only the user prompt",
  },
  {
    value: "invert",
    zh: "Image Inversion",
    en: "Invert media",
    hintZh: "Reverse-engineer a prompt from image, video, or audio",
    hintEn: "Reverse-engineer a prompt from image, video, or audio",
  },
];

const SERVICES = [
  {
    value: "api",
    zh: "API Text-only Mode",
    en: "API Text-only Mode",
  },
  {
    value: "local",
    zh: "Local Mode",
    en: "Local Mode",
  },
];

const installs = new WeakSet();
let languageUnsubscribe = null;
let graphToPromptHookInstalled = false;
let graphToPromptHookRetryTimer = null;
let queuePromptHookInstalled = false;
let queuePromptHookRetryTimer = null;

function normalizeOperationValue(value) {
  const normalized = String(value || "auto").trim().toLowerCase();
  return {
    "自动": "auto",
    "Auto": "auto",
    "扩写": "expand",
    "Expand Prompt": "expand",
    "反推": "invert",
    "Image Inversion": "invert",
  }[normalized] || (
    ["auto", "expand", "invert"].includes(normalized)
      ? normalized
      : "auto"
  );
}

function normalizeModeValue(value) {
  const normalized = String(value || "api").trim().toLowerCase();
  if (["local", "本地", "Local Mode"].includes(normalized)) return "local";
  return "api";
}

function ui(english) {
  return translateUiText(english);
}

function isPromptProcessorNode(node) {
  const matched = Boolean(
    node &&
      (node.type === NODE_TYPE ||
        node.constructor?.comfyClass === NODE_TYPE),
  );
  return matched;
}

function normalizeNodeSize(size) {
  if (!Array.isArray(size) || size.length < 2) return null;
  const width = Math.max(
    CONTROL_MIN_WIDTH,
    Number(size[0]) || CONTROL_MIN_WIDTH,
  );
  const height = Math.max(1, Number(size[1]) || 0);
  return [width, height];
}

function preservePromptProcessorNodeSize(
  node,
  size = node?.size,
  { user = false } = {},
) {
  const normalized = normalizeNodeSize(size);
  if (!node || !normalized) return null;
  node.__astralPromptProcessorRestoredSize = normalized;
  if (user) {
    node.__astralPromptProcessorUserSize = normalized;
  }
  return normalized;
}

function createElement(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function markUserContent(element) {
  if (!element) return element;
  element.dataset.astralI18nSkip = "true";
  return element;
}

function ensureStyles() {
  if (
    document.querySelector(
      'link[data-assets-astral-prompt-processor="true"]',
    )
  ) {
    return;
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = STYLE_URL;
  link.dataset.assetsAstralPromptProcessor = "true";
  document.head.append(link);
}

async function fetchJson(path, options = {}) {
  const response = await api.fetchApi(path, {
    cache: "no-store",
    ...options,
    headers: {
      "Cache-Control": "no-cache",
      ...(options.headers || {}),
    },
  });
  const body = await response.text();
  let payload = null;
  if (body) {
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(
        `HTTP ${response.status}: ${body.slice(0, 160)}`,
      );
    }
  }
  if (!response.ok || payload?.error) {
    throw new Error(
      payload?.error || `HTTP ${response.status}`,
    );
  }
  return payload;
}

function widgetByName(node, name) {
  return node.widgets?.find((widget) => widget?.name === name) || null;
}

function hideWidget(widget) {
  if (!widget || widget.__astralPromptProcessorHidden) return;
  widget.__astralPromptProcessorHidden = true;
  widget.__astralPromptProcessorOriginalType = widget.type;
  widget.__astralPromptProcessorOriginalComputeSize = widget.computeSize;
  widget.computeSize = () => [0, -4];
  widget.type = `converted-widget:${CONTROL_WIDGET}:${widget.name}`;
  widget.hidden = true;
  widget.options ||= {};
  widget.options.hidden = true;
  if (widget.inputEl) widget.inputEl.style.display = "none";
  if (widget.element) widget.element.style.display = "none";
}

function syncWidget(node, widget, value) {
  if (!widget) return false;
  const index = node.widgets?.indexOf(widget) ?? -1;
  const values = node.widgets_values;
  if (
    Object.is(widget.value, value) &&
    (index < 0 || Object.is(values?.[index], value))
  ) {
    return false;
  }
  widget.value = value;
  if (index >= 0) {
    node.widgets_values ||= [];
    node.widgets_values[index] = value;
  }
  node.graph?.setDirtyCanvas?.(true, true);
  return true;
}

function fillSelect(select, items, selectedValue, emptyLabel) {
  select.replaceChildren();
  const empty = createElement("option", "", emptyLabel);
  empty.value = "";
  select.append(empty);
  for (const item of items) {
    const option = createElement(
      "option",
      "",
      item.title || item.name || item.label || item.id,
    );
    option.value = String(item.id || "");
    markUserContent(option);
    select.append(option);
  }
  const requested = String(selectedValue || "");
  if (
    requested &&
    ![...select.options].some((option) => option.value === requested)
  ) {
    const missing = createElement(
      "option",
      "",
      `${ui("Missing", "Missing")}: ${requested}`,
    );
    missing.value = requested;
    missing.dataset.astralI18nSkip = "true";
    select.append(missing);
  }
  select.value = requested;
  if (select.value !== requested) select.value = "";
}

function addField(label, control, className = "") {
  const field = createElement(
    "label",
    `astral-pp-field${className ? ` ${className}` : ""}`,
  );
  const caption = createElement("span", "astral-pp-field-label", label);
  field.append(caption, control);
  field.__label = caption;
  return field;
}

function updateMediaInputLabels(node) {
  for (const input of node.inputs || []) {
    const parsed = parseMediaInput(input);
    if (!parsed) continue;
    const label = mediaInputLabel(parsed.kind, parsed.index);
    input.label = label;
    input.localized_name = label;
  }
}

function graphLink(node, linkRef) {
  if (linkRef == null) return null;
  if (typeof linkRef === "object") return linkRef;
  const links = node.graph?.links;
  if (links instanceof Map) {
    return links.get(linkRef) || links.get(String(linkRef)) || null;
  }
  if (Array.isArray(links)) {
    return links.find(
      (link) => String(link?.id) === String(linkRef),
    ) || null;
  }
  return links?.[linkRef] || links?.[String(linkRef)] || null;
}

function reorderMediaInputs(node) {
  const inputs = node.inputs || [];
  const mediaInputs = inputs.filter(parseMediaInput);
  if (mediaInputs.length < 2) return false;

  const sortedMedia = [...mediaInputs].sort((left, right) => {
    const leftParsed = parseMediaInput(left);
    const rightParsed = parseMediaInput(right);
    const kindDifference =
      MEDIA_INPUT_KIND_ORDER[leftParsed.kind] -
      MEDIA_INPUT_KIND_ORDER[rightParsed.kind];
    return kindDifference || leftParsed.index - rightParsed.index;
  });
  const reordered = inputs.slice();
  let mediaCursor = 0;
  for (let slot = 0; slot < reordered.length; slot += 1) {
    if (!parseMediaInput(reordered[slot])) continue;
    reordered[slot] = sortedMedia[mediaCursor];
    mediaCursor += 1;
  }
  if (reordered.every((input, slot) => input === inputs[slot])) {
    return false;
  }

  const linkRefs = new Map();
  for (const input of inputs) {
    linkRefs.set(input, input?.link);
  }
  inputs.splice(0, inputs.length, ...reordered);

  for (let slot = 0; slot < reordered.length; slot += 1) {
    const linkRef = linkRefs.get(reordered[slot]);
    const link = graphLink(node, linkRef);
    if (link) link.target_slot = slot;
  }
  node.graph?.setDirtyCanvas?.(true, true);
  return true;
}

function syncMediaInputs(node) {
  let changed = false;
  const isConnected = (input, slot) =>
    isMediaInputConnected(input, slot, node);
  for (const kind of Object.keys(MEDIA_INPUT_LIMITS)) {
    const desired = desiredMediaInputCount(
      node.inputs,
      kind,
      isConnected,
    );
    const existing = new Map();
    for (const input of node.inputs || []) {
      const parsed = parseMediaInput(input);
      if (parsed?.kind === kind) existing.set(parsed.index, input);
    }

    for (let index = 1; index <= desired; index += 1) {
      if (existing.has(index)) continue;
      const label = mediaInputLabel(kind, index);
      const input = node.addInput(
        mediaInputName(kind, index),
        MEDIA_INPUT_TYPES[kind],
        { label },
      );
      input.label = label;
      existing.set(index, input);
      changed = true;
    }

    const removals = [];
    for (const [slot, input] of (node.inputs || []).entries()) {
      const parsed = parseMediaInput(input);
      if (
        parsed?.kind === kind &&
        parsed.index > desired &&
        !isConnected(input, slot)
      ) {
        removals.push(slot);
      }
    }
    for (const slot of removals.reverse()) {
      node.removeInput(slot);
      changed = true;
    }
  }
  if (reorderMediaInputs(node)) changed = true;
  updateMediaInputLabels(node);
  if (changed) node.graph?.setDirtyCanvas?.(true, true);
  return changed;
}

function setupPromptProcessor(node) {
  if (!node || installs.has(node)) return true;
  if (!isPromptProcessorNode(node)) return false;
  patchComboLabels(node);
  if (typeof node.addDOMWidget !== "function") return false;
  const widgets = {
    operation: widgetByName(node, "operation"),
    mode: widgetByName(node, "mode"),
    expandRule: widgetByName(node, "expand_rule"),
    invertRule: widgetByName(node, "invert_rule"),
    skill: widgetByName(node, "skill"),
    clearVram: widgetByName(node, "clear_vram"),
    userPrompt: widgetByName(node, "user_prompt"),
  };
  if (
    !widgets.operation ||
    !widgets.mode ||
    !widgets.expandRule ||
    !widgets.invertRule ||
    !widgets.skill ||
    !widgets.clearVram
  ) {
    return false;
  }
  installs.add(node);
  ensureStyles();
  syncWidget(
    node,
    widgets.operation,
    normalizeOperationValue(widgets.operation.value),
  );
  syncWidget(
    node,
    widgets.mode,
    normalizeModeValue(widgets.mode.value),
  );

  for (const widget of [
    widgets.operation,
    widgets.mode,
    widgets.expandRule,
    widgets.invertRule,
    widgets.skill,
    widgets.clearVram,
  ]) {
    hideWidget(widget);
  }

  const originalUserPromptLayout = widgets.userPrompt?.computeLayoutSize;
  const initialUserPromptLayout =
    originalUserPromptLayout?.call(widgets.userPrompt, node) || {};
  const userPromptBaseHeight = Math.max(
    1,
    Number(initialUserPromptLayout.minHeight) ||
      Number(widgets.userPrompt?.options?.minHeight) ||
      50,
  );
  const wrappedUserPromptLayout = function (owner) {
    const layout =
      originalUserPromptLayout?.call(this, owner) ||
      initialUserPromptLayout;
    return {
      ...layout,
      minHeight: userPromptBaseHeight,
      maxHeight: USER_PROMPT_MAX_HEIGHT,
    };
  };
  if (widgets.userPrompt) {
    widgets.userPrompt.computeLayoutSize = wrappedUserPromptLayout;
  }

  const root = createElement("div", "astral-pp");
  const header = createElement("div", "astral-pp-header");
  const heading = createElement("strong", "astral-pp-heading");
  const hint = createElement("span", "astral-pp-hint");
  const refresh = createElement(
    "button",
    "astral-pp-icon-button",
    "↻",
  );
  refresh.type = "button";
  refresh.title = ui("Refresh rules and Skills", "Refresh rules and Skills");
  refresh.setAttribute("aria-label", refresh.title);
  header.append(heading, hint, refresh);

  const body = createElement("div", "astral-pp-body");
  const operation = createElement("select", "astral-pp-select");
  const service = createElement("select", "astral-pp-select");
  const expandRule = createElement("select", "astral-pp-select");
  const invertRule = createElement("select", "astral-pp-select");
  const skill = createElement("select", "astral-pp-select");
  const clearLabel = createElement("label", "astral-pp-check");
  const clearVram = createElement("input");
  clearVram.type = "checkbox";
  const clearSwitch = createElement("span", "astral-pp-switch");
  clearSwitch.setAttribute("aria-hidden", "true");
  const clearText = createElement(
    "span",
    "astral-pp-check-label",
    "Clear VRAM",
  );
  clearLabel.append(clearVram, clearSwitch, clearText);

  const manageExpand = createElement(
    "button",
    "astral-pp-link-button",
    "Manage rules",
  );
  const manageInvert = createElement(
    "button",
    "astral-pp-link-button",
    "Manage rules",
  );
  manageExpand.type = "button";
  manageInvert.type = "button";
  const apiConfig = createElement(
    "button",
    "astral-pp-link-button astral-pp-api-config-button",
    "API Configuration",
  );
  apiConfig.type = "button";

  const expandField = addField("Expansion rule", expandRule, "astral-pp-rule-field");
  expandField.append(manageExpand);
  const invertField = addField("Inversion rule", invertRule, "astral-pp-rule-field");
  invertField.append(manageInvert);
  const operationField = addField("Operation", operation);
  const serviceField = addField(
    "Service",
    service,
    "astral-pp-service-field",
  );
  const apiConfigRow = createElement(
    "div",
    "astral-pp-config-row",
  );
  apiConfigRow.append(apiConfig);
  const skillField = addField(
    "Skill (exclusive with rules)",
    skill,
    "astral-pp-skill-field",
  );
  const bottom = createElement("div", "astral-pp-bottom");
  bottom.append(serviceField, apiConfigRow, clearLabel);
  body.append(
    operationField,
    expandField,
    invertField,
    skillField,
    bottom,
  );

  const status = createElement("div", "astral-pp-status");
  status.hidden = true;
  root.append(header, body, status);

  let catalogLoaded = false;
  let catalogLoading = null;
  let controlHeight = CONTROL_INITIAL_HEIGHT;
  let domWidget = null;
  let statusTimer = null;
  let layoutFrame = null;
  let mediaInputFrame = null;
  let resizeObserver = null;
  const catalogs = {
    expand: [],
    invert: [],
    skills: [],
  };

  const operationInfo = () =>
    OPERATIONS.find(
      (item) => item.value === normalizeOperationValue(operation.value),
    ) ||
    OPERATIONS[0];

  const isMediaConnected = (input, slot) =>
    isMediaInputConnected(input, slot, node);

  const hasMediaConnected = () =>
    (node.inputs || []).some(
      (input, slot) => isMediaConnected(input, slot),
    );

  const serviceItems = () => {
    const currentOperation = operationInfo().value;
    const usesInvert =
      currentOperation === "invert" ||
      (currentOperation === "auto" && hasMediaConnected());
    const usesExpand =
      currentOperation === "expand" ||
      (currentOperation === "auto" && !hasMediaConnected());
    let zh = "API Text-only Mode";
    let en = "API Text-only Mode";
    if (usesInvert) {
      zh = "API Image Mode";
      en = "API Image Mode";
    }
    return SERVICES.map((item) =>
      item.value === "api" ? { ...item, zh, en } : item,
    );
  };

  const measureControlHeight = () => {
    const measured = Math.ceil(
      Math.max(root.offsetHeight || 0, root.scrollHeight || 0),
    );
    return Math.max(1, measured + CONTROL_HEIGHT_MARGIN);
  };

  const fitControlHeight = () => {
    if (layoutFrame != null) return;
    layoutFrame = window.requestAnimationFrame(() => {
      layoutFrame = null;
      if (!domWidget || !node.inputs) return;
      const nodeCanvas =
        node.canvas ||
        node.graph?._canvas ||
        node.graph?.list_of_graphcanvas?.[0] ||
        app.canvas;
      if (nodeCanvas?.resizing_node === node) {
        layoutFrame = window.requestAnimationFrame(fitControlHeight);
        return;
      }
      domWidget.element?.parentElement?.classList.add(
        "astral-pp-widget-shell",
      );
      const measured = measureControlHeight();
      if (measured > 0) controlHeight = measured;
      domWidget.computeLayoutSize = () => ({
        minHeight: controlHeight,
        minWidth: CONTROL_MIN_WIDTH,
        maxHeight: controlHeight,
        maxWidth: 100000,
      });
      const restoredSize = normalizeNodeSize(
        node.__astralPromptProcessorRestoredSize,
      );
      const userSize = normalizeNodeSize(
        node.__astralPromptProcessorUserSize,
      );
      const computed = node.computeSize?.();
      if (computed?.[1]) {
        const currentWidth = Math.max(
          0,
          Number(node.size?.[0]) || 0,
        );
        const computedHeight = Math.max(1, Number(computed[1]) || 0);
        const renderedHeight = Math.max(
          0,
          Number(domWidget.element?.offsetHeight) || 0,
        );
        const effectiveRenderedHeight =
          renderedHeight > 0 ? renderedHeight : controlHeight;
        const minimumHeight = Math.max(
          1,
          computedHeight + measured - effectiveRenderedHeight,
        );
        const currentHeight = Math.max(
          0,
          Number(node.size?.[1]) || 0,
        );
        const [width, height] = nextPromptProcessorSize({
          current: [currentWidth, currentHeight],
          restored: restoredSize,
          user: userSize,
          minimum: [CONTROL_MIN_WIDTH, minimumHeight],
          minimumWidth: CONTROL_MIN_WIDTH,
        });
        if (
          width !== node.size?.[0] ||
          Math.abs(height - currentHeight) > 1
        ) {
          node.__astralPromptProcessorApplyingAutomaticSize = true;
          try {
            node.setSize?.([width, height]);
          } finally {
            node.__astralPromptProcessorApplyingAutomaticSize = false;
          }
        }
      }
    });
  };

  const scheduleMediaInputSync = () => {
    if (mediaInputFrame != null) return;
    mediaInputFrame = window.requestAnimationFrame(() => {
      mediaInputFrame = null;
      syncMediaInputs(node);
      updateMediaInputLabels(node);
      syncVisibility();
      fitControlHeight();
    });
  };

  const syncVisibility = () => {
    const selected = operationInfo();
    const mediaConnected = hasMediaConnected();
    const usesInvert =
      selected.value === "invert" ||
      (selected.value === "auto" && mediaConnected);
    const usesExpand =
      selected.value === "expand" ||
      (selected.value === "auto" && !mediaConnected);
    expandField.hidden = !usesExpand;
    invertField.hidden = !usesInvert;
    clearLabel.hidden = String(service.value || "api") !== "local";
    const currentMode = normalizeModeValue(service.value);
    service.replaceChildren();
    for (const item of serviceItems()) {
      const option = createElement("option", "", ui(item.zh, item.en));
      option.value = item.value;
      service.append(option);
    }
    service.value = currentMode;
    hint.textContent = ui(selected.hintZh, selected.hintEn);
    fitControlHeight();
  };

  const refreshUi = () => {
    updateMediaInputLabels(node);
    heading.textContent = ui("Prompt Processing", "Prompt Processing");
    hint.textContent = ui(operationInfo().hintZh, operationInfo().hintEn);
    refresh.title = ui("Refresh rules and Skills", "Refresh rules and Skills");
    refresh.setAttribute("aria-label", refresh.title);
    clearText.textContent = ui(
      "Clear VRAM",
      "Clear VRAM",
    );
    apiConfig.textContent = ui("API Configuration", "API Configuration");
    apiConfig.title = ui("Open API Configuration", "Open API Configuration");
    apiConfig.setAttribute("aria-label", apiConfig.title);
    manageExpand.textContent = ui("Manage rules", "Manage rules");
    manageInvert.textContent = ui("Manage rules", "Manage rules");
    widgets.userPrompt && (widgets.userPrompt.label = ui("User Prompt", "User Prompt"));

    const operationValue = normalizeOperationValue(
      widgets.operation.value,
    );
    const modeValue = normalizeModeValue(widgets.mode.value);
    syncWidget(node, widgets.operation, operationValue);
    syncWidget(node, widgets.mode, modeValue);
    operation.replaceChildren();
    for (const item of OPERATIONS) {
      const option = createElement("option", "", ui(item.zh, item.en));
      option.value = item.value;
      operation.append(option);
    }
    operation.value = operationValue;

    service.value = modeValue;
    fillSelect(
      expandRule,
      catalogs.expand,
      widgets.expandRule.value,
      ui("No expansion rule", "No expansion rule"),
    );
    fillSelect(
      invertRule,
      catalogs.invert,
      widgets.invertRule.value,
      ui("No inversion rule", "No inversion rule"),
    );
    fillSelect(
      skill,
      catalogs.skills,
      widgets.skill.value,
      ui("No Skill", "No Skill"),
    );
    clearVram.checked = widgets.clearVram.value === true;
    syncVisibility();
  };

  const setStatus = (message, kind = "", autoHide = false) => {
    if (statusTimer) {
      window.clearTimeout(statusTimer);
      statusTimer = null;
    }
    status.textContent = message || "";
    status.dataset.kind = kind;
    status.hidden = !message;
    fitControlHeight();
    if (message && autoHide) {
      statusTimer = window.setTimeout(() => {
        statusTimer = null;
        status.textContent = "";
        status.hidden = true;
        fitControlHeight();
      }, 2400);
    }
  };

  const syncCatalogValues = () => {
    fillSelect(
      expandRule,
      catalogs.expand,
      widgets.expandRule.value,
      ui("No expansion rule", "No expansion rule"),
    );
    fillSelect(
      invertRule,
      catalogs.invert,
      widgets.invertRule.value,
      ui("No inversion rule", "No inversion rule"),
    );
    fillSelect(
      skill,
      catalogs.skills,
      widgets.skill.value,
      ui("No Skill", "No Skill"),
    );
  };

  const loadCatalog = async (force = false) => {
    if (catalogLoaded && !force) return;
    if (catalogLoading && !force) return catalogLoading;
    setStatus(ui("Loading rules and Skills...", "Loading rules and Skills..."), "loading");
    catalogLoading = Promise.all([
      fetchJson("/assets-astral/prompt-templates?category=expand"),
      fetchJson("/assets-astral/prompt-templates?category=invert"),
      fetchJson("/assets-astral/skills"),
    ])
      .then(([expand, invert, skills]) => {
        catalogs.expand = Array.isArray(expand?.items) ? expand.items : [];
        catalogs.invert = Array.isArray(invert?.items) ? invert.items : [];
        catalogs.skills = Array.isArray(skills?.items) ? skills.items : [];
        catalogLoaded = true;
        syncCatalogValues();
        setStatus(
          ui(
            `Loaded ${catalogs.expand.length} expansion rules, ${catalogs.invert.length} inversion rules, and ${catalogs.skills.length} Skills.`,
            `Loaded ${catalogs.expand.length} expansion rules, ${catalogs.invert.length} inversion rules, and ${catalogs.skills.length} Skills.`,
          ),
          "success",
          true,
        );
      })
      .catch((error) => {
        catalogLoading = null;
        setStatus(
          `${ui("Failed to load configuration", "Failed to load configuration")}: ${error.message || error}`,
          "error",
        );
      })
      .finally(() => {
        catalogLoading = null;
      });
    return catalogLoading;
  };

  operation.addEventListener("change", () => {
    preservePromptProcessorNodeSize(node, node.size, { user: true });
    syncWidget(
      node,
      widgets.operation,
      normalizeOperationValue(operation.value),
    );
    syncVisibility();
  });
  service.addEventListener("change", () => {
    preservePromptProcessorNodeSize(node, node.size, { user: true });
    syncWidget(node, widgets.mode, normalizeModeValue(service.value));
    syncVisibility();
  });
  expandRule.addEventListener("change", () => {
    preservePromptProcessorNodeSize(node, node.size, { user: true });
    syncWidget(node, widgets.expandRule, expandRule.value);
    if (expandRule.value) {
      syncWidget(node, widgets.skill, "");
      skill.value = "";
    }
  });
  invertRule.addEventListener("change", () => {
    preservePromptProcessorNodeSize(node, node.size, { user: true });
    syncWidget(node, widgets.invertRule, invertRule.value);
    if (invertRule.value) {
      syncWidget(node, widgets.skill, "");
      skill.value = "";
    }
  });
  skill.addEventListener("change", () => {
    preservePromptProcessorNodeSize(node, node.size, { user: true });
    syncWidget(node, widgets.skill, skill.value);
    if (skill.value) {
      syncWidget(node, widgets.expandRule, "");
      syncWidget(node, widgets.invertRule, "");
      expandRule.value = "";
      invertRule.value = "";
    }
  });
  clearVram.addEventListener("change", () => {
    preservePromptProcessorNodeSize(node, node.size, { user: true });
    syncWidget(node, widgets.clearVram, Boolean(clearVram.checked));
  });
  refresh.addEventListener("click", () => void loadCatalog(true));
  manageExpand.addEventListener("click", () => {
    window.openAssetsAstralPromptCategory?.("expand");
  });
  manageInvert.addEventListener("click", () => {
    window.openAssetsAstralPromptCategory?.("invert");
  });
  apiConfig.addEventListener("click", () => {
    window.openAssetsAstralApiConfig?.("api");
  });

  domWidget = node.addDOMWidget(
    CONTROL_WIDGET,
    CONTROL_WIDGET,
    root,
    {
      getMinHeight: () => controlHeight,
      getMaxHeight: () => controlHeight,
      getHeight: () => controlHeight,
      hideOnZoom: false,
      margin: 0,
      serialize: false,
    },
  );
  domWidget.computeLayoutSize = () => ({
    minHeight: controlHeight,
    minWidth: CONTROL_MIN_WIDTH,
    maxHeight: controlHeight,
    maxWidth: 100000,
  });
  if (domWidget.element) {
    domWidget.element.parentElement?.classList.add(
      "astral-pp-widget-shell",
    );
    root.style.pointerEvents = "none";
  }
  const originalGetWidgetOnPos = node.getWidgetOnPos;
  const wrappedGetWidgetOnPos = function (x, y) {
    if (this.findResizeDirection?.(x, y)) return null;
    return originalGetWidgetOnPos?.apply(this, arguments);
  };
  node.getWidgetOnPos = wrappedGetWidgetOnPos;
  node.resizable = true;
  const originalSetSize = node.setSize;
  const wrappedSetSize = function (size) {
    const isAutomatic =
      this.__astralPromptProcessorApplyingRestoredSize ||
      this.__astralPromptProcessorApplyingAutomaticSize;
    const nodeCanvas =
      this.canvas ||
      this.graph?._canvas ||
      this.graph?.list_of_graphcanvas?.[0] ||
      app.canvas;
    if (!isAutomatic && nodeCanvas?.resizing_node === this) {
      preservePromptProcessorNodeSize(this, size, { user: true });
    }
    return originalSetSize?.apply(this, arguments);
  };
  node.setSize = wrappedSetSize;
  const originalOnResize = node.onResize;
  const wrappedOnResize = function (size) {
    const isAutomatic =
      this.__astralPromptProcessorApplyingRestoredSize ||
      this.__astralPromptProcessorApplyingAutomaticSize;
    const nodeCanvas =
      this.canvas ||
      this.graph?._canvas ||
      this.graph?.list_of_graphcanvas?.[0] ||
      app.canvas;
    const isManualResize =
      !isAutomatic &&
      nodeCanvas?.resizing_node === this;
    if (isManualResize) {
      preservePromptProcessorNodeSize(this, size, { user: true });
    }
    const result = originalOnResize?.apply(this, arguments);
    if (isManualResize) {
      queueMicrotask(() => {
        this.arrange?.();
        this.setDirtyCanvas?.(true, true);
      });
    } else if (
      !isAutomatic &&
      (normalizeNodeSize(this.__astralPromptProcessorUserSize) ||
        normalizeNodeSize(this.__astralPromptProcessorRestoredSize))
    ) {
      // Parameter widgets and ComfyUI layout can call setSize(). Re-apply the
      // saved dimensions after those programmatic changes.
      queueMicrotask(() => fitControlHeight());
    }
    return result;
  };
  node.onResize = wrappedOnResize;
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => fitControlHeight());
    resizeObserver.observe(root);
  }

  refreshUi();
  syncMediaInputs(node);
  updateMediaInputLabels(node);
  fitControlHeight();
  scheduleMediaInputSync();
  registerLocalizationRoot(root);
  void loadCatalog();

  const originalConfigure = node.onConfigure;
  node.onConfigure = function () {
    const configuration = arguments[0] || {};
    preservePromptProcessorNodeSize(this, configuration.size, {
      user: true,
    });
    const result = originalConfigure?.apply(this, arguments);
    preservePromptProcessorNodeSize(this, configuration.size, {
      user: true,
    });
    window.setTimeout(() => {
      refreshUi();
      scheduleMediaInputSync();
      void loadCatalog(true);
    }, 0);
    window.setTimeout(() => {
      scheduleMediaInputSync();
      fitControlHeight();
    }, 80);
    return result;
  };

  const originalConnectionsChange = node.onConnectionsChange;
  const wrappedConnectionsChange = function () {
    const result = originalConnectionsChange?.apply(this, arguments);
    window.setTimeout(() => {
      scheduleMediaInputSync();
      syncVisibility();
    }, 0);
    return result;
  };
  node.onConnectionsChange = wrappedConnectionsChange;

  const originalRemoved = node.onRemoved;
  node.onRemoved = function () {
    if (statusTimer) {
      window.clearTimeout(statusTimer);
      statusTimer = null;
    }
    if (layoutFrame != null) {
      window.cancelAnimationFrame(layoutFrame);
      layoutFrame = null;
    }
    if (mediaInputFrame != null) {
      window.cancelAnimationFrame(mediaInputFrame);
      mediaInputFrame = null;
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (node.onConnectionsChange === wrappedConnectionsChange) {
      node.onConnectionsChange = originalConnectionsChange;
    }
    if (node.getWidgetOnPos === wrappedGetWidgetOnPos) {
      node.getWidgetOnPos = originalGetWidgetOnPos;
    }
    if (node.onResize === wrappedOnResize) {
      node.onResize = originalOnResize;
    }
    if (node.setSize === wrappedSetSize) {
      node.setSize = originalSetSize;
    }
    if (
      widgets.userPrompt?.computeLayoutSize === wrappedUserPromptLayout
    ) {
      if (originalUserPromptLayout) {
        widgets.userPrompt.computeLayoutSize =
          originalUserPromptLayout;
      } else {
        delete widgets.userPrompt.computeLayoutSize;
      }
    }
    unregisterLocalizationRoot(root);
    installs.delete(node);
    return originalRemoved?.apply(this, arguments);
  };

  node.__astralPromptProcessorRefreshUi = () => {
    refreshUi();
    scheduleMediaInputSync();
  };
  return true;
}

const setupRetries = new WeakMap();

function retryPromptProcessorSetup(node, attempt = 0) {
  if (!isPromptProcessorNode(node) || installs.has(node)) return;
  if (setupPromptProcessor(node)) {
    setupRetries.delete(node);
    return;
  }
  if (attempt >= SETUP_RETRY_LIMIT || setupRetries.has(node)) return;
  setupRetries.set(node, true);
  window.setTimeout(() => {
    setupRetries.delete(node);
    retryPromptProcessorSetup(node, attempt + 1);
  }, SETUP_RETRY_DELAY);
}

function promptProcessorNodes() {
  return (
    app.canvas?.graph?._nodes ||
    app.graph?._nodes ||
    []
  );
}

function retryInstalledPromptProcessorNodes() {
  for (const node of promptProcessorNodes()) {
    if (isPromptProcessorNode(node)) {
      retryPromptProcessorSetup(node);
    }
  }
}

function graphForPromptCall(args) {
  return (
    args.find(
      (value) =>
        value &&
        typeof value === "object" &&
        (Array.isArray(value._nodes) ||
          value._nodes_by_id ||
          typeof value.getNodeById === "function"),
    ) ||
    app.rootGraph ||
    app.graph ||
    app.canvas?.graph ||
    null
  );
}

function installGraphToPromptHook() {
  if (graphToPromptHookInstalled) return true;
  if (typeof app.graphToPrompt !== "function") return false;
  const original = app.graphToPrompt;
  if (original.__astralPromptProcessorPassthrough) {
    graphToPromptHookInstalled = true;
    return true;
  }
  const wrapped = async function (...args) {
    const result = await original.apply(this, args);
    return applyPromptProcessorPassthrough(
      result,
      graphForPromptCall(args),
    );
  };
  wrapped.__astralPromptProcessorPassthrough = true;
  wrapped.__astralPromptProcessorOriginal = original;
  app.graphToPrompt = wrapped;
  graphToPromptHookInstalled = true;
  return true;
}

function retryInstallGraphToPromptHook(attempt = 0) {
  if (installGraphToPromptHook()) {
    if (graphToPromptHookRetryTimer != null) {
      window.clearTimeout(graphToPromptHookRetryTimer);
      graphToPromptHookRetryTimer = null;
    }
    return;
  }
  if (
    attempt >= GRAPH_HOOK_RETRY_LIMIT ||
    graphToPromptHookRetryTimer != null
  ) {
    return;
  }
  graphToPromptHookRetryTimer = window.setTimeout(() => {
    graphToPromptHookRetryTimer = null;
    retryInstallGraphToPromptHook(attempt + 1);
  }, GRAPH_HOOK_RETRY_DELAY);
}

function queuePromptGraph(promptData) {
  return (
    promptData?.graph ||
    promptData?.workflowGraph ||
    app.rootGraph ||
    app.graph ||
    app.canvas?.graph ||
    null
  );
}

function applyQueuePromptPassthrough(promptData) {
  if (!promptData || typeof promptData !== "object") {
    return promptData;
  }
  if (promptData.output && typeof promptData.output === "object") {
    applyPromptProcessorPassthrough(
      promptData,
      queuePromptGraph(promptData),
    );
    return promptData;
  }
  applyPromptProcessorPassthrough(
    { output: promptData },
    queuePromptGraph(promptData),
  );
  return promptData;
}

function installQueuePromptHook() {
  if (queuePromptHookInstalled) return true;
  if (typeof api.queuePrompt !== "function") return false;
  const original = api.queuePrompt;
  if (original.__astralPromptProcessorQueuePassthrough) {
    queuePromptHookInstalled = true;
    return true;
  }
  const wrapped = async function (number, promptData, options) {
    const transformedPrompt = applyQueuePromptPassthrough(promptData);
    return original.apply(this, [
      number,
      transformedPrompt,
      options,
    ]);
  };
  wrapped.__astralPromptProcessorQueuePassthrough = true;
  wrapped.__astralPromptProcessorQueueOriginal = original;
  api.queuePrompt = wrapped;
  queuePromptHookInstalled = true;
  return true;
}

function retryInstallQueuePromptHook(attempt = 0) {
  if (installQueuePromptHook()) {
    if (queuePromptHookRetryTimer != null) {
      window.clearTimeout(queuePromptHookRetryTimer);
      queuePromptHookRetryTimer = null;
    }
    return;
  }
  if (
    attempt >= QUEUE_HOOK_RETRY_LIMIT ||
    queuePromptHookRetryTimer != null
  ) {
    return;
  }
  queuePromptHookRetryTimer = window.setTimeout(() => {
    queuePromptHookRetryTimer = null;
    retryInstallQueuePromptHook(attempt + 1);
  }, QUEUE_HOOK_RETRY_DELAY);
}

function installLanguageListener() {
  if (languageUnsubscribe) return;
  languageUnsubscribe = onLanguageChange(() => {
    const nodes = app.graph?._nodes || app.canvas?.graph?._nodes || [];
    for (const node of nodes) {
      node.__astralPromptProcessorRefreshUi?.();
    }
  });
}

app.registerExtension({
  name: "ComfyUI-Astral-Manage.PromptProcessor",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;
    const originalNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = originalNodeCreated?.apply(this, arguments);
      retryPromptProcessorSetup(this);
      return result;
    };
  },
  setup() {
    ensureStyles();
    installLanguageListener();
    retryInstallGraphToPromptHook();
    retryInstallQueuePromptHook();
    retryInstalledPromptProcessorNodes();
    window.setTimeout(retryInstalledPromptProcessorNodes, 50);
    window.setTimeout(retryInstalledPromptProcessorNodes, 250);
    window.setTimeout(retryInstalledPromptProcessorNodes, 1000);
  },
  nodeCreated(node) {
    if (isPromptProcessorNode(node)) {
      retryPromptProcessorSetup(node);
    }
  },
  loadedGraphNode(node) {
    if (isPromptProcessorNode(node)) {
      preservePromptProcessorNodeSize(node, node.size, { user: true });
      retryPromptProcessorSetup(node);
    }
  },
  afterConfigureGraph() {
    for (const node of promptProcessorNodes()) {
      if (isPromptProcessorNode(node)) {
        preservePromptProcessorNodeSize(node, node.size, {
          user: true,
        });
      }
    }
    retryInstalledPromptProcessorNodes();
    retryInstallGraphToPromptHook();
    retryInstallQueuePromptHook();
    window.setTimeout(retryInstalledPromptProcessorNodes, 0);
  },
});

globalThis.__astralPromptProcessor = {
  NODE_TYPE,
  CONTROL_WIDGET,
  OPERATIONS,
  SERVICES,
  MEDIA_INPUT_LIMITS,
};
