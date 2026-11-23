import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  onLanguageChange,
  registerLocalizationRoot,
  translateUiText,
} from "./astral_i18n.js";

const STYLE_URL = "/extensions/ComfyUI-Astral-Manage/prompt_tools.css";
const TOOLBAR_CLASS = "astral-pt-toolbar";
const PANEL_CLASS = "astral-pt-panel";
const SETTINGS_CLASS = "astral-pt-settings";
const MAX_IMAGE_EDGE = 2048;

const TARGET_LANGUAGES = [
  { value: "en", zh: "英语", en: "English" },
  { value: "zh", zh: "简体中文", en: "Simplified Chinese" },
  { value: "ja", zh: "日语", en: "Japanese" },
  { value: "ko", zh: "韩语", en: "Korean" },
  { value: "fr", zh: "法语", en: "French" },
  { value: "de", zh: "德语", en: "German" },
  { value: "es", zh: "西班牙语", en: "Spanish" },
  { value: "ru", zh: "俄语", en: "Russian" },
  { value: "pt", zh: "葡萄牙语", en: "Portuguese" },
  { value: "it", zh: "意大利语", en: "Italian" },
  { value: "ar", zh: "阿拉伯语", en: "Arabic" },
];

const state = {
  node: null,
  widget: null,
  kind: "",
  action: "expand",
  translationTarget: "en",
  menuAction: "",
  settingsAnchor: null,
  anchorElement: null,
  pointerOverTextWidget: false,
  imageSource: null,
  imageLabel: "",
  running: false,
  abortController: null,
  requestId: "",
  stopRequested: false,
  result: "",
  sentAt: 0,
  receivedAt: 0,
  lastTask: null,
  status: { key: "", detail: "", kind: "" },
  statusTimer: null,
  catalogs: {
    expand: [],
    invert: [],
    skills: [],
  },
  settings: {
    expand: {
      ruleId: "",
      skillId: "",
      mode: "api",
      clearVram: false,
    },
    invert: {
      ruleId: "",
      skillId: "",
      mode: "api",
      clearVram: false,
    },
  },
  loadedCategories: new Set(),
  catalogLoading: null,
};

const ui = {
  toolbar: null,
  expandButton: null,
  translateEnButton: null,
  translateZhButton: null,
  invertButton: null,
  invertEnButton: null,
  settings: null,
  settingsHeading: null,
  settingsSource: null,
  settingsRuleField: null,
  settingsRuleSelect: null,
  settingsSkillField: null,
  settingsSkillSelect: null,
  settingsServiceField: null,
  settingsServiceSelect: null,
  settingsClearLabel: null,
  settingsClearVram: null,
  settingsManageButton: null,
  settingsRefreshButton: null,
  settingsCloseButton: null,
  settingsHint: null,
  panel: null,
  panelHeading: null,
  panelSource: null,
  closeButton: null,
  refreshButton: null,
  serviceField: null,
  serviceSelect: null,
  languageField: null,
  languageSelect: null,
  clearLabel: null,
  clearVram: null,
  runButton: null,
  copyButton: null,
  applyButton: null,
  retryButton: null,
  sentTime: null,
  receivedTime: null,
  status: null,
  resultLabel: null,
  result: null,
};

let initialized = false;
let languageUnsubscribe = null;

function text(english) {
  return translateUiText(english);
}

function createElement(tag, className = "", value = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value) element.textContent = value;
  return element;
}

function markUserContent(element) {
  if (element) element.dataset.astralI18nSkip = "true";
  return element;
}

function ensureStyles() {
  if (document.querySelector('link[data-assets-astral-prompt-tools="true"]')) {
    return;
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = STYLE_URL;
  link.dataset.assetsAstralPromptTools = "true";
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
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  return payload;
}

function allNodes() {
  return app.canvas?.graph?._nodes || app.graph?._nodes || [];
}

function selectedNodes(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value && typeof value === "object") {
    return Object.values(value).filter(Boolean);
  }
  return allNodes().filter((node) => node?.flags?.selected);
}

function nodeIsSelected(node) {
  if (!node) return false;
  const currentSelection = app.canvas?.selected_nodes;
  const selected = selectedNodes(currentSelection);
  const selectedMatch = selected.some(
    (selected) =>
      selected === node ||
      (selected?.id != null &&
        node.id != null &&
        String(selected.id) === String(node.id)),
  );
  if (selectedMatch) return true;
  if (
    Array.isArray(currentSelection) ||
    (currentSelection && typeof currentSelection === "object")
  ) {
    return false;
  }
  return Boolean(node.flags?.selected || node.Flags?.selected);
}

function widgetElements(widget) {
  const elements = [];
  for (const candidate of [widget?.inputEl, widget?.element]) {
    if (!candidate) continue;
    if (
      candidate.matches?.("textarea, input, [contenteditable='true']") ||
      candidate.isContentEditable
    ) {
      elements.push(candidate);
    }
    candidate
      .querySelectorAll?.(
        "textarea, input, [contenteditable='true'], .ProseMirror",
      )
      .forEach((element) => elements.push(element));
  }
  return [...new Set(elements)];
}

function isVisibleElement(element) {
  if (!element || element.hidden) return false;
  const style = window.getComputedStyle?.(element);
  if (style?.display === "none" || style?.visibility === "hidden") {
    return false;
  }
  return !element.getClientRects || element.getClientRects().length > 0;
}

function isTextWidget(widget, node = null) {
  if (!widget) return false;
  const elements = widgetElements(widget);
  if (elements.some((element) => isVisibleElement(element))) return true;
  const type = String(widget.type || "").toLowerCase();
  const isString =
    typeof widget.value === "string" &&
    ["string", "customtext", "text"].some((item) =>
      type.includes(item),
    );
  if (isString && widget.options?.multiline) return true;
  return Boolean(
    node?.type === "Note" &&
      String(widget.name || "").toLowerCase().includes("text"),
  );
}

function activeTextWidget(node) {
  if (!node?.widgets?.length) return null;
  const focused = document.activeElement;
  const byFocus = node.widgets.find(
    (widget) =>
      isTextWidget(widget, node) &&
      widgetElements(widget).some(
        (element) =>
          element === focused || element.contains?.(focused),
      ),
  );
  if (byFocus) return byFocus;

  const selected = app.canvas?.selected_widget;
  const byCanvas = node.widgets.find(
    (widget) =>
      (widget === selected || widget.name === selected) &&
      isTextWidget(widget, node),
  );
  if (byCanvas) return byCanvas;
  return (
    node.widgets.find(
      (widget) =>
        isTextWidget(widget, node) &&
        widget.options?.multiline === true,
    ) ||
    node.widgets.find((widget) => isTextWidget(widget, node)) ||
    null
  );
}

function nodeContainer(node) {
  if (!node || node.id == null) return null;
  return document.querySelector(
    `[data-node-id="${String(node.id).replaceAll('"', '\\"')}"]`,
  );
}

function nodeForElement(element) {
  for (const node of allNodes()) {
    if (
      node?.widgets?.some((widget) =>
        widgetElements(widget).some(
          (candidate) =>
            candidate === element ||
            candidate.contains?.(element) ||
            candidate.parentElement?.contains?.(element),
        ),
      )
    ) {
      return node;
    }
  }
  const container = element?.closest?.("[data-node-id]");
  if (!container) return null;
  const nodeId = String(container.dataset.nodeId || "");
  return (
    app.canvas?.graph?._nodes_by_id?.[nodeId] ||
    allNodes().find((node) => String(node.id) === nodeId) ||
    null
  );
}

