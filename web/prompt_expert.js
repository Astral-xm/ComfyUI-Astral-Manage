import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
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
import { nextPromptExpertSize } from "./prompt_expert_size.js?v=20261127-2";

const NODE_TYPE = "Prompt Processor";
const STYLE_URL =
  "/extensions/ComfyUI-Astral-Manage/prompt_expert.css?v=20261127-2";
const CONTROL_WIDGET = "astral_prompt_expert_controls";
const CONTROL_MIN_WIDTH = 260;
const CONTROL_HEIGHT_MARGIN = 2;
const HISTORY_VERSION = 1;
const PROFILE_LIMIT = 5;
const CONVERSATION_LIMIT = 20;
const EMPTY_HISTORY = { version: HISTORY_VERSION, skill: "", messages: [] };
const EMPTY_CONVERSATIONS = { version: 1, active: 0, items: [] };
const FIELD_HELP = Object.freeze({
  "Profile": "Active API profile used in API mode.",
  "Name": "Display name for this API profile.",
  "Base URL": "OpenAI-compatible base URL.",
  "API Key": "Saved with this workflow; leave empty for endpoints without auth.",
  "Model": "Model name sent with the request.",
  "Fetch models": "Query this endpoint's /models list.",
  "Temperature": "Sampling temperature.",
  "Max tokens": "Maximum reply length.",
  "Top P": "Nucleus sampling probability.",
  "History rounds": "Conversation rounds sent with each request.",
  "Frequency penalty": "Penalize tokens by frequency.",
  "Presence penalty": "Penalize tokens already present.",
  "Response format": "Optional response_format field.",
  "Reasoning effort": "Optional reasoning_effort field.",
  "Local model": "GGUF file under ComfyUI/models/LLM.",
  "Vision model (mmproj)": "Optional mmproj for image inputs.",
  "Context length n_ctx": "Local context window size.",
  "Batch n_batch": "Prompt batch size.",
  "Micro-batch n_ubatch": "Micro-batch size.",
  "Max tokens (local)": "Maximum reply length for local mode.",
  "Max rounds": "Local history rounds kept by the model.",
  "Temperature (local)": "Local sampling temperature.",
  "Top K": "Top-k sampling.",
  "Min P": "Min-p sampling.",
  "Repeat penalty": "Repetition penalty.",
  "GPU layers": "Layers offloaded to the GPU; -1 offloads all.",
  "Threads": "CPU threads; 0 lets llama.cpp decide.",
  "Max image edge": "Longest edge for local image attachments.",
  "JPEG quality": "JPEG quality for local image attachments.",
  "Context checkpoints": "llama.cpp context checkpoints.",
  "Flash attention": "llama.cpp flash attention mode.",
  "KV cache K": "K cache type.",
  "KV cache V": "V cache type.",
  "Enable thinking": "Request thinking from the local model.",
  "Use mmap": "Memory-map the GGUF file.",
  "Clear VRAM": "Release the local GGUF after the task.",
});
const SECTION_DEFAULTS = Object.freeze({ api: false, llm: false, chat: true });
const MEDIA_INPUT_KIND_ORDER = Object.freeze({
  image: 0,
  video: 1,
  audio: 2,
});
const TEXT_PORTS = Object.freeze({
  systemPrompt: "system_prompt",
  skill: "skill",
  userPrompt: "user_prompt",
});
const COMBO_LABELS = Object.freeze({
  mode: {
    api: "API 模式",
    local: "本地模式",
  },
});
const HIDDEN_WIDGETS = [
  "prompt_text",
  "chat_history",
  "conversations",
  "api_profiles",
  "api_active",
  "api_temperature",
  "api_max_tokens",
  "api_top_p",
  "api_frequency_penalty",
  "api_presence_penalty",
  "api_response_format",
  "api_reasoning_effort",
  "api_history_rounds",
  "local_model",
  "local_vision_model",
  "local_n_ctx",
  "local_n_batch",
  "local_n_ubatch",
  "local_max_tokens",
  "local_max_rounds",
  "local_temperature",
  "local_top_p",
  "local_top_k",
  "local_min_p",
  "local_repeat_penalty",
  "local_frequency_penalty",
  "local_presence_penalty",
  "local_gpu_layers",
  "local_threads",
  "local_max_image_edge",
  "local_image_jpeg_quality",
  "local_context_checkpoints",
  "local_flash_attention",
  "local_kv_cache_k",
  "local_kv_cache_v",
  "local_reasoning_effort",
  "local_enable_thinking",
  "local_use_mmap",
  "clear_vram",
];
const REQUIRED_WIDGETS = [
  "prompt_text",
  "chat_history",
  "conversations",
  "mode",
  "multi_turn",
  "api_profiles",
  "api_active",
];

const installs = new Set();
let languageHooked = false;

function ui(english) {
  return translateUiText(english);
}

function client() {
  return globalThis.app || app;
}

function isExpertNode(node) {
  if (!node) return false;
  return node.type === NODE_TYPE || node.constructor?.comfyClass === NODE_TYPE;
}

function expertNodes() {
  const graph = client()?.graph;
  return Array.isArray(graph?._nodes) ? graph._nodes : [];
}

function widgetByName(node, name) {
  return node.widgets?.find((widget) => widget?.name === name) || null;
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function markUserContent(element) {
  if (!element) return;
  element.dataset.astralI18nSkip = "true";
  element.setAttribute("translate", "no");
  element.classList.add("notranslate");
}

function hideWidget(widget) {
  if (!widget || widget.__astralPromptExpertHidden) return;
  widget.__astralPromptExpertHidden = true;
  widget.__astralPromptExpertOriginalComputeSize = widget.computeSize;
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

function normalizeMode(value) {
  const normalized = String(value || "api").trim().toLowerCase();
  return ["local", "本地", "本地模式", "local mode"].includes(normalized)
    ? "local"
    : "api";
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
}

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
    if (!labels || widget.__astralExpertComboLabels) continue;
    widget.__astralExpertComboLabels = true;
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

function parseHistory(raw) {
  let payload = null;
  try {
    payload = JSON.parse(String(raw ?? ""));
  } catch {
    return { ...EMPTY_HISTORY };
  }
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.messages)
      ? payload.messages
      : [];
  const messages = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const role = String(entry.role || "").toLowerCase();
    if (role !== "user" && role !== "assistant") continue;
    if (typeof entry.content !== "string") continue;
    messages.push({
      role,
      content: entry.content,
      ...(typeof entry.prompt === "string" && role === "assistant"
        ? { prompt: entry.prompt }
        : {}),
    });
  }
  return {
    version: HISTORY_VERSION,
    skill: String(payload?.skill || ""),
    messages,
  };
}

function serializeHistory(conversation) {
  return JSON.stringify({
    version: HISTORY_VERSION,
    skill: String(conversation?.skill || ""),
    messages: Array.isArray(conversation?.messages)
      ? conversation.messages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.prompt ? { prompt: message.prompt } : {}),
        }))
      : [],
  });
}

function parseProfiles(raw) {
  let payload = null;
  try {
    payload = JSON.parse(String(raw ?? ""));
  } catch {
    payload = [];
  }
  if (payload && !Array.isArray(payload) && Array.isArray(payload.profiles)) {
    payload = payload.profiles;
  }
  const entries = Array.isArray(payload) ? payload : [];
  const profiles = [];
  for (let index = 0; index < PROFILE_LIMIT; index += 1) {
    const entry =
      entries[index] && typeof entries[index] === "object" ? entries[index] : {};
    profiles.push({
      name: String(entry.name || "") || `Profile ${index + 1}`,
      baseUrl: String(entry.baseUrl || ""),
      apiKey: String(entry.apiKey || ""),
      model: String(entry.model || ""),
    });
  }
  return profiles;
}

