import { app } from "../../scripts/app.js";
import {
  registerLocalizationRoot,
  translateUiText,
  unregisterLocalizationRoot,
} from "./astral_i18n.js";

const NODE_TYPE = "Prompt Skill Loader";
const STYLE_URL =
  "/extensions/ComfyUI-Astral-Manage/prompt_skill_loader.css?v=20261128-1";
const CONTROL_WIDGET = "astral_prompt_skill_loader_controls";
const MAX_SKILL_BYTES = 4 * 1024 * 1024;
const installs = new Set();

function ui(english) {
  return translateUiText(english);
}

function client() {
  return globalThis.app || app;
}

function isLoaderNode(node) {
  return Boolean(
    node &&
      (node.type === NODE_TYPE || node.constructor?.comfyClass === NODE_TYPE),
  );
}

function loaderNodes() {
  const graph = client()?.graph;
  return Array.isArray(graph?._nodes) ? graph._nodes : [];
}

function widgetByName(node, name) {
  return node.widgets?.find((widget) => widget?.name === name) || null;
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function hideWidget(widget) {
  if (!widget || widget.__astralSkillLoaderHidden) return;
  widget.__astralSkillLoaderHidden = true;
  widget.computeSize = () => [0, -4];
  widget.type = `converted-widget:${CONTROL_WIDGET}:${widget.name}`;
  widget.hidden = true;
  widget.options ||= {};
  widget.options.hidden = true;
}

function syncWidget(node, widget, value) {
  if (!widget) return false;
  const index = node.widgets?.indexOf(widget) ?? -1;
  if (Object.is(widget.value, value)) return false;
  widget.value = value;
  if (index >= 0) {
    node.widgets_values ||= [];
    node.widgets_values[index] = value;
  }
  node.graph?.setDirtyCanvas?.(true, true);
  return true;
}

function ensureStyles() {
  if (document.querySelector("style[data-astral-prompt-skill-loader]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = STYLE_URL;
  link.dataset.astralPromptSkillLoader = "true";
  document.head.append(link);
}

function setupSkillLoader(node) {
  if (!node || installs.has(node)) return true;
  if (!isLoaderNode(node)) return false;
  if (typeof node.addDOMWidget !== "function") return false;
  const widgets = {
    skill: widgetByName(node, "skill"),
    skillPath: widgetByName(node, "skill_path"),
    inlineName: widgetByName(node, "inline_name"),
    inlineContent: widgetByName(node, "inline_content"),
  };
  if (!widgets.skill || !widgets.skillPath) return false;
  installs.add(node);
  ensureStyles();
  for (const widget of [widgets.skillPath, widgets.inlineName, widgets.inlineContent]) {
    hideWidget(widget);
  }

  const root = createElement("div", "astral-sl");
  const actions = createElement("div", "astral-sl-actions");
  const load = createElement("button", "astral-sl-button", ui("Load Skill file"));
  load.type = "button";
  const clear = createElement("button", "astral-sl-button", ui("Clear file"));
  clear.type = "button";
  actions.append(load, clear);
  const status = createElement("span", "astral-sl-status");
  const fileInput = createElement("input", "astral-sl-file");
  fileInput.type = "file";
  fileInput.accept = ".md,.txt,text/markdown,text/plain";
  root.append(actions, status, fileInput);

  const setStatus = (text, kind = "") => {
    status.textContent = text || "";
    status.dataset.kind = kind;
  };

  const refreshStatus = () => {
    const inlineName = String(widgets.inlineName?.value || "").trim();
    const inlineContent = String(widgets.inlineContent?.value || "");
    if (inlineName || inlineContent) {
      setStatus(inlineName || ui("Skill file"), "success");
      return;
    }
    const pinned = String(widgets.skillPath?.value || "").trim();
    if (pinned) {
      setStatus(pinned.split(/[\\/]/).pop(), "success");
      return;
    }
    const selected = String(widgets.skill?.value || "").trim();
    setStatus(selected && selected !== "Auto (none)" ? selected : ui("No Skill loaded."));
  };

  load.addEventListener("click", () => fileInput.click());
  clear.addEventListener("click", () => {
    syncWidget(node, widgets.inlineName, "");
    syncWidget(node, widgets.inlineContent, "");
    syncWidget(node, widgets.skillPath, "");
    refreshStatus();
  });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    if (!/\.(md|txt)$/i.test(file.name)) {
      setStatus(ui("Choose a .md or .txt file."), "error");
      return;
    }
    if (file.size > MAX_SKILL_BYTES) {
      setStatus(ui("Skill file must be 4 MB or smaller."), "error");
      return;
    }
    try {
      const text = await file.text();
      syncWidget(node, widgets.inlineName, file.name);
      syncWidget(node, widgets.inlineContent, text);
      syncWidget(node, widgets.skillPath, "");
      refreshStatus();
    } catch (error) {
      setStatus(`${ui("Failed to read file")}: ${error.message || error}`, "error");
    }
  });

  const domWidget = node.addDOMWidget(CONTROL_WIDGET, CONTROL_WIDGET, root, {
    getMinHeight: () => 54,
    getMaxHeight: () => 54,
    getHeight: () => 54,
    hideOnZoom: false,
    margin: 0,
    serialize: false,
    // Keep the panel off the Vue/right-side surfaces: ComfyUI's legacy widget
    // bridge writes y/width onto the real widget there and collapses it.
    surfaces: { canvas: "shown", vueNode: "never", panel: "never" },
  });
  domWidget.computeLayoutSize = () => ({
    minHeight: 54,
    minWidth: 200,
    maxHeight: 54,
    maxWidth: 100000,
  });
  if (domWidget.element) {
    domWidget.element.parentElement?.classList.add("astral-sl-widget-shell");
    root.style.pointerEvents = "none";
  }

  const currentSignature = () =>
    [
      String(widgets.skillPath?.value || ""),
      String(widgets.inlineName?.value || ""),
      String(widgets.inlineContent?.value || "").length,
      String(widgets.skill?.value || ""),
    ].join("\u0000");
  let lastSignature = currentSignature();

  // The asset manager pins a Skill path right after creating the node, before
  // the panel has rendered. Watching the widget values keeps the name below
  // the buttons in sync with that change.
  const originalDraw = node.onDrawForeground;
  const wrappedDraw = function (ctx) {
    const result = originalDraw?.apply(this, arguments);
    const signature = currentSignature();
    if (signature !== lastSignature) {
      lastSignature = signature;
      refreshStatus();
    }
    return result;
  };
  node.onDrawForeground = wrappedDraw;

  const originalConfigure = node.onConfigure;
  node.onConfigure = function () {
    const result = originalConfigure?.apply(this, arguments);
    window.setTimeout(() => {
      lastSignature = currentSignature();
      refreshStatus();
      const width = Math.max(320, Number(node.size?.[0]) || 0);
      const height = Math.max(
        90,
        Number(node.size?.[1]) || 0,
        Number(node.computeSize?.()[1]) || 0,
      );
      node.setSize?.([width, height]);
    }, 0);
    return result;
  };

  const originalRemoved = node.onRemoved;
  node.onRemoved = function () {
    if (node.onDrawForeground === wrappedDraw) {
      node.onDrawForeground = originalDraw;
    }
    unregisterLocalizationRoot(root);
    installs.delete(node);
    return originalRemoved?.apply(this, arguments);
  };

  registerLocalizationRoot(root);
  refreshStatus();
  const width = Math.max(320, Number(node.size?.[0]) || 0);
  const height = Math.max(90, Number(node.computeSize?.()[1]) || 0);
  node.setSize?.([width, height]);
  return true;
}

function retrySetup(node) {
  if (!node || installs.has(node)) return;
  if (setupSkillLoader(node)) return;
  for (const delay of [0, 50, 250, 1000]) {
    window.setTimeout(() => setupSkillLoader(node), delay);
  }
}

function retryInstalled() {
  for (const node of loaderNodes()) {
    if (isLoaderNode(node) && !installs.has(node)) setupSkillLoader(node);
  }
}

app.registerExtension({
  name: "ComfyUI-Astral-Manage.PromptSkillLoader",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;
    const originalNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = originalNodeCreated?.apply(this, arguments);
      retrySetup(this);
      return result;
    };
  },
  setup() {
    ensureStyles();
    retryInstalled();
    window.setTimeout(retryInstalled, 50);
    window.setTimeout(retryInstalled, 250);
    window.setTimeout(retryInstalled, 1000);
  },
  nodeCreated(node) {
    if (isLoaderNode(node)) retrySetup(node);
  },
  loadedGraphNode(node) {
    if (isLoaderNode(node)) retrySetup(node);
  },
  afterConfigureGraph() {
    retryInstalled();
    window.setTimeout(retryInstalled, 0);
  },
});

globalThis.__astralPromptSkillLoader = { NODE_TYPE, CONTROL_WIDGET };