function imageNodeAllowed(node) {
  if (!node) return false;
  if (Array.isArray(node.imgs) && node.imgs.length) return true;
  const typename = `${node.type || ""} ${node.title || ""}`;
  return /(load.?image|preview.?image|save.?image|image.?preview)/i.test(
    typename,
  );
}

function imageLabelFromElement(image) {
  const source = String(image?.currentSrc || image?.src || "");
  if (!/^data:/i.test(source)) {
    const candidate = source.split(/[/?#]/).filter(Boolean).pop();
    if (candidate) {
      try {
        return decodeURIComponent(candidate);
      } catch {
        return candidate;
      }
    }
  }
  return text("Canvas image", "Canvas image");
}

function findImageSource(node) {
  if (!imageNodeAllowed(node)) return null;
  if (Array.isArray(node.imgs) && node.imgs.length) {
    const index = Math.min(
      Math.max(Number(node.imageIndex) || 0, 0),
      node.imgs.length - 1,
    );
    const source = node.imgs[index];
    if (source) {
      return {
        source,
        label:
          source instanceof HTMLImageElement
            ? imageLabelFromElement(source)
            : text("Canvas image", "Canvas image"),
      };
    }
  }
  const container = nodeContainer(node);
  const candidates = [
    ...(container?.querySelectorAll?.("img") || []),
  ].filter(
    (image) =>
      !image.src ||
      (!image.src.includes("error") &&
        (image.complete !== true ||
          (image.naturalWidth || 0) > 0)),
  );
  const image = candidates.sort(
    (left, right) =>
      (right.naturalWidth || 0) * (right.naturalHeight || 0) -
      (left.naturalWidth || 0) * (left.naturalHeight || 0),
  )[0];
  if (!image) return null;
  return { source: image, label: imageLabelFromElement(image) };
}

function resolveSelection(value) {
  const nodes = selectedNodes(value);
  for (const node of nodes) {
    const image = findImageSource(node);
    if (image && imageNodeAllowed(node)) {
      return { kind: "image", node, ...image };
    }
  }
  for (const node of nodes) {
    const widget = activeTextWidget(node);
    if (widget) {
      return { kind: "text", node, widget };
    }
  }
  for (const node of nodes) {
    const image = findImageSource(node);
    if (image) return { kind: "image", node, ...image };
  }
  return null;
}

function readWidgetText(widget) {
  if (!widget) return "";
  for (const element of widgetElements(widget)) {
    if (!isVisibleElement(element)) continue;
    if (typeof element.value === "string") {
      return element.value;
    }
    const content = element.isContentEditable
      ? element.innerText
      : element.textContent;
    if (typeof content === "string") return content;
  }
  return typeof widget.value === "string" ? widget.value : "";
}

function sourceNodeForWidget(widget) {
  return (
    allNodes().find((node) => node?.widgets?.includes(widget)) ||
    state.node
  );
}

function syncWidgetText(node, widget, value) {
  if (!widget) return;
  widget.value = value;
  for (const element of widgetElements(widget)) {
    if (typeof element.value === "string" && element.value !== value) {
      element.value = value;
      element.dispatchEvent?.(new Event("input", { bubbles: true }));
      element.dispatchEvent?.(new Event("change", { bubbles: true }));
    } else if (
      element.isContentEditable &&
      element.textContent !== value
    ) {
      element.textContent = value;
      const inputEvent =
        typeof InputEvent === "function"
          ? new InputEvent("input", { bubbles: true })
          : new Event("input", { bubbles: true });
      element.dispatchEvent?.(inputEvent);
    }
  }
  const index = node?.widgets?.indexOf(widget) ?? -1;
  if (node && index >= 0) {
    node.widgets_values ||= [];
    node.widgets_values[index] = value;
  }
  widget.callback?.(value, app.canvas, node, null, null);
  node?.graph?.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty?.(true, true);
}

function formatTimestamp(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

function actionTitle(action = state.action) {
  return {
    expand: text("Expand Prompt", "Expand Prompt"),
    translate: text("Translate", "Translate"),
    invert: text("Image Inversion", "Image Inversion"),
  }[action] || text("Prompt Tools", "Prompt Tools");
}

function statusText() {
  const { key, detail } = state.status;
  const labels = {
    loadingRules: text("Loading rules and Skills...", "Loading rules and Skills..."),
    rulesLoaded: text("Rules and Skills updated.", "Rules and Skills updated."),
    needText: text("Enter or select a prompt first.", "Enter or select a prompt first."),
    needImage: text("Select a node containing an image first.", "Select a node containing an image first."),
    conflict: text(
      "Choose either a system prompt or a Skill.",
      "Choose either a system prompt or a Skill.",
    ),
    preparingImage: text("Reading image...", "Reading image..."),
    runningExpand: text("Expanding prompt...", "Expanding prompt..."),
    runningTranslate: text("Translating...", "Translating..."),
    runningInvert: text("Inverting image...", "Inverting image..."),
    stopping: text("Stopping...", "Stopping..."),
    stopped: text("Action stopped.", "Action stopped."),
    completed: text("Result received.", "Result received."),
    copied: text("Copied to the clipboard.", "Copied to the clipboard."),
    applied: text("Result applied to the source widget.", "Result applied to the source widget."),
    expandedApplied: text(
      "Expansion complete. The prompt field was updated.",
      "Expansion complete. The prompt field was updated.",
    ),
    invertedCopied: text(
      "Inversion complete. Copied to the clipboard.",
      "Inversion complete. Copied to the clipboard.",
    ),
    copyFailed: text("Copy failed: ", "Copy failed: "),
    clearFailed: text("Task finished, but clearing VRAM failed: ", "Task finished, but clearing VRAM failed: "),
    error: text("Action failed: ", "Action failed: "),
  };
  return (labels[key] || "") + (detail || "");
}

function renderStatus() {
  if (state.statusTimer) {
    window.clearTimeout(state.statusTimer);
    state.statusTimer = null;
  }
  const message = statusText();
  ui.status.textContent = message;
  ui.status.dataset.kind = state.status.kind;
  ui.status.hidden = !message;
  if (message) {
    window.requestAnimationFrame?.(positionFloatingUi);
  }
}

function setStatus(key, detail = "", kind = "", autoHide = false) {
  state.status = { key, detail, kind };
  renderStatus();
  if (autoHide && key) {
    state.statusTimer = window.setTimeout(() => {
      state.statusTimer = null;
      state.status = { key: "", detail: "", kind: "" };
      renderStatus();
    }, 2400);
  }
}

function createButton(className, label, role) {
  const button = createElement("button", className, label);
  button.type = "button";
  button.dataset.role = role;
  return button;
}

function createField(label, control, className = "") {
  const field = createElement(
    "label",
    `astral-pt-field${className ? ` ${className}` : ""}`,
  );
  const caption = createElement("span", "astral-pt-field-label", label);
  field.append(caption, control);
  field.__label = caption;
  return field;
}

function createToolIconButton(role, icon) {
  const button = createButton("astral-pt-tool-button", "", role);
  const iconElement = createElement("span", "astral-pt-tool-icon");
  iconElement.dataset.icon = icon;
  iconElement.setAttribute("aria-hidden", "true");
  button.append(iconElement);
  button.setAttribute("aria-haspopup", "menu");
  return button;
}

function createTranslationButton(target) {
  const button = createButton(
    "astral-pt-tool-button astral-pt-translate-button",
    target === "zh" ? "ZH" : "EN",
    `translate-${target}`,
  );
  button.dataset.target = target;
  return button;
}

function createFloatingUi() {
  ui.toolbar = createElement("div", TOOLBAR_CLASS);
  ui.toolbar.hidden = true;
  ui.expandButton = createToolIconButton("expand", "expand");
  ui.translateEnButton = createTranslationButton("en");
  ui.translateZhButton = createTranslationButton("zh");
  ui.invertButton = createToolIconButton("invert-zh", "caption-zh");
  ui.invertEnButton = createButton(
    "astral-pt-tool-button astral-pt-translate-button",
    "EN",
    "invert-en",
  );
  ui.invertEnButton.setAttribute("aria-haspopup", "menu");
  ui.toolbar.append(
    ui.expandButton,
    ui.translateEnButton,
    ui.translateZhButton,
    ui.invertButton,
    ui.invertEnButton,
  );

  ui.panel = createElement("section", PANEL_CLASS);
  ui.panel.hidden = true;
  ui.panel.setAttribute("role", "dialog");
  const panelHeader = createElement("div", "astral-pt-header");
  ui.panelHeading = createElement("strong", "astral-pt-heading");
  ui.panelSource = createElement("span", "astral-pt-source");
  ui.closeButton = createButton(
    "astral-pt-icon-button",
    "×",
    "close",
  );
  panelHeader.append(
    ui.panelHeading,
    ui.panelSource,
    ui.closeButton,
  );

  const panelFields = createElement("div", "astral-pt-fields");
  ui.serviceSelect = createElement("select", "astral-pt-select");
  ui.serviceField = createField(
    "Service",
    ui.serviceSelect,
    "astral-pt-wide-field",
  );
  ui.languageSelect = createElement("select", "astral-pt-select");
  ui.languageField = createField(
    "Target language",
    ui.languageSelect,
    "astral-pt-language-field",
  );
  ui.clearLabel = createElement("label", "astral-pt-check");
  ui.clearVram = document.createElement("input");
  ui.clearVram.type = "checkbox";
  const clearText = createElement("span", "", "Clear VRAM after task");
  ui.clearLabel.append(ui.clearVram, clearText);
  panelFields.append(
    ui.serviceField,
    ui.languageField,
    ui.clearLabel,
  );

  const panelActions = createElement("div", "astral-pt-actions");
  ui.runButton = createButton(
    "astral-pt-primary-button",
    "Send",
    "run",
  );
  ui.copyButton = createButton(
    "astral-pt-action-button",
    "Copy",
    "copy",
  );
  ui.applyButton = createButton(
    "astral-pt-action-button",
    "Apply result",
    "apply",
  );
  ui.retryButton = createButton(
    "astral-pt-action-button",
    "Retry",
    "retry",
  );
  panelActions.append(
    ui.runButton,
    ui.copyButton,
    ui.applyButton,
    ui.retryButton,
  );

  const timestamps = createElement("div", "astral-pt-timestamps");
  ui.sentTime = createElement("span", "astral-pt-time");
  ui.receivedTime = createElement("span", "astral-pt-time");
  timestamps.append(ui.sentTime, ui.receivedTime);

  ui.resultLabel = createElement("span", "astral-pt-result-label");
  ui.result = createElement("textarea", "astral-pt-result");
  ui.result.readOnly = true;
  ui.result.spellcheck = false;
  markUserContent(ui.result);
  ui.resultLabel.hidden = true;
  ui.result.hidden = true;
  ui.panel.append(
    panelHeader,
    panelFields,
    panelActions,
    timestamps,
    ui.resultLabel,
    ui.result,
  );

  ui.settings = createElement("section", SETTINGS_CLASS);
  ui.settings.hidden = true;
  ui.settings.setAttribute("role", "dialog");
  ui.settings.setAttribute("aria-modal", "false");
  const settingsHeader = createElement(
    "div",
    "astral-pt-settings-header",
  );
  ui.settingsHeading = createElement(
    "strong",
    "astral-pt-settings-heading",
  );
  ui.settingsSource = createElement(
    "span",
    "astral-pt-settings-source",
  );
  ui.settingsCloseButton = createButton(
    "astral-pt-icon-button",
    "×",
    "close-settings",
  );
  settingsHeader.append(
    ui.settingsHeading,
    ui.settingsSource,
    ui.settingsCloseButton,
  );

  const settingsFields = createElement(
    "div",
    "astral-pt-settings-fields",
  );
  ui.settingsRuleSelect = createElement("select", "astral-pt-select");
  ui.settingsManageButton = createButton(
    "astral-pt-link-button",
    "Manage rules",
    "manage-settings-rules",
  );
  const settingsRuleControl = createElement(
    "span",
    "astral-pt-rule-control",
  );
  settingsRuleControl.append(
    ui.settingsRuleSelect,
    ui.settingsManageButton,
  );
  ui.settingsRuleField = createField(
    "System Prompt",
    settingsRuleControl,
    "astral-pt-wide-field",
  );
  ui.settingsSkillSelect = createElement("select", "astral-pt-select");
  ui.settingsSkillField = createField(
    "Skill",
    ui.settingsSkillSelect,
    "astral-pt-wide-field",
  );
  ui.settingsServiceSelect = createElement("select", "astral-pt-select");
  ui.settingsServiceField = createField(
    "Service",
    ui.settingsServiceSelect,
    "astral-pt-wide-field",
  );
  ui.settingsClearLabel = createElement("label", "astral-pt-check");
  ui.settingsClearVram = document.createElement("input");
  ui.settingsClearVram.type = "checkbox";
  const settingsClearText = createElement(
    "span",
    "",
    "Clear VRAM after task",
  );
  ui.settingsClearLabel.append(
    ui.settingsClearVram,
    settingsClearText,
  );
  ui.settingsHint = createElement("p", "astral-pt-settings-hint");
  settingsFields.append(
    ui.settingsRuleField,
    ui.settingsSkillField,
    ui.settingsServiceField,
    ui.settingsClearLabel,
    ui.settingsHint,
  );

  const settingsActions = createElement(
    "div",
    "astral-pt-settings-actions",
  );
  ui.settingsRefreshButton = createButton(
    "astral-pt-link-button",
    "↻ Refresh rules and Skills",
    "refresh-settings",
  );
  settingsActions.append(ui.settingsRefreshButton);
  ui.settings.append(settingsHeader, settingsFields, settingsActions);

  ui.status = createElement("div", "astral-pt-toast");
  ui.status.hidden = true;
  ui.status.setAttribute("role", "status");
  markUserContent(ui.status);

  document.body.append(ui.toolbar, ui.panel, ui.settings, ui.status);
  registerLocalizationRoot(ui.toolbar);
  registerLocalizationRoot(ui.panel);
  registerLocalizationRoot(ui.settings);

  ui.expandButton.addEventListener("click", () =>
    handleToolClick("expand"),
  );
  ui.expandButton.addEventListener("contextmenu", (event) =>
    openSettings("expand", event),
  );
  ui.translateEnButton.addEventListener("click", () =>
    openTranslation("en"),
  );
  ui.translateZhButton.addEventListener("click", () =>
    openTranslation("zh"),
  );
  ui.invertButton.addEventListener("click", () =>
    handleToolClick("invert", "zh"),
  );
  ui.invertButton.addEventListener("contextmenu", (event) =>
    openSettings("invert", event),
  );
  ui.invertEnButton.addEventListener("click", () =>
    handleToolClick("invert", "en"),
  );
  ui.invertEnButton.addEventListener("contextmenu", (event) =>
    openSettings("invert", event),
  );
  ui.closeButton.addEventListener("click", closePanel);
  ui.runButton.addEventListener("click", () => {
    if (state.running) {
      void stopTask();
    } else {
      void runTask();
    }
  });
  ui.copyButton.addEventListener("click", () => void copyResult());
  ui.applyButton.addEventListener("click", applyResult);
  ui.retryButton.addEventListener("click", () => void runTask(true));
  ui.settingsCloseButton.addEventListener("click", closeSettings);
  ui.settingsManageButton.addEventListener("click", () =>
    openRuleManager(state.menuAction),
  );
  ui.settingsRefreshButton.addEventListener("click", () => {
    if (state.menuAction) void loadCatalog(state.menuAction, true);
  });
  ui.settingsRuleSelect.addEventListener("change", () => {
    const config = state.settings[state.menuAction];
    if (!config) return;
    config.ruleId = ui.settingsRuleSelect.value;
    if (config.ruleId) config.skillId = "";
    refreshSettingsOptions();
  });
  ui.settingsSkillSelect.addEventListener("change", () => {
    const config = state.settings[state.menuAction];
    if (!config) return;
    config.skillId = ui.settingsSkillSelect.value;
    if (config.skillId) config.ruleId = "";
    refreshSettingsOptions();
  });
  ui.settingsServiceSelect.addEventListener("change", () => {
    const config = state.settings[state.menuAction];
    if (!config) return;
    config.mode =
      ui.settingsServiceSelect.value === "local" ? "local" : "api";
    refreshSettingsOptions();
  });
  ui.settingsClearVram.addEventListener("change", () => {
    const config = state.settings[state.menuAction];
    if (!config) return;
    config.clearVram = Boolean(ui.settingsClearVram.checked);
  });
  ui.serviceSelect.addEventListener("change", refreshTexts);
  ui.languageSelect.addEventListener("change", () => {
    state.translationTarget =
      ui.languageSelect.value || state.translationTarget || "en";
    refreshTexts();
  });
  ui.clearVram.addEventListener("change", refreshTexts);
  for (const element of [ui.toolbar, ui.panel, ui.settings]) {
    for (const eventName of [
      "pointerdown",
      "keydown",
      "wheel",
      "contextmenu",
    ]) {
      element.addEventListener(eventName, (event) => {
        event.stopPropagation();
      });
    }
  }
  ui.panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePanel();
    }
  });
  ui.settings.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSettings();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (
      !ui.settings.hidden &&
      !ui.settings.contains?.(event.target)
    ) {
      closeSettings();
    }
  });
}