function serializeProfiles(profiles) {
  return JSON.stringify(
    profiles.map((profile) => ({
      name: profile.name,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      model: profile.model,
    })),
  );
}

function parseConversations(raw, fallback) {
  let payload = null;
  try {
    payload = JSON.parse(String(raw ?? ""));
  } catch {
    payload = null;
  }
  const items = [];
  const source = Array.isArray(payload?.items) ? payload.items : [];
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const messages = Array.isArray(item.messages)
      ? item.messages
          .filter(
            (message) =>
              message &&
              typeof message.content === "string" &&
              (message.role === "user" || message.role === "assistant"),
          )
          .map((message) => ({
            role: message.role,
            content: message.content,
            ...(typeof message.prompt === "string" &&
            message.role === "assistant"
              ? { prompt: message.prompt }
              : {}),
            ...(Number.isFinite(Number(message.time))
              ? { time: Number(message.time) }
              : {}),
          }))
      : [];
    items.push({
      title: String(item.title || "").trim(),
      titleManual: Boolean(item.titleManual),
      skill: String(item.skill || ""),
      messages,
      updatedAt: Number(item.updatedAt) || 0,
    });
  }
  if (!items.length) {
    items.push({
      title: "",
      titleManual: false,
      skill: String(fallback?.skill || ""),
      messages: Array.isArray(fallback?.messages) ? fallback.messages : [],
      updatedAt: Date.now(),
    });
  }
  const active = Math.min(
    items.length - 1,
    Math.max(0, Number(payload?.active) || 0),
  );
  return {
    version: 1,
    active,
    items: items.slice(-CONVERSATION_LIMIT),
  };
}

function serializeConversations(state) {
  return JSON.stringify({
    version: 1,
    active: state.active,
    items: state.items.map((item) => ({
      title: item.title,
      titleManual: Boolean(item.titleManual),
      skill: item.skill,
      messages: item.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.prompt ? { prompt: message.prompt } : {}),
        ...(Number.isFinite(message.time) ? { time: message.time } : {}),
      })),
      updatedAt: item.updatedAt,
    })),
  });
}

function formatMessageTime(value) {
  const date = new Date(Number(value) || Date.now());
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    textarea.remove();
    return copied;
  }
}

function readSections(node) {
  const stored = node?.properties?.promptExpertSections;
  const sections = {};
  for (const [key, fallback] of Object.entries(SECTION_DEFAULTS)) {
    const value = stored?.[key];
    sections[key] = typeof value === "boolean" ? value : fallback;
  }
  return sections;
}

function storeSections(node, sections) {
  node.properties ||= {};
  node.properties.promptExpertSections = { ...sections };
}

function ensureStyles() {
  if (document.querySelector("style[data-astral-prompt-expert]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = STYLE_URL;
  link.dataset.astralPromptExpert = "true";
  document.head.append(link);
}

async function fetchJson(url, options) {
  const response = await api.fetchApi(url, options);
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      if (payload?.error) detail = payload.error;
    } catch {
      // Keep the status code when the body is not JSON.
    }
    throw new Error(detail);
  }
  return response.json();
}

function collectPromptLinks(value, output, result = new Set()) {
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[1] === "number" &&
    output?.[String(value[0])]
  ) {
    result.add(String(value[0]));
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPromptLinks(item, output, result);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectPromptLinks(item, output, result);
    }
  }
  return result;
}