function fillSelect(select, items, selectedValue, emptyLabel, labelKey = "title") {
  select.replaceChildren();
  const empty = createElement("option", "", emptyLabel);
  empty.value = "";
  select.append(empty);
  for (const item of items) {
    const option = createElement(
      "option",
      "",
      String(item[labelKey] || item.name || item.id || ""),
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
      `${text("Missing", "Missing")}: ${requested}`,
    );
    missing.value = requested;
    markUserContent(missing);
    select.append(missing);
  }
  select.value = requested;
  if (select.value !== requested) select.value = "";
}

function toolSettings(action) {
  return ["expand", "invert"].includes(action)
    ? state.settings[action] || null
    : null;
}

function setCheckCaption(label, zh, en) {
  const caption = label?.querySelector?.("span");
  if (caption) caption.textContent = text(zh, en);
}

function refreshServiceOptions() {
  const current = ui.serviceSelect.value || "api";
  ui.serviceSelect.replaceChildren();
  for (const item of [
    {
      value: "api",
      label: text("API Text-only Mode", "API Text-only Mode"),
    },
    { value: "local", label: text("Local Mode", "Local Mode") },
  ]) {
    const option = createElement("option", "", item.label);
    option.value = item.value;
    ui.serviceSelect.append(option);
  }
  ui.serviceSelect.value = current === "local" ? "local" : "api";
}

function refreshLanguageOptions() {
  const current = ui.languageSelect.value || "en";
  ui.languageSelect.replaceChildren();
  for (const item of TARGET_LANGUAGES) {
    const option = createElement("option", "", text(item.zh, item.en));
    option.value = item.value;
    ui.languageSelect.append(option);
  }
  ui.languageSelect.value = current;
}

function refreshSettingsOptions() {
  const action = state.menuAction;
  const config = toolSettings(action);
  if (!ui.settings || !config) return;

  ui.settingsHeading.textContent = `${actionTitle(action)} ${text(
    "settings",
    "settings",
  )}`;
  const target =
    state.kind === "image"
      ? state.imageLabel
      : state.widget?.name || state.node?.title || "";
  ui.settingsSource.textContent = target
    ? `${text("Target", "Target")}: ${target}`
    : "";
  ui.settingsRuleField.__label.textContent = text(
    "System Prompt",
    "System prompt",
  );
  ui.settingsSkillField.__label.textContent = "Skill";
  ui.settingsServiceField.__label.textContent = text("Service", "Service");
  setCheckCaption(
    ui.settingsClearLabel,
    "Clear VRAM after task",
    "Clear VRAM after task",
  );

  fillSelect(
    ui.settingsRuleSelect,
    state.catalogs[action] || [],
    config.ruleId,
    text("No system prompt", "No system prompt"),
  );
  fillSelect(
    ui.settingsSkillSelect,
    state.catalogs.skills,
    config.skillId,
    text("No Skill", "No Skill"),
  );

  const apiLabel =
    action === "invert"
      ? text("API Image Mode", "API Image Mode")
      : text("API Text-only Mode", "API Text-only Mode");
  const serviceValue = config.mode === "local" ? "local" : "api";
  ui.settingsServiceSelect.replaceChildren();
  for (const item of [
    { value: "api", label: apiLabel },
    { value: "local", label: text("Local Mode", "Local Mode") },
  ]) {
    const option = createElement("option", "", item.label);
    option.value = item.value;
    ui.settingsServiceSelect.append(option);
  }
  ui.settingsServiceSelect.value = serviceValue;
  ui.settingsClearLabel.hidden = serviceValue !== "local";
  ui.settingsClearVram.checked =
    serviceValue === "local" && Boolean(config.clearVram);

  const ruleSelected = Boolean(config.ruleId);
  const skillSelected = Boolean(config.skillId);
  ui.settingsRuleSelect.disabled = state.running || skillSelected;
  ui.settingsSkillSelect.disabled = state.running || ruleSelected;
  ui.settingsServiceSelect.disabled = state.running;
  ui.settingsClearVram.disabled = state.running;
  ui.settingsManageButton.disabled = state.running;
  ui.settingsRefreshButton.disabled = state.running;
  ui.settingsManageButton.textContent = text("Manage rules", "Manage rules");
  ui.settingsRefreshButton.textContent = text(
    "↻ Refresh rules and Skills",
    "↻ Refresh rules and Skills",
  );
  ui.settingsHint.textContent = text(
    "Left-click to run; right-click to configure. Choose either a system prompt or a Skill.",
    "Left-click to run; right-click to configure. Choose either a system prompt or a Skill.",
  );
}