async function buildScopedPrompt(node) {
  const prompt = await client().graphToPrompt();
  const output = prompt?.output;
  const targetId = String(node.id);
  if (!output?.[targetId]) {
    throw new Error(ui("The node is not part of the executable prompt."));
  }
  const keep = new Set();
  const addWithAncestors = (nodeId) => {
    const id = String(nodeId);
    if (keep.has(id)) return;
    const apiNode = output[id];
    if (!apiNode) return;
    keep.add(id);
    for (const sourceId of collectPromptLinks(apiNode.inputs || {}, output)) {
      addWithAncestors(sourceId);
    }
  };
  addWithAncestors(targetId);
  const scoped = {};
  for (const [id, apiNode] of Object.entries(output)) {
    if (keep.has(String(id))) scoped[id] = apiNode;
  }
  prompt.output = scoped;
  return prompt;
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
    return links.find((link) => String(link?.id) === String(linkRef)) || null;
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
    return (
      MEDIA_INPUT_KIND_ORDER[leftParsed.kind] -
        MEDIA_INPUT_KIND_ORDER[rightParsed.kind] ||
      leftParsed.index - rightParsed.index
    );
  });
  const reordered = inputs.slice();
  let cursor = 0;
  for (let slot = 0; slot < reordered.length; slot += 1) {
    if (!parseMediaInput(reordered[slot])) continue;
    reordered[slot] = sortedMedia[cursor];
    cursor += 1;
  }
  if (reordered.every((input, slot) => input === inputs[slot])) return false;
  const linkRefs = new Map();
  for (const input of inputs) linkRefs.set(input, input?.link);
  inputs.splice(0, inputs.length, ...reordered);
  for (let slot = 0; slot < reordered.length; slot += 1) {
    const link = graphLink(node, linkRefs.get(reordered[slot]));
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
    const desired = desiredMediaInputCount(node.inputs, kind, isConnected);
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

function setupPromptExpert(node) {
  if (!node || installs.has(node)) return true;
  if (!isExpertNode(node)) return false;
  if (typeof node.addDOMWidget !== "function") return false;
  const widgets = {};
  for (const name of [...HIDDEN_WIDGETS, "mode", "multi_turn", "seed"]) {
    widgets[name] = widgetByName(node, name);
  }
  for (const name of REQUIRED_WIDGETS) {
    if (!widgets[name]) return false;
  }
  installs.add(node);
  ensureStyles();
  patchComboLabels(node);
  for (const name of HIDDEN_WIDGETS) hideWidget(widgets[name]);

  const state = (node.__astralPromptExpert = {
    root: null,
    domWidget: null,
    widgets,
    sections: readSections(node),
    conversations: parseConversations(
      widgets.conversations?.value,
      parseHistory(widgets.chat_history?.value),
    ),
    conversation: { ...EMPTY_HISTORY },
    profiles: parseProfiles(widgets.api_profiles.value),
    profileIndex: Math.min(
      PROFILE_LIMIT - 1,
      Math.max(0, (Number(widgets.api_active.value) || 1) - 1),
    ),
    fetchedModels: Array.from({ length: PROFILE_LIMIT }, () => []),
    catalogs: { models: [], visionModels: [] },
    catalogLoaded: false,
    catalogLoading: null,
    statusTimer: null,
    layoutFrame: null,
    resizeObserver: null,
    controlHeight: 240,
    sending: false,
  });
  state.conversation =
    state.conversations.items[state.conversations.active] || {
      title: "",
      skill: "",
      messages: [],
      updatedAt: Date.now(),
    };
  state.restored =
    Boolean(node.properties?.promptExpertSections) ||
    String(widgets.chat_history?.value || "").trim() !==
      '{"version":1,"skill":"","messages":[]}';
  storeSections(node, state.sections);

  const root = createElement("div", "astral-pe");
  state.root = root;
  const header = createElement("div", "astral-pe-header");
  const heading = createElement("strong", "astral-pe-heading", "Prompt Processor");
  const hint = createElement("span", "astral-pe-hint");
  const refresh = createElement("button", "astral-pe-icon-button", "↻");
  refresh.type = "button";
  refresh.title = ui("Refresh local models");
  refresh.setAttribute("aria-label", refresh.title);
  header.append(heading, hint, refresh);

  const apiSection = createSection("api", "API Configuration");
  const profileSelect = createElement("select", "astral-pe-select");
  const profileName = textInput("", "Profile name");
  const apiBase = textInput("", "https://api.example.com/v1");
  const apiKey = textInput("", "");
  apiKey.type = "password";
  const modelInput = textInput("", "Model name");
  const modelListId = `astral-pe-models-${Math.random().toString(36).slice(2)}`;
  modelInput.setAttribute("list", modelListId);
  const modelList = createElement("datalist");
  modelList.id = modelListId;
  const fetchModels = createElement(
    "button",
    "astral-pe-button",
    ui("Fetch models"),
  );
  fetchModels.type = "button";
  const modelRow = createElement("div", "astral-pe-row");
  modelRow.append(modelInput, fetchModels);
  const apiTemperature = numberInput(0.7, { min: 0, max: 2, step: 0.01 });
  const apiMaxTokens = numberInput(2048, { min: 1, max: 128000, step: 1 });
  const apiTopP = numberInput(0.95, { min: 0.01, max: 1, step: 0.01 });
  const apiFrequencyPenalty = numberInput(0, { min: -2, max: 2, step: 0.01 });
  const apiPresencePenalty = numberInput(0, { min: -2, max: 2, step: 0.01 });
  const apiHistoryRounds = numberInput(12, { min: 1, max: 50, step: 1 });
  const makeSelect = (values) => {
    const select = createElement("select", "astral-pe-select");
    for (const value of values) {
      const option = createElement("option", "", ui(value));
      option.value = value;
      select.append(option);
    }
    return select;
  };
  const apiResponseFormat = makeSelect(["default", "text", "json_object"]);
  const apiReasoningEffort = makeSelect(["default", "low", "medium", "high"]);
  const apiGrid = createElement("div", "astral-pe-grid");
  apiGrid.append(
    field("Top P", apiTopP),
    field("History rounds", apiHistoryRounds),
    field("Frequency penalty", apiFrequencyPenalty),
    field("Presence penalty", apiPresencePenalty),
    field("Response format", apiResponseFormat),
    field("Reasoning effort", apiReasoningEffort),
  );
  apiSection.body.append(
    createElement(
      "p",
      "astral-pe-note",
      ui(
        "Shared by text, image, and multimodal API modes; optional fields the endpoint rejects are dropped and retried.",
      ),
    ),
    field("Profile", profileSelect),
    field("Name", profileName),
    field("Base URL", apiBase),
    field("API Key", apiKey),
    field("Model", modelRow),
    modelList,
    field("Temperature", apiTemperature),
    field("Max tokens", apiMaxTokens),
    apiGrid,
    createElement("p", "astral-pe-note", ui("The API key is saved with this workflow.")),
  );

  const llmSection = createSection("llm", "Local LLM Configuration");
  const localModel = createElement("select", "astral-pe-select");
  const localVision = createElement("select", "astral-pe-select");
  const llmFields = createElement("div", "astral-pe-grid");
  const llm = {};
  const addNumber = (key, label, widgetName, options, decimal = false) => {
    const control = numberInput(0, options);
    control.__decimal = decimal;
    llm[key] = control;
    llmFields.append(field(label, control));
    llm[key].__widgetName = widgetName;
    return control;
  };
  const addSelect = (key, label, widgetName, values) => {
    const control = createElement("select", "astral-pe-select");
    for (const value of values) {
      const option = createElement("option", "", ui(value));
      option.value = value;
      control.append(option);
    }
    llm[key] = control;
    llm[key].__widgetName = widgetName;
    llmFields.append(field(label, control));
    return control;
  };
  const addCheck = (key, label, widgetName) => {
    const control = createElement("input");
    control.type = "checkbox";
    llm[key] = control;
    llm[key].__widgetName = widgetName;
    const wrapper = createElement("label", "astral-pe-check");
    wrapper.append(control, createElement("span", "astral-pe-check-label", ui(label)));
    llmFields.append(wrapper);
    return control;
  };

  addNumber("nCtx", "Context length n_ctx", "local_n_ctx", { min: 512, max: 131072, step: 1 });
  addNumber("nBatch", "Batch n_batch", "local_n_batch", { min: 32, max: 65536, step: 1 });
  addNumber("nUbatch", "Micro-batch n_ubatch", "local_n_ubatch", { min: 32, max: 65536, step: 1 });
  addNumber("maxTokens", "Max tokens (local)", "local_max_tokens", { min: 1, max: 32768, step: 1 });
  addNumber("maxRounds", "Max rounds", "local_max_rounds", { min: 1, max: 50, step: 1 });
  addNumber("temperature", "Temperature (local)", "local_temperature", { min: 0, max: 2, step: 0.01 }, true);
  addNumber("topP", "Top P", "local_top_p", { min: 0.01, max: 1, step: 0.01 }, true);
  addNumber("topK", "Top K", "local_top_k", { min: 1, max: 200, step: 1 });
  addNumber("minP", "Min P", "local_min_p", { min: 0, max: 1, step: 0.01 }, true);
  addNumber("repeatPenalty", "Repeat penalty", "local_repeat_penalty", { min: 0.5, max: 2, step: 0.01 }, true);
  addNumber("frequencyPenalty", "Frequency penalty", "local_frequency_penalty", { min: -2, max: 2, step: 0.01 }, true);
  addNumber("presencePenalty", "Presence penalty", "local_presence_penalty", { min: -2, max: 2, step: 0.01 }, true);
  addNumber("gpuLayers", "GPU layers", "local_gpu_layers", { min: -1, max: 1000, step: 1 });
  addNumber("threads", "Threads", "local_threads", { min: 0, max: 128, step: 1 });
  addNumber("maxImageEdge", "Max image edge", "local_max_image_edge", { min: 256, max: 4096, step: 1 });
  addNumber("jpegQuality", "JPEG quality", "local_image_jpeg_quality", { min: 40, max: 100, step: 1 });
  addNumber("contextCheckpoints", "Context checkpoints", "local_context_checkpoints", { min: 0, max: 64, step: 1 });
  addSelect("flashAttention", "Flash attention", "local_flash_attention", ["auto", "enabled", "disabled"]);
  addSelect("kvK", "KV cache K", "local_kv_cache_k", ["default", "q8_0"]);
  addSelect("kvV", "KV cache V", "local_kv_cache_v", ["default", "q8_0"]);
  addSelect("reasoningEffort", "Reasoning effort", "local_reasoning_effort", ["xhigh", "medium", "low"]);
  addCheck("enableThinking", "Enable thinking", "local_enable_thinking");
  addCheck("useMmap", "Use mmap", "local_use_mmap");
  addCheck("clearVram", "Clear VRAM", "clear_vram");
  llmSection.body.append(
    field("Local model", localModel),
    field("Vision model (mmproj)", localVision),
    llmFields,
  );

  const chatSection = createSection("chat", "Conversation");
  const portNote = createElement("p", "astral-pe-note");
  const messages = createElement("div", "astral-pe-messages");
  const input = createElement("textarea", "astral-pe-input astral-pe-textarea");
  input.rows = 3;
  input.placeholder = ui("Type a message...");
  const compose = createElement("div", "astral-pe-compose");
  const actions = createElement("div", "astral-pe-compose-actions");
  const send = createElement("button", "astral-pe-button is-primary", ui("Send"));
  send.type = "button";
  const clear = createElement("button", "astral-pe-button", ui("Clear"));
  clear.type = "button";
  actions.append(send, clear);
  compose.append(input, actions);
  const status = createElement("div", "astral-pe-status");
  const sessions = createElement("div", "astral-pe-sessions");
  const sessionActions = createElement("div", "astral-pe-session-actions");
  const newSession = createElement(
    "button",
    "astral-pe-session-button",
    ui("New chat"),
  );
  newSession.type = "button";
  const deleteSession = createElement(
    "button",
    "astral-pe-session-button is-danger",
    ui("Delete chat"),
  );
  deleteSession.type = "button";
  sessionActions.append(newSession, deleteSession);
  const sessionList = createElement("div", "astral-pe-session-list");
  sessions.append(sessionActions, sessionList);
  const chatMain = createElement("div", "astral-pe-chat-main");
  chatMain.append(portNote, messages, compose, status);
  const chatBody = createElement("div", "astral-pe-chat");
  chatBody.append(sessions, chatMain);
  chatSection.body.append(chatBody);

  root.append(header, apiSection.wrap, llmSection.wrap, chatSection.wrap);

  const sections = { api: apiSection, llm: llmSection, chat: chatSection };

  const setStatus = (text, kind = "", autoClear = false) => {
    status.textContent = text || "";
    status.dataset.kind = kind;
    status.classList.toggle("is-visible", Boolean(text));
    if (state.statusTimer) {
      window.clearTimeout(state.statusTimer);
      state.statusTimer = null;
    }
    if (autoClear && text) {
      state.statusTimer = window.setTimeout(() => {
        status.textContent = "";
        status.classList.remove("is-visible");
        state.statusTimer = null;
        fitControlHeight();
      }, 5000);
    }
    fitControlHeight();
  };

  const applySections = () => {
    for (const [key, section] of Object.entries(sections)) {
      const open = Boolean(state.sections[key]);
      section.wrap.dataset.open = open ? "true" : "false";
      section.head.setAttribute("aria-expanded", open ? "true" : "false");
      section.body.hidden = !open;
      section.chevron.textContent = open ? "▾" : "▸";
    }
  };

  const toggleSection = (key) => {
    state.sections[key] = !state.sections[key];
    storeSections(node, state.sections);
    applySections();
    // Folding or unfolding always re-fits the content height, so the bottom
    // edge follows the panel instead of keeping an old manual height. A second
    // pass after layout settles fixes frontends that re-apply the widget size.
    fitControlHeight(true);
    window.setTimeout(() => fitControlHeight(true), 80);
  };

  const measureControlHeight = () =>
    Math.max(
      1,
      Math.ceil(Math.max(root.offsetHeight || 0, root.scrollHeight || 0)) +
        CONTROL_HEIGHT_MARGIN,
    );

  const applyPanelLayout = () => {
    if (!state.domWidget) return;
    // The layout engine distributes the node body's free space between
    // minHeight and maxHeight. A large maxHeight lets a manual vertical stretch
    // grow the panel (and its conversation list) instead of leaving blank body.
    state.domWidget.computeLayoutSize = () => ({
      minHeight: state.controlHeight,
      maxHeight: 100000,
      minWidth: CONTROL_MIN_WIDTH,
      maxWidth: 100000,
    });
  };

  const measurePanelMinimum = () => {
    root.style.height = "auto";
    const measured = measureControlHeight();
    root.style.height = `${Math.max(1, Number(state.controlHeight) || measured)}px`;
    state.controlHeight = measured;
    applyPanelLayout();
    return measured;
  };

  const fitControlHeight = (forceContent = false) => {
    if (state.layoutFrame != null) return;
    state.layoutFrame = window.requestAnimationFrame(() => {
      state.layoutFrame = null;
      if (!state.domWidget) return;
      const nodeCanvas =
        node.canvas ||
        node.graph?._canvas ||
        node.graph?.list_of_graphcanvas?.[0] ||
        client()?.canvas;
      const pointerDown = nodeCanvas?.pointer?.isDown === true;
      if (nodeCanvas?.resizing_node === node && pointerDown) {
        state.layoutFrame = window.requestAnimationFrame(fitControlHeight);
        return;
      }
      state.domWidget.element?.parentElement?.classList.add(
        "astral-pe-widget-shell",
      );
      const previousMinimum = Number(state.controlHeight) || 0;
      const measured = measurePanelMinimum();
      const currentWidth = Math.max(0, Number(node.size?.[0]) || 0);
      const currentHeight = Math.max(0, Number(node.size?.[1]) || 0);
      const computed = node.computeSize?.();
      const minimumHeight = Number(computed?.[1]) || 0;
      // The layout engine's minimum width adds its own margins, so match it to
      // keep the width the node can shrink back to stable.
      const minimumWidth = Math.max(
        CONTROL_MIN_WIDTH,
        Number(computed?.[0]) || 0,
      );
      if (!forceContent) {
        // Keep a stable minimum even when the size came from workflow data or
        // from the node being created before the panel existed.
        const width = Math.max(minimumWidth, currentWidth);
        const height = Math.max(minimumHeight, currentHeight);
        if (
          width !== currentWidth ||
          Math.abs(height - currentHeight) > 1
        ) {
          node.__astralPromptExpertApplyingAutomaticSize = true;
          try {
            node.setSize?.([width, height]);
          } finally {
            node.__astralPromptExpertApplyingAutomaticSize = false;
          }
        }
        return;
      }
      // `computedHeight` is the height the layout engine allocated before this
      // pass; the minimum is only a fallback. Using the freshly measured
      // minimum here would treat all previous panel height as fixed chrome and
      // the node would never shrink.
      const allocated =
        Number(state.domWidget.computedHeight) || previousMinimum;
      const base = Math.max(40, currentHeight - allocated);
      const contentHeight = Math.max(base + measured, minimumHeight);
      const [width, height] = nextPromptExpertSize({
        content: contentHeight,
        minimumWidth,
        currentWidth,
        force: true,
      });
      if (width !== currentWidth || Math.abs(height - currentHeight) > 1) {
        node.__astralPromptExpertApplyingAutomaticSize = true;
        try {
          node.setSize?.([width, height]);
        } finally {
          node.__astralPromptExpertApplyingAutomaticSize = false;
        }
      }
    });
  };

  const persistChatHistory = () => {
    syncWidget(
      node,
      widgets.chat_history,
      serializeHistory({
        version: HISTORY_VERSION,
        skill: state.conversation?.skill || "",
        messages: state.conversation?.messages || [],
      }),
    );
  };

  const persistConversations = () => {
    syncWidget(
      node,
      widgets.conversations,
      serializeConversations(state.conversations),
    );
  };

  const conversationTitle = () => {
    const first = (state.conversation?.messages || []).find(
      (message) => message.role === "user",
    );
    const text = String(first?.content || "").trim().replace(/\s+/g, " ");
    return text ? text.slice(0, 18) : "";
  };

  const startRenamingSession = (index, button, titleElement) => {
    if (button.querySelector(".astral-pe-session-rename")) return;
    const item = state.conversations.items[index];
    if (!item) return;
    const input = createElement("input", "astral-pe-session-rename");
    input.type = "text";
    input.value = item.title || "";
    input.placeholder = ui("New chat");
    input.maxLength = 40;
    button.dataset.renaming = "true";
    titleElement.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = (save) => {
      if (finished) return;
      finished = true;
      delete button.dataset.renaming;
      if (save) {
        item.title = input.value.trim().slice(0, 40);
        item.titleManual = Boolean(item.title);
        persistConversations();
      }
      renderSessions();
      refreshSummaries();
    };
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("mousedown", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        finish(event.key === "Enter");
      }
    });
    input.addEventListener("blur", () => finish(true));
  };

  const renderSessions = () => {
    sessionList.replaceChildren();
    state.conversations.items.forEach((item, index) => {
      const button = createElement(
        "button",
        `astral-pe-session${
          index === state.conversations.active ? " is-active" : ""
        }`,
      );
      button.type = "button";
      const titleElement = createElement(
        "span",
        "astral-pe-session-title",
        item.title || ui("New chat"),
      );
      button.append(
        titleElement,
        createElement(
          "span",
          "astral-pe-session-count",
          ui(`${item.messages.length} messages`),
        ),
      );
      button.addEventListener("click", () => {
        if (button.dataset.renaming === "true") return;
        switchConversation(index);
      });
      button.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        startRenamingSession(index, button, titleElement);
      });
      sessionList.append(button);
    });
  };

  const switchConversation = (index) => {
    if (!state.conversations.items[index]) return;
    if (index === state.conversations.active) return;
    state.conversations.active = index;
    state.conversation = state.conversations.items[index];
    persistChatHistory();
    persistConversations();
    renderSessions();
    renderConversation();
    refreshSummaries();
  };

  const newConversation = () => {
    const item = {
      title: "",
      titleManual: false,
      skill: state.conversation?.skill || "",
      messages: [],
      updatedAt: Date.now(),
    };
    if (state.conversations.items.length >= CONVERSATION_LIMIT) {
      state.conversations.items.shift();
    }
    state.conversations.items.push(item);
    state.conversations.active = state.conversations.items.length - 1;
    state.conversation = item;
    persistChatHistory();
    persistConversations();
    renderSessions();
    renderConversation();
    refreshSummaries();
  };

  const deleteConversation = () => {
    const items = state.conversations.items;
    items.splice(state.conversations.active, 1);
    if (!items.length) {
      items.push({
        title: "",
        titleManual: false,
        skill: "",
        messages: [],
        updatedAt: Date.now(),
      });
    }
    state.conversations.active = Math.min(
      state.conversations.active,
      items.length - 1,
    );
    state.conversation = items[state.conversations.active];
    persistChatHistory();
    persistConversations();
    renderSessions();
    renderConversation();
    refreshSummaries();
  };

  const deleteMessage = (message) => {
    const items = state.conversation.messages;
    const index = items.indexOf(message);
    if (index < 0) return;
    items.splice(index, 1);
    if (!state.conversation.titleManual) {
      state.conversation.title = conversationTitle();
    }
    persistChatHistory();
    persistConversations();
    renderSessions();
    renderConversation();
    refreshSummaries();
  };

  const renderConversation = () => {
    messages.replaceChildren();
    const items = state.conversation?.messages || [];
    if (!items.length) {
      messages.append(
        createElement("div", "astral-pe-empty", ui("No messages yet.")),
      );
      return;
    }
    for (const message of items) {
      const bubble = createElement(
        "div",
        `astral-pe-msg is-${message.role === "user" ? "user" : "assistant"}${
          message.pending ? " is-pending" : ""
        }`,
      );
      const head = createElement("div", "astral-pe-msg-head");
      head.append(
        createElement(
          "span",
          "astral-pe-msg-role",
          message.role === "user" ? ui("You") : ui("Expert"),
        ),
        createElement(
          "span",
          "astral-pe-msg-time",
          formatMessageTime(message.time),
        ),
      );
      const content = createElement(
        "div",
        "astral-am-chat-message-content",
        message.content,
      );
      markUserContent(content);
      const row = createElement("div", "astral-pe-msg-actions");
      const copy = createElement("button", "astral-pe-msg-action", ui("Copy"));
      copy.type = "button";
      copy.addEventListener("click", () => {
        void copyToClipboard(message.content).then((copied) => {
          setStatus(
            copied ? ui("Copied.") : ui("Copy failed"),
            copied ? "success" : "error",
            true,
          );
        });
      });
      const remove = createElement("button", "astral-pe-msg-action", ui("Delete"));
      remove.type = "button";
      remove.addEventListener("click", () => deleteMessage(message));
      row.append(copy, remove);
      bubble.append(head, content, row);
      messages.append(bubble);
    }
    messages.scrollTop = messages.scrollHeight;
  };

  const activeProfile = () => state.profiles[state.profileIndex];

  const refreshSummaries = () => {
    const profile = activeProfile();
    apiSection.note.textContent =
      `${profile.name}${profile.model ? ` · ${profile.model}` : ""}` ||
      ui("Not configured");
    const localName = String(widgets.local_model?.value || "")
      .split(/[\\/]/)
      .pop();
    llmSection.note.textContent = localName || ui("Not configured");
    chatSection.note.textContent = ui(
      `${state.conversation.messages.length} messages`,
    );
    hint.textContent = ui(
      "System prompt and Skill come from the input ports.",
    );
  };

  const fillSelect = (select, items, selectedValue, emptyLabel, labelKey) => {
    select.replaceChildren();
    const empty = createElement("option", "", emptyLabel);
    empty.value = "";
    select.append(empty);
    for (const item of items) {
      const value = String(item?.id ?? item?.path ?? "");
      if (!value) continue;
      const rawLabel =
        item?.[labelKey] || item?.title || item?.name || item?.path || value;
      const option = createElement(
        "option",
        "",
        labelKey === "path"
          ? String(rawLabel).split(/[\\/]/).pop()
          : String(rawLabel),
      );
      option.value = value;
      markUserContent(option);
      select.append(option);
    }
    const requested = String(selectedValue ?? "");
    if (
      requested &&
      ![...select.options].some((option) => option.value === requested)
    ) {
      const missing = createElement("option", "", `${ui("Missing")}: ${requested}`);
      missing.value = requested;
      markUserContent(missing);
      select.append(missing);
    }
    select.value = requested;
  };

  const syncCatalogSelects = () => {
    fillSelect(
      localModel,
      state.catalogs.models,
      widgets.local_model?.value,
      ui("Select a local model"),
      "path",
    );
    fillSelect(
      localVision,
      state.catalogs.visionModels,
      widgets.local_vision_model?.value,
      ui("No vision model"),
      "path",
    );
  };

  const loadCatalog = async (force = false) => {
    if (state.catalogLoading && !force) return state.catalogLoading;
    if (state.catalogLoaded && !force) return;
    setStatus(ui("Loading local models..."), "loading");
    const promise = Promise.all([fetchJson("/assets-astral/local-llm/models")])
      .then(([models]) => {
        state.catalogs.models = Array.isArray(models?.items) ? models.items : [];
        state.catalogs.visionModels = Array.isArray(models?.visionModels)
          ? models.visionModels
          : [];
        state.catalogLoaded = true;
        state.catalogLoading = null;
        syncCatalogSelects();
        refreshSummaries();
        setStatus(
          ui(`Loaded ${state.catalogs.models.length} local models.`),
          "success",
          true,
        );
      })
      .catch((error) => {
        state.catalogLoading = null;
        setStatus(
          `${ui("Failed to load configuration")}: ${error.message || error}`,
          "error",
        );
      });
    state.catalogLoading = promise;
    return promise;
  };

  const persistProfiles = () => {
    syncWidget(
      node,
      widgets.api_profiles,
      serializeProfiles(state.profiles),
    );
  };

  const fillProfileSelect = () => {
    profileSelect.replaceChildren();
    state.profiles.forEach((profile, index) => {
      const option = createElement(
        "option",
        "",
        `${index + 1}. ${profile.name}${profile.model ? ` · ${profile.model}` : ""}`,
      );
      option.value = String(index);
      markUserContent(option);
      profileSelect.append(option);
    });
    profileSelect.value = String(state.profileIndex);
  };

  const applyProfileToFields = () => {
    const profile = activeProfile();
    profileName.value = profile.name;
    apiBase.value = profile.baseUrl;
    apiKey.value = profile.apiKey;
    modelInput.value = profile.model;
    fillModelList();
  };

  const fillModelList = () => {
    modelList.replaceChildren();
    for (const model of state.fetchedModels[state.profileIndex] || []) {
      const option = createElement("option");
      option.value = model;
      modelList.append(option);
    }
  };

  const updateActiveProfile = (key, value) => {
    const profile = activeProfile();
    if (profile[key] === value) return;
    profile[key] = value;
    persistProfiles();
    refreshSummaries();
  };

  const clearConversation = () => {
    state.conversation.title = "";
    state.conversation.titleManual = false;
    state.conversation.messages = [];
    state.conversation.updatedAt = Date.now();
    persistChatHistory();
    persistConversations();
    renderSessions();
    renderConversation();
    refreshSummaries();
  };

  const portLinked = (name) => {
    const port = (node.inputs || []).find((entry) => entry?.name === name);
    return Boolean(port && port.link != null);
  };

  const skillLinked = () => portLinked(TEXT_PORTS.skill);
  const multiTurnOn = () => booleanValue(widgets.multi_turn?.value);
  const chatReady = () => skillLinked() && multiTurnOn();

  const syncPortState = () => {
    const linkedPrompt = portLinked(TEXT_PORTS.userPrompt);
    const ready = chatReady();
    input.disabled = !ready || linkedPrompt;
    send.disabled = !ready || state.sending;
    if (!skillLinked()) {
      input.placeholder = ui("Connect a Skill loader first.");
      portNote.textContent = ui(
        "Connect a Skill loader to the skill input to start chatting.",
      );
      return;
    }
    if (!multiTurnOn()) {
      input.placeholder = ui("Enable Multi-turn to chat.");
      portNote.textContent = ui("Enable Multi-turn to start chatting.");
      return;
    }
    input.placeholder = linkedPrompt
      ? ui("Using the linked user prompt input.")
      : ui("Type a message...");
    portNote.textContent = linkedPrompt
      ? ui("Messages come from the linked user prompt input.")
      : ui("System prompt and Skill come from the input ports.");
    fitControlHeight();
  };

  const bindText = (control, widget, { numeric = false, integer = false } = {}) => {
    if (!control || !widget) return;
    const apply = () => {
      let value = control.value;
      if (numeric) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return;
        value = integer ? Math.trunc(parsed) : parsed;
      }
      syncWidget(node, widget, value);
    };
    control.addEventListener("input", apply);
    control.addEventListener("change", apply);
  };

  const bindCheck = (control, widget) => {
    if (!control || !widget) return;
    control.addEventListener("change", () => {
      syncWidget(node, widget, Boolean(control.checked));
    });
  };

  const bindLlmControls = () => {
    for (const control of Object.values(llm)) {
      const widget = widgets[control.__widgetName];
      if (!widget) continue;
      if (control.type === "checkbox") {
        bindCheck(control, widget);
      } else if (control.tagName === "SELECT") {
        control.addEventListener("change", () => {
          syncWidget(node, widget, control.value);
        });
      } else {
        bindText(control, widget, {
          numeric: true,
          integer: !control.__decimal,
        });
      }
    }
  };

  profileSelect.addEventListener("change", () => {
    state.profileIndex = Math.min(
      PROFILE_LIMIT - 1,
      Math.max(0, Number(profileSelect.value) || 0),
    );
    syncWidget(node, widgets.api_active, state.profileIndex + 1);
    applyProfileToFields();
    refreshSummaries();
  });
  profileName.addEventListener("input", () =>
    updateActiveProfile("name", profileName.value),
  );
  profileName.addEventListener("change", () => {
    fillProfileSelect();
    refreshSummaries();
  });
  apiBase.addEventListener("input", () =>
    updateActiveProfile("baseUrl", apiBase.value.trim()),
  );
  apiKey.addEventListener("input", () =>
    updateActiveProfile("apiKey", apiKey.value.trim()),
  );
  modelInput.addEventListener("input", () =>
    updateActiveProfile("model", modelInput.value.trim()),
  );
  modelInput.addEventListener("change", () => {
    fillProfileSelect();
    refreshSummaries();
  });
  bindText(apiTemperature, widgets.api_temperature, { numeric: true });
  bindText(apiMaxTokens, widgets.api_max_tokens, {
    numeric: true,
    integer: true,
  });
  bindText(apiTopP, widgets.api_top_p, { numeric: true });
  bindText(apiFrequencyPenalty, widgets.api_frequency_penalty, {
    numeric: true,
  });
  bindText(apiPresencePenalty, widgets.api_presence_penalty, {
    numeric: true,
  });
  bindText(apiHistoryRounds, widgets.api_history_rounds, {
    numeric: true,
    integer: true,
  });
  apiResponseFormat.addEventListener("change", () => {
    syncWidget(node, widgets.api_response_format, apiResponseFormat.value);
  });
  apiReasoningEffort.addEventListener("change", () => {
    syncWidget(node, widgets.api_reasoning_effort, apiReasoningEffort.value);
  });
  bindLlmControls();
  const originalMultiTurnCallback = widgets.multi_turn?.callback;
  const wrappedMultiTurnCallback = function (...args) {
    const result = originalMultiTurnCallback?.apply(this, args);
    syncPortState();
    return result;
  };
  if (widgets.multi_turn) {
    widgets.multi_turn.callback = wrappedMultiTurnCallback;
  }
  localModel.addEventListener("change", () => {
    syncWidget(node, widgets.local_model, localModel.value);
    refreshSummaries();
  });
  localVision.addEventListener("change", () => {
    syncWidget(node, widgets.local_vision_model, localVision.value);
  });
  refresh.addEventListener("click", () => void loadCatalog(true));
  newSession.addEventListener("click", () => newConversation());
  deleteSession.addEventListener("click", () => deleteConversation());
  clear.addEventListener("click", () => {
    clearConversation();
    setStatus(ui("Conversation cleared."), "success", true);
  });
  send.addEventListener("click", () => void sendMessage());

  const fetchModelsNow = async () => {
    const profile = activeProfile();
    if (!profile.baseUrl) {
      setStatus(ui("Enter the API base URL first."), "error");
      return;
    }
    setStatus(ui("Fetching models..."), "loading");
    fetchModels.disabled = true;
    try {
      const payload = await fetchJson("/assets-astral/prompt-expert/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: profile.baseUrl,
          apiKey: profile.apiKey,
        }),
      });
      const models = Array.isArray(payload?.items)
        ? payload.items.filter((item) => typeof item === "string")
        : [];
      state.fetchedModels[state.profileIndex] = models;
      fillModelList();
      if (!profile.model && models.length) {
        modelInput.value = models[0];
        updateActiveProfile("model", models[0]);
        fillProfileSelect();
      }
      setStatus(
        ui(`Fetched ${models.length} models.`),
        "success",
        true,
      );
    } catch (error) {
      setStatus(`${ui("Failed to fetch models")}: ${error.message || error}`, "error");
    } finally {
      fetchModels.disabled = false;
    }
  };
  fetchModels.addEventListener("click", () => void fetchModelsNow());

  const validateConfiguration = () => {
    if (normalizeMode(widgets.mode?.value) === "api") {
      const profile = activeProfile();
      if (!profile.baseUrl.trim() || !profile.model.trim()) {
        state.sections.api = true;
        storeSections(node, state.sections);
        applySections();
        fitControlHeight();
        setStatus(ui("Enter the API base URL and model first."), "error");
        return false;
      }
      return true;
    }
    if (!String(widgets.local_model?.value || "").trim()) {
      state.sections.llm = true;
      storeSections(node, state.sections);
      applySections();
      fitControlHeight();
      setStatus(ui("Select a local GGUF model first."), "error");
      return false;
    }
    return true;
  };

  async function sendMessage() {
    if (state.sending) return;
    const linkedPrompt = portLinked(TEXT_PORTS.userPrompt);
    const text = input.value.trim();
    if (!text && !linkedPrompt) {
      setStatus(ui("Type a message first."), "error");
      return;
    }
    if (!validateConfiguration()) return;
    state.sending = true;
    send.disabled = true;
    syncWidget(node, widgets.prompt_text, text);
    state.conversation.messages.push({
      role: "user",
      content: text || ui("(linked user prompt)"),
      time: Date.now(),
      pending: true,
    });
    if (!state.conversation.titleManual) {
      state.conversation.title = conversationTitle();
    }
    state.conversation.updatedAt = Date.now();
    persistConversations();
    renderSessions();
    renderConversation();
    refreshSummaries();
    input.value = "";
    setStatus(ui("Sending..."), "loading");
    try {
      const prompt = await buildScopedPrompt(node);
      await api.queuePrompt(0, prompt);
      setStatus(ui("Sent. Waiting for the reply..."), "loading");
    } catch (error) {
      state.sending = false;
      syncPortState();
      input.value = text;
      const pending = state.conversation.messages.find((message) => message.pending);
      if (pending) state.conversation.messages.pop();
      renderConversation();
      refreshSummaries();
      setStatus(`${ui("Failed to send")}: ${error.message || error}`, "error");
    }
  }

  const handleExecution = (payload) => {
    if (!payload) return;
    state.sending = false;
    syncPortState();
    const read = (key) => {
      const value = payload?.[key] ?? payload?.ui?.[key];
      return Array.isArray(value) ? value[0] : value;
    };
    const history = read("chat_history");
    const reply = read("reply");
    const promptText = read("prompt_text");
    const report = read("report");
    if (typeof history === "string" && history.trim()) {
      const parsed = parseHistory(history);
      state.conversation.skill = parsed.skill;
      state.conversation.messages = parsed.messages;
      if (!state.conversation.titleManual) {
      state.conversation.title = conversationTitle();
    }
      state.conversation.updatedAt = Date.now();
      persistChatHistory();
      persistConversations();
      renderSessions();
      renderConversation();
    } else if (typeof reply === "string" && reply) {
      for (const message of state.conversation.messages) {
        delete message.pending;
      }
      state.conversation.messages.push({
        role: "assistant",
        content: reply,
        ...(typeof promptText === "string" && promptText
          ? { prompt: promptText }
          : {}),
        time: Date.now(),
      });
      if (!state.conversation.titleManual) {
      state.conversation.title = conversationTitle();
    }
      state.conversation.updatedAt = Date.now();
      persistChatHistory();
      persistConversations();
      renderSessions();
      renderConversation();
    }
    refreshSummaries();
    if (report) {
      let summary = "";
      try {
        const parsed = JSON.parse(report);
        summary = `${parsed.mode || ""} · ${parsed.rounds ?? 0} rounds`;
      } catch {
        summary = String(report).slice(0, 120);
      }
      setStatus(
        ui("Reply received.") + (summary ? ` (${summary})` : ""),
        "success",
        true,
      );
    }
    fitControlHeight();
  };

  state.domWidget = node.addDOMWidget(CONTROL_WIDGET, CONTROL_WIDGET, root, {
    getMinHeight: () => state.controlHeight,
    getMaxHeight: () => 100000,
    hideOnZoom: false,
    margin: 0,
    serialize: false,
    // Keep the panel off the Vue/right-side surfaces: ComfyUI's legacy widget
    // bridge writes y/width onto the real widget there and collapses it.
    surfaces: { canvas: "shown", vueNode: "never", panel: "never" },
  });
  applyPanelLayout();
  if (state.domWidget.element) {
    state.domWidget.element.parentElement?.classList.add(
      "astral-pe-widget-shell",
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

  // The layout engine assigns the widget its share of the node body through
  // `computedHeight`; mirror it onto the panel so a vertical stretch fills the
  // node instead of leaving empty body space below the panel.
  const originalDrawForeground = node.onDrawForeground;
  const wrappedDrawForeground = function (ctx) {
    const result = originalDrawForeground?.apply(this, arguments);
    const allocated = Number(state.domWidget?.computedHeight) || 0;
    if (allocated > 0) {
      const target = Math.max(1, allocated - 4);
      if (Math.abs((Number(root.offsetHeight) || 0) - target) > 2) {
        root.style.height = `${target}px`;
      }
    }
    return result;
  };
  node.onDrawForeground = wrappedDrawForeground;

  const previousExecuted = node.onExecuted;
  const wrappedExecuted = function (message) {
    const result = previousExecuted?.apply(this, arguments);
    try {
      handleExecution(message);
    } catch (error) {
      setStatus(String(error?.message || error), "error");
    }
    return result;
  };
  node.onExecuted = wrappedExecuted;

  const handleExecutionError = (event) => {
    const detail = event?.detail || {};
    if (detail.node_id == null) return;
    if (String(detail.node_id) !== String(node.id)) return;
    state.sending = false;
    syncPortState();
    for (const message of state.conversation.messages) {
      delete message.pending;
    }
    renderConversation();
    setStatus(
      `${ui("Failed to send")}: ${
        detail.exception_message || detail.exception_type || ui("execution error")
      }`,
      "error",
    );
  };
  api.addEventListener?.("execution_error", handleExecutionError);

  const originalConnectionsChange = node.onConnectionsChange;
  const wrappedConnectionsChange = function () {
    const result = originalConnectionsChange?.apply(this, arguments);
    window.setTimeout(() => {
      syncMediaInputs(node);
      syncPortState();
      fitControlHeight();
    }, 0);
    return result;
  };
  node.onConnectionsChange = wrappedConnectionsChange;

  const syncControlsFromWidgets = () => {
    state.profiles = parseProfiles(widgets.api_profiles?.value);
    state.profileIndex = Math.min(
      PROFILE_LIMIT - 1,
      Math.max(0, (Number(widgets.api_active?.value) || 1) - 1),
    );
    fillProfileSelect();
    applyProfileToFields();
    state.conversations = parseConversations(
      widgets.conversations?.value,
      parseHistory(widgets.chat_history?.value),
    );
    state.conversation =
      state.conversations.items[state.conversations.active] || {
        title: "",
        skill: "",
        messages: [],
        updatedAt: Date.now(),
      };
    persistChatHistory();
    persistConversations();
    const setValue = (control, value) => {
      if (!control) return;
      const next = value == null ? "" : String(value);
      if (control.value !== next) control.value = next;
    };
    setValue(apiTemperature, widgets.api_temperature?.value ?? 0.7);
    setValue(apiMaxTokens, widgets.api_max_tokens?.value ?? 2048);
    setValue(apiTopP, widgets.api_top_p?.value ?? 0.95);
    setValue(apiFrequencyPenalty, widgets.api_frequency_penalty?.value ?? 0);
    setValue(apiPresencePenalty, widgets.api_presence_penalty?.value ?? 0);
    setValue(apiHistoryRounds, widgets.api_history_rounds?.value ?? 12);
    setValue(
      apiResponseFormat,
      widgets.api_response_format?.value ?? "default",
    );
    setValue(
      apiReasoningEffort,
      widgets.api_reasoning_effort?.value ?? "default",
    );
    for (const control of Object.values(llm)) {
      const widget = widgets[control.__widgetName];
      if (!widget) continue;
      if (control.type === "checkbox") {
        control.checked = booleanValue(widget.value);
      } else {
        setValue(control, widget.value ?? "");
      }
    }
  };

  const originalConfigure = node.onConfigure;
  const wrappedConfigure = function () {
    const result = originalConfigure?.apply(this, arguments);
    window.setTimeout(() => {
      state.sections = readSections(node);
      applySections();
      syncControlsFromWidgets();
      syncCatalogSelects();
      syncPortState();
      renderSessions();
      renderConversation();
      refreshSummaries();
      syncMediaInputs(node);
      fitControlHeight();
    }, 0);
    return result;
  };
  node.onConfigure = wrappedConfigure;

  const originalRemoved = node.onRemoved;
  node.onRemoved = function () {
    if (state.statusTimer) window.clearTimeout(state.statusTimer);
    if (state.layoutFrame != null) window.cancelAnimationFrame(state.layoutFrame);
    state.resizeObserver?.disconnect();
    api.removeEventListener?.("execution_error", handleExecutionError);
    const restore = (name, original, wrapper) => {
      if (node[name] !== wrapper) return;
      if (original) node[name] = original;
      else delete node[name];
    };
    restore("getWidgetOnPos", originalGetWidgetOnPos, wrappedGetWidgetOnPos);
    restore("onDrawForeground", originalDrawForeground, wrappedDrawForeground);
    restore("onExecuted", previousExecuted, wrappedExecuted);
    restore("onConnectionsChange", originalConnectionsChange, wrappedConnectionsChange);
    restore("onConfigure", originalConfigure, wrappedConfigure);
    if (widgets.multi_turn?.callback === wrappedMultiTurnCallback) {
      widgets.multi_turn.callback = originalMultiTurnCallback;
    }
    unregisterLocalizationRoot(root);
    delete node.__astralPromptExpert;
    installs.delete(node);
    return originalRemoved?.apply(this, arguments);
  };

  applySections();
  syncControlsFromWidgets();
  syncPortState();
  renderSessions();
  renderConversation();
  refreshSummaries();
  registerLocalizationRoot(root);
  syncMediaInputs(node);
  syncCatalogSelects();
  const forceInitial = !state.restored;
  fitControlHeight(forceInitial);
  window.setTimeout(() => fitControlHeight(forceInitial), 60);
  // ComfyUI can place a new node before the panel has a size; a few delayed
  // passes enforce the minimum width/height once layout has settled.
  for (const delay of [180, 400, 900]) {
    window.setTimeout(() => fitControlHeight(false), delay);
  }
  void loadCatalog();
  return true;

  function createSection(key, title) {
    const wrap = createElement("section", "astral-pe-section");
    wrap.dataset.section = key;
    const head = createElement("button", "astral-pe-section-head");
    head.type = "button";
    const chevron = createElement("span", "astral-pe-chevron", "▸");
    const label = createElement("span", "astral-pe-section-title", ui(title));
    const note = createElement("span", "astral-pe-section-note");
    head.append(chevron, label, note);
    const body = createElement("div", "astral-pe-section-body");
    head.addEventListener("click", () => toggleSection(key));
    wrap.append(head, body);
    return { wrap, head, body, chevron, note };
  }
}

function field(labelText, control) {
  const wrapper = createElement("label", "astral-pe-field");
  const help = FIELD_HELP[labelText];
  if (help && control) {
    const title = ui(help);
    wrapper.title = title;
    control.title = title;
  }
  wrapper.append(createElement("span", "astral-pe-field-label", ui(labelText)), control);
  return wrapper;
}

function textInput(value, placeholder) {
  const input = createElement("input", "astral-pe-input");
  input.type = "text";
  input.value = value == null ? "" : String(value);
  if (placeholder) input.placeholder = placeholder;
  return input;
}

function numberInput(value, { min, max, step } = {}) {
  const input = createElement("input", "astral-pe-input");
  input.type = "number";
  const number = Number(value);
  input.value = String(Number.isFinite(number) ? number : 0);
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  if (step !== undefined) input.step = String(step);
  return input;
}

function retryPromptExpertSetup(node) {
  if (!node || installs.has(node)) return;
  if (setupPromptExpert(node)) return;
  for (const delay of [0, 50, 250, 1000]) {
    window.setTimeout(() => setupPromptExpert(node), delay);
  }
}

function retryInstalledPromptExpertNodes() {
  for (const node of expertNodes()) {
    if (isExpertNode(node) && !installs.has(node)) setupPromptExpert(node);
  }
}

function installLanguageListener() {
  if (languageHooked) return;
  languageHooked = true;
  if (typeof app?.ui?.settings?.addEventListener !== "function") return;
  const redraw = () => {
    for (const node of expertNodes()) {
      if (!isExpertNode(node)) continue;
      node.graph?.setDirtyCanvas?.(true, true);
    }
  };
  try {
    app.ui.settings.addEventListener("Comfy.Locale.change", redraw);
  } catch {
    // Older frontends do not expose locale change events.
  }
}

app.registerExtension({
  name: "ComfyUI-Astral-Manage.PromptExpert",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;
    const originalNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = originalNodeCreated?.apply(this, arguments);
      retryPromptExpertSetup(this);
      return result;
    };
  },
  setup() {
    ensureStyles();
    installLanguageListener();
    retryInstalledPromptExpertNodes();
    window.setTimeout(retryInstalledPromptExpertNodes, 50);
    window.setTimeout(retryInstalledPromptExpertNodes, 250);
    window.setTimeout(retryInstalledPromptExpertNodes, 1000);
  },
  nodeCreated(node) {
    if (isExpertNode(node)) retryPromptExpertSetup(node);
  },
  loadedGraphNode(node) {
    if (isExpertNode(node)) retryPromptExpertSetup(node);
  },
  afterConfigureGraph() {
    retryInstalledPromptExpertNodes();
    window.setTimeout(retryInstalledPromptExpertNodes, 0);
  },
});

globalThis.__astralPromptExpert = {
  NODE_TYPE,
  CONTROL_WIDGET,
  PROFILE_LIMIT,
  SECTION_DEFAULTS,
  nextPromptExpertSize,
};