function refreshTimestamps() {
  ui.sentTime.textContent = state.sentAt
    ? `${text("Send", "Sent")} ${formatTimestamp(state.sentAt)}`
    : "";
  ui.receivedTime.textContent = state.receivedAt
    ? `${text("Received", "Received")} ${formatTimestamp(state.receivedAt)}`
    : "";
  ui.sentTime.hidden = !ui.sentTime.textContent;
  ui.receivedTime.hidden = !ui.receivedTime.textContent;
}

function refreshResult() {
  const visible =
    state.action === "translate" &&
    Boolean(state.result) &&
    !state.running;
  ui.result.value = state.result;
  ui.result.hidden = !visible;
  ui.resultLabel.textContent = text("Result", "Result");
  ui.resultLabel.hidden = !visible;
  ui.copyButton.hidden = !visible;
  ui.applyButton.hidden =
    !visible ||
    !state.lastTask?.widget;
  ui.retryButton.hidden =
    state.running || state.lastTask?.action !== "translate";
}

function setRunning(running) {
  state.running = running;
  const activeTool = running ? state.action : "";
  ui.runButton.textContent = running
    ? text("Stop", "Stop")
    : text("Send", "Send");
  ui.runButton.dataset.running = running ? "true" : "false";
  ui.closeButton.disabled = running;
  ui.serviceSelect.disabled = running;
  ui.languageSelect.disabled = running;
  ui.clearVram.disabled = running;
  for (const [action, button] of [
    ["expand", ui.expandButton],
    ["invert", ui.invertButton],
    ["invert", ui.invertEnButton],
  ]) {
    button.dataset.running =
      activeTool === action ? "true" : "false";
    button.disabled = running && activeTool !== action;
  }
  for (const [target, button] of [
    ["en", ui.translateEnButton],
    ["zh", ui.translateZhButton],
  ]) {
    button.dataset.running =
      activeTool === "translate" &&
      state.translationTarget === target
        ? "true"
        : "false";
    button.disabled = running;
  }
  refreshTexts();
  refreshResult();
}

function refreshTexts() {
  const expandRunning =
    state.running && state.action === "expand";
  const invertRunning =
    state.running && state.action === "invert";
  ui.expandButton.title = expandRunning
    ? text("Stop prompt expansion", "Stop prompt expansion")
    : text(
        "Expand selected text (left-click to run, right-click to configure)",
        "Expand selected text (left-click to run, right-click to configure)",
      );
  ui.translateEnButton.title = text(
    "Translate to English",
    "Translate to English",
  );
  ui.translateZhButton.title = text(
    "Translate to Simplified Chinese",
    "Translate to Simplified Chinese",
  );
  ui.invertButton.title = invertRunning
    ? text("Stop image inversion", "Stop image inversion")
    : text(
        "Chinese image inversion (left-click to run, right-click to configure)",
        "Chinese image inversion (left-click to run, right-click to configure)",
      );
  ui.invertEnButton.title = invertRunning
    ? text("Stop image inversion", "Stop image inversion")
    : text(
        "English image inversion (left-click to run, right-click to configure)",
        "English image inversion (left-click to run, right-click to configure)",
      );
  ui.expandButton.setAttribute("aria-label", ui.expandButton.title);
  ui.translateEnButton.setAttribute(
    "aria-label",
    ui.translateEnButton.title,
  );
  ui.translateZhButton.setAttribute(
    "aria-label",
    ui.translateZhButton.title,
  );
  ui.invertButton.setAttribute("aria-label", ui.invertButton.title);
  ui.invertEnButton.setAttribute("aria-label", ui.invertEnButton.title);
  ui.panelHeading.textContent = actionTitle("translate");
  ui.closeButton.title = text("Close", "Close");
  ui.closeButton.setAttribute("aria-label", ui.closeButton.title);
  ui.resultLabel.textContent = text("Result", "Result");
  ui.runButton.textContent =
    state.running && state.action === "translate"
    ? text("Stop", "Stop")
    : text("Send", "Send");
  ui.runButton.dataset.running =
    state.running && state.action === "translate" ? "true" : "false";
  ui.copyButton.textContent = text("Copy", "Copy");
  ui.applyButton.textContent = text("Apply result", "Apply result");
  ui.retryButton.textContent = text("Retry", "Retry");
  ui.serviceField.__label.textContent = text("Service", "Service");
  ui.languageField.__label.textContent = text(
    "Target language",
    "Target language",
  );
  setCheckCaption(
    ui.clearLabel,
    "Clear VRAM after task",
    "Clear VRAM after task",
  );
  ui.clearLabel.hidden = ui.serviceSelect.value !== "local";
  if (ui.panelSource?.childNodes.length) {
    ui.panelSource.firstChild.textContent =
      state.kind === "image"
        ? text("Current image", "Current image")
        : text("Current widget", "Current widget");
  }
  refreshServiceOptions();
  refreshLanguageOptions();
  refreshSettingsOptions();
  renderStatus();
}

function updateSourceLabel() {
  ui.panelSource.replaceChildren();
  const prefix = createElement(
    "span",
    "",
    state.kind === "image"
      ? text("Current image: ", "Current image: ")
      : text("Current widget: ", "Current widget: "),
  );
  const value = createElement(
    "span",
    "astral-pt-user-content",
    state.kind === "image"
      ? state.imageLabel
      : state.widget?.name || state.node?.title || "",
  );
  markUserContent(value);
  ui.panelSource.append(prefix, value);
}

function resetSourceState(selection) {
  state.node = selection.node;
  state.widget = selection.widget || null;
  state.kind = selection.kind;
  state.pointerOverTextWidget = false;
  state.anchorElement =
    widgetElements(selection.widget)[0] || nodeContainer(selection.node);
  state.imageSource = selection.kind === "image" ? selection.source : null;
  state.imageLabel = selection.kind === "image" ? selection.label : "";
  state.abortController = null;
  state.requestId = "";
  state.stopRequested = false;
  state.result = "";
  state.sentAt = 0;
  state.receivedAt = 0;
  state.lastTask = null;
  state.translationTarget = ui.languageSelect?.value || "en";
  setStatus("");
  updateSourceLabel();
  refreshTimestamps();
  refreshResult();
}

function showToolbar(selection) {
  const same =
    state.node === selection.node &&
    state.widget === selection.widget &&
    state.kind === selection.kind;
  if (!same) {
    resetSourceState(selection);
    ui.panel.hidden = true;
    ui.settings.hidden = true;
    state.menuAction = "";
    state.settingsAnchor = null;
  }
  ui.expandButton.hidden = selection.kind !== "text";
  ui.translateEnButton.hidden = selection.kind !== "text";
  ui.translateZhButton.hidden = selection.kind !== "text";
  ui.invertButton.hidden = selection.kind !== "image";
  ui.invertEnButton.hidden = selection.kind !== "image";
  syncToolbarVisibility();
}

function clearSourceState() {
  state.node = null;
  state.widget = null;
  state.kind = "";
  state.pointerOverTextWidget = false;
  state.anchorElement = null;
  state.imageSource = null;
  state.imageLabel = "";
  state.abortController = null;
  state.requestId = "";
  state.stopRequested = false;
  state.result = "";
  state.sentAt = 0;
  state.receivedAt = 0;
  state.lastTask = null;
  state.translationTarget = "en";
  setStatus("");
  refreshTimestamps();
  refreshResult();
}

function hideFloatingUi(clearSource = false) {
  ui.toolbar.hidden = true;
  ui.panel.hidden = true;
  ui.settings.hidden = true;
  state.menuAction = "";
  state.settingsAnchor = null;
  if (clearSource) clearSourceState();
}

function pointerInsideActiveAnchor() {
  if (state.kind === "image") return true;
  if (state.kind !== "text") return false;
  return state.pointerOverTextWidget;
}

function toolbarShouldBeVisible() {
  if (!state.node) return false;
  if (!ui.panel.hidden || !ui.settings.hidden) return false;
  if (state.kind !== "text") return true;
  return nodeIsSelected(state.node) && pointerInsideActiveAnchor();
}

function syncToolbarVisibility() {
  ui.toolbar.hidden = !toolbarShouldBeVisible();
  if (!ui.toolbar.hidden) {
    window.requestAnimationFrame?.(positionFloatingUi);
  }
}

function positionElement(element, anchor) {
  if (!element || element.hidden || !anchor) return;
  const margin = 8;
  const elementRect =
    element.getBoundingClientRect?.() || {
      width: 0,
      height: 0,
    };
  const width = Math.min(elementRect.width || 320, window.innerWidth - margin * 2);
  let left = Math.min(
    Math.max(anchor.left, margin),
    Math.max(margin, window.innerWidth - width - margin),
  );
  let top = anchor.bottom + 8;
  const height = elementRect.height || 40;
  if (top + height > window.innerHeight - margin) {
    top = Math.max(margin, anchor.top - height - 8);
  }
  element.style.left = `${left}px`;
  element.style.top = `${Math.max(margin, top)}px`;
}

function positionToolbar(anchor) {
  if (!ui.toolbar || ui.toolbar.hidden || !anchor) return;
  const inset = 4;
  const elementRect = ui.toolbar.getBoundingClientRect?.() || {
    width: 0,
    height: 0,
  };
  const width = Math.min(
    elementRect.width || 60,
    Math.max(0, window.innerWidth - inset * 2),
  );
  const height = elementRect.height || 32;
  const anchorRight =
    Number(anchor.right) ||
    Number(anchor.left) + Number(anchor.width) ||
    0;
  const preferredLeft =
    state.kind === "text"
      ? anchorRight - width - inset
      : anchor.left + inset;
  const left = Math.min(
    Math.max(preferredLeft, inset),
    Math.max(inset, window.innerWidth - width - inset),
  );
  const maxTop = Math.max(inset, window.innerHeight - height - inset);
  const insideBottomTop = anchor.bottom - height - inset;
  const belowEditorTop = anchor.bottom - 2;
  const preferredTop =
    state.kind === "text" && belowEditorTop <= maxTop
      ? belowEditorTop
      : insideBottomTop;
  const top = Math.max(
    inset,
    Math.min(preferredTop, maxTop),
  );
  ui.toolbar.style.left = `${left}px`;
  ui.toolbar.style.top = `${top}px`;
}

function canvasNodeRect(node) {
  const canvas = app.canvas?.canvas;
  if (!canvas || !node?.pos || !node?.size) return null;
  const rect = canvas.getBoundingClientRect();
  const scale = Number(app.canvas?.ds?.scale) || 1;
  const offsetX = Number(app.canvas?.ds?.offset?.[0]) || 0;
  const offsetY = Number(app.canvas?.ds?.offset?.[1]) || 0;
  const left = rect.left + (Number(node.pos[0]) + offsetX) * scale;
  const top = rect.top + (Number(node.pos[1]) + offsetY) * scale;
  return {
    left,
    top,
    right: left + Number(node.size[0]) * scale,
    bottom: top + Number(node.size[1]) * scale,
    width: Number(node.size[0]) * scale,
    height: Number(node.size[1]) * scale,
  };
}

function currentAnchorRect() {
  const element = state.anchorElement;
  if (element?.isConnected) {
    const rect = element.getBoundingClientRect();
    if (rect.width || rect.height) return rect;
  }
  return canvasNodeRect(state.node);
}

function positionFloatingUi() {
  const anchor = currentAnchorRect();
  if (anchor) {
    positionToolbar(anchor);
    positionElement(ui.panel, anchor);
  }
  positionElement(
    ui.settings,
    state.settingsAnchor || anchor,
  );
  let statusAnchor = anchor;
  const button = [
    ui.expandButton,
    ui.translateEnButton,
    ui.translateZhButton,
    ui.invertButton,
    ui.invertEnButton,
  ].find(
    (candidate) =>
      candidate?.dataset?.running === "true",
  );
  const buttonRect = button?.getBoundingClientRect?.();
  if (buttonRect?.width || buttonRect?.height) {
    statusAnchor = buttonRect;
  } else if (!ui.settings.hidden && state.settingsAnchor) {
    statusAnchor = state.settingsAnchor;
  }
  positionElement(ui.status, statusAnchor);
}

async function loadCatalog(category, force = false) {
  if (!["expand", "invert"].includes(category)) return;
  if (!force && state.loadedCategories.has(category)) return;
  if (state.catalogLoading && !force) return state.catalogLoading;
  if (!ui.settings.hidden) {
    setStatus("loadingRules", "", "loading");
  }
  const loading = Promise.all([
    fetchJson(
      `/assets-astral/prompt-templates?category=${encodeURIComponent(category)}`,
    ),
    fetchJson("/assets-astral/skills"),
  ])
    .then(([rules, skills]) => {
      state.catalogs[category] = Array.isArray(rules?.items) ? rules.items : [];
      state.catalogs.skills = Array.isArray(skills?.items) ? skills.items : [];
      state.loadedCategories.add(category);
      if (state.menuAction === category) {
        refreshSettingsOptions();
      }
      if (!ui.settings.hidden) {
        setStatus("rulesLoaded", "", "success", true);
      }
    })
    .catch((error) => {
      if (!ui.settings.hidden) {
        setStatus("error", error.message || String(error), "error");
      }
    })
    .finally(() => {
      if (state.catalogLoading === loading) {
        state.catalogLoading = null;
      }
    });
  state.catalogLoading = loading;
  return loading;
}

function openTranslation(targetLanguage) {
  const target = targetLanguage === "zh" ? "zh" : "en";
  ui.languageSelect.value = target;
  openPanel("translate", target);
}

function openPanel(action, targetLanguage = "") {
  if (state.running) return;
  if (action !== "translate" || state.kind !== "text") return;
  const nextTarget =
    targetLanguage || state.translationTarget || "en";
  if (
    state.action !== action ||
    nextTarget !== state.translationTarget
  ) {
    state.abortController = null;
    state.requestId = "";
    state.stopRequested = false;
    state.result = "";
    state.sentAt = 0;
    state.receivedAt = 0;
    state.lastTask = null;
    setStatus("");
    refreshTimestamps();
    refreshResult();
  }
  state.action = action;
  state.translationTarget = nextTarget;
  ui.languageSelect.value = nextTarget;
  ui.settings.hidden = true;
  state.menuAction = "";
  state.settingsAnchor = null;
  ui.panel.hidden = false;
  ui.toolbar.hidden = true;
  setStatus("");
  refreshTexts();
  updateSourceLabel();
  window.requestAnimationFrame(positionFloatingUi);
}

function closePanel() {
  if (state.running) return;
  ui.panel.hidden = true;
  syncToolbarVisibility();
}

function openRuleManager(category) {
  const target =
    category === "invert" ? "invert" : "expand";
  window.openAssetsAstralPromptCategory?.(target);
}

function pointAnchor(event, fallback) {
  const rect = fallback?.getBoundingClientRect?.();
  const left = Number.isFinite(event?.clientX)
    ? event.clientX
    : rect?.left || 0;
  const top = Number.isFinite(event?.clientY)
    ? event.clientY
    : rect?.top || 0;
  return {
    left,
    right: left,
    top,
    bottom: top,
    width: 0,
    height: 0,
  };
}

function openSettings(action, event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  if (state.running || !toolSettings(action)) return;
  state.menuAction = action;
  state.settingsAnchor = pointAnchor(
    event,
    event?.currentTarget ||
      (action === "invert"
        ? ui.invertButton
        : ui.expandButton),
  );
  ui.panel.hidden = true;
  ui.toolbar.hidden = true;
  ui.settings.hidden = false;
  refreshSettingsOptions();
  void loadCatalog(action, true);
  window.requestAnimationFrame(positionFloatingUi);
}

function closeSettings() {
  ui.settings.hidden = true;
  state.menuAction = "";
  state.settingsAnchor = null;
  syncToolbarVisibility();
}

function handleToolClick(action, language = "") {
  if (state.running) {
    if (state.action === action) return stopTask();
    return undefined;
  }
  if (action === "expand" && state.kind === "text") {
    return runTask("expand");
  }
  if (action === "invert" && state.kind === "image") {
    return runTask("invert", false, language);
  }
  return undefined;
}

function insertImageElement(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    let objectUrl = "";
    image.onload = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      reject(new Error(text("Unable to read image", "Unable to read image")));
    };
    if (source instanceof Blob) {
      objectUrl = URL.createObjectURL(source);
      image.src = objectUrl;
    } else {
      image.src = String(source);
    }
  });
}

async function imageToJpegAttachment(source, name = "canvas-image.jpg") {
  let drawable = source;
  if (
    typeof source === "string" ||
    source instanceof Blob ||
    (
      source &&
      typeof source === "object" &&
      typeof source.src === "string" &&
      typeof HTMLImageElement !== "undefined" &&
      !(source instanceof HTMLImageElement)
    )
  ) {
    drawable = await insertImageElement(
      typeof source === "string" || source instanceof Blob
        ? source
        : source.src,
    );
  } else if (
    typeof HTMLImageElement !== "undefined" &&
    source instanceof HTMLImageElement &&
    (!source.complete || !source.naturalWidth)
  ) {
    await source.decode?.().catch(() => null);
  }
  if (!drawable) throw new Error(text("No image is available", "No image is available"));

  let width =
    drawable.naturalWidth ||
    drawable.videoWidth ||
    drawable.width ||
    drawable.displayWidth ||
    0;
  let height =
    drawable.naturalHeight ||
    drawable.videoHeight ||
    drawable.height ||
    drawable.displayHeight ||
    0;
  const isImageData =
    typeof ImageData !== "undefined" && drawable instanceof ImageData;
  if (isImageData) {
    width = drawable.width;
    height = drawable.height;
  }
  if (!width || !height) {
    throw new Error(text("The image has no valid dimensions", "The image has no valid dimensions"));
  }
  const ratio = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
  width = Math.max(1, Math.round(width * ratio));
  height = Math.max(1, Math.round(height * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error(text("Unable to create an image canvas", "Unable to create an image canvas"));
  }
  context.fillStyle = "#111827";
  context.fillRect(0, 0, width, height);
  if (isImageData) {
    context.putImageData(drawable, 0, 0);
  } else {
    context.drawImage(drawable, 0, 0, width, height);
  }
  let data = "";
  try {
    data = canvas.toDataURL("image/jpeg", 0.92);
  } catch {
    throw new Error(
      text(
        "Canvas pixels are blocked; save the image to input or output first",
        "Canvas pixels are blocked; save the image to input or output first",
      ),
    );
  }
  return {
    kind: "image",
    mimeType: "image/jpeg",
    data,
    name: String(name || "canvas-image.jpg").replace(/\.[^.]+$/, ".jpg"),
  };
}

function newRequestId() {
  return `prompt-tool-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

async function writeClipboardText(value) {
  const content = String(value || "");
  let clipboardError = null;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(content);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }
  const scratch = document.createElement("textarea");
  scratch.value = content;
  scratch.style.position = "fixed";
  scratch.style.opacity = "0";
  document.body.append(scratch);
  try {
    scratch.select?.();
    const copied = document.execCommand?.("copy");
    if (copied === true) return;
  } finally {
    scratch.remove?.();
  }
  throw clipboardError || new Error(text("Copy failed", "Copy failed"));
}

async function runTask(
  action = state.action,
  isRetry = false,
  targetLanguageOverride = "",
) {
  if (typeof action === "boolean") {
    isRetry = action;
    action = state.action;
  }
  if (state.running || !state.node) return;
  if (!["expand", "translate", "invert"].includes(action)) return;
  const sourceText = state.widget ? readWidgetText(state.widget).trim() : "";
  if (action !== "invert" && (!state.widget || !sourceText)) {
    setStatus("needText", "", "error");
    return;
  }
  if (action === "invert" && !state.imageSource) {
    setStatus("needImage", "", "error");
    return;
  }

  const config = action === "translate" ? null : toolSettings(action);
  if (action !== "translate" && !config) return;
  const ruleId = config?.ruleId || "";
  const skillId = config?.skillId || "";
  if (ruleId && skillId) {
    setStatus("conflict", "", "error");
    return;
  }

  const targetLanguage =
    action === "translate"
      ? ui.languageSelect.value ||
        state.translationTarget ||
        "en"
      : action === "invert"
        ? targetLanguageOverride || "en"
        : "en";
  state.action = action;
  if (action === "translate") {
    state.translationTarget = targetLanguage;
  }
  state.abortController = new AbortController();
  state.stopRequested = false;
  state.requestId = newRequestId();
  state.result = "";
  state.sentAt = Date.now();
  state.receivedAt = 0;
  state.lastTask = {
    action,
    widget: state.widget,
    node: state.node,
    sourceText,
    imageSource: state.imageSource,
    imageLabel: state.imageLabel,
  };
  setRunning(true);
  refreshTimestamps();
  refreshResult();

  let attachment = null;
  try {
    if (action === "invert") {
      setStatus("preparingImage", "", "loading");
      attachment = await imageToJpegAttachment(
        state.imageSource,
        state.imageLabel || "canvas-image.jpg",
      );
      if (state.stopRequested) throw new DOMException("Aborted", "AbortError");
      setStatus("runningInvert", "", "loading");
    } else if (action === "translate") {
      setStatus("runningTranslate", "", "loading");
    } else {
      setStatus("runningExpand", "", "loading");
    }

    const mode =
      action === "translate"
        ? ui.serviceSelect.value === "local"
          ? "local"
          : "api"
        : config.mode === "local"
          ? "local"
          : "api";
    const clearVram =
      mode === "local" &&
      (action === "translate"
        ? ui.clearVram.checked
        : Boolean(config.clearVram));
    const payload = await fetchJson("/assets-astral/prompt-task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: state.abortController.signal,
      body: JSON.stringify({
        requestId: state.requestId,
        text: sourceText,
        task: action,
        mode,
        ruleId,
        skillIds: skillId ? [skillId] : [],
        attachments: attachment ? [attachment] : [],
        clearVram,
        targetLanguage,
        sourceLanguage: "auto",
      }),
    });
    if (state.stopRequested) {
      setStatus("stopped", "", "stopped");
      return;
    }
    state.result = String(payload?.text || "").trim();
    if (!state.result) {
      throw new Error(
        text("The model returned no content", "The model returned no content"),
      );
    }
    state.sentAt = Number(payload?.sentAt || 0) * 1000 || state.sentAt;
    state.receivedAt =
      Number(payload?.receivedAt || 0) * 1000 || Date.now();
    refreshTimestamps();
    refreshResult();

    if (action === "expand") {
      const node = sourceNodeForWidget(state.lastTask.widget);
      syncWidgetText(node, state.lastTask.widget, state.result);
      state.anchorElement =
        widgetElements(state.lastTask.widget)[0] ||
        nodeContainer(node) ||
        state.anchorElement;
      setStatus("expandedApplied", "", "success", true);
    } else if (action === "invert") {
      try {
        await writeClipboardText(state.result);
        setStatus("invertedCopied", "", "success", true);
      } catch (error) {
        setStatus(
          "copyFailed",
          error.message || String(error),
          "error",
        );
        return;
      }
    } else {
      setStatus("completed", "", "success", true);
    }

    if (payload?.clearVramError) {
      setStatus("clearFailed", payload.clearVramError, "error");
    }
    positionFloatingUi();
  } catch (error) {
    if (
      state.stopRequested ||
      error?.name === "AbortError" ||
      /操作已停止|aborted|cancelled/i.test(String(error?.message || error))
    ) {
      setStatus("stopped", "", "stopped");
    } else {
      setStatus("error", error.message || String(error), "error");
    }
  } finally {
    state.abortController = null;
    setRunning(false);
  }
}

async function stopTask() {
  if (!state.running || state.stopRequested) return;
  state.stopRequested = true;
  const requestId = state.requestId;
  setStatus("stopping", "", "loading");
  try {
    if (requestId) {
      await fetchJson("/assets-astral/chat/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
    }
  } catch (error) {
    console.warn(
      "[ComfyUI-Astral-Manage] Unable to cancel prompt task:",
      error,
    );
  } finally {
    state.abortController?.abort();
  }
}

async function copyResult() {
  if (!state.result) return;
  try {
    await writeClipboardText(state.result);
    setStatus("copied", "", "success", true);
  } catch (error) {
    setStatus("error", error.message || String(error), "error");
  }
}

function applyResult() {
  if (!state.result || !state.lastTask?.widget) return;
  const node = sourceNodeForWidget(state.lastTask.widget);
  syncWidgetText(node, state.lastTask.widget, state.result);
  state.anchorElement =
    widgetElements(state.lastTask.widget)[0] || nodeContainer(node);
  setStatus("applied", "", "success", true);
  window.requestAnimationFrame(positionFloatingUi);
}

function handleSelection(value) {
  if (state.running) return;
  const selection = resolveSelection(value);
  if (!selection) {
    hideFloatingUi(true);
    return;
  }
  showToolbar(selection);
}

function installSelectionHook() {
  if (!app.canvas) return;
  const previous = app.canvas.onSelectionChange;
  if (previous?.__astralPromptToolsHook) return;
  const wrapped = function (selected) {
    let result;
    try {
      result = previous?.apply(this, arguments);
    } finally {
      window.setTimeout(() => handleSelection(selected), 0);
    }
    return result;
  };
  wrapped.__astralPromptToolsHook = true;
  wrapped.__astralPromptToolsOriginal = previous || null;
  app.canvas.onSelectionChange = wrapped;
  handleSelection(app.canvas.selected_nodes);
}

function installCanvasPositionHook() {
  if (!app.canvas) return;
  const previousDraw = app.canvas.onDrawForeground;
  if (previousDraw?.__astralPromptToolsPositionHook) return;
  const wrapped = function () {
    const result = previousDraw?.apply(this, arguments);
    positionFloatingUi();
    return result;
  };
  wrapped.__astralPromptToolsPositionHook = true;
  app.canvas.onDrawForeground = wrapped;
  window.addEventListener("resize", positionFloatingUi, { passive: true });
  window.addEventListener("scroll", positionFloatingUi, {
    passive: true,
    capture: true,
  });
}

function installFocusHook() {
  document.addEventListener(
    "focusin",
    (event) => {
      if (state.running) return;
      const node = nodeForElement(event.target);
      if (!node) return;
      handleSelection({ [node.id]: node });
    },
    true,
  );
}

function textWidgetAtElement(node, element) {
  return (
    node?.widgets?.find(
      (widget) =>
        isTextWidget(widget, node) &&
        widgetElements(widget).some(
          (candidate) =>
            candidate === element ||
            candidate.contains?.(element),
        ),
    ) || null
  );
}

function handlePromptPointer(event) {
  const target = event?.target;
  if (
    target === ui.toolbar ||
    ui.toolbar.contains?.(target) ||
    target === ui.panel ||
    ui.panel.contains?.(target) ||
    target === ui.settings ||
    ui.settings.contains?.(target)
  ) {
    return;
  }
  const hoveredNode = nodeForElement(event.target);
  const hoveredWidget = textWidgetAtElement(hoveredNode, event.target);
  state.pointerOverTextWidget = Boolean(hoveredWidget);
  if (
    hoveredWidget &&
    !state.running &&
    ui.panel.hidden &&
    ui.settings.hidden
  ) {
    showToolbar({
      kind: "text",
      node: hoveredNode,
      widget: hoveredWidget,
    });
    state.pointerOverTextWidget = true;
    syncToolbarVisibility();
    return;
  }
  syncToolbarVisibility();
}

function installPointerHook() {
  document.addEventListener("pointermove", handlePromptPointer, {
    capture: true,
    passive: true,
  });
  document.addEventListener("pointerdown", handlePromptPointer, {
    capture: true,
    passive: true,
  });
}

function initialize() {
  if (initialized || !document.body) return;
  initialized = true;
  ensureStyles();
  createFloatingUi();
  installSelectionHook();
  installCanvasPositionHook();
  installFocusHook();
  installPointerHook();
  installLanguageListener();
  refreshTexts();
}

function installLanguageListener() {
  if (languageUnsubscribe) return;
  languageUnsubscribe = onLanguageChange(() => {
    refreshTexts();
    updateSourceLabel();
  });
}

app.registerExtension({
  name: "ComfyUI-Astral-Manage.PromptTools",
  setup() {
    initialize();
  },
});

globalThis.__astralPromptTools = {
  state,
  ui,
  readWidgetText,
  syncWidgetText,
  findImageSource,
  imageToJpegAttachment,
  resolveSelection,
  installSelectionHook,
  initialize,
  refreshTexts,
  refreshSettingsOptions,
  setRunning,
  openPanel,
  openTranslation,
  openSettings,
  closeSettings,
  handleSelection,
  handlePromptPointer,
  handleToolClick,
  runTask,
  stopTask,
  writeClipboardText,
  copyResult,
  applyResult,
};
