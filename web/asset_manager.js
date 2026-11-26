import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  showAstralAlert,
  showAstralConfirm,
  showAstralPrompt,
  showAstralSelect,
  showAstralShortcutRecorder,
} from "./astral_dialogs.js";
import {
  getLanguage,
  onLanguageChange,
  registerLocalizationRoot,
  toggleLanguage,
} from "./astral_i18n.js";
import {
  DEFAULT_ASSET_MANAGER_SHORTCUT,
  formatShortcut,
  matchesShortcut,
  readAssetManagerShortcut,
  saveAssetManagerShortcut,
  shortcutFromKeyboardEvent,
  shortcutsEqual,
  validateAssetManagerShortcut,
} from "./astral_shortcuts.js";

const STYLE_URL =
  "/extensions/ComfyUI-Astral-Manage/asset_manager.css?v=20261116-api-runtime-hints";
const PROMPT_PAGE_SIZE = 60;
const ASSET_PAGE_SIZE = 60;
const LORA_PAGE_SIZE = 40;
const MAX_LORA_CANVAS_BATCH = 10;
const MAX_CHAT_ATTACHMENTS = 30;
const SOURCE_CHUNK_SIZE = 6;
const ASSET_OPERATION_CHUNK_SIZE = 500;
const DUPLICATE_SCAN_POLL_MS = 1000;
const THUMBNAIL_PREFERENCE = "assets-astral.show-lora-thumbnails";
const WINDOW_VIEWPORT_MARGIN = 18;
const AUTO_LOAD_BOTTOM_THRESHOLD = 96;
const ASTRAL_PROMPT_NODE_ID = "Assets Prompt";
const LEGACY_NODE_TYPES = Object.freeze({
  "Assets Astral Prompt": ASTRAL_PROMPT_NODE_ID,
});

let manager = null;
let activeAssetManagerShortcut = null;
let assetManagerShortcutListenerInstalled = false;

function migrateLegacyNodeTypes(graphData) {
  if (!graphData || typeof graphData !== "object") return;

  for (const node of graphData.nodes || []) {
    if (node?.type && LEGACY_NODE_TYPES[node.type]) {
      node.type = LEGACY_NODE_TYPES[node.type];
    }
  }

  for (const subgraph of graphData.definitions?.subgraphs || []) {
    migrateLegacyNodeTypes(subgraph);
  }
}

function hideLegacyNodeDefs(nodeDefs) {
  for (let index = nodeDefs.length - 1; index >= 0; index -= 1) {
    if (LEGACY_NODE_TYPES[nodeDefs[index]?.name]) {
      nodeDefs.splice(index, 1);
    }
  }
}

function showLoraThumbnails() {
  try {
    return window.localStorage?.getItem(THUMBNAIL_PREFERENCE) !== "false";
  } catch {
    return true;
  }
}

function setShowLoraThumbnails(value) {
  try {
    window.localStorage?.setItem(THUMBNAIL_PREFERENCE, value ? "true" : "false");
  } catch {
    // Preferences remain available for this session when storage is blocked.
  }
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function skillPreviewExcerpt(content, limit = 1400) {
  const text = String(content || "").replace(/\r\n?/g, "\n").trim();
  const body = text.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "").trim();
  const source = body || text;
  if (!source) return "This Skill has no body content.";
  return source.length > limit
    ? `${source.slice(0, limit).trimEnd()}\n…`
    : source;
}

function markUntranslated(element) {
  if (!element) return element;
  element.setAttribute("translate", "no");
  element.classList.add("notranslate");
  return element;
}

function getAssetManagerShortcut() {
  activeAssetManagerShortcut ||= readAssetManagerShortcut();
  return activeAssetManagerShortcut;
}

function isTextEntryTarget(target) {
  const selector = [
    "input",
    "textarea",
    "select",
    "[role='textbox']",
    "[contenteditable='']",
    "[contenteditable='true']",
  ].join(",");
  const eventTarget = target?.closest?.(selector);
  const focusedTarget = document.activeElement?.closest?.(selector);
  return Boolean(eventTarget || focusedTarget);
}

function handleAssetManagerShortcut(event) {
  if (!matchesShortcut(event, getAssetManagerShortcut())) return;
  if (document.querySelector("[data-assets-astral-dialog='true']")) return;
  const panelIsOpen = Boolean(manager?.isOpen());
  if (!panelIsOpen && isTextEntryTarget(event.target)) return;
  event.preventDefault();
  event.stopImmediatePropagation?.();
  event.stopPropagation();
  if (panelIsOpen) {
    manager.close();
    return;
  }
  openAssetManager(manager?.activeTab || "prompts");
}

function installAssetManagerShortcut() {
  if (assetManagerShortcutListenerInstalled) return;
  assetManagerShortcutListenerInstalled = true;
  document.addEventListener("keydown", handleAssetManagerShortcut, true);
}

function isPhysicalModelCategory(category) {
  if (!category || !Array.isArray(category.roots)) return false;
  if (category.source === "models") return true;
  // Compatibility with the previously loaded backend: keep configured
  // categories only when they actually point inside a models directory.
  return category.roots.some((root) =>
    /(?:^|[\\/])models(?:[\\/]|$)/i.test(String(root?.path || "")),
  );
}

function debounce(callback, delay) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => callback(...args), delay);
  };
}

function installAutoLoadOnScroll(element, canLoad, loadMore) {
  if (!element) return () => {};
  let frame = null;
  const trigger = () => {
    frame = null;
    if (!canLoad()) return;
    const remaining =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    if (remaining > AUTO_LOAD_BOTTOM_THRESHOLD) return;
    loadMore();
  };
  const onScroll = () => {
    if (frame !== null) return;
    frame = window.requestAnimationFrame(trigger);
  };
  element.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    element.removeEventListener("scroll", onScroll);
    if (frame !== null) window.cancelAnimationFrame(frame);
  };
}

function captureScrollState(element, anchorAttribute = "") {
  const pendingState = element.__astralPendingScrollState;
  if (pendingState) return pendingState;
  const state = {
    top: element.scrollTop,
    left: element.scrollLeft,
    anchorAttribute,
    anchorValue: "",
    anchorViewportTop: 0,
  };
  if (!anchorAttribute) return state;
  const containerTop = element.getBoundingClientRect().top;
  const anchors = [...element.querySelectorAll(`[${anchorAttribute}]`)];
  // Use the row that actually crosses the viewport's top edge. Preferring the
  // next fully visible row moves the list whenever the clicked row changes
  // height, such as when "Refresh Sources" replaces its metadata with a loading state.
  const anchor = anchors.find(
    (candidate) => candidate.getBoundingClientRect().bottom > containerTop,
  );
  if (!anchor) return state;
  state.anchorValue = anchor.getAttribute(anchorAttribute) || "";
  state.anchorViewportTop = anchor.getBoundingClientRect().top;
  return state;
}

function restoreScrollState(element, state) {
  if (!state) return;
  let top = state.top;
  if (state.anchorAttribute && state.anchorValue) {
    const anchor = [
      ...element.querySelectorAll(`[${state.anchorAttribute}]`),
    ].find(
      (candidate) =>
        candidate.getAttribute(state.anchorAttribute) === state.anchorValue,
    );
    if (anchor) {
      // Correct only the current anchor offset. Starting from state.top on
      // every pass repeatedly reapplies the same offset when status text,
      // re-rendering, and requestAnimationFrame all restore one snapshot.
      const currentTop = Number.isFinite(element.scrollTop)
        ? element.scrollTop
        : state.top;
      const anchorDelta =
        anchor.getBoundingClientRect().top - state.anchorViewportTop;
      top = currentTop + anchorDelta;
    }
  }
  element.scrollTop = Math.max(0, top);
  element.scrollLeft = Math.max(0, state.left);
}

function restoreScrollStateAfterLayout(element, state) {
  if (!element || !state) return;
  const pendingState = element.__astralPendingScrollState || state;
  element.__astralPendingScrollState = pendingState;
  restoreScrollState(element, pendingState);
  if (
    typeof window === "undefined" ||
    typeof window.requestAnimationFrame !== "function"
  ) {
    element.__astralPendingScrollState = null;
    return;
  }
  if (element.__astralScrollRestoreFrame !== undefined) {
    window.cancelAnimationFrame(element.__astralScrollRestoreFrame);
  }
  element.__astralScrollRestoreFrame = window.requestAnimationFrame(() => {
    const latestState = element.__astralPendingScrollState || pendingState;
    if (element?.isConnected) restoreScrollState(element, latestState);
    element.__astralPendingScrollState = null;
    element.__astralScrollRestoreFrame = null;
  });
}

function updateStatusPreservingScroll(
  statusElement,
  message,
  kind = "",
  scrollElement = null,
  anchorAttribute = "",
) {
  const scrollState = scrollElement
    ? captureScrollState(scrollElement, anchorAttribute)
    : null;
  statusElement.textContent = message || "";
  statusElement.className = `astral-am-status${kind ? ` is-${kind}` : ""}`;
  statusElement.hidden = !message;
  statusElement.title = message || "";
  if (scrollState) {
    restoreScrollStateAfterLayout(scrollElement, scrollState);
  }
}

function replaceChildrenPreservingScroll(
  element,
  children = null,
  anchorAttribute = "",
  preservedState = null,
) {
  const state =
    preservedState || captureScrollState(element, anchorAttribute);
  if (children === null) element.replaceChildren();
  else element.replaceChildren(children);
  restoreScrollStateAfterLayout(element, state);
}

function appendChildrenPreservingScroll(
  element,
  children = null,
  anchorAttribute = "",
  preservedState = null,
) {
  const state =
    preservedState || captureScrollState(element, anchorAttribute);
  if (children !== null) element.append(children);
  restoreScrollStateAfterLayout(element, state);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(value) {
  const seconds = Math.max(0, Number(value) || 0);
  if (seconds < 60) return `${Math.ceil(seconds)} sec`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.ceil(seconds % 60);
  if (minutes < 60) return `${minutes} min ${remainder} sec`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

function formatDate(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

function formatMessageTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part) => String(part).padStart(2, "0");
  return [
    `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
      date.getSeconds(),
    )}`,
  ].join(" ");
}

function createChatRequestId() {
  if (globalThis.crypto?.randomUUID) {
    return `chat-${globalThis.crypto.randomUUID()}`;
  }
  return `chat-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}

function pathBasename(value, fallback = "LoRA") {
  const parts = String(value || "")
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .filter(Boolean);
  return parts[parts.length - 1] || fallback;
}

function setChildren(element, ...children) {
  element.replaceChildren(...children);
  return element;
}

function ensureStyles() {
  if (document.querySelector('link[data-assets-astral-manager="true"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = STYLE_URL;
  link.dataset.assetsAstralManager = "true";
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
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      const contentType = response.headers.get("content-type") || "Unknown type";
      const preview = text.replace(/\s+/g, " ").trim().slice(0, 160);
      throw new Error(
        `The backend returned unparseable data (HTTP ${response.status}, ${contentType})` +
          (preview ? `: ${preview}` : ""),
      );
    }
  }
  if (!response.ok || payload?.error) {
    const error = new Error(
      payload?.error || `Request failed (HTTP ${response.status})`,
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function queryString(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

function assetMediaUrl(asset, thumbnail = false) {
  const route = thumbnail
    ? "/assets-astral/assets/thumbnail"
    : "/assets-astral/assets/file";
  return `${route}?${queryString({ root: asset.root, path: asset.path })}`;
}

function attachmentKind(attachment) {
  const declared = String(attachment?.kind || "").toLowerCase();
  if (["image", "video", "audio"].includes(declared)) return declared;
  const path = String(attachment?.path || "");
  if (/\.(?:avif|bmp|gif|jpe?g|png|webp)$/i.test(path)) return "image";
  if (/\.(?:avi|flv|m4v|mkv|mov|mp4|mpe?g|webm|wmv)$/i.test(path)) {
    return "video";
  }
  if (/\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav|wma)$/i.test(path)) {
    return "audio";
  }
  return "file";
}

function isImageAttachment(attachment) {
  return attachmentKind(attachment) === "image";
}

function attachmentMentionPattern(kind) {
  return new RegExp(`^${kind}([1-9]\\d{0,2})$`, "i");
}

function normalizedAttachmentMention(attachment) {
  const mention = String(attachment?.mention || "").trim().toLowerCase();
  return attachmentMentionPattern(attachmentKind(attachment)).test(mention)
    ? mention
    : "";
}

function attachmentMentionMap(attachments) {
  const items = Array.isArray(attachments) ? attachments : [];
  const mentions = new Map();
  const maximums = Object.create(null);
  const used = new Set();
  for (const attachment of items) {
    const kind = attachmentKind(attachment);
    const mention = normalizedAttachmentMention(attachment);
    if (!mention || used.has(mention)) continue;
    const number = Number(mention.match(attachmentMentionPattern(kind))[1]);
    maximums[kind] = Math.max(maximums[kind] || 0, number);
    mentions.set(assetSelectionKey(attachment), mention);
    used.add(mention);
  }
  for (const attachment of items) {
    const key = assetSelectionKey(attachment);
    if (mentions.has(key)) continue;
    const kind = attachmentKind(attachment);
    let number = (maximums[kind] || 0) + 1;
    while (used.has(`${kind}${number}`)) number += 1;
    maximums[kind] = number;
    const mention = `${kind}${number}`;
    mentions.set(key, mention);
    used.add(mention);
  }
  return mentions;
}

function ensureAttachmentMentions(attachments) {
  if (!Array.isArray(attachments)) return;
  const mentions = attachmentMentionMap(attachments);
  for (const attachment of attachments) {
    const mention = mentions.get(assetSelectionKey(attachment));
    if (mention && attachment.mention !== mention) {
      attachment.mention = mention;
    }
  }
}

function assetSelectionKey(asset) {
  return JSON.stringify([asset.root, asset.path]);
}

function assetSelectionPayload(items) {
  return items.map((item) => ({ root: item.root, path: item.path }));
}

function loraSelectionKey(item) {
  const rootIndex = Number.isFinite(Number(item?.rootIndex))
    ? Number(item.rootIndex)
    : 0;
  const relativePath = String(
    item?.relativePath || item?.file || item?.path || "",
  );
  return JSON.stringify([rootIndex, relativePath]);
}

function loraSelectionPayload(items) {
  return items.map((item) => ({
    rootIndex: Number(item.rootIndex) || 0,
    relativePath: item.relativePath || item.file || item.path,
  }));
}

function sourceThumbnailUrl(result, source, sourceName = "") {
  const localUrl = String(result?.thumbnailLocalUrl || "").trim();
  if (localUrl.startsWith("/assets-astral/loras/thumbnail?")) {
    return localUrl;
  }
  const labels = {
    civitai: "Civitai",
    huggingface: "Hugging Face",
    modelscope: "ModelScope",
  };
  const topLevelMatches =
    !sourceName ||
    String(result?.thumbnailSource || "").includes(labels[sourceName] || "\u0000");
  const url = source?.thumbnailUrl || (topLevelMatches ? result?.thumbnailUrl : "");
  if (!url) return "";
  return `/assets-astral/thumbnails/proxy?${queryString({ url })}`;
}

async function copyText(value) {
  const text = String(value ?? "");
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Local HTTP and embedded browsers may deny the async clipboard API.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-10000px";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand?.("copy");
  textarea.remove();
  if (!copied) throw new Error("The browser denied clipboard access.");
}

function sourceLink(url, label) {
  const link = createElement("a", "astral-am-source-link", label || url);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = url;
  return link;
}

function createCustomDropdown(className = "") {
  const wrapper = markUntranslated(
    createElement(
      "div",
      `astral-am-dropdown${className ? ` ${className}` : ""}`,
    ),
  );
  const trigger = markUntranslated(
    createElement("button", "astral-am-dropdown-trigger"),
  );
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const label = markUntranslated(
    createElement("span", "astral-am-dropdown-label"),
  );
  const chevron = markUntranslated(
    createElement("span", "astral-am-dropdown-chevron", "⌄"),
  );
  trigger.append(label, chevron);
  const menu = markUntranslated(
    createElement("div", "astral-am-dropdown-menu"),
  );
  menu.hidden = true;
  menu.setAttribute("role", "listbox");
  wrapper.append(trigger, menu);

  let options = [];
  let currentValue = "";
  let changeHandler = null;

  const close = () => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  const updateLabel = () => {
    const selected =
      options.find((option) => option.value === currentValue) ||
      options.find((option) => !option.disabled);
    if (!selected) {
      label.textContent = "No options available";
      return;
    }
    currentValue = selected.value;
    label.textContent = selected.label;
    trigger.title = selected.title || selected.label;
  };
  const renderMenu = () => {
    menu.replaceChildren();
    for (const option of options) {
      const item = markUntranslated(
        createElement(
          "button",
          `astral-am-dropdown-option${option.value === currentValue ? " is-selected" : ""}`,
          option.label,
        ),
      );
      item.type = "button";
      item.disabled = Boolean(option.disabled);
      item.title = option.title || option.label;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.value === currentValue));
      item.addEventListener("click", () => {
        if (item.disabled) return;
        currentValue = option.value;
        updateLabel();
        renderMenu();
        close();
        changeHandler?.(currentValue);
      });
      menu.append(item);
    }
  };

  trigger.addEventListener("click", () => {
    const opening = menu.hidden;
    menu.hidden = !opening;
    trigger.setAttribute("aria-expanded", String(opening));
    if (opening) renderMenu();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!wrapper.contains(event.target)) close();
  });
  wrapper.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  return {
    element: wrapper,
    trigger,
    setOptions(nextOptions, preferredValue = "") {
      options = nextOptions
        .map((option) => ({
          value: String(option.value),
          label: String(option.label ?? option.value),
          title: option.title,
          disabled: Boolean(option.disabled),
        }));
      const nextValue =
        options.find((option) => option.value === preferredValue && !option.disabled) ||
        options.find((option) => option.value === currentValue && !option.disabled) ||
        options.find((option) => !option.disabled);
      currentValue = nextValue?.value || "";
      updateLabel();
      renderMenu();
    },
    get value() {
      return currentValue;
    },
    set value(nextValue) {
      const normalized = String(nextValue ?? "");
      if (options.some((option) => option.value === normalized && !option.disabled)) {
        currentValue = normalized;
        updateLabel();
        renderMenu();
      }
    },
    setDisabled(disabled) {
      trigger.disabled = Boolean(disabled);
    },
    onChange(handler) {
      changeHandler = handler;
    },
  };
}

class AssetBrowser {
  constructor(root) {
    this.root = root;
    this.items = [];
    this.pageItems = [];
    this.selected = new Map();
    this.chatSelectionTarget = null;
    this.offset = 0;
    this.total = 0;
    this.loading = false;
    this.hasMore = false;
    this.operationBusy = false;
    this.selectionLoading = false;
    this.selectionScopeComplete = false;
    this.requestId = 0;
    this.query = "";
    this.kind = "all";
    this.assetRoot = "all";
    this.currentPath = "";
    this.buildMediaManager();
  }

  build() {
    const section = createElement("section", "astral-am-pane astral-am-assets-pane");

    const toolbar = createElement("div", "astral-am-toolbar");
    const search = createElement("input", "astral-am-search");
    search.type = "search";
    search.placeholder = "Search file names or subdirectories";
    search.autocomplete = "off";
    search.setAttribute("aria-label", "Filter assets by keyword");

    const kind = createElement("select", "astral-am-select");
    kind.setAttribute("aria-label", "Asset type");
    for (const [value, label] of [
      ["all", "All Types"],
      ["image", "Image"],
      ["video", "Video"],
    ]) {
      const option = createElement("option", "", label);
      option.value = value;
      kind.append(option);
    }

    const root = createElement("select", "astral-am-select");
    root.setAttribute("aria-label", "Asset directory");
    for (const [value, label] of [
      ["all", "input + output"],
      ["input", "input only"],
      ["output", "output only"],
    ]) {
      const option = createElement("option", "", label);
      option.value = value;
      root.append(option);
    }

    const refresh = createElement("button", "astral-am-button", "Refresh");
    refresh.type = "button";
    toolbar.append(root, kind, search, refresh);

    const directoryNav = createElement("div", "astral-am-directory-nav");
    const breadcrumb = createElement("div", "astral-am-breadcrumb");
    const tree = createElement("div", "astral-am-directory-tree");
    directoryNav.append(breadcrumb, tree);

    const fileActions = createElement("div", "astral-am-file-actions");
    const selectAll = createElement("button", "astral-am-button is-small", "Select All");
    const invertSelection = createElement(
      "button",
      "astral-am-button is-small",
      "Invert",
    );
    const clearSelection = createElement("button", "astral-am-button is-small", "Clear Selection");
    const renameSelected = createElement("button", "astral-am-button is-small", "Rename");
    const renamePrefix = createElement("button", "astral-am-button is-small", "Batch Prefix Rename");
    const deleteSelected = createElement("button", "astral-am-button is-small is-danger", "Delete Selected");
    for (const button of [
      selectAll,
      invertSelection,
      clearSelection,
      renameSelected,
      renamePrefix,
      deleteSelected,
    ]) {
      button.type = "button";
    }
    renameSelected.title = "Rename one selected image or video.";
    renamePrefix.title = "Batch-rename selected images as image1, image2, and so on.";
    deleteSelected.title = "Move selected assets to the Windows Recycle Bin.";
    fileActions.append(
      selectAll,
      invertSelection,
      clearSelection,
      renameSelected,
      renamePrefix,
      deleteSelected,
    );

    const summary = createElement("div", "astral-am-summary");
    const status = createElement("div", "astral-am-status");
    const grid = createElement("div", "astral-am-grid");

    section.append(toolbar, directoryNav, fileActions, summary, status, grid);
    this.element = section;
    this.search = search;
    this.kind = kind;
    this.assetRoot = root;
    this.refreshButton = refresh;
    this.breadcrumb = breadcrumb;
    this.tree = tree;
    this.actionBar = fileActions;
    this.selectAllButton = selectAll;
    this.invertSelectionButton = invertSelection;
    this.clearSelectionButton = clearSelection;
    this.renameButton = renameSelected;
    this.renamePrefixButton = renamePrefix;
    this.deleteButton = deleteSelected;
    this.summary = summary;
    this.status = status;
    this.grid = grid;

    search.addEventListener(
      "input",
      debounce(() => {
        this.query = search.value.trim();
        this.clearSelection();
        void this.load(true);
      }, 250),
    );
    kind.addEventListener("change", () => {
      this.kindFilter = kind.value;
      this.clearSelection();
      void this.load(true);
    });
    root.addEventListener("change", () => {
      this.rootFilter = root.value;
      this.currentPath = "";
      this.clearSelection();
      void this.loadTree();
      void this.load(true);
    });
    refresh.addEventListener("click", () => {
      this.clearSelection();
      void this.reloadPreservingLoadedCount(this.items.length, true);
    });
    selectAll.addEventListener("click", () => this.selectAllItems());
    invertSelection.addEventListener("click", () => this.invertSelection());
    clearSelection.addEventListener("click", () => this.clearSelection());
    renameSelected.addEventListener("click", () => void this.renameSelected());
    renamePrefix.addEventListener("click", () => void this.renameSelectedWithPrefix());
    deleteSelected.addEventListener("click", () => void this.recycleSelected());
    installAutoLoadOnScroll(
      section,
      () => this.hasMore && !this.loading,
      () => void this.load(false),
    );
    this.updateSelectionControls();
  }

  buildMediaManager() {
    const section = createElement(
      "section",
      "astral-am-pane astral-am-assets-pane astral-am-models-pane",
    );
    const toolbar = createElement("div", "astral-am-toolbar");
    const search = createElement("input", "astral-am-search");
    search.type = "search";
    search.placeholder = "Search file names or subdirectories";
    search.autocomplete = "off";
    search.setAttribute("aria-label", "Filter assets by keyword");

    const kind = createCustomDropdown("astral-am-category-dropdown");
    kind.element.setAttribute("aria-label", "Asset type");
    kind.setOptions([
      { value: "all", label: "All Types" },
      { value: "image", label: "Image" },
      { value: "video", label: "Video" },
      { value: "audio", label: "Audio" },
    ]);

    const root = createCustomDropdown("astral-am-category-dropdown");
    root.element.setAttribute("aria-label", "Asset directory");
    root.setOptions([
      { value: "all", label: "input + output" },
      { value: "input", label: "input" },
      { value: "output", label: "output" },
    ]);

    const refresh = createElement("button", "astral-am-button", "Refresh");
    refresh.type = "button";
    toolbar.append(root.element, kind.element, search, refresh);

    const location = markUntranslated(
      createElement("div", "astral-am-model-location"),
    );
    const browser = createElement("div", "astral-am-model-browser");
    const tree = markUntranslated(
      createElement("aside", "astral-am-model-tree"),
    );
    const content = createElement("div", "astral-am-model-content");

    const fileActions = createElement("div", "astral-am-file-actions");
    const selectAll = createElement("button", "astral-am-button is-small", "Select All");
    const invertSelection = createElement(
      "button",
      "astral-am-button is-small",
      "Invert",
    );
    const clearSelection = createElement("button", "astral-am-button is-small", "Clear Selection");
    const renameSelected = createElement("button", "astral-am-button is-small", "Rename");
    const renamePrefix = createElement("button", "astral-am-button is-small", "Batch Prefix Rename");
    const addToChat = createElement("button", "astral-am-button is-small", "Add to Chat");
    const deleteSelected = createElement(
      "button",
      "astral-am-button is-small is-danger",
      "Delete Selected",
    );
    for (const button of [
      selectAll,
      invertSelection,
      clearSelection,
      renameSelected,
      renamePrefix,
      addToChat,
      deleteSelected,
    ]) {
      button.type = "button";
    }
    renameSelected.title = "Rename one selected image, video, or audio file.";
    renamePrefix.title = "Batch-rename selected images as image1, image2, and so on.";
    addToChat.title = "Append selected assets to the current API chat.";
    deleteSelected.title = "Move selected assets to the Windows Recycle Bin.";
    fileActions.append(
      selectAll,
      invertSelection,
      clearSelection,
      renameSelected,
      renamePrefix,
      addToChat,
      deleteSelected,
    );

    const summary = createElement("div", "astral-am-summary");
    const status = createElement("div", "astral-am-status");
    const grid = createElement("div", "astral-am-grid");
    const locationHeader = createElement("div", "astral-am-model-header");
    locationHeader.append(location, fileActions);
    content.append(summary, status, grid);
    browser.append(tree, content);
    section.append(toolbar, locationHeader, browser);

    this.element = section;
    this.search = search;
    this.kind = kind;
    this.assetRoot = root;
    this.refreshButton = refresh;
    this.breadcrumb = location;
    this.tree = tree;
    this.browser = browser;
    this.content = content;
    this.actionBar = fileActions;
    this.selectAllButton = selectAll;
    this.invertSelectionButton = invertSelection;
    this.clearSelectionButton = clearSelection;
    this.renameButton = renameSelected;
    this.renamePrefixButton = renamePrefix;
    this.addToChatButton = addToChat;
    this.deleteButton = deleteSelected;
    this.summary = summary;
    this.status = status;
    this.grid = grid;

    search.addEventListener(
      "input",
      debounce(() => {
        this.query = search.value.trim();
        this.clearSelection();
        void this.load(true);
      }, 250),
    );
    kind.onChange(() => {
      this.clearSelection();
      void this.load(true);
    });
    root.onChange(() => {
      this.currentPath = "";
      this.clearSelection();
      void this.loadTree();
      void this.load(true);
    });
    refresh.addEventListener("click", () => {
      this.clearSelection();
      void this.reloadPreservingLoadedCount(this.items.length, true);
    });
    selectAll.addEventListener("click", () => this.selectAllItems());
    invertSelection.addEventListener("click", () => this.invertSelection());
    clearSelection.addEventListener("click", () => this.clearSelection());
    renameSelected.addEventListener("click", () => void this.renameSelected());
    renamePrefix.addEventListener("click", () => void this.renameSelectedWithPrefix());
    addToChat.addEventListener("click", () => void this.addSelectedToChat());
    deleteSelected.addEventListener("click", () => void this.recycleSelected());
    installAutoLoadOnScroll(
      grid,
      () => this.hasMore && !this.loading,
      () => void this.load(false),
    );
    this.updateSelectionControls();
  }

  setStatus(message, kind = "") {
    updateStatusPreservingScroll(
      this.status,
      message,
      kind,
      this.grid,
      "data-asset-key",
    );
  }

  selectedItems() {
    return [...this.selected.values()];
  }

  beginChatSelection(promptBrowser) {
    this.chatSelectionTarget = promptBrowser || this.root.promptBrowser;
    this.clearSelection();
    this.setStatus(
      `Select assets to add to the current API chat, up to ${this.chatSelectionTarget.chatComposerAttachmentLimit}.`,
    );
  }

  async addSelectedToChat() {
    const items = this.selectedItems();
    if (!items.length) {
      this.setStatus("Select assets to add to chat first.", "warning");
      return;
    }
    await this.addItemsToChat(items);
  }

  async addItemsToChat(items) {
    const promptBrowser = this.chatSelectionTarget || this.root.promptBrowser;
    const result = await promptBrowser.addChatAttachments(items);
    if (!result?.ok) {
      if (Array.isArray(result?.retainedItems) && result.retainedItems.length) {
        this.setSelectedItems(result.retainedItems);
      }
      this.setStatus(result?.message || "Failed to add to chat.", "warning");
      if (result?.message) promptBrowser.setChatStatus(result.message, "warning");
      return;
    }
    const retainedItems = Array.isArray(result.retainedItems)
      ? result.retainedItems
      : [];
    this.setSelectedItems(retainedItems);
    this.setStatus(
      result.message,
      retainedItems.length ? "warning" : "success",
    );
    if (retainedItems.length) {
      promptBrowser.setChatStatus(result.message, "warning");
    }
    this.root.showTab("prompts");
    promptBrowser.setMode("chat");
    promptBrowser.chatInput.focus();
  }

  updateSelectionControls() {
    const selected = this.selectedItems();
    const count = selected.length;
    const promptBrowser = this.chatSelectionTarget || this.root.promptBrowser;
    const chatAttachmentLimit =
      promptBrowser?.chatComposerAttachmentLimit || MAX_CHAT_ATTACHMENTS;
    const allSelected =
      this.total > 0 &&
      this.selectionScopeComplete &&
      selected.length >= this.total;
    const imageOnly = count > 0 && selected.every((item) => item.kind === "image");
    const busy =
      this.operationBusy ||
      this.loading ||
      this.selectionLoading;
    this.selectAllButton.disabled = busy || !this.total || allSelected;
    this.invertSelectionButton.disabled = busy || !this.total;
    this.clearSelectionButton.disabled = busy || !count;
    this.renameButton.disabled = busy || count !== 1;
    this.renamePrefixButton.disabled = busy || !imageOnly;
    this.addToChatButton.disabled = busy || !count;
    this.deleteButton.disabled = busy || !count;
    this.selectAllButton.textContent = this.selectionLoading
      ? "Selecting all..."
      : allSelected
        ? `All Selected (${this.total})`
        : this.total
          ? `Select All (${this.total})`
          : "Select All";
    this.addToChatButton.textContent = count
      ? count > chatAttachmentLimit
        ? `Add to Chat (first ${chatAttachmentLimit}/${count})`
        : `Add to Chat (${count})`
      : "Add to Chat";
    this.deleteButton.textContent = count ? `Delete Selected (${count})` : "Delete Selected";
    if (this.total) {
      this.summary.textContent =
        `${this.total} assets total, showing ${this.items.length}` +
        (count ? ` · ${count} selected` : "");
    }
    this.actionBar.dataset.selectedCount = String(count);
  }

  setCardSelected(item, selected) {
    const key = assetSelectionKey(item);
    if (selected) this.selected.set(key, item);
    else this.selected.delete(key);
    for (const card of this.grid.querySelectorAll("[data-asset-key]")) {
      if (card.dataset.assetKey !== key) continue;
      card.classList.toggle("is-selected", selected);
      const checkbox = card.querySelector('input[type="checkbox"]');
      if (checkbox) checkbox.checked = selected;
    }
    this.updateSelectionControls();
  }

  setSelectedItems(items) {
    this.selected.clear();
    for (const item of Array.isArray(items) ? items : []) {
      if (item?.root && item?.path) {
        this.selected.set(assetSelectionKey(item), item);
      }
    }
    this.selectionScopeComplete = false;
    this.syncSelectionCards();
  }

  clearSelection() {
    this.selected.clear();
    this.syncSelectionCards();
  }

  syncSelectionCards() {
    for (const card of this.grid.querySelectorAll("[data-asset-key]")) {
      const selected = this.selected.has(card.dataset.assetKey);
      card.classList.toggle("is-selected", selected);
      const checkbox = card.querySelector('input[type="checkbox"]');
      if (checkbox) checkbox.checked = selected;
    }
    this.updateSelectionControls();
  }

  selectAllItems() {
    return this.selectCompleteScope(false);
  }

  invertSelection() {
    return this.selectCompleteScope(true);
  }

  selectionScopeSignature() {
    return JSON.stringify([
      this.assetRoot.value,
      this.kind.value,
      this.currentPath,
      this.search.value.trim(),
    ]);
  }

  async fetchSelectionScope() {
    const signature = this.selectionScopeSignature();
    const collected = [];
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const payload = await fetchJson(
        `/assets-astral/assets?${queryString({
          root: this.assetRoot.value,
          kind: this.kind.value,
          path: this.currentPath,
          exact: 1,
          q: this.search.value.trim(),
          offset,
          limit: 500,
        })}`,
      );
      if (signature !== this.selectionScopeSignature()) return null;
      const page = Array.isArray(payload?.items) ? payload.items : [];
      collected.push(...page);
      offset += page.length;
      hasMore = Boolean(payload?.hasMore) && page.length > 0;
    }
    return collected;
  }

  async selectCompleteScope(invert) {
    if (
      this.operationBusy ||
      this.loading ||
      this.selectionLoading ||
      this.total <= 0
    ) {
      return;
    }
    this.selectionLoading = true;
    this.updateSelectionControls();
    this.setStatus(
      invert
        ? "Loading every asset in the current path and inverting selection..."
        : "Loading every asset in the current path...",
      "loading",
    );
    try {
      const items = await this.fetchSelectionScope();
      if (!items) return;
      const previous = new Set(this.selected.keys());
      this.selected.clear();
      for (const item of items) {
        const key = assetSelectionKey(item);
        if (!invert || !previous.has(key)) this.selected.set(key, item);
      }
      this.selectionScopeComplete = true;
      this.syncSelectionCards();
      this.setStatus(
        invert
          ? `Inverted selection, ${this.selected.size} assets selected.`
          : `Selected all ${this.selected.size} assets in the current path, including files not yet loaded.`,
        "success",
      );
    } catch (error) {
      this.setStatus(
        `${invert ? "Invert" : "Select All"} failed: ${error.message || error}`,
        "error",
      );
    } finally {
      this.selectionLoading = false;
      this.updateSelectionControls();
    }
  }

  async openLocation(root, path = "", select = false) {
    try {
      const endpointRoot = root || "input";
      const result = await fetchJson("/assets-astral/assets/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root: endpointRoot,
          path,
          select: Boolean(select && path),
        }),
      });
      this.setStatus(
        select && path && result?.revealMode === "selected"
          ? `Revealed in system file manager: ${root}/${path}`
          : select && path
            ? `Opened containing folder: ${result?.absolutePath || `${endpointRoot}/${path}`}`
            : `Opened system file manager: ${result?.absolutePath || `${endpointRoot}/${path}`}`,
        "success",
      );
    } catch (error) {
      this.setStatus(`Failed to open system file manager: ${error.message || error}`, "error");
    }
  }

  async reloadPreservingLoadedCount(targetCount, preserveScroll = false) {
    const desiredCount = Math.max(
      ASSET_PAGE_SIZE,
      Number(targetCount) || 0,
    );
    await Promise.all([
      this.loadTree(),
      this.load(true, preserveScroll),
    ]);
    while (this.items.length < desiredCount && this.hasMore) {
      const previousCount = this.items.length;
      await this.load(false);
      if (this.items.length === previousCount) break;
    }
  }

  async runAssetOperation(label, endpoint, payload) {
    if (this.operationBusy) return;
    const loadedCount = this.items.length;
    this.operationBusy = true;
    this.updateSelectionControls();
    this.setStatus(`${label} in progress...`, "loading");
    try {
      const result = await fetchJson(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      this.selected.clear();
      await this.reloadPreservingLoadedCount(loadedCount, true);
      this.setStatus(`${label} complete, processed ${Number(result?.count) || 0} assets.`, "success");
    } catch (error) {
      this.setStatus(`${label} failed: ${error.message || error}`, "error");
    } finally {
      this.operationBusy = false;
      this.updateSelectionControls();
    }
  }

  async renameSelected() {
    const items = this.selectedItems();
    if (items.length !== 1 || this.operationBusy) return;
    const item = items[0];
    const newName = await showAstralPrompt({
      title: "Rename Asset",
      message: `Enter a new file name for "${item.name}". If you omit the extension, the original extension will be kept.`,
      label: "New file name",
      initialValue: item.name,
      confirmLabel: "Rename",
    });
    if (newName === null || !newName.trim() || newName.trim() === item.name) return;
    await this.runAssetOperation("Rename", "/assets-astral/assets/rename", {
      mode: "single",
      items: assetSelectionPayload(items),
      newName: newName.trim(),
    });
  }

  async renameItem(item) {
    if (this.operationBusy) return;
    const newName = await showAstralPrompt({
      title: "Rename Asset",
      message: `Enter a new file name for "${item.name}". If you omit the extension, the original extension will be kept.`,
      label: "New file name",
      initialValue: item.name,
      confirmLabel: "Rename",
    });
    if (newName === null || !newName.trim() || newName.trim() === item.name) return;
    await this.runAssetOperation("Rename", "/assets-astral/assets/rename", {
      mode: "single",
      items: assetSelectionPayload([item]),
      newName: newName.trim(),
    });
  }

  async renameSelectedWithPrefix() {
    const items = this.selectedItems();
    if (!items.length || this.operationBusy) return;
    if (!items.every((item) => item.kind === "image")) {
      this.setStatus("Batch prefix rename currently supports selected images only.", "warning");
      return;
    }
    const prefix = await showAstralPrompt({
      title: "Batch Rename by Prefix",
      message: "Files will be generated as image1, image2, and so on in selection order.",
      label: "File name prefix",
      initialValue: "image",
      confirmLabel: "Start Rename",
    });
    if (prefix === null || !prefix.trim()) return;
    await this.runAssetOperation("Batch rename by prefix", "/assets-astral/assets/rename", {
      mode: "prefix",
      items: assetSelectionPayload(items),
      prefix: prefix.trim(),
      start: 1,
    });
  }

  async recycleSelected() {
    const items = this.selectedItems();
    if (!items.length || this.operationBusy) return;
    const confirmed = await showAstralConfirm({
      title: "Move to Recycle Bin",
      message:
        `Move the selected ${items.length} assets to the Windows Recycle Bin?\n\n` +
        "This removes files from input/output after confirmation.",
      confirmLabel: "Move to Recycle Bin",
    });
    if (!confirmed) return;
    const loadedCount = this.items.length;
    let processed = 0;
    this.operationBusy = true;
    this.updateSelectionControls();
    this.setStatus(`Moving ${items.length} assets to the Recycle Bin...`, "loading");
    try {
      for (
        let index = 0;
        index < items.length;
        index += ASSET_OPERATION_CHUNK_SIZE
      ) {
        const chunk = items.slice(
          index,
          index + ASSET_OPERATION_CHUNK_SIZE,
        );
        const result = await fetchJson("/assets-astral/assets/recycle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: assetSelectionPayload(chunk),
            confirm: true,
          }),
        });
        processed += Number(result?.count) || chunk.length;
        this.setStatus(
          `Moving to Recycle Bin: ${processed}/${items.length}`,
          "loading",
        );
      }
      this.selected.clear();
      await this.reloadPreservingLoadedCount(loadedCount, true);
      this.setStatus(
        `Deletion complete, moved ${processed} assets to the Windows Recycle Bin.`,
        "success",
      );
    } catch (error) {
      this.selected.clear();
      try {
        await this.reloadPreservingLoadedCount(loadedCount, true);
      } catch {
        // Keep the original backend error visible.
      }
      this.setStatus(`Delete failed: ${error.message || error}`, "error");
    } finally {
      this.operationBusy = false;
      this.updateSelectionControls();
    }
  }

  async load(reset, preserveScroll = false) {
    // A filter change must be able to supersede an in-flight request.
    if (this.loading && !reset) return;
    const scrollState =
      !reset || preserveScroll
        ? captureScrollState(this.grid, "data-asset-key")
        : null;
    this.loading = true;
    this.requestId += 1;
    const requestId = this.requestId;
    if (reset) {
      this.offset = 0;
      this.items = [];
      this.pageItems = [];
      this.hasMore = false;
      this.selectionScopeComplete = false;
      if (!scrollState) this.grid.replaceChildren();
    }
    this.refreshButton.disabled = true;
    this.setStatus(reset ? "Loading assets..." : "Loading more assets...", "loading");

    try {
      const payload = await fetchJson(
        `/assets-astral/assets?${queryString({
          root: this.assetRoot.value,
          kind: this.kind.value,
          path: this.currentPath,
          exact: 1,
          q: this.search.value.trim(),
          offset: this.offset,
          limit: ASSET_PAGE_SIZE,
        })}`,
      );
      if (requestId !== this.requestId) return;
      const page = Array.isArray(payload?.items) ? payload.items : [];
      this.items.push(...page);
      this.pageItems = page;
      this.offset += page.length;
      this.total = Number(payload?.total) || 0;
      this.hasMore = Boolean(payload?.hasMore);
      if (!this.hasMore) this.selectionScopeComplete = true;
      const fragment = document.createDocumentFragment();
      for (const item of page) fragment.append(this.createCard(item));
      if (reset) {
        if (scrollState) {
          replaceChildrenPreservingScroll(
            this.grid,
            fragment,
            "data-asset-key",
            scrollState,
          );
        } else {
          this.grid.replaceChildren(fragment);
        }
      } else {
        appendChildrenPreservingScroll(
          this.grid,
          fragment,
          "data-asset-key",
          scrollState,
        );
      }
      this.updateSelectionControls();
      this.setStatus(
        page.length ? "" : this.items.length ? "No more assets" : "No matching assets found",
        page.length ? "" : "empty",
      );
    } catch (error) {
      if (requestId === this.requestId) {
        this.setStatus(`Read failed: ${error.message || error}`, "error");
      }
    } finally {
      if (requestId === this.requestId) {
        this.loading = false;
        this.refreshButton.disabled = false;
        this.updateSelectionControls();
      }
    }
  }

  async loadTree() {
    const selectedRoot = this.assetRoot.value;
    const roots = selectedRoot === "all" ? ["input", "output"] : [selectedRoot];
    this.tree.replaceChildren(createElement("span", "astral-am-muted", "Loading folders..."));
    try {
      const payloads = await Promise.all(
        roots.map((root) =>
          fetchJson(
            `/assets-astral/assets/tree?${queryString({
              root,
              path: selectedRoot === "all" ? "" : this.currentPath,
            })}`,
          ).then((payload) => ({ root, payload })),
        ),
      );
      this.renderTree(payloads);
    } catch (error) {
      this.tree.replaceChildren(
        createElement("span", "astral-am-source-error", `Failed to read directory: ${error.message || error}`),
      );
    }
  }

  navigate(root, path = "") {
    this.assetRoot.value = root;
    this.currentPath = path;
    this.clearSelection();
    void this.loadTree();
    void this.load(true);
  }

  renderTree(payloads) {
    const fragment = document.createDocumentFragment();
    const crumbs = createElement("div", "astral-am-breadcrumb-items");
    const allRoot = this.assetRoot.value === "all";
    const currentParts =
      !allRoot && this.currentPath ? this.currentPath.split("/") : [];
    if (allRoot) {
      crumbs.append(createElement("span", "astral-am-breadcrumb-current", "input + output"));
    } else {
      const rootButton = createElement("button", "astral-am-crumb", this.assetRoot.value);
      rootButton.type = "button";
      rootButton.addEventListener("click", () => this.navigate(this.assetRoot.value, ""));
      crumbs.append(rootButton);
      currentParts.forEach((part, index) => {
        crumbs.append(createElement("span", "astral-am-crumb-separator", "/"));
        const path = currentParts.slice(0, index + 1).join("/");
        const button = createElement("button", "astral-am-crumb", part);
        button.type = "button";
        button.addEventListener("click", () => this.navigate(this.assetRoot.value, path));
        crumbs.append(button);
      });
    }
    let locationLine = null;
    if (allRoot) {
      locationLine = createElement(
        "span",
        "astral-am-location-path",
        "Browsing all input and output subdirectories",
      );
    } else if (!currentParts.length) {
      locationLine = createElement(
        "span",
        "astral-am-location-path",
        `Current directory: ${this.assetRoot.value} / (root)`,
      );
    }
    this.breadcrumb.replaceChildren(crumbs);
    if (locationLine) this.breadcrumb.append(locationLine);

    for (const { root, payload } of payloads) {
      const group = createElement("section", "astral-am-tree-root");
      const rootRow = createElement("div", "astral-am-tree-row");
      const treePath = this.assetRoot.value === root ? this.currentPath : "";
      const treeLabel =
        treePath && currentParts.length
          ? currentParts[currentParts.length - 1]
          : root.toUpperCase();
      const treeLocation = treePath ? `${root}/${treePath}` : root;
      const rootHeader = createElement(
        "button",
        "astral-am-tree-root-button",
        treeLabel,
      );
      rootHeader.type = "button";
      rootHeader.title = treeLocation;
      rootHeader.classList.toggle(
        "is-current",
        this.assetRoot.value === root,
      );
      rootHeader.addEventListener("click", () => this.navigate(root, treePath));
      const openRoot = createElement("button", "astral-am-tree-open", "📁");
      openRoot.type = "button";
    openRoot.title = `Open ${treeLocation} in system file manager`;
      openRoot.addEventListener(
        "click",
        () => void this.openLocation(root, treePath, false),
      );
      rootRow.append(rootHeader, openRoot);
      group.append(rootRow);
      const directories = Array.isArray(payload?.directories) ? payload.directories : [];
      if (!directories.length) {
        group.append(createElement("span", "astral-am-muted astral-am-tree-empty", "No subdirectories"));
      } else {
        const list = createElement("div", "astral-am-tree-children");
        for (const directory of directories) {
          const row = createElement("div", "astral-am-tree-row");
          const button = createElement("button", "astral-am-tree-item", `▸ ${directory.name}`);
          button.type = "button";
          button.title = `${root}/${directory.path}`;
          button.classList.toggle(
            "is-current",
            this.assetRoot.value === root && this.currentPath === directory.path,
          );
          button.addEventListener("click", () => this.navigate(root, directory.path));
          const openDirectory = createElement("button", "astral-am-tree-open", "📁");
          openDirectory.type = "button";
    openDirectory.title = `Open ${root}/${directory.path} in system file manager`;
          openDirectory.addEventListener(
            "click",
            () => void this.openLocation(root, directory.path, false),
          );
          row.append(button, openDirectory);
          list.append(row);
        }
        group.append(list);
      }
      fragment.append(group);
    }
    this.tree.replaceChildren(fragment);
  }

  createCard(item) {
    const key = assetSelectionKey(item);
    const selected = this.selected.has(key);
    const card = createElement("article", "astral-am-card");
    card.dataset.assetKey = key;
    card.classList.toggle("is-selected", selected);
    card.title = `${item.root}/${item.path}`;

    const preview = createElement("button", "astral-am-card-main");
    preview.type = "button";
    preview.title = "Click to preview";

    const media = createElement("div", "astral-am-card-media");
    if (item.kind === "audio") {
      const audioIcon = createElement("div", "astral-am-audio-card-icon");
      audioIcon.append(
        createElement("span", "", "♫"),
        createElement("strong", "", item.name),
      );
      media.append(audioIcon);
    } else {
      const image = createElement("img");
      image.loading = "lazy";
      image.decoding = "async";
      image.alt = item.name || item.path;
      image.src = assetMediaUrl(item, true);
      image.addEventListener("error", () => {
        if (image.dataset.fallback === "true") {
          image.hidden = true;
          return;
        }
        image.dataset.fallback = "true";
        image.src = assetMediaUrl(item, false);
      });
      media.append(image);
    }

    if (item.kind === "video") {
      const play = createElement("span", "astral-am-play", "▶");
      media.append(play);
    }
    const kindLabels = { image: "Image", video: "Video", audio: "Audio" };
    const badges = createElement("div", "astral-am-card-badges");
    badges.append(
      createElement("span", "astral-am-badge", item.root.toUpperCase()),
      createElement("span", "astral-am-badge is-kind", kindLabels[item.kind] || item.kind),
    );
    media.append(badges);

    const body = createElement("div", "astral-am-card-body");
    const title = createElement("strong", "astral-am-card-title", item.name);
    const path = createElement("span", "astral-am-card-path", item.path);
    const meta = createElement(
      "span",
      "astral-am-card-meta",
      [formatBytes(item.size), formatDate(item.modified)].filter(Boolean).join(" · "),
    );
    body.append(title, path, meta);
    preview.append(media, body);
    preview.addEventListener("click", () => {
      this.root.viewer.open(item);
    });

    const selection = createElement("label", "astral-am-card-select");
    selection.title = "Select assets to add them to chat, delete them, or batch-rename by prefix.";
    const checkbox = createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected;
    checkbox.setAttribute("aria-label", `Select ${item.name}`);
    checkbox.addEventListener("change", () => {
      this.setCardSelected(item, checkbox.checked);
    });
    selection.append(checkbox);

    const actions = createElement("div", "astral-am-card-actions");
    const copyMedia = createElement(
      "button",
      "astral-am-card-action",
      item.kind === "video" ? "Copy Video" : "Copy Image",
    );
    copyMedia.type = "button";
    copyMedia.title =
      item.kind === "video" ? "Copy this video to the system clipboard." : "Copy this image to the system clipboard.";
    copyMedia.addEventListener(
      "click",
      () =>
        void this.root.viewer.copyMedia(item, copyMedia, (message, kind) => {
          this.setStatus(message, kind);
        }),
    );
    const insertNode = createElement("button", "astral-am-card-action", "Add to Canvas");
    insertNode.type = "button";
    insertNode.title = "Add to the current canvas using the official loader node.";
    insertNode.addEventListener("click", () => {
      this.root.viewer.insertLoader(item, (message, kind) => {
        this.setStatus(message, kind);
      });
    });
    const addToChat = createElement("button", "astral-am-card-action", "Add to Chat");
    addToChat.type = "button";
    addToChat.title = "Append this asset to the current API chat.";
    addToChat.addEventListener(
      "click",
      () => void this.addItemsToChat([item]),
    );

    if (item.kind === "image" || item.kind === "video") {
      actions.append(copyMedia);
    }
    actions.append(insertNode, addToChat);

    card.append(preview, selection, actions);
    return card;
  }
}

class LegacyPromptBrowser {
  constructor(root) {
    this.root = root;
    this.items = [];
    this.offset = 0;
    this.total = 0;
    this.loading = false;
    this.hasMore = false;
    this.requestId = 0;
    this.build();
  }

  build() {
    const section = createElement("section", "astral-am-pane astral-am-prompts-pane");
    const toolbar = createElement("div", "astral-am-toolbar");
    const search = createElement("input", "astral-am-search");
    search.type = "search";
    search.placeholder = "Search prompts or asset paths";
    search.autocomplete = "off";
    search.setAttribute("aria-label", "Search prompts");

    const root = createElement("select", "astral-am-select");
    root.setAttribute("aria-label", "Prompt asset directory");
    for (const [value, label] of [
      ["all", "input + output"],
      ["input", "input only"],
      ["output", "output only"],
    ]) {
      const option = createElement("option", "", label);
      option.value = value;
      root.append(option);
    }

    const refresh = createElement("button", "astral-am-button", "Refresh");
    refresh.type = "button";
    toolbar.append(search, root, refresh);

    const note = createElement(
      "p",
      "astral-am-note",
      "Extract prompts from embedded image/video metadata, workflows, and matching JSON files. Preview opens in the existing media viewer.",
    );
    const summary = createElement("div", "astral-am-summary");
    const status = createElement("div", "astral-am-status");
    const list = createElement("div", "astral-am-prompt-list");
    section.append(toolbar, note, summary, status, list);

    this.element = section;
    this.search = search;
    this.rootFilter = root;
    this.refreshButton = refresh;
    this.summary = summary;
    this.status = status;
    this.list = list;

    search.addEventListener(
      "input",
      debounce(() => void this.load(true), 300),
    );
    root.addEventListener("change", () => void this.load(true));
    refresh.addEventListener("click", () => void this.load(true, true));
    installAutoLoadOnScroll(
      section,
      () => this.hasMore && !this.loading,
      () => void this.load(false),
    );
  }

  setStatus(message, kind = "") {
    updateStatusPreservingScroll(
      this.status,
      message,
      kind,
      this.element,
    );
  }

  async load(reset, preserveScroll = false) {
    if (this.loading && !reset) return;
    const scrollState =
      !reset || preserveScroll
        ? captureScrollState(this.list, "data-prompt-key")
        : null;
    this.loading = true;
    this.requestId += 1;
    const requestId = this.requestId;
    if (reset) {
      this.offset = 0;
      this.items = [];
      this.hasMore = false;
      if (!scrollState) this.list.replaceChildren();
    }
    this.refreshButton.disabled = true;
    this.setStatus(reset ? "Scanning asset prompts..." : "Loading more prompts...", "loading");
    try {
      const payload = await fetchJson(
        `/assets-astral/prompts?${queryString({
          root: this.rootFilter.value,
          q: this.search.value.trim(),
          offset: this.offset,
          limit: PROMPT_PAGE_SIZE,
        })}`,
      );
      if (requestId !== this.requestId) return;
      const page = Array.isArray(payload?.items) ? payload.items : [];
      this.items.push(...page);
      this.offset += page.length;
      this.total = Number(payload?.total) || 0;
      this.hasMore = Boolean(payload?.hasMore);
      const fragment = document.createDocumentFragment();
      for (const entry of page) fragment.append(this.createCard(entry));
      if (reset) {
        if (scrollState) {
          replaceChildrenPreservingScroll(
            this.list,
            fragment,
            "data-prompt-key",
            scrollState,
          );
        } else {
          this.list.replaceChildren(fragment);
        }
      } else {
        appendChildrenPreservingScroll(
          this.list,
          fragment,
          "data-prompt-key",
          scrollState,
        );
      }
      this.summary.textContent =
        `${this.total} prompts total, showing ${this.items.length}` +
        (payload?.scannedAssets ? ` · scanned ${payload.scannedAssets} assets` : "");
      this.setStatus(
        page.length ? "" : this.items.length ? "No more prompts" : "No matching prompts found",
        page.length ? "" : "empty",
      );
    } catch (error) {
      if (requestId === this.requestId) {
        this.setStatus(`Read failed: ${error.message || error}`, "error");
      }
    } finally {
      if (requestId === this.requestId) {
        this.loading = false;
        this.refreshButton.disabled = false;
      }
    }
  }

  createCard(entry) {
    const card = createElement("article", "astral-am-prompt-card");
    card.dataset.promptKey = `${entry.asset.root}:${entry.asset.path}`;
    const header = createElement("div", "astral-am-prompt-header");
    const heading = createElement("div", "astral-am-prompt-heading");
    heading.append(
      createElement("span", "astral-am-badge", entry.asset.root.toUpperCase()),
      createElement("strong", "", entry.asset.name),
    );
    const modified = createElement("span", "astral-am-muted", formatDate(entry.asset.modified));
    header.append(heading, modified);

    const prompt = createElement("pre", "astral-am-prompt-card-text", entry.prompt);
    const footer = createElement("div", "astral-am-prompt-footer");
    footer.append(createElement("span", "astral-am-prompt-source", entry.asset.path));

    const actions = createElement("div", "astral-am-prompt-actions");
    const copy = createElement("button", "astral-am-button is-small", "Copy Prompt");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        await copyText(entry.prompt);
        copy.textContent = "Copied";
        window.setTimeout(() => {
          copy.textContent = "Copy Prompt";
        }, 1200);
      } catch (error) {
        this.setStatus(`Copy failed: ${error.message || error}`, "error");
      }
    });
    const preview = createElement("button", "astral-am-button is-small", "Preview Asset");
    preview.type = "button";
    preview.addEventListener("click", () => this.root.viewer.open(entry.asset));
    actions.append(copy, preview);
    footer.append(actions);
    card.append(header, prompt, footer);
    return card;
  }
}

const PROMPT_CATEGORY_OPTIONS = [
  { value: "text", label: "Text" },
  { value: "image", label: "Image" },
  { value: "audio", label: "Audio" },
  { value: "video", label: "Video" },
  { value: "expand", label: "Expand Prompt" },
  { value: "invert", label: "Image Inversion" },
];

const API_TASK_DEFINITIONS = [
  {
    id: "text",
    label: "Text-only Mode",
    hint: "Translation, prompt expansion, and refinement",
    legacyIds: ["optimize", "translate"],
    legacyWriteIds: ["optimize", "translate"],
  },
  {
    id: "image",
    label: "Image Mode",
    hint: "Reverse-engineer prompts from images",
    legacyIds: ["invert"],
    legacyWriteIds: ["invert"],
  },
  {
    id: "multimodal",
    label: "Multimodal Mode",
    hint: "Image, video, and audio understanding",
    legacyIds: ["chat"],
    legacyWriteIds: ["chat"],
  },
];
const LOCAL_CHAT_MODE_DEFINITION = Object.freeze({
  id: "local",
  label: "Local Mode",
  hint: "Use GGUF models in ComfyUI/models/LLM",
});
const CHAT_MODE_DEFINITIONS = [
  ...API_TASK_DEFINITIONS,
  LOCAL_CHAT_MODE_DEFINITION,
];
const TRANSLATION_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh", label: "Simplified Chinese" },
  { value: "ja", label: "Japanese (日本語)" },
  { value: "ko", label: "Korean (한국어)" },
  { value: "fr", label: "French (Français)" },
  { value: "de", label: "German (Deutsch)" },
  { value: "es", label: "Spanish (Español)" },
  { value: "ru", label: "Russian (Русский)" },
  { value: "pt", label: "Portuguese (Português)" },
  { value: "it", label: "Italian (Italiano)" },
  { value: "ar", label: "Arabic (العربية)" },
];
const DEFAULT_LOCAL_LLM_CONFIG = Object.freeze({
  modelPath: "",
  visionModelPath: "",
  nCtx: 8192,
  nBatch: 2048,
  nUbatch: 512,
  maxTokens: 1024,
  maxRounds: 12,
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  minP: 0.05,
  repeatPenalty: 1.1,
  frequencyPenalty: 0.0,
  presencePenalty: 0.0,
  gpuLayers: -1,
  threads: 0,
  seed: 42,
  maxImageEdge: 1024,
  imageJpegQuality: 90,
  flashAttention: "auto",
  kvCacheTypeK: "default",
  kvCacheTypeV: "default",
  enableThinking: false,
  preserveThinking: false,
  reasoningEffort: "xhigh",
  useMmap: true,
  contextCheckpoints: 0,
});
const DEFAULT_API_RUNTIME_SETTINGS = Object.freeze({
  temperature: 0.7,
  topP: 0.95,
  maxTokens: 2048,
  maxRounds: 12,
  frequencyPenalty: 0.0,
  presencePenalty: 0.0,
  seed: null,
  stop: [],
  responseFormat: "default",
  reasoningEffort: "default",
  sourceLanguage: "auto",
  targetLanguage: "zh",
  systemPrompt: "You are a rigorous and helpful AI assistant.",
});

const LOCAL_LLM_PARAMETER_HINTS = Object.freeze({
  nCtx: "Maximum context tokens the model can process at once. Larger values use more memory or VRAM.",
  nBatch: "Prompt batch size. Increasing it usually improves throughput but uses more memory.",
  nUbatch: "Micro-batch size, affecting inference speed and VRAM usage. Usually best left at the default.",
  maxTokens: "Maximum tokens generated per reply, excluding input tokens.",
  maxRounds: "Number of history rounds included when sending multi-turn chats; Prompt Processor sends no history.",
  temperature: "Controls randomness. Lower values are more stable; higher values are more creative and varied.",
  topP: "Nucleus sampling threshold. Usually adjust only one of Temperature or Top P; 0.9–0.95 is common.",
  topK: "Sample each step only from the K most probable candidate tokens.",
  minP: "Filters out tokens whose probability is below the given fraction of the top candidate, reducing low-probability noise.",
  repeatPenalty: "Reduces the chance of recently seen tokens repeating.",
  frequencyPenalty: "Penalizes tokens by how often they appear, reducing repeated wording.",
  presencePenalty: "Penalizes any token that has already appeared, encouraging the model to introduce new content.",
  gpuLayers: "-1 offloads as many layers as possible to the GPU; 0 uses CPU only.",
  threads: "Number of CPU inference threads. 0 lets the inference library choose automatically.",
  seed: "Local sampling seed. A fixed value is reproducible; changing it produces different results.",
  maxImageEdge: "Longest edge in pixels before an image is sent to the model. Smaller is faster and uses less memory.",
  imageJpegQuality: "Quality when converting images to JPEG. Higher is clearer but makes requests larger.",
  contextCheckpoints: "Number of llama.cpp context checkpoints for reusing long contexts; 0 disables.",
  flashAttention: "Attention computation acceleration option. Choose off or auto if incompatible.",
  kvCacheTypeK: "KV Cache type for K. Q8_0 saves VRAM but may lose a little precision.",
  kvCacheTypeV: "KV Cache type for V. Q8_0 saves VRAM but may lose a little precision.",
  reasoningEffort: "Reasoning effort for Qwen3.8. XHigh favors quality, Low favors speed.",
  enableThinking: "Enable the model's thinking process. Works for Qwen3.8, Qwen3.5/3.6 and Gemma4.",
  preserveThinking: "Keep think content in the history context; turn off to save context.",
  useMmap: "Load the model with memory mapping. On by default; turning it off consumes physical memory faster.",
});
function promptCategoryLabel(category) {
  return (
    PROMPT_CATEGORY_OPTIONS.find((option) => option.value === category)?.label ||
    category ||
    "Text"
  );
}

class PromptBrowser {
  constructor(root) {
    this.root = root;
    this.mode = "templates";
    this.templates = [];
    this.skills = [];
    this.skillRoot = "";
    this.skillRoots = [];
    this.config = {};
    this.apiProviders = [];
    this.activeApiId = "";
    this.editingApiId = "";
    this.apiProviderDrag = null;
    this.apiProviderDropTarget = null;
    this.taskBindings = Object.fromEntries(
      API_TASK_DEFINITIONS.map((task) => [
        task.id,
        { apiId: "", model: "" },
      ]),
    );
    this.apiModelCache = new Map();
    this.conversations = [];
    this.activeConversation = null;
    this.conversationLoadSequence = 0;
    this.chatGenerating = false;
    this.chatStopping = false;
    this.chatStopRequested = false;
    this.chatAbortController = null;
    this.chatActiveRequestId = "";
    this.chatStopRequestPromise = null;
    this.chatPendingRequest = null;
    this.pendingAttachments = [];
    this.pendingSkillIds = [];
    this.pendingSystemPromptTemplate = null;
    this.activeTaskId = "text";
    this.chatModeButtons = new Map();
    this.translationEnabled = false;
    this.translationTargetLanguage = "en";
    this.chatCurrentModelName = null;
    this.localLlmConfig = { ...DEFAULT_LOCAL_LLM_CONFIG };
    this.localLlmModels = [];
    this.localLlmVisionModels = [];
    this.localLlmModelsRoot = "";
    this.localLlmLoaded = false;
    this.localLlmLoading = null;
    this.skillContentCache = new Map();
    this.skillPreviewTimer = null;
    this.skillPreviewRequestId = 0;
    this.skillPreviewAnchor = null;
    this.skillPreviewElement = null;
    this.skillTagState = {
      categories: [],
      subcategories: [],
      tags: [],
    };
    this.skillTagsLoaded = false;
    this.skillTagsPromise = null;
    this.skillTagQuery = "";
    this.activeSkillTagCategoryId = "all";
    this.activeSkillTagSubcategoryId = "";
    this.collapsedSkillTagCategoryIds = new Set();
    this.selectedInspirationTagIds = new Set();
    this.batchSelectedSkillTagIds = new Set();
    this.editingSkillTagId = "";
    this.skillTagDrag = null;
    this.skillTagContextMenu = null;
    this.inspirationGenerating = false;
    this.templatesLoaded = false;
    this.chatLoaded = false;
    this.skillsLoaded = false;
    this.templatesRequestId = 0;
    this.chatComposerAttachmentLimit = MAX_CHAT_ATTACHMENTS;
    this.build();
  }

  build() {
    const section = createElement(
      "section",
      "astral-am-pane astral-am-prompts-pane",
    );
    const modeTabs = createElement("nav", "astral-am-subtabs");
    modeTabs.setAttribute("aria-label", "Prompt management tools");
    this.skillTagModeButton = createElement(
      "button",
      "astral-am-subtab",
      "Prompt Inspiration",
    );
    this.templateModeButton = createElement(
      "button",
      "astral-am-subtab is-active",
      "System Prompt Management",
    );
    this.skillModeButton = createElement("button", "astral-am-subtab", "Skill Management");
    this.chatModeButton = createElement("button", "astral-am-subtab", "API Chat");
    this.apiConfigModeButton = createElement(
      "button",
      "astral-am-subtab",
      "API Configuration",
    );
    for (const button of [
      this.skillTagModeButton,
      this.templateModeButton,
      this.skillModeButton,
      this.chatModeButton,
      this.apiConfigModeButton,
    ]) {
      button.type = "button";
    }
    modeTabs.append(
      this.skillTagModeButton,
      this.templateModeButton,
      this.skillModeButton,
      this.chatModeButton,
      this.apiConfigModeButton,
    );

    this.templatePane = this.buildTemplatePane();
    this.chatPane = this.buildChatPane();
    this.chatPane.hidden = true;
    this.skillPane = this.buildSkillPane();
    this.skillPane.hidden = true;
    this.skillTagPane = this.buildSkillTagPane();
    this.skillTagPane.hidden = true;
    this.apiConfigPane = this.buildApiConfigPane();
    this.apiConfigPane.hidden = true;
    section.append(
      modeTabs,
      this.skillTagPane,
      this.templatePane,
      this.chatPane,
      this.skillPane,
      this.apiConfigPane,
    );
    this.element = section;
    this.templateModeButton.addEventListener("click", () => this.setMode("templates"));
    this.chatModeButton.addEventListener("click", () => this.setMode("chat"));
    this.skillModeButton.addEventListener("click", () => this.setMode("skills"));
    this.skillTagModeButton.addEventListener("click", () =>
      this.setMode("skillTags"),
    );
    this.apiConfigModeButton.addEventListener("click", () =>
      this.setMode("apiConfig"),
    );
  }

  buildTemplatePane() {
    const pane = createElement("div", "astral-am-prompt-tool is-active");
    const toolbar = createElement("div", "astral-am-toolbar");
    this.templateSearch = createElement("input", "astral-am-search");
    this.templateSearch.type = "search";
    this.templateSearch.placeholder = "Search titles, categories, or prompt content";
    this.templateSearch.autocomplete = "off";
    this.templateSearch.setAttribute("aria-label", "Search prompt templates");
    this.templateCategory = createCustomDropdown("astral-am-category-dropdown");
    this.templateCategory.element.setAttribute("aria-label", "Prompt template category");
    this.templateCategory.setOptions([
      { value: "all", label: "All Categories" },
      ...PROMPT_CATEGORY_OPTIONS,
    ]);
    this.templateCreateButton = createElement(
      "button",
      "astral-am-button is-primary",
      "New Template",
    );
    this.templateCreateButton.type = "button";
    this.templateRefreshButton = createElement("button", "astral-am-button", "Refresh");
    this.templateRefreshButton.type = "button";
    toolbar.append(
      this.templateSearch,
      this.templateCategory.element,
      this.templateCreateButton,
      this.templateRefreshButton,
    );

    this.templateSummary = createElement("div", "astral-am-summary");
    this.templateStatus = createElement("div", "astral-am-status");
    this.templateList = createElement("div", "astral-am-template-list");
    pane.append(
      toolbar,
      this.templateSummary,
      this.templateStatus,
      this.templateList,
    );

    this.templateSearch.addEventListener(
      "input",
      debounce(() => void this.loadTemplates(), 250),
    );
    this.templateCategory.onChange(() => void this.loadTemplates());
    this.templateCreateButton.addEventListener("click", () => {
      this.openTemplateEditor();
    });
    this.templateRefreshButton.addEventListener("click", () => {
      void this.loadTemplates(true, true);
    });
    return pane;
  }

  buildChatPane() {
    const pane = createElement("div", "astral-am-prompt-tool");
    const settings = createElement("section", "astral-am-api-config-panel");

    const providerPanel = createElement("div", "astral-am-api-provider-panel");
    const providerToolbar = createElement(
      "div",
      "astral-am-api-provider-toolbar",
    );
    this.apiProviderTabs = createElement(
      "nav",
      "astral-am-api-provider-tabs",
    );
    this.apiProviderTabs.setAttribute("aria-label", "API configuration list");
    this.apiProviderTabs.setAttribute("role", "tablist");
    this.apiProviderSelect = createElement("select", "astral-am-select");
    this.apiProviderSelect.setAttribute("aria-label", "Select an API configuration to edit");
    this.apiProviderSelect.hidden = true;
    this.addApiButton = createElement(
      "button",
      "astral-am-button is-small",
      "Add API",
    );
    this.duplicateApiButton = createElement(
      "button",
      "astral-am-button is-small",
      "Duplicate API",
    );
    this.deleteApiButton = createElement(
      "button",
      "astral-am-button is-small is-danger",
      "Delete API",
    );
    this.addApiButton.type = "button";
    this.duplicateApiButton.type = "button";
    this.deleteApiButton.type = "button";
    const providerActions = createElement(
      "div",
      "astral-am-api-provider-actions",
    );
    providerActions.append(
      this.addApiButton,
      this.duplicateApiButton,
      this.deleteApiButton,
    );
    providerToolbar.append(
      this.apiProviderTabs,
      providerActions,
      this.apiProviderSelect,
    );

    const configGrid = createElement("div", "astral-am-chat-config-grid");
    this.apiNameInput = createElement("input", "astral-am-input");
    this.apiNameInput.placeholder = "For example: OpenAI, DeepSeek, or local LM Studio";
    this.baseUrlInput = createElement("input", "astral-am-input");
    this.baseUrlInput.type = "url";
    this.baseUrlInput.placeholder = "https://api.openai.com/v1";
    this.modelInput = createElement("input", "astral-am-input");
    this.modelInput.placeholder = "Enter a model name or fetch the list and choose one";
    this.providerModelList = createElement("datalist");
    this.providerModelList.id = "astral-am-provider-model-options";
    this.modelInput.setAttribute("list", this.providerModelList.id);
    this.fetchModelsButton = createElement(
      "button",
      "astral-am-button is-small",
      "Fetch Models",
    );
    this.fetchModelsButton.type = "button";
    this.fetchModelsButton.title =
      "Read the OpenAI-compatible /models list; manual model names are still supported.";
    const providerModelControl = createElement(
      "div",
      "astral-am-input-with-action",
    );
    providerModelControl.append(
      this.modelInput,
      this.fetchModelsButton,
      this.providerModelList,
    );
    this.apiKeyInput = createElement("input", "astral-am-input");
    this.apiKeyInput.type = "password";
    this.apiKeyInput.autocomplete = "new-password";
    this.apiKeyInput.placeholder = "Optional for local APIs";

    for (const [label, input, hint] of [
      [
        "API name",
        this.apiNameInput,
        "Only used to distinguish multiple API configurations; it is not sent to the endpoint and does not affect generation results.",
      ],
      [
        "API URL",
        this.baseUrlInput,
        "Root address of the OpenAI-compatible API, e.g. https://api.openai.com/v1; usually you do not need to add /chat/completions.",
      ],
      [
        "API Key",
        this.apiKeyInput,
        "Endpoint authentication key. Can be left empty for local APIs; it is shown masked after saving.",
      ],
    ]) {
      configGrid.append(this.createField(label, input, "", hint));
    }
    configGrid.append(
      this.createField(
        "Default model for this API",
        providerModelControl,
        "",
        "Used when no model is specified for a particular mode; can be fetched from /models or entered manually.",
      ),
    );
    providerPanel.append(providerToolbar, configGrid);

    const runtimePanel = createElement(
      "section",
      "astral-am-api-runtime-panel",
    );
    const runtimeHeading = createElement(
      "div",
      "astral-am-api-task-heading",
    );
    runtimeHeading.append(
      createElement("strong", "", "General Generation Parameters"),
      createElement(
        "span",
        "astral-am-muted",
        "Shared by the plain-text, image and multimodal external API modes; optional fields the endpoint does not support are removed automatically and retried.",
      ),
    );
    const runtimeGrid = createElement(
      "div",
      "astral-am-api-runtime-grid",
    );
    const runtimeNumberField = (
      key,
      label,
      minimum,
      maximum,
      step = "1",
      hint = "",
      optional = false,
    ) => {
      const input = createElement("input", "astral-am-input");
      input.type = "number";
      input.min = String(minimum);
      input.max = String(maximum);
      input.step = step;
      if (optional) input.placeholder = "Leave empty to omit";
      this[`api${key[0].toUpperCase()}${key.slice(1)}Input`] = input;
      runtimeGrid.append(this.createField(label, input, "", hint));
    };
    const runtimeChoiceField = (key, label, options, hint) => {
      const select = createElement("select", "astral-am-select");
      select.replaceChildren(
        ...options.map(([value, text]) => {
          const option = createElement("option", "", text);
          option.value = value;
          return option;
        }),
      );
      this[`api${key[0].toUpperCase()}${key.slice(1)}Input`] = select;
      runtimeGrid.append(this.createField(label, select, "", hint));
    };
    const runtimeTextField = (
      key,
      label,
      hint,
      placeholder,
      rows,
      wide = false,
    ) => {
      const input = createElement("textarea", "astral-am-textarea");
      input.rows = rows;
      input.placeholder = placeholder;
      this[`api${key[0].toUpperCase()}${key.slice(1)}Input`] = input;
      runtimeGrid.append(
        this.createField(
          label,
          input,
          wide ? "api-config-grid-wide" : "",
          hint,
        ),
      );
    };
    runtimeNumberField(
      "temperature",
      "Temperature",
      0,
      2,
      "0.05",
      "Controls randomness. Prompt expansion usually uses 0.7–0.9; image reverse-prompting usually uses 0.4–0.7.",
    );
    runtimeNumberField(
      "topP",
      "Top P",
      0,
      1,
      "0.01",
      "Nucleus sampling threshold. Usually keep 0.9–0.95 and adjust together with Temperature.",
    );
    runtimeNumberField(
      "maxTokens",
      "Maximum output tokens",
      1,
      128000,
      "1",
      "Maximum tokens allowed per reply, excluding input content.",
    );
    runtimeNumberField(
      "maxRounds",
      "History rounds",
      1,
      50,
      "1",
      "Maximum number of history message rounds carried in API chats; Prompt Processor has no history and is unaffected.",
    );
    runtimeNumberField(
      "frequencyPenalty",
      "Frequency penalty",
      -2,
      2,
      "0.05",
      "Penalizes tokens by how often they appear; a positive value reduces repeated wording.",
    );
    runtimeNumberField(
      "presencePenalty",
      "Presence penalty",
      -2,
      2,
      "0.05",
      "Penalizes any token that has already appeared; a positive value encourages the model to introduce new content.",
    );
    runtimeNumberField(
      "seed",
      "API Seed",
      0,
      4294967295,
      "1",
      "Random seed for the API request. Leave empty to omit it; whether it is supported and fully reproducible depends on the API provider.",
      true,
    );
    runtimeChoiceField(
      "responseFormat",
      "Response format",
      [
        ["default", "Default (not sent)"],
        ["text", "Plain text"],
        ["json_object", "JSON object"],
      ],
      "Response format requested from the endpoint. Non-default options send response_format and retry automatically if unsupported.",
    );
    runtimeChoiceField(
      "reasoningEffort",
      "Reasoning effort",
      [
        ["default", "Default (not sent)"],
        ["low", "Low (speed)"],
        ["medium", "Medium (balanced)"],
        ["high", "High (quality first)"],
      ],
      "Sends the optional reasoning_effort parameter. Only some reasoning models and OpenAI-compatible endpoints support it.",
    );
    runtimeTextField(
      "stop",
      "Stop sequences",
      "Enter one stop sequence per line. Generation stops when any of them is produced; leave empty to omit.",
      "e.g.:\n</answer>\n<END>",
      2,
      true,
    );
    runtimeTextField(
      "systemPrompt",
      "General system prompt",
      "System instructions appended to API requests. Mode-specific rules, Skills and built-in task instructions are still appended.",
      "You are a rigorous and helpful AI assistant.",
      3,
      true,
    );
    runtimePanel.append(runtimeHeading, runtimeGrid);
    this.populateApiRuntimeInputs();

    const taskSection = createElement("section", "astral-am-api-task-section");
    const taskHeading = createElement("div", "astral-am-api-task-heading");
    taskHeading.append(
      createElement("strong", "", "API and Model for Each Mode"),
      createElement(
        "span",
        "astral-am-muted",
        "Assign an API and model to each mode. Leave the model blank to use the API default.",
      ),
    );
    const taskGrid = createElement("div", "astral-am-api-task-grid");
    this.taskBindingControls = {};
    for (const task of API_TASK_DEFINITIONS) {
      const taskCard = createElement("div", "astral-am-api-task-card");
      const taskTitle = createElement("div", "astral-am-api-task-title");
      taskTitle.append(
        createElement("strong", "", task.label),
        createElement("span", "astral-am-muted", task.hint),
      );
      const taskApiSelect = createElement("select", "astral-am-select");
      taskApiSelect.setAttribute("aria-label", `API used by ${task.label}`);
      const taskModelInput = createElement("input", "astral-am-input");
      taskModelInput.placeholder = "Choose the default model or fetch the list";
      const taskModelList = createElement("datalist");
      taskModelList.id = `astral-am-task-${task.id}-model-options`;
      taskModelInput.setAttribute("list", taskModelList.id);
      const taskFetchButton = createElement(
        "button",
        "astral-am-button is-small",
        "Fetch Models",
      );
      taskFetchButton.type = "button";
      const taskModelControl = createElement(
        "div",
        "astral-am-input-with-action",
      );
      taskModelControl.append(
        taskModelInput,
        taskFetchButton,
        taskModelList,
      );
      taskCard.append(
        taskTitle,
        this.createField(
          "API",
          taskApiSelect,
          "",
          `API configuration used by "${task.label}".`,
        ),
        this.createField(
          "Model",
          taskModelControl,
          "",
          `Model used by "${task.label}"; leave blank to use the default model of the selected API.`,
        ),
      );
      taskGrid.append(taskCard);
      this.taskBindingControls[task.id] = {
        apiSelect: taskApiSelect,
        modelInput: taskModelInput,
        modelList: taskModelList,
        fetchButton: taskFetchButton,
      };
    }
    taskSection.append(taskHeading, taskGrid);

    const configActions = createElement("div", "astral-am-chat-config-actions");
    this.apiKeyHint = createElement("span", "astral-am-muted");
    this.saveConfigButton = createElement(
      "button",
      "astral-am-button is-primary",
      "Save API Settings",
    );
    this.saveConfigButton.type = "button";
    this.chatConfigStatus = createElement("div", "astral-am-action-status");
    configActions.append(this.apiKeyHint, this.saveConfigButton);
    settings.append(
      providerPanel,
      runtimePanel,
      taskSection,
      configActions,
      this.chatConfigStatus,
    );

    const workspace = createElement("div", "astral-am-chat-workspace");
    const sidebar = createElement("aside", "astral-am-chat-sidebar");
    const sidebarActions = createElement("div", "astral-am-chat-sidebar-actions");
    this.newConversationButton = createElement(
      "button",
      "astral-am-button is-small is-primary",
      "New Conversation",
    );
    this.deleteConversationButton = createElement(
      "button",
      "astral-am-button is-small is-danger",
      "Delete Conversation",
    );
    this.newConversationButton.type = "button";
    this.deleteConversationButton.type = "button";
    sidebarActions.append(
      this.newConversationButton,
      this.deleteConversationButton,
    );
    this.conversationList = createElement("div", "astral-am-conversation-list");
    sidebar.append(sidebarActions, this.conversationList);

    const main = createElement("div", "astral-am-chat-main");
    this.chatMessages = createElement("div", "astral-am-chat-messages");

    this.chatControls = createElement("div", "astral-am-chat-controls");
    this.systemPromptButton = createElement(
      "button",
      "astral-am-button is-small",
      "Load System Prompt",
    );
    this.skillButton = createElement(
      "button",
      "astral-am-button is-small",
      "Load Skill",
    );
    this.attachmentButton = createElement(
      "button",
      "astral-am-button is-small",
      "Attach Assets",
    );
    this.systemPromptButton.type = "button";
    this.attachmentButton.type = "button";
    this.skillButton.type = "button";
    this.chatSelectionTray = createElement("div", "astral-am-selection-tray");
    this.chatControls.append(
      this.systemPromptButton,
      this.skillButton,
      this.attachmentButton,
      this.chatSelectionTray,
    );

    const composer = createElement("div", "astral-am-chat-composer");
    this.chatInput = createElement("textarea", "astral-am-textarea");
    this.chatInput.rows = 4;
    this.chatInput.placeholder =
      "Enter a message. Click an asset chip to insert names such as image1 or video1.";
    const composerActions = createElement("div", "astral-am-chat-composer-actions");
    this.chatStatus = createElement("div", "astral-am-action-status");
    this.translationControls = createElement(
      "div",
      "astral-am-chat-translation-controls",
    );
    this.translationToggle = createElement(
      "label",
      "astral-am-chat-translation-toggle",
    );
    this.translationToggle.title =
      "Only translate the text being sent; do not send history, system prompts, Skills, or assets.";
    this.translationCheckbox = createElement("input");
    this.translationCheckbox.type = "checkbox";
    this.translationCheckbox.setAttribute("aria-label", "Translation Mode");
    this.translationToggle.append(
      this.translationCheckbox,
      createElement("span", "astral-am-chat-translation-switch"),
      createElement("span", "", "Translation Mode"),
    );
    this.translationLanguageSelect = createElement(
      "select",
      "astral-am-select astral-am-chat-translation-language",
    );
    this.translationLanguageSelect.setAttribute("aria-label", "Translation target language");
    this.translationLanguageSelect.replaceChildren(
      ...TRANSLATION_LANGUAGES.map((language) => {
        const option = createElement("option", "", language.label);
        option.value = language.value;
        return option;
      }),
    );
    this.translationLanguageSelect.value = this.translationTargetLanguage;
    this.translationToggle.classList.toggle(
      "is-active",
      this.translationEnabled,
    );
    this.translationCheckbox.checked = this.translationEnabled;
    this.translationControls.append(
      this.translationToggle,
      this.translationLanguageSelect,
    );
    this.sendButton = createElement(
      "button",
      "astral-am-button is-primary",
      "Send",
    );
    this.sendButton.type = "button";
    composerActions.append(
      this.chatStatus,
      this.translationControls,
      this.sendButton,
    );
    composer.append(this.chatInput, composerActions);
    main.append(this.chatMessages, this.chatControls, composer);
    workspace.append(sidebar, main);
    const configHint = createElement("div", "astral-am-chat-config-hint");
    const configToolbar = createElement(
      "div",
      "astral-am-chat-config-toolbar",
    );
    const modeButtons = createElement(
      "div",
      "astral-am-chat-mode-buttons",
    );
    modeButtons.setAttribute("role", "group");
    modeButtons.setAttribute("aria-label", "Select chat mode");
    this.chatModeButtons.clear();
    for (const task of CHAT_MODE_DEFINITIONS) {
      const modeButton = createElement(
        "button",
        "astral-am-button is-small astral-am-chat-mode-button",
        task.label,
      );
      modeButton.type = "button";
      modeButton.title = `${task.label}: ${task.hint}`;
      modeButton.setAttribute("aria-pressed", "false");
      modeButton.addEventListener("click", () =>
        this.selectChatTask(task.id),
      );
      this.chatModeButtons.set(task.id, modeButton);
      modeButtons.append(modeButton);
    }
    this.openApiConfigButton = createElement(
      "button",
      "astral-am-button is-small",
      "Open API Configuration",
    );
    this.openApiConfigButton.type = "button";
    this.openApiConfigButton.addEventListener("click", () =>
      this.openApiConfigSection("api"),
    );
    this.openLocalLlmConfigButton = createElement(
      "button",
      "astral-am-button is-small",
      "Local LLM Configuration",
    );
    this.openLocalLlmConfigButton.type = "button";
    this.openLocalLlmConfigButton.addEventListener("click", () =>
      this.openApiConfigSection("local"),
    );
    const configButtons = createElement(
      "div",
      "astral-am-chat-config-buttons",
    );
    configButtons.append(
      this.openApiConfigButton,
      this.openLocalLlmConfigButton,
    );
    configToolbar.append(modeButtons, configButtons);
    this.chatCurrentModel = createElement(
      "div",
      "astral-am-chat-current-model",
    );
    this.chatCurrentModelName = createElement("strong", "", "Not configured");
    this.chatCurrentModel.append(
      createElement("span", "", "Current model: "),
      this.chatCurrentModelName,
    );
    configHint.append(configToolbar, this.chatCurrentModel);
    this.updateChatModeStatus();
    this.apiConfigContent = settings;
    pane.append(configHint, workspace);

    this.saveConfigButton.addEventListener("click", () => void this.saveApiConfig());
    this.apiProviderSelect.addEventListener("change", () => {
      this.selectApiProvider(this.apiProviderSelect.value);
    });
    this.addApiButton.addEventListener("click", () => this.addApiProvider());
    this.duplicateApiButton.addEventListener("click", () => {
      this.duplicateApiProvider();
    });
    this.deleteApiButton.addEventListener("click", () => {
      void this.deleteApiProvider();
    });
    this.fetchModelsButton.addEventListener(
      "click",
      () => void this.fetchModelsForEditor(),
    );
    for (const task of API_TASK_DEFINITIONS) {
      const controls = this.taskBindingControls[task.id];
      controls.apiSelect.addEventListener("change", () => {
        this.handleTaskApiChange(task.id);
      });
      controls.fetchButton.addEventListener(
        "click",
        () => void this.fetchModelsForTask(task.id),
      );
    }
    this.newConversationButton.addEventListener(
      "click",
      () => void this.createConversation(true),
    );
    this.deleteConversationButton.addEventListener(
      "click",
      () => void this.deleteActiveConversation(),
    );
    this.attachmentButton.addEventListener(
      "click",
      () => void this.openAssetPicker(),
    );
    this.skillButton.addEventListener("click", () => this.openSkillPicker());
    this.systemPromptButton.addEventListener("click", () =>
      this.openSystemPromptPicker(),
    );
    this.translationCheckbox.addEventListener("change", () => {
      this.translationEnabled = this.translationCheckbox.checked;
      this.translationToggle.classList.toggle(
        "is-active",
        this.translationEnabled,
      );
      this.setChatStatus(
        this.translationEnabled
          ? "Translation Mode enabled: this send will ignore history, system prompts, Skills, and assets."
          : "Translation Mode turned off.",
        this.translationEnabled ? "warning" : "",
      );
    });
    this.translationLanguageSelect.addEventListener("change", () => {
      this.translationTargetLanguage = this.translationLanguageSelect.value;
    });
    this.sendButton.addEventListener(
      "click",
      () => void this.handleChatSendButton(),
    );
    this.renderChatSelection();
    return pane;
  }

  buildApiConfigPane() {
    const pane = createElement(
      "div",
      "astral-am-prompt-tool astral-am-api-config-pane",
    );
    const heading = createElement("div", "astral-am-api-config-heading");
    heading.append(
      createElement("strong", "", "Multiple APIs and Mode Assignment"),
      createElement(
        "span",
        "astral-am-muted",
        "Configuration stays on this machine. Manage external APIs above and local GGUF models below.",
      ),
    );
    this.localLlmConfigPane = this.buildLocalLlmConfigPane();
    this.apiConfigScroll = createElement(
      "div",
      "astral-am-api-config-stack",
    );
    this.apiConfigScroll.append(
      this.apiConfigContent,
      this.localLlmConfigPane,
    );
    pane.append(heading, this.apiConfigScroll);
    return pane;
  }

  buildLocalLlmConfigPane() {
    const pane = createElement("div", "astral-am-local-llm-pane");
    const heading = createElement(
      "div",
      "astral-am-api-config-heading",
    );
    heading.append(
      createElement("strong", "", "Local GGUF Multimodal Models"),
      createElement(
        "span",
        "astral-am-muted",
        "Scan ComfyUI models/LLM. The main model handles chat; mmproj adds images, video frames, and Gemma4 audio.",
      ),
    );

    const panel = createElement(
      "section",
      "astral-am-api-config-panel astral-am-local-llm-panel",
    );
    const modelSection = createElement(
      "div",
      "astral-am-local-llm-model-section",
    );
    this.localLlmModelsRootLabel = createElement(
      "div",
      "astral-am-location-path",
      "Model directory not loaded",
    );
    const modelToolbar = createElement(
      "div",
      "astral-am-local-llm-model-toolbar",
    );
    this.localLlmModelSelect = createElement(
      "select",
      "astral-am-select astral-am-local-llm-model-select",
    );
    this.localLlmModelSelect.setAttribute("aria-label", "Select the local LLM main model");
    this.localLlmModelSelect.title =
      "Select the GGUF main model for local chat and prompt processing; audio, images and video also need a matching mmproj.";
    this.localLlmVisionModelSelect = createElement(
      "select",
      "astral-am-select astral-am-local-llm-model-select",
    );
    this.localLlmVisionModelSelect.setAttribute(
      "aria-label",
      "Select the local LLM vision projection model (mmproj)",
    );
    this.localLlmVisionModelSelect.title =
      "Select a mmproj from the same family as the main model. For text-only use, set it to None; images, video frame extraction and Gemma4 audio need it.";
    this.localLlmRefreshButton = createElement(
      "button",
      "astral-am-button is-small",
      "Refresh Models",
    );
    this.localLlmRefreshButton.type = "button";
    this.localLlmRefreshButton.title =
      "Rescan ComfyUI/models/LLM to refresh the main model and mmproj lists.";
    modelToolbar.append(
      this.localLlmModelSelect,
      this.localLlmVisionModelSelect,
      this.localLlmRefreshButton,
    );
    this.localLlmModelHint = createElement(
      "div",
      "astral-am-muted astral-am-local-llm-model-hint",
      "The main model and mmproj must come from the same model family. For text-only use, set mmproj to None (text-only).",
    );
    modelSection.append(
      this.localLlmModelsRootLabel,
      modelToolbar,
      this.localLlmModelHint,
    );

    const parameterGrid = createElement(
      "div",
      "astral-am-local-llm-grid",
    );
    const numberField = (
      key,
      label,
      minimum,
      maximum,
      step = "1",
      hint = "",
    ) => {
      const input = createElement("input", "astral-am-input");
      input.type = "number";
      input.min = String(minimum);
      input.max = String(maximum);
      input.step = step;
      input.value = String(DEFAULT_LOCAL_LLM_CONFIG[key]);
      this[`localLlm${key[0].toUpperCase()}${key.slice(1)}Input`] = input;
      return this.createField(
        label,
        input,
        "",
        LOCAL_LLM_PARAMETER_HINTS[key] || hint,
      );
    };
    parameterGrid.append(
      numberField("nCtx", "Context length n_ctx", 512, 131072, "256"),
      numberField("nBatch", "Batch size n_batch", 32, 65536, "32"),
      numberField("nUbatch", "Micro-batch n_ubatch", 32, 65536, "32"),
      numberField("maxTokens", "Maximum output tokens", 1, 32768),
      numberField("maxRounds", "History rounds", 1, 50),
      numberField("temperature", "Temperature", 0, 2, "0.05"),
      numberField("topP", "Top P", 0.01, 1, "0.01"),
      numberField("topK", "Top K", 1, 200),
      numberField("minP", "Min P", 0, 1, "0.01"),
      numberField("repeatPenalty", "Repetition penalty", 0.5, 2, "0.05"),
      numberField("frequencyPenalty", "Frequency penalty", -2, 2, "0.05"),
      numberField("presencePenalty", "Presence penalty", -2, 2, "0.05"),
      numberField("gpuLayers", "GPU layers", -1, 1000, "1", "-1 unloads all layers"),
      numberField("threads", "CPU threads", 0, 128, "1", "0 enables automatic selection"),
      numberField("seed", "Seed", 0, 4294967295),
      numberField("maxImageEdge", "Maximum image edge", 256, 4096, "64"),
      numberField("imageJpegQuality", "JPEG quality", 40, 100, "1"),
      numberField(
        "contextCheckpoints",
        "Context Checkpoints",
        0,
        64,
        "1",
        "0 disables the limit",
      ),
    );
    const choiceField = (key, label, options) => {
      const select = createElement("select", "astral-am-select");
      select.replaceChildren(
        ...options.map(([value, text]) => {
          const option = createElement("option", "", text);
          option.value = value;
          return option;
        }),
      );
      this[`localLlm${key[0].toUpperCase()}${key.slice(1)}Input`] = select;
      return this.createField(
        label,
        select,
        "",
        LOCAL_LLM_PARAMETER_HINTS[key] || "",
      );
    };
    const toggleField = (key, label, hint = "") => {
      const toggle = createElement(
        "label",
        "astral-am-local-llm-toggle",
      );
      const input = createElement("input");
      input.type = "checkbox";
      toggle.append(input, createElement("span", "", label));
      const description = LOCAL_LLM_PARAMETER_HINTS[key] || hint;
      if (description) {
        toggle.title = description;
        input.title = description;
      }
      this[`localLlm${key[0].toUpperCase()}${key.slice(1)}Input`] = input;
      return toggle;
    };
    parameterGrid.append(
      choiceField("flashAttention", "Flash Attention", [
        ["auto", "Auto (recommended)"],
        ["enabled", "On"],
        ["disabled", "Close"],
      ]),
      choiceField("kvCacheTypeK", "KV Cache K", [
        ["default", "Default"],
        ["q8_0", "Q8_0"],
      ]),
      choiceField("kvCacheTypeV", "KV Cache V", [
        ["default", "Default"],
        ["q8_0", "Q8_0"],
      ]),
      choiceField("reasoningEffort", "Qwen3.8 reasoning effort", [
        ["xhigh", "XHigh (quality)"],
        ["medium", "Medium (balanced)"],
        ["low", "Low (speed)"],
      ]),
      toggleField(
        "enableThinking",
        "Enable reasoning",
        "Applies to Qwen3.8, Qwen3.5/3.6, and Gemma4.",
      ),
      toggleField(
        "preserveThinking",
        "Keep historical think blocks",
        "Turn off to save context.",
      ),
      toggleField(
        "useMmap",
        "Use mmap",
        "On by default; disabling uses physical memory faster.",
      ),
    );

    const actions = createElement(
      "div",
      "astral-am-chat-config-actions",
    );
    const note = createElement(
      "span",
      "astral-am-muted",
      "Saved in the ComfyUI user directory at assets-astral/local-llm-config.json.",
    );
    this.saveLocalLlmConfigButton = createElement(
      "button",
      "astral-am-button is-primary",
      "Save Local LLM Settings",
    );
    this.saveLocalLlmConfigButton.type = "button";
    actions.append(note, this.saveLocalLlmConfigButton);
    this.localLlmConfigStatus = createElement(
      "div",
      "astral-am-action-status",
    );
    panel.append(
      modelSection,
      parameterGrid,
      actions,
      this.localLlmConfigStatus,
    );
    pane.append(heading, panel);

    this.localLlmRefreshButton.addEventListener("click", () => {
      void this.loadLocalLlmModels();
    });
    this.saveLocalLlmConfigButton.addEventListener("click", () => {
      void this.saveLocalLlmConfig();
    });
    return pane;
  }

  buildSkillPane() {
    const pane = createElement("div", "astral-am-prompt-tool");
    const toolbar = createElement("div", "astral-am-toolbar");
    const note = createElement(
      "p",
      "astral-am-note",
      "Scan SKILL.cn.md or SKILL.md in ComfyUI custom_nodes and input. Each conversation can load one Skill at a time and switch freely; input Skills use the input/... namespace.",
    );
    this.skillSearch = createElement("input", "astral-am-search");
    this.skillSearch.type = "search";
    this.skillSearch.placeholder = "Search Skill name, ID, description, or source";
    this.skillSearch.autocomplete = "off";
    this.skillSearch.setAttribute("aria-label", "Search Skills");
    this.skillRefreshButton = createElement("button", "astral-am-button", "Refresh Skills");
    this.skillRefreshButton.type = "button";
    toolbar.append(this.skillSearch, this.skillRefreshButton);
    this.skillRootLabel = createElement("div", "astral-am-location-path");
    this.skillSummary = createElement("div", "astral-am-summary");
    this.skillStatus = createElement("div", "astral-am-status");
    this.skillList = createElement("div", "astral-am-skill-list");
    pane.append(
      toolbar,
      note,
      this.skillRootLabel,
      this.skillSummary,
      this.skillStatus,
      this.skillList,
    );
    this.skillSearch.addEventListener("input", () => this.renderSkills());
    this.skillRefreshButton.addEventListener(
      "click",
      () => void this.loadSkills(true, true),
    );
    return pane;
  }

  buildSkillTagPane() {
    const pane = createElement(
      "div",
      "astral-am-prompt-tool astral-am-skill-tags-pane",
    );
    const toolbar = createElement("div", "astral-am-toolbar");
    this.skillTagSearch = createElement("input", "astral-am-search");
    this.skillTagSearch.type = "search";
    this.skillTagSearch.placeholder = "Search tag names or categories";
    this.skillTagSearch.autocomplete = "off";
    this.skillTagSearch.setAttribute("aria-label", "Search prompt inspiration tags");
    toolbar.append(this.skillTagSearch);
    const note = createElement(
      "p",
      "astral-am-note",
      "Tags are prompt-inspiration assets. Use + beside a category or subcategory to add tags in bulk, one per line or separated by commas or semicolons.",
    );

    const workspace = createElement("div", "astral-am-skill-tag-workspace");
    const sidebar = createElement("aside", "astral-am-skill-tag-sidebar");
    const sidebarHeading = createElement(
      "div",
      "astral-am-skill-tag-sidebar-heading",
    );
    this.skillTagCategoryCount = createElement(
      "span",
      "astral-am-muted",
      "Category",
    );
    const addCategoryInline = createElement(
      "button",
      "astral-am-icon-button",
      "+",
    );
    addCategoryInline.type = "button";
    addCategoryInline.title = "New Top-level Category (maximum two levels)";
    addCategoryInline.setAttribute(
      "aria-label",
      "Create a top-level category (maximum two levels).",
    );
    sidebarHeading.append(this.skillTagCategoryCount, addCategoryInline);
    this.skillTagAllCategoryButton = createElement(
      "button",
      "astral-am-skill-tag-category is-active",
    );
    this.skillTagAllCategoryButton.type = "button";
    this.skillTagFavoriteCategoryButton = createElement(
      "button",
      "astral-am-skill-tag-category",
    );
    this.skillTagFavoriteCategoryButton.type = "button";
    this.skillTagFavoriteCategoryButton.textContent = "★ Favorites";
    this.skillTagCategoryList = createElement(
      "div",
      "astral-am-skill-tag-category-list",
    );
    sidebar.append(
      sidebarHeading,
      this.skillTagAllCategoryButton,
      this.skillTagFavoriteCategoryButton,
      this.skillTagCategoryList,
    );

    const content = createElement("section", "astral-am-skill-tag-content");
    const contentHeading = createElement(
      "div",
      "astral-am-skill-tag-content-heading",
    );
    this.skillTagHeading = createElement("strong", "", "All Tags");
    this.skillTagSummary = createElement("span", "astral-am-muted");
    contentHeading.append(this.skillTagHeading, this.skillTagSummary);

    this.inspirationSelectionPanel = createElement(
      "section",
      "astral-am-inspiration-panel",
    );
    const inspirationHeader = createElement(
      "div",
      "astral-am-inspiration-header",
    );
    const inspirationHeading = createElement(
      "div",
      "astral-am-inspiration-heading",
    );
    this.inspirationSelectionCount = createElement(
      "strong",
      "",
      "0 inspiration tags selected",
    );
    inspirationHeading.append(
      this.inspirationSelectionCount,
      createElement(
        "span",
        "astral-am-muted",
        "Random Mix selects one tag from each of several categories.",
      ),
    );
    this.inspirationRandomButton = createElement(
      "button",
      "astral-am-button is-small",
      "Random Mix",
    );
    this.inspirationClearButton = createElement(
      "button",
      "astral-am-button is-small",
      "Clear Selection",
    );
    this.inspirationRandomButton.type = "button";
    this.inspirationClearButton.type = "button";
    this.inspirationRandomButton.title =
      "Randomly combine tags from different categories; click again for another set.";
    const inspirationHeaderActions = createElement(
      "div",
      "astral-am-inspiration-header-actions",
    );
    inspirationHeaderActions.append(
      this.inspirationRandomButton,
      this.inspirationClearButton,
    );
    inspirationHeader.append(inspirationHeading, inspirationHeaderActions);
    this.inspirationSelectedChips = createElement(
      "div",
      "astral-am-inspiration-selected-chips",
    );
    inspirationHeader.append(this.inspirationSelectedChips);

    const inspirationForm = createElement(
      "form",
      "astral-am-inspiration-form",
    );
    this.inspirationBasePromptInput = createElement(
      "textarea",
      "astral-am-textarea",
    );
    this.inspirationBasePromptInput.rows = 3;
    this.inspirationBasePromptInput.placeholder =
      "Describe the base scene, for example: a girl standing on a rainy street. Leave blank to let the model create freely from the tags.";
    this.inspirationTargetInput = createElement(
      "select",
      "astral-am-select",
    );
    this.inspirationTargetInput.setAttribute(
      "aria-label",
      "Prompt target",
    );
    for (const [value, label] of [
      ["image", "Text to Image"],
      ["video", "Text to Video"],
    ]) {
      const option = createElement("option", "", label);
      option.value = value;
      this.inspirationTargetInput.append(option);
    }
    this.inspirationLanguageInput = createElement(
      "select",
      "astral-am-select",
    );
    this.inspirationLanguageInput.setAttribute(
      "aria-label",
      "Prompt output language",
    );
    for (const [value, label] of [
      ["en", "English"],
      ["zh", "Chinese"],
    ]) {
      const option = createElement("option", "", label);
      option.value = value;
      this.inspirationLanguageInput.append(option);
    }
    this.inspirationModeInput = createElement(
      "select",
      "astral-am-select",
    );
    this.inspirationModeInput.setAttribute(
      "aria-label",
      "Prompt expansion mode",
    );
    for (const [value, label] of [
      ["api", "API Text-only Mode"],
      ["local", "Local Mode"],
    ]) {
      const option = createElement("option", "", label);
      option.value = value;
      this.inspirationModeInput.append(option);
    }
    this.inspirationGenerateButton = createElement(
      "button",
      "astral-am-button is-primary",
      "Generate Inspiration Prompt",
    );
    this.inspirationGenerateButton.type = "submit";
    const inspirationControls = createElement(
      "div",
      "astral-am-inspiration-controls",
    );
    inspirationControls.append(
      this.createField("Base Scene Idea", this.inspirationBasePromptInput),
      this.createField("Target Type", this.inspirationTargetInput),
      this.createField("Output language", this.inspirationLanguageInput),
      this.createField("Generation Mode", this.inspirationModeInput),
      this.inspirationGenerateButton,
    );
    inspirationForm.append(inspirationControls);

    this.inspirationStatus = createElement("div", "astral-am-status");
    this.inspirationStatus.hidden = true;
    const resultHeading = createElement(
      "div",
      "astral-am-inspiration-result-heading",
    );
    resultHeading.append(
      createElement("strong", "", "Expanded Result"),
      (this.inspirationResultHint = createElement("span", "astral-am-muted")),
    );
    this.inspirationResultInput = createElement(
      "textarea",
      "astral-am-textarea astral-am-inspiration-result",
    );
    this.inspirationResultInput.rows = 5;
    this.inspirationResultInput.placeholder =
      "The generated inspiration prompt will appear here.";
    const resultActions = createElement(
      "div",
      "astral-am-inspiration-result-actions",
    );
    this.inspirationCopyButton = createElement(
      "button",
      "astral-am-button is-small",
      "Copy Prompt",
    );
    this.inspirationUseAsBaseButton = createElement(
      "button",
      "astral-am-button is-small",
      "Use as Base Idea",
    );
    this.inspirationSendToChatButton = createElement(
      "button",
      "astral-am-button is-small is-primary",
      "Add to API Chat",
    );
    for (const button of [
      this.inspirationCopyButton,
      this.inspirationUseAsBaseButton,
      this.inspirationSendToChatButton,
    ]) {
      button.type = "button";
    }
    resultActions.append(
      this.inspirationCopyButton,
      this.inspirationUseAsBaseButton,
      this.inspirationSendToChatButton,
    );
    inspirationForm.append(
      resultHeading,
      this.inspirationResultInput,
      resultActions,
    );
    this.inspirationSelectionPanel.append(
      inspirationHeader,
      inspirationForm,
      this.inspirationStatus,
    );
    this.skillTagStatus = createElement("div", "astral-am-status");
    this.skillTagStatus.hidden = true;
    this.skillTagBatchCount = createElement(
      "strong",
      "astral-am-skill-tag-batch-count",
      "0 tags selected",
    );
    this.skillTagSelectAllButton = createElement(
      "button",
      "astral-am-button is-small",
      "Select All Results",
    );
    this.skillTagClearSelectionButton = createElement(
      "button",
      "astral-am-button is-small",
      "Clear Selection",
    );
    this.skillTagBatchDeleteButton = createElement(
      "button",
      "astral-am-button is-small is-danger",
      "Batch Delete",
    );
    this.skillTagBatchMoveButton = createElement(
      "button",
      "astral-am-button is-small is-primary",
      "Move Category",
    );
    for (const button of [
      this.skillTagSelectAllButton,
      this.skillTagClearSelectionButton,
      this.skillTagBatchDeleteButton,
      this.skillTagBatchMoveButton,
    ]) {
      button.type = "button";
    }
    this.skillTagSelectAllButton.title = "Select all tags in the current category or search results.";
    this.skillTagClearSelectionButton.title = "Clear all selected tags.";
    this.skillTagBatchDeleteButton.title = "Delete all selected tags.";
    this.skillTagBatchMoveButton.title =
      "Move selected tags to another category or subcategory.";
    const skillTagBatchActions = createElement(
      "div",
      "astral-am-skill-tag-batch-actions",
    );
    skillTagBatchActions.append(
      this.skillTagSelectAllButton,
      this.skillTagClearSelectionButton,
      this.skillTagBatchDeleteButton,
      this.skillTagBatchMoveButton,
    );
    this.skillTagBatchBar = createElement(
      "div",
      "astral-am-skill-tag-batch-bar",
    );
    this.skillTagBatchBar.append(
      this.skillTagBatchCount,
      skillTagBatchActions,
    );
    this.skillTagList = createElement("div", "astral-am-skill-tag-list");
    const tagLibrary = createElement("section", "astral-am-tag-library");
    tagLibrary.append(
      this.skillTagStatus,
      this.skillTagBatchBar,
      this.skillTagList,
    );
    const tagBrowserLayout = createElement(
      "div",
      "astral-am-tag-browser-layout",
    );
    tagBrowserLayout.append(tagLibrary, this.inspirationSelectionPanel);
    content.append(contentHeading, tagBrowserLayout);
    workspace.append(sidebar, content);
    pane.append(toolbar, note, workspace);

    this.skillTagSearch.addEventListener("input", () => {
      this.skillTagQuery = this.skillTagSearch.value.trim();
      this.renderSkillTagManager();
    });
    addCategoryInline.addEventListener(
      "click",
      () => void this.createSkillTagCategory(),
    );
    this.skillTagAllCategoryButton.addEventListener("click", () => {
      this.activeSkillTagCategoryId = "all";
      this.activeSkillTagSubcategoryId = "";
      this.renderSkillTagManager();
    });
    this.skillTagFavoriteCategoryButton.addEventListener("click", () => {
      this.activeSkillTagCategoryId = "favorites";
      this.activeSkillTagSubcategoryId = "";
      this.renderSkillTagManager();
    });
    this.inspirationRandomButton.addEventListener(
      "click",
      () => this.randomizeInspirationTags(),
    );
    this.inspirationClearButton.addEventListener(
      "click",
      () => this.clearInspirationTags(),
    );
    this.skillTagSelectAllButton.addEventListener(
      "click",
      () => this.selectAllVisibleSkillTags(),
    );
    this.skillTagClearSelectionButton.addEventListener(
      "click",
      () => this.clearSkillTagBatchSelection(),
    );
    this.skillTagBatchDeleteButton.addEventListener(
      "click",
      () => void this.deleteSkillTagsBatch(),
    );
    this.skillTagBatchMoveButton.addEventListener(
      "click",
      () => void this.moveSkillTagsBatch(),
    );
    inspirationForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.generateInspirationPrompt();
    });
    this.inspirationModeInput.addEventListener("change", () => {
      this.updateInspirationModeUi();
    });
    this.inspirationCopyButton.addEventListener(
      "click",
      () => void this.copyInspirationResult(),
    );
    this.inspirationUseAsBaseButton.addEventListener(
      "click",
      () => this.useInspirationResultAsBase(),
    );
    this.inspirationSendToChatButton.addEventListener(
      "click",
      () => this.sendInspirationResultToChat(),
    );
    this.inspirationResultInput.addEventListener("input", () => {
      this.updateInspirationResultActions();
    });
    this.updateInspirationModeUi();
    this.renderInspirationSelection();
    return pane;
  }

  createField(labelText, input, extraClass = "", hint = "") {
    const label = createElement(
      "label",
      `astral-am-field${extraClass ? ` ${extraClass}` : ""}`,
    );
    const title = createElement("span", "", labelText);
    if (hint) {
      label.classList.add("has-help");
      label.title = hint;
      title.title = hint;
      input.title = hint;
    }
    label.append(title, input);
    return label;
  }

  currentChatTask() {
    return (
      CHAT_MODE_DEFINITIONS.find((task) => task.id === this.activeTaskId) ||
      CHAT_MODE_DEFINITIONS[0]
    );
  }

  currentChatTaskModel(taskId = this.activeTaskId) {
    if (taskId === LOCAL_CHAT_MODE_DEFINITION.id) {
      return String(this.localLlmConfig?.modelPath || "").trim();
    }
    const binding = this.taskBindings[taskId] || {};
    const provider = this.apiProviderById(binding.apiId || this.activeApiId);
    return String(binding.model || provider?.model || "").trim();
  }

  selectChatTask(taskId) {
    if (!CHAT_MODE_DEFINITIONS.some((task) => task.id === taskId)) return;
    this.activeTaskId = taskId;
    this.updateChatModeStatus();
  }

  updateChatModeStatus() {
    const activeTask = this.currentChatTask();
    for (const task of CHAT_MODE_DEFINITIONS) {
      const button = this.chatModeButtons.get(task.id);
      if (!button) continue;
      const isActive = task.id === activeTask.id;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
      button.title = `${task.label}: ${task.hint}`;
    }
    if (!this.chatCurrentModelName) return;
    if (activeTask.id === LOCAL_CHAT_MODE_DEFINITION.id) {
      const modelPath = this.currentChatTaskModel(activeTask.id);
      const modelName = modelPath.split("/").pop() || "";
      this.chatCurrentModelName.textContent = modelName || "Not configured";
      this.chatCurrentModel.title = modelPath
        ? `Local Mode · ComfyUI/models/LLM\nModel: ${modelPath}`
        : "No GGUF model is selected for Local Mode. Open Local LLM Configuration to set one.";
      return;
    }
    const binding = this.taskBindings[activeTask.id] || {};
    const provider = this.apiProviderById(binding.apiId || this.activeApiId);
    const model = this.currentChatTaskModel(activeTask.id);
    this.chatCurrentModelName.textContent = model || "Not configured";
    this.chatCurrentModel.title = model
      ? `${activeTask.label} · ${provider?.name || "No API selected"}\nModel: ${model}`
      : `${activeTask.label} has no model configured yet. Open API configuration to set one.`;
  }

  setMode(mode) {
    if (
      ![
        "templates",
        "chat",
        "skills",
        "skillTags",
        "apiConfig",
      ].includes(mode)
    ) {
      mode = "templates";
    }
    if (mode !== "chat") this.hideSkillPreview();
    if (mode !== "skillTags") this.hideSkillTagContextMenu();
    this.mode = mode;
    this.templatePane.hidden = mode !== "templates";
    this.chatPane.hidden = mode !== "chat";
    this.skillPane.hidden = mode !== "skills";
    this.skillTagPane.hidden = mode !== "skillTags";
    this.apiConfigPane.hidden = mode !== "apiConfig";
    this.templatePane.classList.toggle("is-active", mode === "templates");
    this.chatPane.classList.toggle("is-active", mode === "chat");
    this.skillPane.classList.toggle("is-active", mode === "skills");
    this.skillTagPane.classList.toggle("is-active", mode === "skillTags");
    this.apiConfigPane.classList.toggle("is-active", mode === "apiConfig");
    this.templateModeButton.classList.toggle("is-active", mode === "templates");
    this.chatModeButton.classList.toggle("is-active", mode === "chat");
    this.skillModeButton.classList.toggle("is-active", mode === "skills");
    this.skillTagModeButton.classList.toggle(
      "is-active",
      mode === "skillTags",
    );
    this.apiConfigModeButton.classList.toggle(
      "is-active",
      mode === "apiConfig",
    );
    if (mode === "templates" && !this.templatesLoaded) {
      void this.loadTemplates();
    } else if (mode === "templates") {
      this.renderTemplates();
    }
    if (mode === "chat" && !this.chatLoaded) {
      void this.loadChatBootstrap();
    }
    if (mode === "skills" && !this.skillsLoaded) {
      void this.loadSkills();
    }
    if (mode === "skillTags" && !this.skillTagsLoaded) {
      void this.loadSkillTags();
    }
    if (mode === "apiConfig" && !this.localLlmLoaded) {
      void this.loadLocalLlmConfig();
    }
  }

  openApiConfigSection(section = "api") {
    this.setMode("apiConfig");
    window.requestAnimationFrame(() => {
      if (!this.apiConfigScroll) return;
      const target =
        section === "local"
          ? this.localLlmConfigPane
          : this.apiConfigScroll;
      if (!target) return;
      const top =
        section === "local"
          ? target.getBoundingClientRect().top -
            this.apiConfigScroll.getBoundingClientRect().top +
            this.apiConfigScroll.scrollTop -
            8
          : 0;
      this.apiConfigScroll.scrollTo({
        top: Math.max(0, top),
        behavior: "smooth",
      });
    });
  }

  async loadAll() {
    await Promise.allSettled([
      this.loadTemplates(),
      this.loadSkills(),
      this.loadSkillTags(),
      this.loadApiConfig(),
      this.loadLocalLlmConfig(),
      this.refreshConversationSummaries(),
    ]);
  }

  async load(reset = true) {
    if (reset) {
      this.templatesLoaded = false;
      this.skillsLoaded = false;
      this.skillTagsLoaded = false;
      this.chatLoaded = false;
      this.localLlmLoaded = false;
    }
    return this.loadAll();
  }

  setTemplateStatus(message, kind = "") {
    updateStatusPreservingScroll(
      this.templateStatus,
      message,
      kind,
      this.templateList,
      "data-template-id",
    );
  }

  async loadTemplates(reset = true, preserveScroll = false) {
    this.templatesRequestId += 1;
    const requestId = this.templatesRequestId;
    this.templateRefreshButton.disabled = true;
    if (reset) this.templateList.classList.add("is-loading");
    this.setTemplateStatus("Loading prompt templates...", "loading");
    try {
      const category =
        this.templateCategory.value === "all"
          ? ""
          : this.templateCategory.value;
      const payload = await fetchJson(
        `/assets-astral/prompt-templates?${queryString({
          q: this.templateSearch.value.trim(),
          category,
        })}`,
      );
      if (requestId !== this.templatesRequestId) return;
      this.templates = Array.isArray(payload?.items) ? payload.items : [];
      this.renderTemplates(preserveScroll);
      this.templateSummary.textContent = `${this.templates.length} prompt templates`;
      this.setTemplateStatus(
        this.templates.length ? "" : "No prompt templates yet. Click New Template to begin.",
        this.templates.length ? "" : "empty",
      );
      this.templatesLoaded = true;
    } catch (error) {
      if (requestId === this.templatesRequestId) {
        this.setTemplateStatus(`Failed to read prompt templates: ${error.message || error}`, "error");
      }
    } finally {
      if (requestId === this.templatesRequestId) {
        this.templateRefreshButton.disabled = false;
        this.templateList.classList.remove("is-loading");
      }
    }
  }

  renderTemplates(preserveScroll = true) {
    if (!this.templates.length) {
      if (preserveScroll) {
        replaceChildrenPreservingScroll(this.templateList, null);
      } else {
        this.templateList.replaceChildren();
      }
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const template of this.templates) {
      fragment.append(this.createTemplateCard(template));
    }
    if (preserveScroll) {
      replaceChildrenPreservingScroll(
        this.templateList,
        fragment,
        "data-template-id",
      );
    } else {
      this.templateList.replaceChildren(fragment);
    }
  }

  createTemplateCard(template) {
    const card = createElement("article", "astral-am-template-card");
    card.dataset.templateId = template.id;
    const header = createElement("div", "astral-am-template-header");
    const heading = createElement("div", "astral-am-template-heading");
    heading.append(
      createElement(
        "span",
        `astral-am-category-badge is-${template.category || "text"}`,
        promptCategoryLabel(template.category),
      ),
      createElement("strong", "", template.title || "Untitled Template"),
    );
    header.append(
      heading,
      createElement("span", "astral-am-muted", formatDate(template.updatedAt)),
    );
    const prompt = createElement("pre", "astral-am-template-text", template.prompt);
    const actions = createElement("div", "astral-am-template-actions");
    const edit = createElement("button", "astral-am-button is-small", "Edit");
    const copy = createElement("button", "astral-am-button is-small", "Copy Text");
    const loaded =
      this.pendingSystemPromptTemplate?.id === template.id;
    const loadToChat = createElement(
      "button",
      "astral-am-button is-small",
      loaded ? "Current Session Prompt" : "Load to Conversation",
    );
    const insert = createElement(
      "button",
      "astral-am-button is-small is-primary",
      "Add to Canvas",
    );
    const remove = createElement(
      "button",
      "astral-am-button is-small is-danger",
      "Delete",
    );
    for (const button of [edit, copy, loadToChat, insert, remove]) {
      button.type = "button";
    }
    loadToChat.disabled = loaded;
    loadToChat.title = loaded
      ? "This system prompt is already loaded in the session."
      : "Load this system prompt into the current API chat.";
    edit.addEventListener("click", () => this.openTemplateEditor(template));
    copy.addEventListener("click", async () => {
      try {
        await copyText(template.prompt);
        copy.textContent = "Copied";
        window.setTimeout(() => {
          copy.textContent = "Copy Text";
        }, 1200);
      } catch (error) {
        this.setTemplateStatus(`Copy failed: ${error.message || error}`, "error");
      }
    });
    loadToChat.addEventListener(
      "click",
      () => void this.addSystemPromptToChat(template),
    );
    insert.addEventListener("click", () => this.insertTemplateOnCanvas(template));
    remove.addEventListener("click", () => void this.deleteTemplate(template));
    actions.append(edit, copy, loadToChat, insert, remove);
    card.append(header, prompt, actions);
    return card;
  }

  ensureTemplateEditor() {
    if (this.templateEditor) return this.templateEditor;
    const dialog = createElement("dialog", "astral-am-editor-dialog");
    const shell = createElement("div", "astral-am-editor-shell");
    const header = createElement("div", "astral-am-editor-header");
    this.templateEditorTitle = createElement("strong", "", "New Prompt Template");
    const close = createElement("button", "astral-am-icon-button", "×");
    close.type = "button";
    close.title = "Close";
    close.addEventListener("click", () => dialog.close());
    header.append(this.templateEditorTitle, close);

    const body = createElement("div", "astral-am-editor-body");
    this.templateTitleInput = createElement("input", "astral-am-input");
    this.templateTitleInput.placeholder = "For example: cinematic portrait";
    this.templateEditorCategory = createCustomDropdown("astral-am-category-dropdown");
    this.templateEditorCategory.setOptions(PROMPT_CATEGORY_OPTIONS);
    this.templatePromptInput = createElement("textarea", "astral-am-textarea");
    this.templatePromptInput.rows = 14;
    this.templatePromptInput.placeholder = "Enter prompt text";
    body.append(
      this.createField("Title", this.templateTitleInput),
      this.createField("Category", this.templateEditorCategory.element),
      this.createField("Prompt", this.templatePromptInput),
    );
    this.templateEditorStatus = createElement("div", "astral-am-action-status");
    const footer = createElement("div", "astral-am-editor-footer");
    const cancel = createElement("button", "astral-am-button", "Cancel");
    this.templateEditorSave = createElement(
      "button",
      "astral-am-button is-primary",
      "Save Template",
    );
    cancel.type = "button";
    this.templateEditorSave.type = "button";
    cancel.addEventListener("click", () => dialog.close());
    this.templateEditorSave.addEventListener("click", () => void this.saveTemplate());
    footer.append(this.templateEditorStatus, cancel, this.templateEditorSave);
    shell.append(header, body, footer);
    dialog.append(shell);
    document.body.append(dialog);
    this.templateEditor = dialog;
    return dialog;
  }

  openTemplateEditor(template = null) {
    const dialog = this.ensureTemplateEditor();
    this.editingTemplateId = template?.id || "";
    this.templateEditorTitle.textContent = template
      ? "Edit Prompt Template"
      : "New Prompt Template";
    this.templateTitleInput.value = template?.title || "";
    this.templateEditorCategory.value = template?.category || "text";
    this.templatePromptInput.value = template?.prompt || "";
    this.templateEditorStatus.textContent = "";
    this.templateEditorStatus.className = "astral-am-action-status";
    if (!dialog.open) dialog.showModal();
    window.setTimeout(() => this.templateTitleInput.focus(), 0);
  }

  async saveTemplate() {
    const title = this.templateTitleInput.value.trim();
    const prompt = this.templatePromptInput.value.trim();
    if (!title || !prompt) {
      this.templateEditorStatus.className =
        "astral-am-action-status is-error";
      this.templateEditorStatus.textContent = "Title and prompt cannot be empty.";
      return;
    }
    this.templateEditorSave.disabled = true;
    this.templateEditorStatus.className = "astral-am-action-status";
    this.templateEditorStatus.textContent = "Saving...";
    try {
      await fetchJson("/assets-astral/prompt-templates/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: this.editingTemplateId,
          title,
          category: this.templateEditorCategory.value,
          prompt,
        }),
      });
      this.templateEditor.close();
      await this.loadTemplates();
    } catch (error) {
      this.templateEditorStatus.className =
        "astral-am-action-status is-error";
      this.templateEditorStatus.textContent = `Save failed: ${error.message || error}`;
    } finally {
      this.templateEditorSave.disabled = false;
    }
  }

  async deleteTemplate(template) {
    const confirmed = await showAstralConfirm({
      title: "Delete Prompt Template",
      message: `Delete prompt template "${template.title}"?\n\nIt cannot be recovered from this page afterward.`,
      confirmLabel: "Delete Template",
    });
    if (!confirmed) return;
    this.setTemplateStatus(`Deleting "${template.title}"...`, "loading");
    try {
      await fetchJson("/assets-astral/prompt-templates/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: template.id }),
      });
      await this.loadTemplates();
      this.setTemplateStatus("Template deleted.", "success");
    } catch (error) {
      this.setTemplateStatus(`Failed to delete template: ${error.message || error}`, "error");
    }
  }

  insertTemplateOnCanvas(template) {
    try {
      const node = LiteGraph.createNode(ASTRAL_PROMPT_NODE_ID);
      if (!node) {
        throw new Error("ComfyUI has not registered the Assets Prompt node.");
      }
      const titleWidget = node.widgets?.find((widget) => widget.name === "title");
      const promptWidget = node.widgets?.find((widget) => widget.name === "prompt");
      if (!titleWidget || !promptWidget) {
        throw new Error("The Assets Prompt node is missing the title or prompt widget.");
      }
      titleWidget.value = template.title || "Prompt";
      promptWidget.value = template.prompt || "";
      node.setSize?.([420, 240]);
      const canvas = app.canvas;
      node.pos = canvas?.graph_offset
        ? [
            -canvas.graph_offset[0] / (canvas.ds?.scale || 1) + 80,
            -canvas.graph_offset[1] / (canvas.ds?.scale || 1) + 80,
          ]
        : [80, 80];
      app.graph.add(node);
      app.graph.setDirtyCanvas?.(true, true);
      node.setDirtyCanvas?.(true, true);
      app.canvas?.selectNode?.(node);
      this.root.close();
    } catch (error) {
      this.setTemplateStatus(`Failed to place on canvas: ${error.message || error}`, "error");
    }
  }

  async loadApiConfig() {
    try {
      const payload = await fetchJson("/assets-astral/chat/config");
      this.applyApiConfiguration(payload || {});
    } catch (error) {
      this.ensureApiProviderDraft();
      this.setConfigStatus(`Failed to read API settings: ${error.message || error}`, "error");
    }
  }

  applyApiConfiguration(payload) {
    this.config = payload || {};
    this.apiProviders = Array.isArray(this.config.providers)
      ? this.config.providers
          .filter((provider) => provider && provider.id)
          .map((provider) => ({ ...provider }))
      : [];
    this.ensureApiProviderDraft();
    const requestedActiveId = String(
      this.config.activeApiId || this.config.activeProviderId || "",
    );
    this.activeApiId =
      this.apiProviders.find((provider) => provider.id === requestedActiveId)?.id ||
      this.apiProviders[0].id;
    this.editingApiId = this.activeApiId;
    this.taskBindings = {};
    for (const task of API_TASK_DEFINITIONS) {
      const configuredTasks =
        this.config.tasks && typeof this.config.tasks === "object"
          ? this.config.tasks
          : {};
      const binding =
        [task.id, ...(task.legacyIds || [])]
          .map((taskId) => configuredTasks[taskId])
          .find(
            (item) =>
              item &&
              typeof item === "object" &&
              (item.apiId || item.providerId || "model" in item),
          ) || {};
      const bindingApiId = String(
        binding.apiId || binding.providerId || this.activeApiId,
      );
      this.taskBindings[task.id] = {
        apiId: this.apiProviders.some(
          (provider) => provider.id === bindingApiId,
        )
          ? bindingApiId
          : this.activeApiId,
        model: String(binding.model || ""),
      };
    }
    this.renderApiProviderOptions();
    this.loadApiProviderEditor(this.editingApiId);
    this.renderTaskBindingOptions();
    this.populateApiRuntimeInputs();
  }

  populateApiRuntimeInputs() {
    const config = {
      ...DEFAULT_API_RUNTIME_SETTINGS,
      ...(this.config && typeof this.config === "object" ? this.config : {}),
    };
    this.apiTemperatureInput.value = String(config.temperature);
    this.apiTopPInput.value = String(config.topP);
    this.apiMaxTokensInput.value = String(config.maxTokens);
    this.apiMaxRoundsInput.value = String(config.maxRounds);
    this.apiFrequencyPenaltyInput.value = String(config.frequencyPenalty);
    this.apiPresencePenaltyInput.value = String(config.presencePenalty);
    this.apiSeedInput.value =
      config.seed === null || config.seed === undefined || config.seed === ""
        ? ""
        : String(config.seed);
    this.apiResponseFormatInput.value = [
      "default",
      "text",
      "json_object",
    ].includes(config.responseFormat)
      ? config.responseFormat
      : "default";
    this.apiReasoningEffortInput.value = [
      "default",
      "low",
      "medium",
      "high",
    ].includes(config.reasoningEffort)
      ? config.reasoningEffort
      : "default";
    this.apiStopInput.value = Array.isArray(config.stop)
      ? config.stop.join("\n")
      : String(config.stop || "");
    this.apiSystemPromptInput.value = String(config.systemPrompt || "");
  }

  ensureApiProviderDraft() {
    if (this.apiProviders.length) return;
    this.apiProviders = [
      {
        id: "default",
        name: "Default API",
        baseUrl: "https://api.openai.com/v1",
        model: "",
        apiKey: "",
        apiKeyHint: "",
      },
    ];
  }

  createApiId() {
    const randomId =
      window.crypto?.randomUUID?.() ||
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return `api-${randomId}`.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80);
  }

  apiProviderById(providerId = this.editingApiId) {
    return this.apiProviders.find((provider) => provider.id === providerId);
  }

  clearApiProviderDragFeedback(includeDragging = true) {
    if (!this.apiProviderTabs) return;
    const selector = includeDragging
      ? ".is-dragging, .is-drop-before, .is-drop-after"
      : ".is-drop-before, .is-drop-after";
    for (const tab of this.apiProviderTabs.querySelectorAll(selector)) {
      tab.classList.remove("is-dragging", "is-drop-before", "is-drop-after");
      if (includeDragging) tab.removeAttribute("aria-grabbed");
    }
    this.apiProviderDropTarget = null;
  }

  setApiProviderDropTarget(targetId, placeAfter) {
    if (
      this.apiProviderDropTarget?.targetId === targetId &&
      this.apiProviderDropTarget?.placeAfter === placeAfter
    ) {
      return;
    }
    this.clearApiProviderDragFeedback(false);
    const target = [...this.apiProviderTabs.children].find(
      (tab) => tab.dataset.apiProviderId === targetId,
    );
    if (!target) return;
    target.classList.add(placeAfter ? "is-drop-after" : "is-drop-before");
    this.apiProviderDropTarget = { targetId, placeAfter };
  }

  reorderApiProviders(sourceId, targetId, placeAfter) {
    if (!sourceId || !targetId || sourceId === targetId) return false;
    this.commitApiProviderEditor();
    const previousOrder = this.apiProviders.map((provider) => provider.id);
    const sourceIndex = previousOrder.indexOf(sourceId);
    if (sourceIndex < 0 || !previousOrder.includes(targetId)) return false;
    const [movedProvider] = this.apiProviders.splice(sourceIndex, 1);
    const targetIndex = this.apiProviders.findIndex(
      (provider) => provider.id === targetId,
    );
    this.apiProviders.splice(
      targetIndex + (placeAfter ? 1 : 0),
      0,
      movedProvider,
    );
    const nextOrder = this.apiProviders.map((provider) => provider.id);
    if (
      nextOrder.every(
        (providerId, index) => providerId === previousOrder[index],
      )
    ) {
      return false;
    }
    this.renderApiProviderOptions();
    void this.saveApiConfig(
      "API task order saved.",
      "Saving API task order...",
    );
    return true;
  }

  renderApiProviderOptions() {
    const options = this.apiProviders.map((provider) => {
      const option = createElement(
        "option",
        "",
        provider.name || provider.id,
      );
      option.value = provider.id;
      return option;
    });
    this.apiProviderSelect.replaceChildren(...options);
    const selectedId = this.editingApiId || this.apiProviders[0]?.id || "";
    this.apiProviderSelect.value = selectedId;
    if (!this.apiProviderTabs) return;
    const tabs = this.apiProviders.map((provider) => {
      const isActive = provider.id === selectedId;
      const button = createElement(
        "button",
        `astral-am-api-provider-tab${isActive ? " is-active" : ""}`,
        provider.name || provider.id,
      );
      button.type = "button";
      button.draggable = true;
      button.dataset.apiProviderId = provider.id;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(isActive));
      button.tabIndex = isActive ? 0 : -1;
      button.title =
        `${provider.baseUrl || "API URL not entered"}\nDrag to reorder API tabs`;
      button.addEventListener("click", () => this.selectApiProvider(provider.id));
      button.addEventListener("dragstart", (event) => {
        if (!event.dataTransfer) return;
        if (this.saveConfigButton.disabled) {
          event.preventDefault();
          this.setConfigStatus(
            "API settings are still saving. Adjust the task order afterward.",
            "warning",
          );
          return;
        }
        this.commitApiProviderEditor();
        this.apiProviderDrag = { sourceId: provider.id };
        button.classList.add("is-dragging");
        button.setAttribute("aria-grabbed", "true");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", provider.id);
        event.stopPropagation();
      });
      button.addEventListener("dragover", (event) => {
        if (
          !this.apiProviderDrag?.sourceId ||
          this.apiProviderDrag.sourceId === provider.id
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        const bounds = button.getBoundingClientRect();
        const placeAfter = event.clientX >= bounds.left + bounds.width / 2;
        this.setApiProviderDropTarget(provider.id, placeAfter);
      });
      button.addEventListener("dragleave", () => {
        if (this.apiProviderDropTarget?.targetId === provider.id) {
          this.clearApiProviderDragFeedback(false);
        }
      });
      button.addEventListener("drop", (event) => {
        const sourceId = this.apiProviderDrag?.sourceId;
        if (!sourceId || sourceId === provider.id) return;
        event.preventDefault();
        event.stopPropagation();
        const bounds = button.getBoundingClientRect();
        const placeAfter = event.clientX >= bounds.left + bounds.width / 2;
        this.clearApiProviderDragFeedback();
        this.apiProviderDrag = null;
        this.reorderApiProviders(sourceId, provider.id, placeAfter);
      });
      button.addEventListener("dragend", (event) => {
        event.stopPropagation();
        this.clearApiProviderDragFeedback();
        this.apiProviderDrag = null;
      });
      return button;
    });
    this.apiProviderTabs.replaceChildren(...tabs);
  }

  loadApiProviderEditor(providerId) {
    const provider = this.apiProviderById(providerId);
    if (!provider) return;
    this.editingApiId = provider.id;
    this.apiProviderSelect.value = provider.id;
    this.apiNameInput.value = provider.name || "";
    this.baseUrlInput.value = provider.baseUrl || "";
    this.modelInput.value = provider.model || "";
    this.apiKeyInput.value = provider.apiKey || "";
    this.apiKeyInput.title =
      "Leave blank or keep the mask to reuse the saved key; entering a new value overwrites it.";
    this.apiKeyHint.textContent = provider.apiKeyHint || "";
    this.refreshModelLists(provider.id);
  }

  commitApiProviderEditor() {
    const provider = this.apiProviderById(this.editingApiId);
    if (!provider) return;
    provider.name = this.apiNameInput.value.trim() || provider.name || "API";
    provider.baseUrl = this.baseUrlInput.value.trim();
    provider.model = this.modelInput.value.trim();
    provider.apiKey = this.apiKeyInput.value;
    this.activeApiId = provider.id;
  }

  selectApiProvider(providerId) {
    if (providerId === this.editingApiId) return;
    this.commitApiProviderEditor();
    if (!this.apiProviderById(providerId)) return;
    this.activeApiId = providerId;
    this.loadApiProviderEditor(providerId);
    this.renderApiProviderOptions();
    this.setConfigStatus(
      `Editing "${this.apiProviderById(providerId)?.name || providerId}".`,
    );
  }

  addApiProvider() {
    this.commitApiProviderEditor();
    if (this.apiProviders.length >= 20) {
      this.setConfigStatus("Up to 20 API configurations can be saved.", "warning");
      return;
    }
    const provider = {
      id: this.createApiId(),
      name: `API ${this.apiProviders.length + 1}`,
      baseUrl: "",
      model: "",
      apiKey: "",
      apiKeyHint: "",
    };
    this.apiProviders.push(provider);
    this.activeApiId = provider.id;
    this.editingApiId = provider.id;
    this.renderApiProviderOptions();
    this.loadApiProviderEditor(provider.id);
    this.renderTaskBindingOptions();
    this.setConfigStatus("API added. Enter its URL and key, then save.", "success");
    this.apiNameInput.focus();
  }

  duplicateApiProvider() {
    this.commitApiProviderEditor();
    const source = this.apiProviderById();
    if (!source) return;
    if (this.apiProviders.length >= 20) {
      this.setConfigStatus("Up to 20 API configurations can be saved.", "warning");
      return;
    }
    const provider = {
      ...source,
      id: this.createApiId(),
      name: `${source.name || "API"} copy`.slice(0, 80),
      apiKey: "",
      apiKeyHint: source.hasApiKey
        ? "Re-enter the API key after duplicating."
        : "",
    };
    delete provider.hasApiKey;
    this.apiProviders.push(provider);
    this.activeApiId = provider.id;
    this.editingApiId = provider.id;
    this.renderApiProviderOptions();
    this.loadApiProviderEditor(provider.id);
    this.renderTaskBindingOptions();
    this.setConfigStatus(
      "API copied. For security, enter the API key again.",
      "warning",
    );
  }

  async deleteApiProvider() {
    this.commitApiProviderEditor();
    const provider = this.apiProviderById();
    if (!provider) return;
    if (this.apiProviders.length <= 1) {
      this.setConfigStatus("Keep at least one API configuration.", "warning");
      return;
    }
    const confirmed = await showAstralConfirm({
      title: "Delete API Configuration",
      message: `Delete API configuration "${provider.name || provider.id}"?`,
      confirmLabel: "Delete API",
    });
    if (!confirmed) return;
    this.apiProviders = this.apiProviders.filter(
      (item) => item.id !== provider.id,
    );
    this.apiModelCache.delete(provider.id);
    const fallbackId = this.apiProviders[0].id;
    const fallbackProvider = this.apiProviderById(fallbackId);
    for (const task of API_TASK_DEFINITIONS) {
      if (this.taskBindings[task.id]?.apiId === provider.id) {
        this.taskBindings[task.id].apiId = fallbackId;
        this.taskBindings[task.id].model = fallbackProvider?.model || "";
      }
    }
    this.activeApiId = fallbackId;
    this.editingApiId = fallbackId;
    this.renderApiProviderOptions();
    this.loadApiProviderEditor(fallbackId);
    this.renderTaskBindingOptions();
    this.setConfigStatus("API configuration deleted.", "success");
  }

  renderTaskBindingOptions() {
    for (const task of API_TASK_DEFINITIONS) {
      const controls = this.taskBindingControls[task.id];
      const binding = this.taskBindings[task.id] || {
        apiId: this.activeApiId,
        model: "",
      };
      const options = this.apiProviders.map((provider) => {
        const option = createElement(
          "option",
          "",
          provider.name || provider.id,
        );
        option.value = provider.id;
        return option;
      });
      controls.apiSelect.replaceChildren(...options);
      controls.apiSelect.value = this.apiProviders.some(
        (provider) => provider.id === binding.apiId,
      )
        ? binding.apiId
        : this.apiProviders[0]?.id || "";
      controls.modelInput.value = binding.model || "";
      this.refreshModelLists(controls.apiSelect.value);
    }
    this.updateChatModeStatus();
  }

  handleTaskApiChange(taskId) {
    const controls = this.taskBindingControls[taskId];
    const binding = this.taskBindings[taskId] || {
      apiId: controls.apiSelect.value,
      model: "",
    };
    const previousProvider = this.apiProviderById(binding.apiId);
    const previousDefaultModel = String(previousProvider?.model || "").trim();
    const currentModel = controls.modelInput.value.trim();
    const provider = this.apiProviderById(controls.apiSelect.value);
    binding.apiId = controls.apiSelect.value;
    if (
      !currentModel ||
      (previousDefaultModel && currentModel === previousDefaultModel)
    ) {
      controls.modelInput.value = provider?.model || "";
    }
    binding.model = controls.modelInput.value.trim();
    this.taskBindings[taskId] = binding;
    this.refreshModelLists(binding.apiId);
    this.updateChatModeStatus();
  }

  refreshModelLists(providerId) {
    if (!providerId) return;
    const models = this.apiModelCache.get(providerId) || [];
    const fill = (datalist) => {
      if (!datalist) return;
      datalist.replaceChildren(
        ...models.map((model) => {
          const option = createElement("option");
          option.value = model;
          return option;
        }),
      );
    };
    if (this.editingApiId === providerId) {
      fill(this.providerModelList);
    }
    for (const task of API_TASK_DEFINITIONS) {
      const controls = this.taskBindingControls[task.id];
      if (controls.apiSelect.value === providerId) {
        fill(controls.modelList);
      }
    }
  }

  async fetchModelsForProvider(provider, button) {
    if (!provider) return;
    if (!provider.baseUrl?.trim()) {
      this.setConfigStatus("Enter the API URL before fetching models.", "warning");
      return;
    }
    button.disabled = true;
    button.textContent = "Fetching...";
    this.setConfigStatus(`Fetching models from "${provider.name || provider.id}"...`);
    try {
      const result = await fetchJson("/assets-astral/chat/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(provider),
      });
      const models = Array.isArray(result?.items) ? result.items : [];
      this.apiModelCache.set(provider.id, models);
      this.refreshModelLists(provider.id);
      this.setConfigStatus(
        models.length
          ? `Fetched ${models.length} models; type one in the model box or pick from the suggestions.`
          : "The model list is empty. You can still enter a model name manually.",
        models.length ? "success" : "warning",
      );
    } catch (error) {
      this.setConfigStatus(
        `Failed to fetch models: ${error.message || error}`,
        "error",
      );
    } finally {
      button.disabled = false;
      button.textContent = "Fetch Models";
    }
  }

  async fetchModelsForEditor() {
    this.commitApiProviderEditor();
    await this.fetchModelsForProvider(
      this.apiProviderById(),
      this.fetchModelsButton,
    );
  }

  async fetchModelsForTask(taskId) {
    this.commitApiProviderEditor();
    const controls = this.taskBindingControls[taskId];
    await this.fetchModelsForProvider(
      this.apiProviderById(controls.apiSelect.value),
      controls.fetchButton,
    );
  }

  setConfigStatus(message, kind = "") {
    this.chatConfigStatus.textContent = message || "";
    this.chatConfigStatus.className =
      `astral-am-action-status${kind ? ` is-${kind}` : ""}`;
  }

  collectApiConfiguration() {
    this.commitApiProviderEditor();
    const tasks = {};
    for (const task of API_TASK_DEFINITIONS) {
      const controls = this.taskBindingControls[task.id];
      const binding = {
        apiId: controls.apiSelect.value || this.apiProviders[0]?.id || "",
        model: controls.modelInput.value.trim(),
      };
      tasks[task.id] = binding;
      for (const legacyId of task.legacyWriteIds || []) {
        tasks[legacyId] = { ...binding };
      }
    }
    return {
      version: 2,
      activeApiId: this.editingApiId || this.apiProviders[0]?.id || "",
      providers: this.apiProviders.map((provider) => ({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        model: provider.model,
        apiKey: provider.apiKey,
      })),
      tasks,
      ...this.collectApiRuntimeSettings(),
    };
  }

  collectApiRuntimeSettings() {
    const numberValue = (input, fallback) => {
      const value = Number(input.value);
      return Number.isFinite(value) ? value : fallback;
    };
    const seedText = this.apiSeedInput.value.trim();
    const seed = seedText === "" ? null : Number(seedText);
    const stop = [
      ...new Set(
        this.apiStopInput.value
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ].slice(0, 8);
    return {
      temperature: numberValue(
        this.apiTemperatureInput,
        DEFAULT_API_RUNTIME_SETTINGS.temperature,
      ),
      topP: numberValue(
        this.apiTopPInput,
        DEFAULT_API_RUNTIME_SETTINGS.topP,
      ),
      maxTokens: numberValue(
        this.apiMaxTokensInput,
        DEFAULT_API_RUNTIME_SETTINGS.maxTokens,
      ),
      maxRounds: numberValue(
        this.apiMaxRoundsInput,
        DEFAULT_API_RUNTIME_SETTINGS.maxRounds,
      ),
      frequencyPenalty: numberValue(
        this.apiFrequencyPenaltyInput,
        DEFAULT_API_RUNTIME_SETTINGS.frequencyPenalty,
      ),
      presencePenalty: numberValue(
        this.apiPresencePenaltyInput,
        DEFAULT_API_RUNTIME_SETTINGS.presencePenalty,
      ),
      seed: Number.isFinite(seed) ? seed : null,
      stop,
      responseFormat: this.apiResponseFormatInput.value || "default",
      reasoningEffort: this.apiReasoningEffortInput.value || "default",
      sourceLanguage:
        this.config?.sourceLanguage ||
        DEFAULT_API_RUNTIME_SETTINGS.sourceLanguage,
      targetLanguage:
        this.config?.targetLanguage ||
        DEFAULT_API_RUNTIME_SETTINGS.targetLanguage,
      systemPrompt: this.apiSystemPromptInput.value,
    };
  }

  async saveApiConfig(
    successMessage = "API settings and mode assignments saved.",
    pendingMessage = "Saving API settings...",
  ) {
    this.saveConfigButton.disabled = true;
    this.setConfigStatus(pendingMessage);
    try {
      const payload = await fetchJson("/assets-astral/chat/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.collectApiConfiguration()),
      });
      this.applyApiConfiguration(payload || {});
      this.setConfigStatus(successMessage, "success");
    } catch (error) {
      this.setConfigStatus(`Save failed: ${error.message || error}`, "error");
    } finally {
      this.saveConfigButton.disabled = false;
    }
  }

  setChatStatus(message, kind = "") {
    this.chatStatus.textContent = message || "";
    this.chatStatus.className =
      `astral-am-action-status${kind ? ` is-${kind}` : ""}`;
  }

  setChatGenerationState(generating, stopping = false) {
    this.chatGenerating = Boolean(generating);
    this.chatStopping = Boolean(generating && stopping);
    if (this.sendButton) {
      this.sendButton.disabled = this.chatStopping;
      this.sendButton.textContent = this.chatGenerating
        ? this.chatStopping
          ? "Stopping..."
          : "Stop"
        : "Send";
      this.sendButton.classList.toggle(
        "is-danger",
        this.chatGenerating,
      );
      this.sendButton.setAttribute(
        "aria-label",
        this.chatGenerating ? "Stop Current Generation" : "Send message",
      );
    }
    for (const button of [
      this.newConversationButton,
      this.deleteConversationButton,
    ]) {
      if (button) button.disabled = this.chatGenerating;
    }
    for (const control of [
      this.translationCheckbox,
      this.translationLanguageSelect,
    ]) {
      if (control) control.disabled = this.chatGenerating;
    }
    this.renderConversationList();
  }

  setLocalLlmStatus(message, kind = "") {
    if (!this.localLlmConfigStatus) return;
    this.localLlmConfigStatus.textContent = message || "";
    this.localLlmConfigStatus.className =
      `astral-am-action-status${kind ? ` is-${kind}` : ""}`;
  }

  renderLocalLlmModels(selectedPath = "", selectedVisionPath = "") {
    const models = Array.isArray(this.localLlmModels)
      ? this.localLlmModels
      : [];
    const paths = new Set(models.map((model) => String(model.path || "")));
    const options = models.map((model) => {
      const option = createElement("option", "", model.path || model.fileName);
      option.value = String(model.path || "");
      const size = Number(model.size) || 0;
      option.title = size
        ? `${model.path}\n${(size / (1024 ** 3)).toFixed(2)} GiB`
        : String(model.path || "");
      return option;
    });
    const normalizedSelected = String(selectedPath || "");
    if (normalizedSelected && !paths.has(normalizedSelected)) {
      const missingOption = createElement(
        "option",
        "",
        `${normalizedSelected} (not found)`,
      );
      missingOption.value = normalizedSelected;
      options.unshift(missingOption);
    }
    if (!options.length) {
      const emptyOption = createElement("option", "", "No GGUF model found");
      emptyOption.value = "";
      options.push(emptyOption);
    }
    this.localLlmModelSelect.replaceChildren(...options);
    this.localLlmModelSelect.value = normalizedSelected;

    const visionModels = Array.isArray(this.localLlmVisionModels)
      ? this.localLlmVisionModels
      : [];
    const visionPaths = new Set(
      visionModels.map((model) => String(model.path || "")),
    );
    const visionOptions = visionModels.map((model) => {
      const option = createElement("option", "", model.path || model.fileName);
      option.value = String(model.path || "");
      const size = Number(model.size) || 0;
      option.title = size
        ? `${model.path}\n${(size / (1024 ** 3)).toFixed(2)} GiB`
        : String(model.path || "");
      return option;
    });
    const noVisionOption = createElement("option", "", "None (text-only)");
    noVisionOption.value = "";
    const normalizedVisionSelected = String(selectedVisionPath || "");
    if (
      normalizedVisionSelected &&
      !visionPaths.has(normalizedVisionSelected)
    ) {
      const missingVisionOption = createElement(
        "option",
        "",
        `${normalizedVisionSelected} (not found)`,
      );
      missingVisionOption.value = normalizedVisionSelected;
      visionOptions.unshift(missingVisionOption);
    }
    this.localLlmVisionModelSelect.replaceChildren(
      noVisionOption,
      ...visionOptions,
    );
    this.localLlmVisionModelSelect.value = normalizedVisionSelected;

    this.localLlmModelsRootLabel.textContent = this.localLlmModelsRoot
      ? `Model directory: ${this.localLlmModelsRoot}`
      : "ComfyUI/models/LLM was not found";
    this.localLlmModelHint.textContent =
      `Found ${models.length} main models / ${visionModels.length} vision projection models.`
      + " Images and video frame extraction need mmproj; audio is only supported for Gemma4.";
  }

  populateLocalLlmInputs() {
    const config = this.localLlmConfig || DEFAULT_LOCAL_LLM_CONFIG;
    for (const [input, key] of [
      [this.localLlmNCtxInput, "nCtx"],
      [this.localLlmNBatchInput, "nBatch"],
      [this.localLlmNUbatchInput, "nUbatch"],
      [this.localLlmMaxTokensInput, "maxTokens"],
      [this.localLlmMaxRoundsInput, "maxRounds"],
      [this.localLlmTemperatureInput, "temperature"],
      [this.localLlmTopPInput, "topP"],
      [this.localLlmTopKInput, "topK"],
      [this.localLlmMinPInput, "minP"],
      [this.localLlmRepeatPenaltyInput, "repeatPenalty"],
      [this.localLlmFrequencyPenaltyInput, "frequencyPenalty"],
      [this.localLlmPresencePenaltyInput, "presencePenalty"],
      [this.localLlmGpuLayersInput, "gpuLayers"],
      [this.localLlmThreadsInput, "threads"],
      [this.localLlmSeedInput, "seed"],
      [this.localLlmMaxImageEdgeInput, "maxImageEdge"],
      [this.localLlmImageJpegQualityInput, "imageJpegQuality"],
      [this.localLlmContextCheckpointsInput, "contextCheckpoints"],
      [this.localLlmFlashAttentionInput, "flashAttention"],
      [this.localLlmKvCacheTypeKInput, "kvCacheTypeK"],
      [this.localLlmKvCacheTypeVInput, "kvCacheTypeV"],
      [this.localLlmReasoningEffortInput, "reasoningEffort"],
    ]) {
      input.value = String(config[key] ?? DEFAULT_LOCAL_LLM_CONFIG[key]);
    }
    for (const [input, key] of [
      [this.localLlmEnableThinkingInput, "enableThinking"],
      [this.localLlmPreserveThinkingInput, "preserveThinking"],
      [this.localLlmUseMmapInput, "useMmap"],
    ]) {
      input.checked = Boolean(config[key] ?? DEFAULT_LOCAL_LLM_CONFIG[key]);
    }
    this.renderLocalLlmModels(
      config.modelPath || "",
      config.visionModelPath || "",
    );
  }

  applyLocalLlmPayload(payload, populate = true) {
    this.localLlmConfig = {
      ...DEFAULT_LOCAL_LLM_CONFIG,
      ...(payload?.config && typeof payload.config === "object"
        ? payload.config
        : {}),
    };
    this.localLlmModels = Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload?.items)
        ? payload.items
        : [];
    this.localLlmVisionModels = Array.isArray(payload?.visionModels)
      ? payload.visionModels
      : [];
    this.localLlmModelsRoot = String(payload?.modelsRoot || "");
    if (populate) this.populateLocalLlmInputs();
    this.updateChatModeStatus();
  }

  async loadLocalLlmConfig() {
    if (this.localLlmLoading) return this.localLlmLoading;
    this.localLlmLoading = (async () => {
      this.setLocalLlmStatus("Loading local LLM configuration and models...");
      try {
        const payload = await fetchJson("/assets-astral/local-llm/config");
        this.applyLocalLlmPayload(payload, true);
        this.localLlmLoaded = true;
        this.setLocalLlmStatus(
          this.localLlmModels.length
            ? `Configuration loaded: found ${this.localLlmModels.length} main models and ${this.localLlmVisionModels.length} vision projection models.`
            : "Configuration loaded, but no usable GGUF main model exists in models/LLM.",
          this.localLlmModels.length ? "success" : "warning",
        );
      } catch (error) {
        this.setLocalLlmStatus(
          `Failed to read local LLM configuration: ${error.message || error}`,
          "error",
        );
      } finally {
        this.localLlmLoading = null;
      }
    })();
    return this.localLlmLoading;
  }

  async loadLocalLlmModels() {
    this.localLlmRefreshButton.disabled = true;
    this.localLlmRefreshButton.textContent = "Refreshing...";
    const selectedPath =
      this.localLlmModelSelect.value ||
      String(this.localLlmConfig?.modelPath || "");
    const selectedVisionPath =
      this.localLlmVisionModelSelect.value ||
      String(this.localLlmConfig?.visionModelPath || "");
    this.setLocalLlmStatus("Scanning ComfyUI/models/LLM...");
    try {
      const payload = await fetchJson("/assets-astral/local-llm/models");
      this.localLlmModels = Array.isArray(payload?.items) ? payload.items : [];
      this.localLlmVisionModels = Array.isArray(payload?.visionModels)
        ? payload.visionModels
        : [];
      this.localLlmModelsRoot = String(payload?.modelsRoot || "");
      this.renderLocalLlmModels(selectedPath, selectedVisionPath);
      this.setLocalLlmStatus(
        this.localLlmModels.length
          ? `Found ${this.localLlmModels.length} main models and ${this.localLlmVisionModels.length} vision projection models.`
          : "No GGUF main model was found. Check the models/LLM directory.",
        this.localLlmModels.length ? "success" : "warning",
      );
    } catch (error) {
      this.setLocalLlmStatus(
        `Failed to refresh models: ${error.message || error}`,
        "error",
      );
    } finally {
      this.localLlmRefreshButton.disabled = false;
      this.localLlmRefreshButton.textContent = "Refresh Models";
    }
  }

  collectLocalLlmConfig() {
    return {
      modelPath: this.localLlmModelSelect.value || "",
      visionModelPath: this.localLlmVisionModelSelect.value || "",
      nCtx: Number(this.localLlmNCtxInput.value),
      nBatch: Number(this.localLlmNBatchInput.value),
      nUbatch: Number(this.localLlmNUbatchInput.value),
      maxTokens: Number(this.localLlmMaxTokensInput.value),
      maxRounds: Number(this.localLlmMaxRoundsInput.value),
      temperature: Number(this.localLlmTemperatureInput.value),
      topP: Number(this.localLlmTopPInput.value),
      topK: Number(this.localLlmTopKInput.value),
      minP: Number(this.localLlmMinPInput.value),
      repeatPenalty: Number(this.localLlmRepeatPenaltyInput.value),
      frequencyPenalty: Number(this.localLlmFrequencyPenaltyInput.value),
      presencePenalty: Number(this.localLlmPresencePenaltyInput.value),
      gpuLayers: Number(this.localLlmGpuLayersInput.value),
      threads: Number(this.localLlmThreadsInput.value),
      seed: Number(this.localLlmSeedInput.value),
      maxImageEdge: Number(this.localLlmMaxImageEdgeInput.value),
      imageJpegQuality: Number(this.localLlmImageJpegQualityInput.value),
      flashAttention: this.localLlmFlashAttentionInput.value,
      kvCacheTypeK: this.localLlmKvCacheTypeKInput.value,
      kvCacheTypeV: this.localLlmKvCacheTypeVInput.value,
      enableThinking: this.localLlmEnableThinkingInput.checked,
      preserveThinking: this.localLlmPreserveThinkingInput.checked,
      reasoningEffort: this.localLlmReasoningEffortInput.value,
      useMmap: this.localLlmUseMmapInput.checked,
      contextCheckpoints: Number(this.localLlmContextCheckpointsInput.value),
    };
  }

  async saveLocalLlmConfig() {
    const config = this.collectLocalLlmConfig();
    if (!config.modelPath) {
      this.setLocalLlmStatus("Select a GGUF model first.", "warning");
      return;
    }
    this.saveLocalLlmConfigButton.disabled = true;
    this.saveLocalLlmConfigButton.textContent = "Saving...";
    this.setLocalLlmStatus("Saving local LLM settings...");
    try {
      const payload = await fetchJson("/assets-astral/local-llm/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      this.applyLocalLlmPayload(payload, true);
      this.localLlmLoaded = true;
      this.setLocalLlmStatus("Local LLM settings saved.", "success");
    } catch (error) {
      this.setLocalLlmStatus(
        `Save failed: ${error.message || error}`,
        "error",
      );
    } finally {
      this.saveLocalLlmConfigButton.disabled = false;
      this.saveLocalLlmConfigButton.textContent = "Save Local LLM Settings";
    }
  }

  async loadChatBootstrap() {
    if (this.chatLoaded || this.chatLoading) return this.chatLoading;
    this.chatLoading = Promise.allSettled([
      this.loadApiConfig(),
      this.loadLocalLlmConfig(),
      this.loadSkills(),
      this.loadConversations(),
    ]).then(() => {
      this.chatLoaded = true;
      this.chatLoading = null;
    });
    return this.chatLoading;
  }

  async loadConversations() {
    try {
      await this.refreshConversationSummaries();
      if (!this.conversations.length) {
        await this.createConversation(false);
      } else {
        const activeId = this.activeConversation?.id;
        const target = this.conversations.find((item) => item.id === activeId) ||
          this.conversations[0];
        await this.selectConversation(target.id);
      }
    } catch (error) {
      this.setChatStatus(`Failed to read conversation list: ${error.message || error}`, "error");
    }
  }

  async refreshConversationSummaries() {
    const payload = await fetchJson("/assets-astral/chat/conversations");
    this.conversations = Array.isArray(payload?.items) ? payload.items : [];
    this.renderConversationList();
  }

  renderConversationList() {
    if (!this.conversations.length) {
      this.conversationList.replaceChildren(
        createElement("span", "astral-am-muted", "No conversations yet"),
      );
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const conversation of this.conversations) {
      const button = createElement(
        "button",
        `astral-am-conversation-item${
          conversation.id === this.activeConversation?.id ? " is-active" : ""
        }`,
      );
      button.type = "button";
      button.disabled = this.chatGenerating;
      button.title = "Click to switch conversations; double-click to rename.";
      if (this.chatGenerating) {
        button.title = "Stop the current generation first";
      }
      button.setAttribute(
        "aria-label",
        `${conversation.title || "Untitled Conversation"}, click to switch conversations, double-click to rename`,
      );
      button.append(
        createElement("strong", "", conversation.title || "Untitled Conversation"),
        createElement(
          "span",
          "astral-am-muted",
          `${Number(conversation.messageCount) || 0} messages`,
        ),
      );
      button.addEventListener("click", () => {
        void this.selectConversation(conversation.id);
      });
      button.addEventListener("dblclick", (event) => {
        event.preventDefault();
        void this.renameConversation(conversation.id);
      });
      fragment.append(button);
    }
    this.conversationList.replaceChildren(fragment);
  }

  async createConversation(select = true) {
    if (this.chatGenerating) {
      this.setChatStatus("Stop the current generation before creating a new conversation.", "warning");
      return null;
    }
    try {
      const conversation = await fetchJson("/assets-astral/chat/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New Conversation" }),
      });
      if (select) {
        this.activeConversation = conversation;
        this.clearChatPendingRequest();
        this.pendingAttachments = [];
        this.pendingSkillIds = [];
        this.pendingSystemPromptTemplate = null;
        this.renderConversation();
      }
      await this.refreshConversationSummaries();
      if (select) {
        this.setChatStatus("New conversation created.", "success");
      }
      return conversation;
    } catch (error) {
      this.setChatStatus(`Failed to create conversation: ${error.message || error}`, "error");
      throw error;
    }
  }

  async selectConversation(conversationId) {
    if (!conversationId) return;
    if (this.chatGenerating) {
      this.setChatStatus("Stop the current generation before switching conversations.", "warning");
      return;
    }
    this.clearChatPendingRequest();
    const requestId = ++this.conversationLoadSequence;
    this.setChatStatus("Loading conversations...", "loading");
    try {
      const conversation = await fetchJson(
        `/assets-astral/chat/conversations/get?${queryString({
          id: conversationId,
        })}`,
      );
      if (requestId !== this.conversationLoadSequence) return;
      this.activeConversation = conversation;
      const storedAttachments = Array.isArray(conversation.attachments)
        ? conversation.attachments.map((item) => ({ ...item }))
        : [];
      this.pendingAttachments = storedAttachments.slice(
        0,
        this.chatComposerAttachmentLimit,
      );
      ensureAttachmentMentions(this.pendingAttachments);
      this.pendingSystemPromptTemplate =
        conversation.systemPromptTemplate &&
        typeof conversation.systemPromptTemplate.content === "string" &&
        conversation.systemPromptTemplate.content.trim()
          ? {
              id: String(conversation.systemPromptTemplate.id || ""),
              title: String(
                conversation.systemPromptTemplate.title || "System Prompt",
              ),
              content: conversation.systemPromptTemplate.content,
            }
          : null;
      this.pendingSkillIds =
        !this.pendingSystemPromptTemplate && Array.isArray(conversation.skillIds)
          ? conversation.skillIds
              .filter((item) => typeof item === "string" && item.trim())
              .slice(0, 1)
          : [];
      this.renderConversation();
      this.setChatStatus(
        storedAttachments.length > this.pendingAttachments.length
          ? `This conversation keeps at most ${this.chatComposerAttachmentLimit} assets; ignored ${
              storedAttachments.length - this.pendingAttachments.length
            } extra.`
          : "",
        storedAttachments.length > this.pendingAttachments.length
          ? "warning"
          : "",
      );
    } catch (error) {
      if (requestId === this.conversationLoadSequence) {
        this.setChatStatus(`Failed to read conversation: ${error.message || error}`, "error");
      }
    }
  }

  renderConversation() {
    this.renderConversationList();
    this.renderMessages();
    this.renderChatSelection();
  }

  clearChatPendingRequest() {
    if (this.chatGenerating) return false;
    this.chatPendingRequest = null;
    return true;
  }

  replaceChatInputRange(start, end, replacement) {
    const value = this.chatInput.value;
    const next = `${value.slice(0, start)}${replacement}${value.slice(end)}`;
    this.chatInput.value = next;
    const caret = start + replacement.length;
    this.chatInput.focus();
    this.chatInput.setSelectionRange(caret, caret);
    this.chatInput.dispatchEvent(new Event("input", { bubbles: true }));
  }

  insertChatAttachmentName(mention) {
    const normalized = String(mention || "").trim().replace(/^@/, "");
    if (!normalized || !this.chatInput) return;
    const start = this.chatInput.selectionStart ?? this.chatInput.value.length;
    const end = this.chatInput.selectionEnd ?? start;
    const before = this.chatInput.value.slice(0, start);
    const after = this.chatInput.value.slice(end);
    const leading =
      before && !/[\s，。；：、,.!?;:（(【[]$/.test(before) ? " " : "";
    const trailing = after && !/^\s/.test(after) ? " " : "";
    const insertion = `${leading}${normalized}${trailing || " "}`;
    this.replaceChatInputRange(
      start,
      end,
      insertion,
    );
  }

  createAttachmentChip(
    attachment,
    onRemove = null,
    mention = "",
    onActivate = null,
  ) {
    const chip = createElement("span", "astral-am-chip is-attachment");
    const pathLabel = `${attachment.root}/${attachment.path}`;
    const labelText = mention || pathLabel;
    chip.title = mention ? `${mention} · ${pathLabel}` : pathLabel;

    if (isImageAttachment(attachment)) {
      const thumbnail = createElement("img", "astral-am-chip-thumbnail");
      thumbnail.alt = attachment.name || attachment.path;
      thumbnail.loading = "lazy";
      thumbnail.decoding = "async";
      thumbnail.draggable = false;
      thumbnail.src = assetMediaUrl(attachment, true);
      thumbnail.addEventListener("error", () => {
        if (thumbnail.dataset.fallback !== "true") {
          thumbnail.dataset.fallback = "true";
          thumbnail.src = assetMediaUrl(attachment, false);
          return;
        }
        thumbnail.remove();
        chip.classList.remove("has-thumbnail");
      });
      chip.classList.add("has-thumbnail");
      chip.append(thumbnail);
    }

    chip.append(createElement("span", "astral-am-chip-label", labelText));
    if (mention && typeof onActivate === "function") {
      chip.classList.add("is-mentionable");
      chip.tabIndex = 0;
      chip.setAttribute("role", "button");
      chip.setAttribute("aria-label", `Insert asset name ${mention}`);
      chip.title = `Click to insert ${mention}\n${pathLabel}`;
      chip.addEventListener("click", (event) => {
        if (event.target.closest(".astral-am-chip-remove")) return;
        onActivate();
      });
      chip.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onActivate();
      });
    }
    if (typeof onRemove === "function") {
      const remove = createElement("button", "astral-am-chip-remove", "×");
      remove.type = "button";
      remove.title = "Remove attachment";
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        onRemove();
      });
      chip.append(remove);
    }
    return chip;
  }

  renderMessages() {
    const storedMessages = Array.isArray(this.activeConversation?.messages)
      ? this.activeConversation.messages
      : [];
    const pendingRequest = this.chatPendingRequest;
    const pendingRequestId = pendingRequest?.requestId;
    const messages = pendingRequestId
      ? storedMessages.filter(
          (message) => message?.requestId !== pendingRequestId,
        )
      : storedMessages;
    if (!messages.length && !pendingRequest && !this.chatGenerating) {
      this.chatMessages.replaceChildren(
        createElement(
          "div",
          "astral-am-chat-empty",
          "No messages yet. Load a system prompt or Skill, attach assets, then send the first message.",
        ),
      );
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const message of messages) {
      fragment.append(this.createChatMessageElement(message));
    }
    if (pendingRequest) {
      fragment.append(
        this.createChatMessageElement(
          {
            ...pendingRequest,
            role: "user",
            pendingState: pendingRequest.state,
          },
          false,
        ),
      );
    }
    if (this.chatGenerating) {
      const typing = createElement(
        "article",
        "astral-am-chat-message is-assistant is-typing",
      );
      const typingHeader = createElement(
        "div",
        "astral-am-chat-message-header",
      );
      typingHeader.append(
        createElement("span", "astral-am-chat-role", "AI"),
        createElement(
          "span",
          "astral-am-chat-message-time",
          this.chatStopping ? "Stopping" : "Generating",
        ),
      );
      typing.append(
        typingHeader,
        createElement(
          "div",
          "astral-am-chat-message-content",
          this.chatStopping ? "Stopping the current operation..." : "Waiting for the model reply...",
        ),
      );
      fragment.append(typing);
    }
    this.chatMessages.replaceChildren(fragment);
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }

  createChatMessageElement(message, persisted = true) {
    const bubble = createElement(
      "article",
      `astral-am-chat-message is-${message.role || "assistant"}${
        message.pendingState ? ` is-${message.pendingState}` : ""
      }`,
    );
    if (message.id) bubble.dataset.messageId = message.id;
    if (message.requestId) bubble.dataset.requestId = message.requestId;

    const header = createElement("div", "astral-am-chat-message-header");
    const role = createElement(
      "span",
      "astral-am-chat-role",
      message.role === "user" ? "You" : "AI",
    );
    const timestamp = formatMessageTimestamp(message.timestamp);
    let timeLabel = "";
    if (message.pendingState === "stopped") {
      timeLabel = timestamp
        ? `Sent ${timestamp} · Stopped`
        : "Stopped";
    } else if (message.pendingState === "sending") {
      timeLabel = timestamp
        ? `Sent ${timestamp} · Waiting for reply`
        : "Sending";
    } else if (timestamp) {
      timeLabel = `${
        message.role === "user" ? "Sent" : "Received"
      } ${timestamp}`;
    }
    if (timeLabel) {
      header.append(
        createElement(
          "time",
          "astral-am-chat-message-time",
          timeLabel,
        ),
      );
    }
    header.prepend(role);
    bubble.append(header);

    const text = String(message.content || "");
    if (text.trim()) {
      const content = createElement(
        "div",
        "astral-am-chat-message-content",
      );
      content.textContent = text;
      bubble.append(content);
    }

    const attachments = Array.isArray(message.attachments)
      ? message.attachments
      : [];
    if (attachments.length) {
      ensureAttachmentMentions(attachments);
      if (message.role === "assistant") {
        const images = attachments.filter(isImageAttachment);
        const otherAttachments = attachments.filter(
          (attachment) => !isImageAttachment(attachment),
        );
        if (images.length) {
          bubble.append(this.renderChatMessageImages(images));
        }
        if (otherAttachments.length) {
          bubble.append(
            this.renderChatMessageAttachmentChips(otherAttachments),
          );
        }
      } else {
        bubble.append(this.renderChatMessageAttachmentChips(attachments));
      }
    }

    const actions = createElement("div", "astral-am-chat-message-actions");
    const copyValue = this.chatMessageCopyValue(message);
    if (copyValue) {
      const copyButton = createElement(
        "button",
        "astral-am-chat-message-action",
        "Copy",
      );
      copyButton.type = "button";
      copyButton.title = "Copy this message";
      copyButton.addEventListener("click", () => {
        void this.copyChatMessage(message);
      });
      actions.append(copyButton);
    }
    if (persisted && message.id) {
      const deleteButton = createElement(
        "button",
        "astral-am-chat-message-action is-danger",
        "Delete",
      );
      deleteButton.type = "button";
      deleteButton.title = "Delete this message (cannot be undone)";
      deleteButton.disabled = this.chatGenerating;
      deleteButton.addEventListener("click", () => {
        void this.deleteChatMessage(message);
      });
      actions.append(deleteButton);
    }
    if (actions.childElementCount) bubble.append(actions);
    return bubble;
  }

  renderChatMessageAttachmentChips(attachments) {
    const mentions = attachmentMentionMap(attachments);
    const chips = createElement(
      "div",
      "astral-am-chat-message-attachments",
    );
    for (const attachment of attachments) {
      const mention = mentions.get(this.attachmentKey(attachment)) || "";
      chips.append(this.createAttachmentChip(attachment, null, mention));
    }
    return chips;
  }

  renderChatMessageImages(attachments) {
    const gallery = createElement(
      "div",
      "astral-am-chat-message-images",
    );
    for (const attachment of attachments) {
      const figure = createElement("figure", "astral-am-chat-message-image");
      const link = createElement("a");
      link.href = assetMediaUrl(attachment, false);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = attachment.name || attachment.path || "Generated image";
      const image = createElement("img");
      image.src = assetMediaUrl(attachment, false);
      image.alt = attachment.name || attachment.path || "AI-generated image";
      image.loading = "lazy";
      image.decoding = "async";
      image.draggable = false;
      link.append(image);
      figure.append(link);
      if (attachment.name) {
        figure.append(
          createElement("figcaption", "", attachment.name),
        );
      }
      gallery.append(figure);
    }
    return gallery;
  }

  chatMessageCopyValue(message) {
    const text = String(message?.content || "");
    if (text.trim()) return text;
    const attachments = Array.isArray(message?.attachments)
      ? message.attachments.filter(isImageAttachment)
      : [];
    return attachments
      .map((attachment) =>
        new URL(
          assetMediaUrl(attachment, false),
          window.location.href,
        ).href,
      )
      .join("\n");
  }

  async copyChatMessage(message) {
    try {
      const value = this.chatMessageCopyValue(message);
      if (!value) throw new Error("This message has no copyable content.");
      await copyText(value);
      this.setChatStatus("Message copied.", "success");
    } catch (error) {
      this.setChatStatus(`Copy failed: ${error.message || error}`, "error");
    }
  }

  async deleteChatMessage(message) {
    const conversationId = this.activeConversation?.id;
    if (!conversationId || !message?.id || this.chatGenerating) return;
    const roleLabel = message.role === "user" ? "User" : "AI";
    const confirmed = await showAstralConfirm({
      title: "Delete Message",
      message: `Delete this ${roleLabel} message? This cannot be undone.`,
      confirmLabel: "Delete Message",
    });
    if (!confirmed) return;
    try {
      const result = await fetchJson(
        "/assets-astral/chat/messages/delete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            messageId: message.id,
          }),
        },
      );
      if (result?.conversation) {
        this.activeConversation = result.conversation;
      }
      this.renderConversation();
      await this.refreshConversationSummaries();
      this.setChatStatus("Message deleted permanently.", "success");
    } catch (error) {
      this.setChatStatus(`Failed to delete message: ${error.message || error}`, "error");
    }
  }

  attachmentKey(attachment) {
    return JSON.stringify([attachment.root, attachment.path]);
  }

  async addChatAttachments(items) {
    if (!this.chatLoaded) {
      await this.loadChatBootstrap();
    }
    const limit = this.chatComposerAttachmentLimit;
    const nextAttachments = this.pendingAttachments
      .slice(0, limit)
      .map((item) => ({ ...item }));
    const keys = new Set(nextAttachments.map((item) => this.attachmentKey(item)));
    let added = 0;
    const retainedItems = [];

    for (const item of Array.isArray(items) ? items : []) {
      if (!item?.root || !item?.path) continue;
      const attachment = {
        root: item.root,
        path: item.path,
        kind: item.kind || "",
        name: item.name || item.path.split("/").pop() || item.path,
      };
      const key = this.attachmentKey(attachment);
      if (keys.has(key)) continue;
      if (nextAttachments.length >= limit) {
        retainedItems.push(item);
        continue;
      }
      keys.add(key);
      nextAttachments.push(attachment);
      added += 1;
    }

    if (!added) {
      return {
        ok: false,
        retainedItems,
        message: retainedItems.length
          ? `This conversation has reached the limit of ${limit} assets; remove some before trying again.`
          : "The selected assets are already in this conversation.",
      };
    }

    this.pendingAttachments = nextAttachments;
    ensureAttachmentMentions(this.pendingAttachments);
    this.renderChatSelection();
    await this.persistConversationSettings();
    return {
      ok: true,
      added,
      retainedItems,
      message:
        `Added ${added} assets to the current conversation, now ${nextAttachments.length}/${limit} in total.` +
        (retainedItems.length
          ? ` Reached the limit; ${retainedItems.length} more were not added and stay selected.`
          : ""),
    };
  }

  renderChatSelection() {
    this.hideSkillPreview();
    if (this.pendingSystemPromptTemplate && this.pendingSkillIds.length) {
      this.pendingSkillIds = [];
    }
    const fragment = document.createDocumentFragment();
    if (this.pendingSystemPromptTemplate) {
      const chip = createElement(
        "span",
        "astral-am-chip is-system-prompt",
        `System prompt: ${
          this.pendingSystemPromptTemplate.title || "System Prompt"
        }`,
      );
      chip.tabIndex = 0;
      chip.setAttribute(
        "aria-label",
        `Loaded system prompt: ${
          this.pendingSystemPromptTemplate.title || "System Prompt"
        }`,
      );
      chip.addEventListener("pointerenter", () => {
        this.scheduleSystemPromptPreview(
          this.pendingSystemPromptTemplate,
          chip,
        );
      });
      chip.addEventListener("pointerleave", () => {
        this.hideSkillPreview(chip);
      });
      chip.addEventListener("focusin", () => {
        this.scheduleSystemPromptPreview(
          this.pendingSystemPromptTemplate,
          chip,
        );
      });
      chip.addEventListener("focusout", (event) => {
        if (!chip.contains(event.relatedTarget)) {
          this.hideSkillPreview(chip);
        }
      });
      const remove = createElement("button", "astral-am-chip-remove", "×");
      remove.type = "button";
      remove.title = "Remove system prompt";
      remove.addEventListener("click", () => {
        this.pendingSystemPromptTemplate = null;
        this.renderChatSelection();
        void this.persistConversationSettings();
      });
      chip.append(remove);
      fragment.append(chip);
    }
    for (const skillId of this.pendingSkillIds.slice(0, 1)) {
      const skill = this.skills.find((item) => item.id === skillId);
      const chip = createElement(
        "span",
        "astral-am-chip is-skill",
        `Skill: ${skill?.name || skillId}`,
      );
      if (skill) {
        chip.tabIndex = 0;
        chip.addEventListener("pointerenter", () => {
          this.scheduleSkillPreview(skill, chip);
        });
        chip.addEventListener("pointerleave", () => {
          this.hideSkillPreview(chip);
        });
        chip.addEventListener("focusin", () => {
          this.scheduleSkillPreview(skill, chip);
        });
        chip.addEventListener("focusout", (event) => {
          if (!chip.contains(event.relatedTarget)) {
            this.hideSkillPreview(chip);
          }
        });
      }
      const remove = createElement("button", "astral-am-chip-remove", "×");
      remove.type = "button";
      remove.title = "Remove Skill";
      remove.addEventListener("click", () => {
        this.pendingSkillIds = this.pendingSkillIds.filter(
          (item) => item !== skillId,
        );
        this.renderChatSelection();
        void this.persistConversationSettings();
      });
      chip.append(remove);
      fragment.append(chip);
    }
    ensureAttachmentMentions(this.pendingAttachments);
    const attachmentMentions = attachmentMentionMap(
      this.pendingAttachments,
    );
    for (const attachment of this.pendingAttachments) {
      const mention = attachmentMentions.get(this.attachmentKey(attachment));
      const chip = this.createAttachmentChip(
        attachment,
        () => {
          const key = this.attachmentKey(attachment);
          this.pendingAttachments = this.pendingAttachments.filter(
            (item) => this.attachmentKey(item) !== key,
          );
          this.renderChatSelection();
          void this.persistConversationSettings();
        },
        mention,
        () => this.insertChatAttachmentName(mention),
      );
      fragment.append(chip);
    }
    this.chatSelectionTray.replaceChildren(fragment);
    this.attachmentButton.textContent = this.pendingAttachments.length
      ? `Attach Assets (${this.pendingAttachments.length})`
      : "Attach Assets";
    this.skillButton.textContent = this.pendingSkillIds.length
      ? "Load Skill (1)"
      : "Load Skill";
    this.systemPromptButton.textContent = this.pendingSystemPromptTemplate
      ? "Load System Prompt (1)"
      : "Load System Prompt";
    this.updateSkillChatButtons();
  }

  updateSkillChatButtons() {
    if (!this.skillList) return;
    const joinedSkillIds = new Set(this.pendingSkillIds);
    const hasJoinedSkill = joinedSkillIds.size > 0;
    const hasCurrentContext =
      hasJoinedSkill || Boolean(this.pendingSystemPromptTemplate);
    for (const button of this.skillList.querySelectorAll(
      "[data-chat-skill-id]",
    )) {
      const joined = joinedSkillIds.has(button.dataset.chatSkillId);
      button.textContent = joined
        ? "Current Session Skill"
        : hasCurrentContext
          ? "Switch to this Skill"
          : "Add to Conversation";
      button.disabled = joined;
      button.title = joined
        ? "This Skill is already loaded in the session."
        : this.pendingSystemPromptTemplate
          ? "Switching replaces the system prompt in the current conversation."
          : hasJoinedSkill
          ? "Switching replaces the Skill in the current conversation."
          : "Add this Skill to the current conversation.";
    }
  }

  async addSkillToChat(skillId) {
    const skill = this.skills.find((item) => item.id === skillId);
    if (!skill) {
      this.setSkillStatus("The Skill to add could not be found.", "warning");
      return;
    }
    if (!this.chatLoaded) {
      await this.loadChatBootstrap();
    }
    if (!this.activeConversation?.id) {
      const conversationId = this.conversations[0]?.id;
      if (conversationId) {
        await this.selectConversation(conversationId);
      } else {
        await this.createConversation(true);
      }
    }
    if (!this.activeConversation?.id) {
      this.setSkillStatus("Could not create or read the current conversation. Try again later.", "error");
      return;
    }
    const previousSkillId = this.pendingSkillIds[0] || "";
    if (previousSkillId === skill.id) {
      this.setSkillStatus(`"${skill.name}" is already in the current conversation.`, "warning");
      this.updateSkillChatButtons();
      return;
    }
    const previousSkill = this.skills.find(
      (item) => item.id === previousSkillId,
    );
    const previousSystemPrompt = this.pendingSystemPromptTemplate;
    this.pendingSystemPromptTemplate = null;
    this.pendingSkillIds = [skill.id];
    this.renderChatSelection();
    if (previousSystemPrompt) {
      this.renderTemplates();
    }
    const saved = await this.persistConversationSettings();
    const action = previousSystemPrompt
      ? `Switched the current conversation's system prompt "${
          previousSystemPrompt.title || "System Prompt"
        }" to Skill "${skill.name}".`
      : previousSkillId
      ? `Switched the current conversation's Skill from "${
          previousSkill?.name || previousSkillId
        }" to "${skill.name}".`
      : `Added "${skill.name}" to the current conversation.`;
    this.setSkillStatus(
      saved ? action : `${action} Failed to save the conversation.`,
      saved ? "success" : "error",
    );
  }

  async persistConversationSettings() {
    const conversationId = this.activeConversation?.id;
    if (!conversationId) return false;
    ensureAttachmentMentions(this.pendingAttachments);
    try {
      this.activeConversation = await fetchJson(
        "/assets-astral/chat/conversations/update",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: conversationId,
            attachments: this.pendingAttachments.slice(
              0,
              this.chatComposerAttachmentLimit,
            ),
            skillIds: this.pendingSkillIds.slice(0, 1),
            systemPromptTemplate: this.pendingSystemPromptTemplate,
          }),
        },
      );
      await this.refreshConversationSummaries();
      return true;
    } catch (error) {
      this.setChatStatus(
        `Failed to save conversation settings: ${error.message || error}`,
        "error",
      );
      return false;
    }
  }

  async openAssetPicker() {
    this.root.openChatAssetSelection(this);
  }

  openSystemPromptPicker() {
    this.root.openChatSystemPromptSelection(this);
  }

  openSkillPicker() {
    this.root.openChatSkillSelection(this);
  }

  async addSystemPromptToChat(template) {
    const content = String(template?.prompt || "").trim();
    if (!template?.id || !content) {
      this.setTemplateStatus("This system prompt has no loadable content.", "warning");
      return;
    }
    if (!this.chatLoaded) {
      await this.loadChatBootstrap();
    }
    if (!this.activeConversation?.id) {
      const conversationId = this.conversations[0]?.id;
      if (conversationId) {
        await this.selectConversation(conversationId);
      } else {
        await this.createConversation(true);
      }
    }
    if (!this.activeConversation?.id) {
      this.setTemplateStatus("Could not create or read the current conversation. Try again later.", "error");
      return;
    }

    const previousSkillId = this.pendingSkillIds[0] || "";
    const previousSkill = this.skills.find(
      (item) => item.id === previousSkillId,
    );
    this.pendingSkillIds = [];
    this.pendingSystemPromptTemplate = {
      id: String(template.id),
      title: String(template.title || "System Prompt"),
      content,
    };
    this.renderChatSelection();
    this.renderTemplates();
    const saved = await this.persistConversationSettings();
    const message = previousSkillId
      ? `Switched the current conversation's Skill "${
          previousSkill?.name || previousSkillId
        }" to system prompt "${this.pendingSystemPromptTemplate.title}".`
      : `Loaded "${this.pendingSystemPromptTemplate.title}" into the current conversation.`;
    this.setTemplateStatus(
      saved ? message : `${message} Failed to save the conversation.`,
      saved ? "success" : "error",
    );
    this.setChatStatus(message, saved ? "success" : "error");
  }

  handleChatSendButton() {
    if (this.chatGenerating) {
      return this.stopChatGeneration();
    }
    return this.sendChat();
  }

  restoreChatDraft(request, mergeDraft = true) {
    const sentText = String(request?.content || "");
    const currentText = mergeDraft ? this.chatInput.value : "";
    this.chatInput.value = currentText.trim()
      ? `${sentText}\n\n${currentText}`.trim()
      : sentText;

    const attachments = new Map();
    for (const attachment of [
      ...(Array.isArray(request?.attachments) ? request.attachments : []),
      ...(mergeDraft && Array.isArray(this.pendingAttachments)
        ? this.pendingAttachments
        : []),
    ]) {
      if (!attachment?.root || !attachment?.path) continue;
      const key = this.attachmentKey(attachment);
      if (!attachments.has(key)) {
        attachments.set(key, { ...attachment });
      }
    }
    this.pendingAttachments = Array.from(attachments.values()).slice(
      0,
      this.chatComposerAttachmentLimit,
    );
    ensureAttachmentMentions(this.pendingAttachments);
    this.renderChatSelection();
    this.chatInput.focus();
  }

  async stopChatGeneration() {
    if (!this.chatGenerating || this.chatStopRequested) {
      return this.chatStopRequestPromise;
    }
    this.chatStopRequested = true;
    this.setChatGenerationState(true, true);
    this.renderMessages();
    const requestId = this.chatActiveRequestId;
    this.chatStopRequestPromise = requestId
      ? fetchJson("/assets-astral/chat/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId }),
        }).catch((error) => {
          this.setChatStatus(
            `Stop request sent, but the server did not confirm: ${error.message || error}`,
            "warning",
          );
          return null;
        })
      : Promise.resolve(null);
    this.chatAbortController?.abort();
    return this.chatStopRequestPromise;
  }

  completeStoppedChat(request, conversation = null) {
    const stoppedRequest = {
      ...request,
      state: "stopped",
      stoppedAt: Date.now() / 1000,
    };
    if (conversation) {
      this.activeConversation = conversation;
    }
    this.chatPendingRequest = stoppedRequest;
    this.chatActiveRequestId = "";
    this.chatAbortController = null;
    this.chatStopRequested = false;
    this.chatStopRequestPromise = null;
    this.setChatGenerationState(false);
    this.renderConversation();
    this.setChatStatus(
      "Generation stopped. The stopped message remains visible.",
      "warning",
    );
  }

  async sendChat() {
    if (this.chatGenerating) {
      return this.stopChatGeneration();
    }
    if (!this.chatLoaded) {
      await this.loadChatBootstrap();
    }
    const message = this.chatInput.value.trim();
    const attachmentSnapshot = this.pendingAttachments
      .slice(0, this.chatComposerAttachmentLimit)
      .map((attachment) => ({ ...attachment }));
    const skillSnapshot = this.pendingSkillIds.slice(0, 1);
    const activeTask = this.currentChatTask();
    const translationEnabled = Boolean(this.translationCheckbox.checked);
    const useLocal = activeTask.id === LOCAL_CHAT_MODE_DEFINITION.id;
    if (translationEnabled && !message) {
      this.setChatStatus("Enter a message to translate.", "warning");
      return;
    }
    if (!translationEnabled && !message && !attachmentSnapshot.length) {
      this.setChatStatus("Enter a message or select assets first.", "warning");
      return;
    }
    if (!translationEnabled) {
      ensureAttachmentMentions(attachmentSnapshot);
    }
    const effectiveTaskId =
      translationEnabled && !useLocal ? "text" : activeTask.id;
    const activeModel = this.currentChatTaskModel(effectiveTaskId);
    if (!activeModel) {
      this.setChatStatus(
        translationEnabled
          ? useLocal
            ? "Select a GGUF model in Local LLM Configuration before using local translation."
            : "Translation Mode uses the text-only API. Select a model under Text-only Mode in API Configuration first."
          : useLocal
            ? "No GGUF model is selected for Local Mode. Open Local LLM Configuration first."
            : `"${activeTask.label}" has no model configured yet. Select a model for this mode in API Configuration first.`,
        "warning",
      );
      return;
    }
    const targetLanguage = TRANSLATION_LANGUAGES.find(
      (language) => language.value === this.translationLanguageSelect.value,
    );
    if (translationEnabled && !targetLanguage) {
      this.setChatStatus("Select a translation target language.", "warning");
      return;
    }
    if (!this.activeConversation?.id) {
      await this.createConversation(true);
    }
    if (!this.activeConversation?.id) {
      this.setChatStatus("Could not create the current conversation. Try again later.", "error");
      return;
    }
    const requestId = createChatRequestId();
    const request = {
      requestId,
      conversationId: this.activeConversation.id,
      content: message,
      attachments: attachmentSnapshot,
      timestamp: Date.now() / 1000,
      state: "sending",
    };
    this.chatPendingRequest = request;
    this.chatActiveRequestId = requestId;
    this.chatStopRequested = false;
    this.chatStopRequestPromise = null;
    this.chatAbortController = new AbortController();
    this.chatInput.value = "";
    this.setChatGenerationState(true);
    this.renderMessages();

    const endpoint = translationEnabled
      ? "/assets-astral/chat/translate"
      : useLocal
        ? "/assets-astral/local-llm/chat"
        : "/assets-astral/chat";
    const payload = translationEnabled
      ? {
          conversationId: request.conversationId,
          requestId,
          text: message,
          targetLanguage: targetLanguage.value,
          sourceLanguage: "auto",
          useLocal,
        }
      : useLocal
        ? {
            conversationId: request.conversationId,
            requestId,
            message,
            attachments: attachmentSnapshot,
            skillIds: skillSnapshot,
          }
        : {
            conversationId: request.conversationId,
            requestId,
            message,
            task: activeTask.id,
            attachments: attachmentSnapshot,
            skillIds: skillSnapshot,
          };
    this.setChatStatus(
      translationEnabled
        ? `Translating this passage to "${targetLanguage.label}"; history, system prompt, Skills and assets will not be sent.`
        : useLocal
          ? `Running inference with local model "${activeModel.split("/").pop()}". First load may be slow.`
          : `Requesting the API with "${activeTask.label}" and model "${activeModel}". ${
              attachmentSnapshot.length
                ? "Video attachments are sampled into frames; larger files may take longer."
                : ""
            }`,
      "loading",
    );
    try {
      const result = await fetchJson(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: this.chatAbortController.signal,
      });
      if (this.chatStopRequested) {
        await this.chatStopRequestPromise;
        this.completeStoppedChat(request, result?.conversation || null);
        return;
      }
      if (result?.conversation) {
        this.activeConversation = result.conversation;
      }
      this.chatPendingRequest = null;
      this.chatActiveRequestId = "";
      this.chatAbortController = null;
      this.setChatGenerationState(false);
      this.renderConversation();
      await this.refreshConversationSummaries();
      this.setChatStatus(
        translationEnabled
          ? "Translation received and saved to the conversation."
          : useLocal
            ? "The local model reply was received and saved."
            : "Reply received and saved to the conversation.",
        "success",
      );
    } catch (error) {
      if (this.chatStopRequested || error?.name === "AbortError") {
        await this.chatStopRequestPromise;
        this.completeStoppedChat(request, this.activeConversation);
        return;
      }
      this.restoreChatDraft(request);
      this.chatPendingRequest = null;
      this.chatActiveRequestId = "";
      this.chatAbortController = null;
      this.setChatGenerationState(false);
      this.renderConversation();
      this.setChatStatus(`Chat failed: ${error.message || error}`, "error");
    } finally {
      if (this.chatActiveRequestId === requestId) {
        this.chatActiveRequestId = "";
        this.chatAbortController = null;
        this.setChatGenerationState(false);
      }
    }
  }

  async deleteActiveConversation() {
    if (this.chatGenerating) {
      this.setChatStatus("Stop the current generation before deleting a conversation.", "warning");
      return;
    }
    const conversation = this.activeConversation;
    if (!conversation?.id) return;
    const confirmed = await showAstralConfirm({
      title: "Delete Conversation",
      message: `Delete conversation "${conversation.title || conversation.id}"?`,
      confirmLabel: "Delete Conversation",
    });
    if (!confirmed) return;
    try {
      await fetchJson("/assets-astral/chat/conversations/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: conversation.id }),
      });
      this.activeConversation = null;
      this.clearChatPendingRequest();
      this.pendingAttachments = [];
      this.pendingSkillIds = [];
      this.pendingSystemPromptTemplate = null;
      await this.loadConversations();
      this.setChatStatus("Conversation deleted.", "success");
    } catch (error) {
      this.setChatStatus(`Failed to delete conversation: ${error.message || error}`, "error");
    }
  }

  async renameConversation(conversationId) {
    const conversation =
      this.activeConversation?.id === conversationId
        ? this.activeConversation
        : this.conversations.find((item) => item.id === conversationId);
    if (!conversation?.id) return;
    const title = await showAstralPrompt({
      title: "Rename Conversation",
      message: "Enter a new conversation title.",
      label: "Conversation name",
      initialValue: conversation.title || "New Conversation",
      confirmLabel: "Save Name",
    });
    if (title === null || !title.trim() || title.trim() === conversation.title) {
      return;
    }
    this.conversationLoadSequence += 1;
    try {
      const updatedConversation = await fetchJson(
        "/assets-astral/chat/conversations/update",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: conversation.id, title: title.trim() }),
        },
      );
      await this.refreshConversationSummaries();
      await this.selectConversation(updatedConversation.id);
      this.setChatStatus("Conversation title updated.", "success");
    } catch (error) {
      this.setChatStatus(`Rename failed: ${error.message || error}`, "error");
    }
  }

  setSkillTagStatus(message, kind = "") {
    updateStatusPreservingScroll(
      this.skillTagStatus,
      message,
      kind,
      this.skillTagList,
      "data-tag-id",
    );
  }

  skillTagById(tagId) {
    return this.skillTagState.tags.find((tag) => tag.id === tagId) || null;
  }

  skillTagCategoryById(categoryId) {
    return (
      this.skillTagState.categories.find(
        (category) => category.id === categoryId,
      ) || null
    );
  }

  skillTagSubcategoryById(subcategoryId) {
    return (
      this.skillTagState.subcategories.find(
        (subcategory) => subcategory.id === subcategoryId,
      ) || null
    );
  }

  skillTagSubcategories(categoryId) {
    return this.skillTagState.subcategories.filter(
      (subcategory) => subcategory.categoryId === categoryId,
    );
  }

  skillTagPath(tag) {
    const category = this.skillTagCategoryById(tag.categoryId);
    const subcategory = this.skillTagSubcategoryById(tag.subcategoryId);
    return [category?.name, subcategory?.name, tag.name]
      .filter(Boolean)
      .join(" / ");
  }

  selectedInspirationTags() {
    return (this.skillTagState.tags || []).filter((tag) =>
      this.selectedInspirationTagIds.has(tag.id),
    );
  }

  toggleInspirationTag(tagId, force = null) {
    const shouldSelect =
      force === null
        ? !this.selectedInspirationTagIds.has(tagId)
        : Boolean(force);
    if (shouldSelect) {
      this.selectedInspirationTagIds.add(tagId);
    } else {
      this.selectedInspirationTagIds.delete(tagId);
    }
    this.renderInspirationSelection();
    this.renderSkillTagManager();
  }

  clearInspirationTags() {
    this.selectedInspirationTagIds.clear();
    this.renderInspirationSelection();
    this.renderSkillTagManager();
    this.setSkillTagStatus("Inspiration tag selection cleared.", "");
  }

  randomizeInspirationTags() {
    const groups = (this.skillTagState.categories || [])
      .map((category) => ({
        category,
        tags: (this.skillTagState.tags || []).filter(
          (tag) => tag.categoryId === category.id,
        ),
      }))
      .filter((group) => group.tags.length);
    if (!groups.length) {
      this.setSkillTagStatus("No tags are available for random combination.", "warning");
      return;
    }
    for (let index = groups.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [groups[index], groups[swapIndex]] = [groups[swapIndex], groups[index]];
    }
    const maximumGroupCount = Math.min(4, groups.length);
    const minimumGroupCount = groups.length > 1 ? 2 : 1;
    const groupCount =
      minimumGroupCount +
      Math.floor(
        Math.random() * (maximumGroupCount - minimumGroupCount + 1),
      );
    this.selectedInspirationTagIds.clear();
    for (const group of groups.slice(0, groupCount)) {
      const tag = group.tags[Math.floor(Math.random() * group.tags.length)];
      this.selectedInspirationTagIds.add(tag.id);
    }
    this.renderInspirationSelection();
    this.renderSkillTagManager();
    this.setSkillTagStatus(
      `Randomly mixed inspiration tags from ${groupCount} different categories; click again for another batch.`,
      "success",
    );
  }

  renderInspirationSelection() {
    if (!this.inspirationSelectionCount) return;
    const selected = this.selectedInspirationTags();
    this.inspirationSelectionCount.textContent =
      `${selected.length} inspiration tags selected`;
    this.inspirationClearButton.disabled = !selected.length;
    this.inspirationRandomButton.disabled =
      !this.skillTagState.tags.length || this.inspirationGenerating;
    const fragment = document.createDocumentFragment();
    if (!selected.length) {
      fragment.append(
        createElement(
          "span",
          "astral-am-inspiration-empty",
          "Click tags below to add inspiration, or use Random Mix to draw across categories.",
        ),
      );
    } else {
      for (const tag of selected) {
        const category = this.skillTagCategoryById(tag.categoryId);
        const subcategory = this.skillTagSubcategoryById(
          tag.subcategoryId,
        );
        const chip = createElement(
          "button",
          "astral-am-inspiration-chip",
        );
        chip.type = "button";
        chip.style.setProperty("--tag-color", tag.color);
        chip.title = `${this.skillTagPath(tag)} · Click to remove from inspiration`;
        chip.append(
          createElement("span", "astral-am-tag-color-dot"),
          createElement(
            "span",
            "",
            `${
              [category?.name, subcategory?.name]
                .filter(Boolean)
                .join(" / ") || "Uncategorized"
            } / ${tag.name}`,
          ),
          createElement("span", "astral-am-inspiration-chip-remove", "×"),
        );
        chip.addEventListener("click", () => {
          this.toggleInspirationTag(tag.id, false);
        });
        fragment.append(chip);
      }
    }
    this.inspirationSelectedChips.replaceChildren(fragment);
    this.updateInspirationResultActions();
  }

  setInspirationStatus(message, kind = "") {
    this.inspirationStatus.textContent = message || "";
    this.inspirationStatus.className =
      `astral-am-status${kind ? ` is-${kind}` : ""}`;
    this.inspirationStatus.hidden = !message;
  }

  inspirationResultText() {
    return this.inspirationResultInput?.value.trim() || "";
  }

  updateInspirationResultActions() {
    const hasResult = Boolean(this.inspirationResultText());
    for (const button of [
      this.inspirationCopyButton,
      this.inspirationUseAsBaseButton,
      this.inspirationSendToChatButton,
    ]) {
      if (button) button.disabled = !hasResult;
    }
  }

  updateInspirationModeUi() {
    const useLocal = this.inspirationModeInput?.value === "local";
    if (this.inspirationResultHint) {
      this.inspirationResultHint.textContent = useLocal
        ? "The result is editable and uses the local GGUF model from API Configuration."
        : "The result is editable and uses the text-only model from API Configuration.";
    }
  }

  async generateInspirationPrompt() {
    if (this.inspirationGenerating) return;
    const basePrompt = this.inspirationBasePromptInput.value.trim();
    const mode =
      this.inspirationModeInput.value === "local" ? "local" : "api";
    const tags = this.selectedInspirationTags().map((tag) => {
      const categoryName =
        this.skillTagCategoryById(tag.categoryId)?.name || "Inspiration";
      const subcategoryName =
        this.skillTagSubcategoryById(tag.subcategoryId)?.name || "";
      return {
        name: tag.name,
        category: [categoryName, subcategoryName]
          .filter(Boolean)
          .join(" / "),
      };
    });
    if (!basePrompt && !tags.length) {
      this.setInspirationStatus(
        "Enter a base scene idea or select at least one inspiration tag.",
        "warning",
      );
      return;
    }
    this.inspirationGenerating = true;
    this.inspirationGenerateButton.disabled = true;
    this.inspirationGenerateButton.textContent = "Generating...";
    this.inspirationModeInput.disabled = true;
    this.inspirationResultInput.value = "";
    this.updateInspirationResultActions();
    this.setInspirationStatus(
      mode === "local"
        ? "Expanding the prompt with a local GGUF model..."
        : "Expanding the prompt with the text-only API...",
      "loading",
    );
    try {
      const payload = await fetchJson(
        "/assets-astral/prompt-inspiration/generate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            basePrompt,
            tags,
            target: this.inspirationTargetInput.value,
            language: this.inspirationLanguageInput.value,
            mode,
          }),
        },
      );
      this.inspirationResultInput.value = String(payload?.text || "").trim();
      this.updateInspirationResultActions();
      this.setInspirationStatus("Inspiration prompt generated.", "success");
    } catch (error) {
      this.setInspirationStatus(
        `Generation failed: ${error.message || error}`,
        "error",
      );
    } finally {
      this.inspirationGenerating = false;
      this.inspirationGenerateButton.disabled = false;
      this.inspirationGenerateButton.textContent = "Generate Inspiration Prompt";
      this.inspirationModeInput.disabled = false;
      this.renderInspirationSelection();
    }
  }

  async copyInspirationResult() {
    const result = this.inspirationResultText();
    if (!result) return;
    try {
      await copyText(result);
      this.setInspirationStatus("Prompt copied to the clipboard.", "success");
    } catch (error) {
      this.setInspirationStatus(
        `Copy failed: ${error.message || error}`,
        "error",
      );
    }
  }

  useInspirationResultAsBase() {
    const result = this.inspirationResultText();
    if (!result) return;
    this.inspirationBasePromptInput.value = result;
    this.inspirationBasePromptInput.focus();
    this.setInspirationStatus(
      "The expanded result was moved back to the base scene idea. Adjust it and generate again.",
      "success",
    );
  }

  async sendInspirationResultToChat() {
    const result = this.inspirationResultText();
    if (!result) return;
    if (!this.chatLoaded) await this.loadChatBootstrap();
    const current = this.chatInput.value.trim();
    this.chatInput.value = current ? `${current}\n\n${result}` : result;
    this.selectChatTask("text");
    this.setMode("chat");
    this.chatInput.dispatchEvent(new Event("input", { bubbles: true }));
    this.chatInput.focus();
    this.setChatStatus(
      "The inspiration prompt was added to the chat input. Add further instructions before sending.",
      "success",
    );
  }

  applySkillTagState(payload) {
    const categories = Array.isArray(payload?.categories)
      ? payload.categories.filter((item) => item?.id && item?.name)
      : [];
    const categoryIds = new Set(categories.map((item) => item.id));
    const subcategories = Array.isArray(payload?.subcategories)
      ? payload.subcategories.filter(
          (item) =>
            item?.id &&
            item?.name &&
            categoryIds.has(item?.categoryId),
        )
      : [];
    const subcategoryIds = new Set(
      subcategories.map((item) => item.id),
    );
    const tags = Array.isArray(payload?.tags)
      ? payload.tags
          .filter((item) => item?.id && item?.name)
          .map((item) => ({
            ...item,
            subcategoryId: subcategoryIds.has(item.subcategoryId)
              ? item.subcategoryId
              : "",
          }))
      : [];
    const tagIds = new Set(tags.map((item) => item.id));
    this.skillTagState = { categories, subcategories, tags };
    this.selectedInspirationTagIds = new Set(
      [...this.selectedInspirationTagIds].filter((tagId) => tagIds.has(tagId)),
    );
    this.batchSelectedSkillTagIds = new Set(
      [...this.batchSelectedSkillTagIds].filter((tagId) => tagIds.has(tagId)),
    );
    if (
      this.activeSkillTagCategoryId !== "all" &&
      this.activeSkillTagCategoryId !== "favorites" &&
      !categories.some((item) => item.id === this.activeSkillTagCategoryId)
    ) {
      this.activeSkillTagCategoryId = "all";
      this.activeSkillTagSubcategoryId = "";
    } else if (
      this.activeSkillTagSubcategoryId &&
      this.activeSkillTagSubcategoryId !== "__unclassified__" &&
      !subcategories.some(
        (item) =>
          item.id === this.activeSkillTagSubcategoryId &&
          item.categoryId === this.activeSkillTagCategoryId,
      )
    ) {
      this.activeSkillTagSubcategoryId = "";
    }
    this.collapsedSkillTagCategoryIds = new Set(
      [...this.collapsedSkillTagCategoryIds].filter((categoryId) =>
        categoryIds.has(categoryId),
      ),
    );
    if (this.editingSkillTagId && !tagIds.has(this.editingSkillTagId)) {
      this.editingSkillTagId = "";
    }
    this.skillTagsLoaded = true;
    this.renderInspirationSelection();
    this.renderSkillTagManager();
  }

  async loadSkillTags() {
    if (this.skillTagsPromise) return this.skillTagsPromise;
    this.setSkillTagStatus("Loading tag data...", "loading");
    this.skillTagsPromise = fetchJson("/assets-astral/skill-tags")
      .then((payload) => {
        this.applySkillTagState(payload);
        this.setSkillTagStatus("Tags loaded.", "success");
      })
      .catch((error) => {
        this.skillTagsPromise = null;
        this.setSkillTagStatus(
          `Failed to read tags: ${error.message || error}`,
          "error",
        );
      });
    return this.skillTagsPromise;
  }

  visibleSkillTags() {
    const tags = this.skillTagState.tags || [];
    const query = this.skillTagQuery.toLocaleLowerCase();
    return tags.filter((tag) => {
      if (
        this.activeSkillTagCategoryId !== "all" &&
        this.activeSkillTagCategoryId !== "favorites" &&
        tag.categoryId !== this.activeSkillTagCategoryId
      ) {
        return false;
      }
      if (
        this.activeSkillTagSubcategoryId === "__unclassified__" &&
        tag.subcategoryId
      ) {
        return false;
      }
      if (
        this.activeSkillTagSubcategoryId &&
        this.activeSkillTagSubcategoryId !== "__unclassified__" &&
        tag.subcategoryId !== this.activeSkillTagSubcategoryId
      ) {
        return false;
      }
      if (
        this.activeSkillTagCategoryId === "favorites" &&
        !tag.favorite
      ) {
        return false;
      }
      if (!query) return true;
      const category =
        this.skillTagCategoryById(tag.categoryId)?.name || "";
      const subcategory =
        this.skillTagSubcategoryById(tag.subcategoryId)?.name || "";
      return `${tag.name}\n${category}\n${subcategory}`
        .toLocaleLowerCase()
        .includes(query);
    });
  }

  batchManageableSkillTags() {
    return this.visibleSkillTags().filter(
      (tag) => tag.id !== this.editingSkillTagId,
    );
  }

  updateSkillTagBatchControls() {
    if (!this.skillTagBatchBar) return;
    const manageableTags = this.batchManageableSkillTags();
    const manageableIds = new Set(manageableTags.map((tag) => tag.id));
    const selectedCount = this.batchSelectedSkillTagIds.size;
    const selectedVisibleCount = [...this.batchSelectedSkillTagIds].filter(
      (tagId) => manageableIds.has(tagId),
    ).length;
    this.skillTagBatchCount.textContent = `${selectedCount} tags checked`;
    this.skillTagBatchBar.classList.toggle(
      "has-selection",
      selectedCount > 0,
    );
    this.skillTagSelectAllButton.disabled =
      !manageableTags.length || selectedVisibleCount === manageableTags.length;
    this.skillTagClearSelectionButton.disabled = selectedCount === 0;
    this.skillTagBatchDeleteButton.disabled = selectedCount === 0;
    this.skillTagBatchMoveButton.disabled = selectedCount === 0;
  }

  toggleSkillTagBatchSelection(tagId, force = null) {
    if (!this.skillTagById(tagId)) return;
    const shouldSelect =
      force === null
        ? !this.batchSelectedSkillTagIds.has(tagId)
        : Boolean(force);
    if (shouldSelect) {
      this.batchSelectedSkillTagIds.add(tagId);
    } else {
      this.batchSelectedSkillTagIds.delete(tagId);
    }
    this.renderSkillTagManager();
  }

  selectAllVisibleSkillTags() {
    const tags = this.batchManageableSkillTags();
    for (const tag of tags) this.batchSelectedSkillTagIds.add(tag.id);
    this.renderSkillTagManager();
    this.setSkillTagStatus(
      `Checked ${tags.length} tags in the current results.`,
      "success",
    );
  }

  clearSkillTagBatchSelection() {
    this.batchSelectedSkillTagIds.clear();
    this.renderSkillTagManager();
    this.setSkillTagStatus("Bulk selection cleared.", "");
  }

  renderSkillTagManager() {
    if (!this.skillTagList) return;
    this.hideSkillTagContextMenu();
    const categories = this.skillTagState.categories || [];
    const subcategories = this.skillTagState.subcategories || [];
    const tags = this.skillTagState.tags || [];
    this.skillTagAllCategoryButton.replaceChildren(
      createElement("span", "", "All Tags"),
      createElement("span", "astral-am-tag-category-count", tags.length),
    );
    this.skillTagAllCategoryButton.classList.toggle(
      "is-active",
      this.activeSkillTagCategoryId === "all",
    );
    this.skillTagFavoriteCategoryButton.replaceChildren(
      createElement("span", "", "★ Favorites"),
      createElement(
        "span",
        "astral-am-tag-category-count",
        tags.filter((tag) => tag.favorite).length,
      ),
    );
    this.skillTagFavoriteCategoryButton.classList.toggle(
      "is-active",
      this.activeSkillTagCategoryId === "favorites",
    );
    this.skillTagCategoryCount.textContent = `Categories · ${categories.length}`;

    const categoryRows = document.createDocumentFragment();
    categories.forEach((category, index) => {
      const count = tags.filter(
        (tag) => tag.categoryId === category.id,
      ).length;
      const categoryRow = createElement(
        "div",
        "astral-am-skill-tag-category-row",
      );
      const isCollapsed = this.collapsedSkillTagCategoryIds.has(
        category.id,
      );
      const toggle = createElement(
        "button",
        "astral-am-skill-tag-tree-toggle",
        isCollapsed ? "▸" : "▾",
      );
      toggle.type = "button";
      toggle.title = isCollapsed ? "Expand subcategories" : "Collapse subcategories";
      toggle.setAttribute("aria-expanded", String(!isCollapsed));
      toggle.setAttribute(
        "aria-label",
        `${isCollapsed ? "Expand" : "Collapse"} ${category.name} subcategories`,
      );
      const button = createElement(
        "button",
        "astral-am-skill-tag-category",
      );
      button.type = "button";
      button.draggable = true;
      button.dataset.categoryId = category.id;
      button.classList.toggle(
        "is-active",
        this.activeSkillTagCategoryId === category.id &&
          !this.activeSkillTagSubcategoryId,
      );
      button.append(
        createElement("span", "astral-am-tag-category-name", category.name),
        createElement("span", "astral-am-tag-category-count", count),
      );
      button.title = `${category.name} · ${count} tags\nRight-click to manage categories`;
      button.addEventListener("click", () => {
        this.activeSkillTagCategoryId = category.id;
        this.activeSkillTagSubcategoryId = "";
        this.renderSkillTagManager();
      });
      toggle.addEventListener("click", () => {
        if (this.collapsedSkillTagCategoryIds.has(category.id)) {
          this.collapsedSkillTagCategoryIds.delete(category.id);
        } else {
          this.collapsedSkillTagCategoryIds.add(category.id);
        }
        this.renderSkillTagManager();
      });
      const addSubcategory = createElement(
        "button",
        "astral-am-skill-tag-subcategory-add",
        "+",
      );
      addSubcategory.type = "button";
      addSubcategory.title =
        `Create a subcategory under "${category.name}" or bulk-add tags`;
      addSubcategory.setAttribute(
        "aria-label",
        `Create a subcategory under ${category.name} or bulk-add tags`,
      );
      addSubcategory.addEventListener("click", (event) => {
        this.showSkillTagContextMenu(event, [
          {
            label: "New Subcategory",
            action: () => this.createSkillTagSubcategory(category),
          },
          {
            label: "Bulk Add Tags",
            action: () => this.createSkillTagsBatch(category.id),
          },
        ]);
      });
      button.addEventListener("contextmenu", (event) =>
        this.showSkillTagContextMenu(event, [
          {
            label: "New Subcategory",
            action: () => this.createSkillTagSubcategory(category),
          },
          {
            label: "Bulk Add Tags",
            action: () => this.createSkillTagsBatch(category.id),
          },
          {
            label: "Rename Category",
            action: () => this.renameSkillTagCategory(category),
          },
          {
            label: "Delete Category",
            danger: true,
            action: () => this.deleteSkillTagCategory(category),
          },
        ]),
      );
      this.bindSkillTagDrag(button, "categories", category.id, index);
      categoryRow.append(toggle, button, addSubcategory);
      categoryRows.append(categoryRow);

      if (isCollapsed) return;
      const childRows = createElement(
        "div",
        "astral-am-skill-tag-subcategory-list",
      );
      const categorySubcategories = subcategories.filter(
        (subcategory) => subcategory.categoryId === category.id,
      );
      categorySubcategories.forEach((subcategory, subcategoryIndex) => {
        const subcategoryCount = tags.filter(
          (tag) => tag.subcategoryId === subcategory.id,
        ).length;
        const subcategoryButton = createElement(
          "button",
          "astral-am-skill-tag-category astral-am-skill-tag-subcategory",
        );
        subcategoryButton.type = "button";
        subcategoryButton.draggable = true;
        subcategoryButton.dataset.subcategoryId = subcategory.id;
        subcategoryButton.classList.toggle(
          "is-active",
          this.activeSkillTagCategoryId === category.id &&
            this.activeSkillTagSubcategoryId === subcategory.id,
        );
        subcategoryButton.append(
          createElement(
            "span",
            "astral-am-tag-category-name",
            subcategory.name,
          ),
          createElement(
            "span",
            "astral-am-tag-category-count",
            subcategoryCount,
          ),
        );
        subcategoryButton.title =
          `${category.name} / ${subcategory.name} · ` +
          `${subcategoryCount} tags\nRight-click to manage subcategories`;
        subcategoryButton.addEventListener("click", () => {
          this.activeSkillTagCategoryId = category.id;
          this.activeSkillTagSubcategoryId = subcategory.id;
          this.renderSkillTagManager();
        });
        subcategoryButton.addEventListener("contextmenu", (event) =>
          this.showSkillTagContextMenu(event, [
            {
              label: "Bulk Add Tags",
              action: () =>
                this.createSkillTagsBatch(category.id, subcategory.id),
            },
            {
              label: "Rename Subcategory",
              action: () => this.renameSkillTagSubcategory(subcategory),
            },
            {
              label: "Delete Subcategory",
              danger: true,
              action: () =>
                this.deleteSkillTagSubcategory(subcategory),
            },
          ]),
        );
        this.bindSkillTagDrag(
          subcategoryButton,
          "subcategories",
          subcategory.id,
          subcategoryIndex,
          category.id,
        );
        const subcategoryRow = createElement(
          "div",
          "astral-am-skill-tag-subcategory-row",
        );
        const addChildTag = createElement(
          "button",
          "astral-am-skill-tag-subcategory-add",
          "+",
        );
        addChildTag.type = "button";
        addChildTag.title =
          `Bulk-add tags under "${subcategory.name}"`;
        addChildTag.setAttribute(
          "aria-label",
          `Bulk-add tags under ${subcategory.name}`,
        );
        addChildTag.addEventListener("click", (event) => {
          event.stopPropagation();
          void this.createSkillTagsBatch(category.id, subcategory.id);
        });
        subcategoryRow.append(subcategoryButton, addChildTag);
        childRows.append(subcategoryRow);
      });
      const unclassifiedCount = tags.filter(
        (tag) =>
          tag.categoryId === category.id && !tag.subcategoryId,
      ).length;
      if (unclassifiedCount) {
        const unclassified = createElement(
          "button",
          "astral-am-skill-tag-category astral-am-skill-tag-subcategory is-unclassified",
        );
        unclassified.type = "button";
        unclassified.classList.toggle(
          "is-active",
          this.activeSkillTagCategoryId === category.id &&
            this.activeSkillTagSubcategoryId === "__unclassified__",
        );
        unclassified.append(
          createElement("span", "astral-am-tag-category-name", "Uncategorized"),
          createElement(
            "span",
            "astral-am-tag-category-count",
            unclassifiedCount,
          ),
        );
        unclassified.title =
          `${category.name} / Uncategorized · ${unclassifiedCount} tags`;
        unclassified.addEventListener("click", () => {
          this.activeSkillTagCategoryId = category.id;
          this.activeSkillTagSubcategoryId = "__unclassified__";
          this.renderSkillTagManager();
        });
        childRows.append(unclassified);
      }
      if (childRows.childNodes.length) categoryRows.append(childRows);
    });
    replaceChildrenPreservingScroll(
      this.skillTagCategoryList,
      categoryRows,
      "data-category-id",
    );

    const activeCategory = this.skillTagCategoryById(
      this.activeSkillTagCategoryId,
    );
    const activeSubcategory = this.skillTagSubcategoryById(
      this.activeSkillTagSubcategoryId,
    );
    this.skillTagHeading.textContent =
      this.activeSkillTagCategoryId === "favorites"
        ? "Favorite tags"
        : activeCategory
          ? activeSubcategory
            ? `${activeCategory.name} / ${activeSubcategory.name}`
            : this.activeSkillTagSubcategoryId === "__unclassified__"
              ? `${activeCategory.name} / Uncategorized`
              : `${activeCategory.name} / All`
          : "All Tags";
    let visibleTags = this.visibleSkillTags();
    this.skillTagSummary.textContent =
      `${visibleTags.length} / ${tags.length} tags`;

    const fragment = document.createDocumentFragment();
    const editingTag = this.skillTagById(this.editingSkillTagId);
    if (editingTag) fragment.append(this.buildSkillTagEditor(editingTag));
    if (!visibleTags.length) {
      const message = this.skillTagQuery
        ? `No tags match "${this.skillTagQuery}".`
        : "This category has no tags yet. Use + beside the category to add a subcategory or tag.";
      fragment.append(
        createElement("p", "astral-am-skill-tag-empty", message),
      );
    }
    visibleTags = visibleTags.filter(
      (tag) => tag.id !== this.editingSkillTagId,
    );
    this.updateSkillTagBatchControls();
    visibleTags.forEach((tag, index) => {
      const category = this.skillTagCategoryById(tag.categoryId);
      const subcategory = this.skillTagSubcategoryById(
        tag.subcategoryId,
      );
      const card = createElement("article", "astral-am-skill-tag-card");
      card.draggable = true;
      card.dataset.tagId = tag.id;
      card.style.setProperty("--tag-color", tag.color);
      card.classList.toggle("is-favorite", Boolean(tag.favorite));
      const selected = this.selectedInspirationTagIds.has(tag.id);
      const batchSelected = this.batchSelectedSkillTagIds.has(tag.id);
      card.classList.toggle("is-selected", selected);
      card.classList.toggle("is-batch-selected", batchSelected);
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-pressed", String(selected));
      card.setAttribute(
        "aria-label",
        `${this.skillTagPath(tag)}, ${
          selected ? "Added to inspiration" : "Click to add to inspiration"
        }, right-click for more actions`,
      );
      const header = createElement("div", "astral-am-skill-tag-card-header");
      const title = createElement("div", "astral-am-skill-tag-card-title");
      const batchCheckbox = createElement(
        "input",
        "astral-am-skill-tag-batch-checkbox",
      );
      batchCheckbox.type = "checkbox";
      batchCheckbox.checked = batchSelected;
      batchCheckbox.draggable = false;
      batchCheckbox.title = "Select to batch-delete or move categories.";
      batchCheckbox.setAttribute(
        "aria-label",
        `Check tag "${tag.name}" for bulk management`,
      );
      batchCheckbox.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      batchCheckbox.addEventListener("change", () => {
        this.toggleSkillTagBatchSelection(
          tag.id,
          batchCheckbox.checked,
        );
      });
      title.append(
        batchCheckbox,
        createElement("span", "astral-am-tag-color-bar"),
        createElement("strong", "", tag.name),
      );
      const favorite = createElement(
        "button",
        "astral-am-tag-favorite-button",
        tag.favorite ? "★" : "☆",
      );
      favorite.type = "button";
      favorite.title = tag.favorite ? "Remove Favorite" : "Favorite tags";
      favorite.setAttribute(
        "aria-pressed",
        String(Boolean(tag.favorite)),
      );
      favorite.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.toggleSkillTagFavorite(tag);
      });
      header.append(title, favorite);
      const meta = createElement("div", "astral-am-skill-tag-card-meta");
      const metaLabels = createElement(
        "div",
        "astral-am-skill-tag-card-meta-labels",
      );
      metaLabels.append(
        createElement(
          "span",
          "astral-am-chip",
          category?.name || "Uncategorized",
        ),
        ...(subcategory
          ? [
              createElement(
                "span",
                "astral-am-chip astral-am-chip-subcategory",
                subcategory.name,
              ),
            ]
          : []),
      );
      meta.append(
        metaLabels,
        createElement(
          "span",
          "astral-am-muted",
          selected ? "✓ Added to inspiration" : "Click to add to inspiration",
        ),
      );
      const actions = createElement(
        "div",
        "astral-am-skill-tag-card-actions",
      );
      const edit = createElement(
        "button",
        "astral-am-button is-small",
        "Edit",
      );
      const selectTag = createElement(
        "button",
        "astral-am-button is-small",
        selected ? "Remove from Inspiration" : "Add to Inspiration",
      );
      const remove = createElement(
        "button",
        "astral-am-button is-small is-danger",
        "Delete",
      );
      edit.type = "button";
      selectTag.type = "button";
      remove.type = "button";
      if (selected) selectTag.classList.add("is-primary");
      selectTag.setAttribute("aria-pressed", String(selected));
      edit.addEventListener("click", (event) => {
        event.stopPropagation();
        this.openSkillTagEditor(tag);
      });
      selectTag.addEventListener("click", (event) => {
        event.stopPropagation();
        this.toggleInspirationTag(tag.id);
      });
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.deleteSkillTag(tag);
      });
      actions.append(edit, selectTag, remove);
      card.addEventListener("click", (event) => {
        if (event.target.closest("button, a, input, select, textarea")) return;
        this.toggleInspirationTag(tag.id);
      });
      card.addEventListener("keydown", (event) => {
        if (event.target !== card) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.toggleInspirationTag(tag.id);
        }
      });
      card.addEventListener("contextmenu", (event) =>
        this.showSkillTagContextMenu(event, [
          {
            label: selected ? "Remove from Inspiration" : "Add to Inspiration",
            action: () => this.toggleInspirationTag(tag.id),
          },
          {
            label: "Edit Tag",
            action: () => this.openSkillTagEditor(tag),
          },
          {
            label: tag.favorite ? "Remove Favorite" : "Favorite tags",
            action: () => this.toggleSkillTagFavorite(tag),
          },
          {
            label: "Delete Tag",
            danger: true,
            action: () => this.deleteSkillTag(tag),
          },
        ]),
      );
      this.bindSkillTagDrag(card, "tags", tag.id, index);
      card.append(header, meta, actions);
      fragment.append(card);
    });
    replaceChildrenPreservingScroll(
      this.skillTagList,
      fragment,
      "data-tag-id",
    );
  }

  buildSkillTagEditor(tag) {
    const form = createElement("form", "astral-am-skill-tag-editor");
    const heading = createElement(
      "div",
      "astral-am-skill-tag-editor-heading",
    );
    heading.append(createElement("strong", "", "Edit Tag"));
    const name = createElement("input", "astral-am-input");
    name.required = true;
    name.maxLength = 80;
    name.value = tag.name;
    const category = createElement("select", "astral-am-select");
    for (const item of this.skillTagState.categories) {
      const option = createElement("option", "", item.name);
      option.value = item.id;
      category.append(option);
    }
    category.value = tag.categoryId;
    const subcategory = createElement("select", "astral-am-select");
    const syncSubcategoryOptions = (preferredId = "") => {
      const categoryId = category.value;
      const current = preferredId || subcategory.value;
      const emptyOption = createElement(
        "option",
        "",
        "Uncategorized",
      );
      emptyOption.value = "";
      subcategory.replaceChildren(emptyOption);
      for (const item of this.skillTagSubcategories(categoryId)) {
        const option = createElement("option", "", item.name);
        option.value = item.id;
        subcategory.append(option);
      }
      const matchingId = this.skillTagSubcategories(categoryId).some(
        (item) => item.id === current,
      )
        ? current
        : "";
      subcategory.value = matchingId;
      subcategory.disabled = subcategory.options.length <= 1;
    };
    syncSubcategoryOptions(tag.subcategoryId);
    category.addEventListener("change", () =>
      syncSubcategoryOptions(""),
    );
    const color = createElement("select", "astral-am-select");
    for (const item of [
      "#69a8dc",
      "#72c29a",
      "#d7b45f",
      "#de8875",
      "#b28ad8",
      "#69c5c1",
      "#9eacbd",
    ]) {
      const option = createElement("option", "", item);
      option.value = item;
      color.append(option);
    }
    color.value = tag.color;
    const favoriteLabel = createElement(
      "label",
      "astral-am-skill-tag-favorite-field",
    );
    const favorite = createElement("input");
    favorite.type = "checkbox";
    favorite.checked = Boolean(tag.favorite);
    favoriteLabel.append(favorite, createElement("span", "", "Favorite"));
    const grid = createElement("div", "astral-am-skill-tag-editor-grid");
    grid.append(
      this.createField("Tag Name", name),
      this.createField("Category", category),
      this.createField("Subcategory", subcategory),
      this.createField("Tag color", color),
      favoriteLabel,
    );
    const actions = createElement("div", "astral-am-skill-tag-editor-actions");
    const save = createElement(
      "button",
      "astral-am-button is-primary",
      "Save",
    );
    save.type = "submit";
    const remove = createElement(
      "button",
      "astral-am-button is-danger",
      "Delete Tag",
    );
    remove.type = "button";
    const cancel = createElement("button", "astral-am-button", "Cancel");
    cancel.type = "button";
    actions.append(save, remove, cancel);
    form.append(heading, grid, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.saveSkillTagEditor(tag, {
        name: name.value,
        categoryId: category.value,
        subcategoryId: subcategory.value,
        color: color.value,
        favorite: favorite.checked,
      });
    });
    remove.addEventListener("click", () => void this.deleteSkillTag(tag));
    cancel.addEventListener("click", () => {
      this.editingSkillTagId = "";
      this.renderSkillTagManager();
    });
    return form;
  }

  openSkillTagEditor(tag) {
    this.editingSkillTagId = tag.id;
    this.renderSkillTagManager();
    window.setTimeout(() => {
      this.skillTagList
        ?.querySelector(".astral-am-skill-tag-editor input")
        ?.focus();
    }, 0);
  }

  async createSkillTagCategory() {
    const name = await showAstralPrompt({
      title: "New Tag Category",
      message: "Categories organize tags, such as Art, Video, and Tools.",
      label: "Category name",
      confirmLabel: "Create Category",
      placeholder: "Enter a category name",
    });
    if (name === null || !String(name).trim()) return;
    try {
      const payload = await fetchJson(
        "/assets-astral/skill-tags/categories/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: String(name).trim() }),
        },
      );
      this.applySkillTagState(payload);
      if (payload?.category?.id) {
        this.activeSkillTagCategoryId = payload.category.id;
        this.activeSkillTagSubcategoryId = "";
        this.renderSkillTagManager();
      }
      this.setSkillTagStatus("Tag category created.", "success");
    } catch (error) {
      this.setSkillTagStatus(
        `Failed to create category: ${error.message || error}`,
        "error",
      );
    }
  }

  async renameSkillTagCategory(category) {
    const name = await showAstralPrompt({
      title: "Rename Category",
      label: "Category name",
      initialValue: category.name,
      confirmLabel: "Save Name",
    });
    if (
      name === null ||
      !String(name).trim() ||
      String(name).trim() === category.name
    ) {
      return;
    }
    try {
      const payload = await fetchJson(
        "/assets-astral/skill-tags/categories/rename",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: category.id,
            name: String(name).trim(),
          }),
        },
      );
      this.applySkillTagState(payload);
      this.setSkillTagStatus("Category name updated.", "success");
    } catch (error) {
      this.setSkillTagStatus(
        `Failed to rename category: ${error.message || error}`,
        "error",
      );
    }
  }

  async createSkillTagSubcategory(category) {
    const name = await showAstralPrompt({
      title: "New Subcategory",
      message: `Subcategories are placed under "${category.name}", e.g. count, gender or hairstyle.`,
      label: "Subcategory name",
      confirmLabel: "Create Subcategory",
      placeholder: "Enter a subcategory name",
    });
    if (name === null || !String(name).trim()) return;
    try {
      const payload = await fetchJson(
        "/assets-astral/skill-tags/subcategories/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            categoryId: category.id,
            name: String(name).trim(),
          }),
        },
      );
      this.collapsedSkillTagCategoryIds.delete(category.id);
      this.activeSkillTagCategoryId = category.id;
      this.activeSkillTagSubcategoryId =
        payload?.subcategory?.id || "";
      this.applySkillTagState(payload);
      this.setSkillTagStatus("Subcategory created.", "success");
    } catch (error) {
      this.setSkillTagStatus(
        `Failed to create subcategory: ${error.message || error}`,
        "error",
      );
    }
  }

  async renameSkillTagSubcategory(subcategory) {
    const name = await showAstralPrompt({
      title: "Rename Subcategory",
      label: "Subcategory name",
      initialValue: subcategory.name,
      confirmLabel: "Save Name",
    });
    if (
      name === null ||
      !String(name).trim() ||
      String(name).trim() === subcategory.name
    ) {
      return;
    }
    try {
      const payload = await fetchJson(
        "/assets-astral/skill-tags/subcategories/rename",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: subcategory.id,
            name: String(name).trim(),
          }),
        },
      );
      this.applySkillTagState(payload);
      this.setSkillTagStatus("Subcategory name updated.", "success");
    } catch (error) {
      this.setSkillTagStatus(
        `Failed to rename subcategory: ${error.message || error}`,
        "error",
      );
    }
  }

  async deleteSkillTagSubcategory(subcategory) {
    const category = this.skillTagCategoryById(
      subcategory.categoryId,
    );
    const tagCount = this.skillTagState.tags.filter(
      (tag) => tag.subcategoryId === subcategory.id,
    ).length;
    const confirmed = await showAstralConfirm({
      title: "Delete Subcategory",
      message:
        `Subcategory "${subcategory.name}" will be deleted. Its ${tagCount} tags` +
        ` will move back to "${category?.name || "Parent category"} / Uncategorized"; the tags themselves are not deleted.`,
      confirmLabel: "Delete Subcategory",
    });
    if (!confirmed) return;
    try {
      const payload = await fetchJson(
        "/assets-astral/skill-tags/subcategories/delete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: subcategory.id }),
        },
      );
      if (
        this.activeSkillTagSubcategoryId === subcategory.id
      ) {
        this.activeSkillTagSubcategoryId = "";
      }
      this.applySkillTagState(payload);
      this.setSkillTagStatus(
        "Subcategory deleted. Its tags were moved back to Uncategorized.",
        "success",
      );
    } catch (error) {
      this.setSkillTagStatus(
        `Failed to delete subcategory: ${error.message || error}`,
        "error",
      );
    }
  }

  async deleteSkillTagCategory(category) {
    const tagCount = this.skillTagState.tags.filter(
      (tag) => tag.categoryId === category.id,
    ).length;
    const confirmed = await showAstralConfirm({
      title: "Delete Tag Category",
      message: `"${category.name}" and its ${tagCount} inspiration tags will be deleted.`,
      confirmLabel: "Delete Category",
    });
    if (!confirmed) return;
    try {
      const payload = await fetchJson(
        "/assets-astral/skill-tags/categories/delete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: category.id }),
        },
      );
      this.activeSkillTagCategoryId = "all";
      this.activeSkillTagSubcategoryId = "";
      this.applySkillTagState(payload);
      this.setSkillTagStatus("Category and its tags deleted.", "success");
    } catch (error) {
      this.setSkillTagStatus(
        `Failed to delete category: ${error.message || error}`,
        "error",
      );
    }
  }

  async createSkillTagsBatch(
    preferredCategoryId = "",
    preferredSubcategoryId = "",
  ) {
    const explicitCategory =
      this.skillTagCategoryById(preferredCategoryId);
    const activeCategory =
      this.skillTagCategoryById(this.activeSkillTagCategoryId);
    const category =
      explicitCategory ||
      activeCategory ||
      this.skillTagState.categories[0];
    if (!category) {
      this.setSkillTagStatus("Create a tag category first.", "warning");
      return;
    }
    let subcategory = this.skillTagSubcategoryById(
      preferredSubcategoryId,
    );
    if (subcategory?.categoryId !== category.id) subcategory = null;
    if (!subcategory && !explicitCategory) {
      const activeSubcategory = this.skillTagSubcategoryById(
        this.activeSkillTagSubcategoryId,
      );
      if (
        activeSubcategory &&
        activeSubcategory.categoryId === category.id
      ) {
        subcategory = activeSubcategory;
      }
    }
    const categoryPath = subcategory
      ? `${category.name} / ${subcategory.name}`
      : category.name;
    const rawNames = await showAstralPrompt({
      title: "Bulk Add Tags",
      message:
        `Tags will be added to "${categoryPath}". ` +
        "Enter one tag per line, or separate tags with commas or semicolons.",
      label: "Tag List",
      confirmLabel: "Bulk Add",
      placeholder: "Silver hair\nRainy night\nVintage jacket\nMechanical wings",
      multiline: true,
    });
    if (rawNames === null) return;
    const names = String(rawNames)
      .split(/[\r\n,，;；]+/u)
      .map((name) => name.trim())
      .filter(Boolean);
    if (!names.length) {
      this.setSkillTagStatus("No tags can be added.", "warning");
      return;
    }
    try {
      const payload = await fetchJson(
        "/assets-astral/skill-tags/batch-create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            names,
            categoryId: category.id,
            subcategoryId: subcategory?.id || "",
          }),
        },
      );
      this.activeSkillTagCategoryId = category.id;
      this.activeSkillTagSubcategoryId = subcategory?.id || "";
      this.applySkillTagState(payload);
      this.renderSkillTagManager();
      const created = Number(payload?.createdCount) || 0;
      const skipped = Number(payload?.skippedDuplicates) || 0;
      const warnings = Array.isArray(payload?.warnings)
        ? payload.warnings.filter(Boolean)
        : [];
      let message = `Added ${created}, skipped ${skipped} duplicate tags.`;
      if (warnings.length) message += ` ${warnings[0]}`;
      this.setSkillTagStatus(
        message,
        warnings.length ? "warning" : "success",
      );
    } catch (error) {
      this.setSkillTagStatus(
        `Failed to bulk-add tags: ${error.message || error}`,
        "error",
      );
    }
  }

  async saveSkillTagEditor(tag, changes) {
    const name = String(changes.name || "").trim();
    if (!name) {
      this.setSkillTagStatus("Tag name cannot be empty.", "warning");
      return;
    }
    try {
      const payload = await fetchJson("/assets-astral/skill-tags/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: tag.id,
          name,
          categoryId: changes.categoryId,
          subcategoryId: changes.subcategoryId,
          color: changes.color,
          favorite: Boolean(changes.favorite),
        }),
      });
      this.editingSkillTagId = "";
      this.applySkillTagState(payload);
      this.setSkillTagStatus("Tag saved.", "success");
    } catch (error) {
      this.setSkillTagStatus(
        `Failed to save tag: ${error.message || error}`,
        "error",
      );
    }
  }

  async toggleSkillTagFavorite(tag) {
    try {
      const payload = await fetchJson("/assets-astral/skill-tags/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: tag.id,
          favorite: !tag.favorite,
        }),
      });
      this.applySkillTagState(payload);
      this.setSkillTagStatus(
        tag.favorite ? "Removed from favorites." : "Added to favorites.",
        "success",
      );
    } catch (error) {
      this.setSkillTagStatus(
        `Failed to update favorite: ${error.message || error}`,
        "error",
      );
    }
  }

  async deleteSkillTag(tag) {
    const confirmed = await showAstralConfirm({
      title: "Delete Tag",
      message: `Delete inspiration tag "${tag.name}"? This will not affect any Skill.`,
      confirmLabel: "Delete Tag",
    });
    if (!confirmed) return;
    try {
      const payload = await fetchJson("/assets-astral/skill-tags/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tag.id }),
      });
      if (this.editingSkillTagId === tag.id) this.editingSkillTagId = "";
      this.applySkillTagState(payload);
      this.setSkillTagStatus("Tag deleted.", "success");
    } catch (error) {
      this.setSkillTagStatus(
        `Failed to delete tag: ${error.message || error}`,
        "error",
      );
    }
  }

  async deleteSkillTagsBatch() {
    const tagIds = [...this.batchSelectedSkillTagIds];
    const selectedTags = tagIds
      .map((tagId) => this.skillTagById(tagId))
      .filter(Boolean);
    if (!selectedTags.length) {
      this.setSkillTagStatus("Select tags to delete first.", "warning");
      return;
    }
    const previewNames = selectedTags
      .slice(0, 6)
      .map((tag) => `"${tag.name}"`)
      .join(", ");
    const remaining = selectedTags.length - 6;
    const confirmed = await showAstralConfirm({
      title: "Bulk Delete Tags",
      message:
        `Delete the ${selectedTags.length} checked tags?\n` +
        `${previewNames}${remaining > 0 ? ` and ${selectedTags.length} tags in total` : ""}\n` +
        "This cannot be undone, but no Skill files will be deleted.",
      confirmLabel: `Delete ${selectedTags.length} tags`,
    });
    if (!confirmed) return;
    try {
      const payload = await fetchJson(
        "/assets-astral/skill-tags/batch-delete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tagIds: selectedTags.map((tag) => tag.id),
          }),
        },
      );
      const deletedIds = Array.isArray(payload?.deletedIds)
        ? payload.deletedIds.map(String)
        : [];
      for (const tagId of deletedIds) {
        this.batchSelectedSkillTagIds.delete(tagId);
      }
      this.applySkillTagState(payload);
      const deletedCount = Number(payload?.deletedCount) || 0;
      const missingCount = Number(payload?.missingCount) || 0;
      let message = `Deleted ${deletedCount} tags.`;
      if (missingCount > 0) {
        message += ` ${missingCount} more tags no longer exist and were ignored.`;
      }
      this.setSkillTagStatus(
        message,
        missingCount > 0 ? "warning" : "success",
      );
    } catch (error) {
      this.setSkillTagStatus(
        `Failed to bulk-delete tags: ${error.message || error}`,
        "error",
      );
    }
  }

  async moveSkillTagsBatch() {
    const tagIds = [...this.batchSelectedSkillTagIds];
    if (!tagIds.length) {
      this.setSkillTagStatus("Select tags to move first.", "warning");
      return;
    }
    const options = [];
    for (const category of this.skillTagState.categories || []) {
      options.push({
        value: JSON.stringify([category.id, ""]),
        label: `${category.name} / Uncategorized`,
      });
      for (const subcategory of this.skillTagSubcategories(category.id)) {
        options.push({
          value: JSON.stringify([category.id, subcategory.id]),
          label: `${category.name} / ${subcategory.name}`,
        });
      }
    }
    if (!options.length) {
      this.setSkillTagStatus("No destination category is available.", "warning");
      return;
    }
    const activeCategory = this.skillTagCategoryById(
      this.activeSkillTagCategoryId,
    );
    const activeSubcategory = this.skillTagSubcategoryById(
      this.activeSkillTagSubcategoryId,
    );
    const initialValue = JSON.stringify([
      activeCategory?.id || this.skillTagState.categories[0].id,
      activeCategory &&
        activeSubcategory &&
        activeSubcategory.categoryId === activeCategory.id
        ? activeSubcategory.id
        : "",
    ]);
    const selectedValue = await showAstralSelect({
      title: "Move Tag Category",
      message:
        `Move the ${tagIds.length} checked tags to a category or subcategory. ` +
        "Tags with the same name in the destination category are skipped automatically.",
      label: "Destination category",
      options,
      initialValue,
      confirmLabel: "Move Tags",
    });
    if (selectedValue === null) return;
    let targetCategoryId = "";
    let targetSubcategoryId = "";
    try {
      const parsed = JSON.parse(String(selectedValue));
      if (!Array.isArray(parsed) || parsed.length < 2) {
        throw new Error("Invalid destination category.");
      }
      [targetCategoryId, targetSubcategoryId] = parsed.map(String);
    } catch (error) {
      this.setSkillTagStatus(
        `Failed to move tags: ${error.message || error}`,
        "error",
      );
      return;
    }
    try {
      const payload = await fetchJson(
        "/assets-astral/skill-tags/batch-move",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tagIds,
            categoryId: targetCategoryId,
            subcategoryId: targetSubcategoryId,
          }),
        },
      );
      const movedIds = Array.isArray(payload?.movedIds)
        ? payload.movedIds.map(String)
        : [];
      for (const tagId of movedIds) {
        this.batchSelectedSkillTagIds.delete(tagId);
      }
      const targetCategory =
        payload?.targetCategory ||
        this.skillTagCategoryById(targetCategoryId);
      const targetSubcategory =
        payload?.targetSubcategory ||
        this.skillTagSubcategoryById(targetSubcategoryId);
      if (movedIds.length && targetCategory?.id) {
        this.collapsedSkillTagCategoryIds.delete(targetCategory.id);
        this.activeSkillTagCategoryId = targetCategory.id;
        this.activeSkillTagSubcategoryId =
          targetSubcategory?.id || "";
      }
      this.applySkillTagState(payload);
      const movedCount = Number(payload?.movedCount) || 0;
      const skippedCount = Number(payload?.skippedDuplicates) || 0;
      const skippedNames = Array.isArray(payload?.skippedNames)
        ? payload.skippedNames.filter(Boolean).map(String)
        : [];
      const missingCount = Number(payload?.missingCount) || 0;
      const targetPath = [
        targetCategory?.name,
        targetSubcategory?.name || "Uncategorized",
      ]
        .filter(Boolean)
        .join(" / ");
      let message = `Moved ${movedCount} tags to "${targetPath}".`;
      if (skippedCount > 0) {
        message +=
          ` Skipped ${skippedCount} duplicate-name tags` +
          (skippedNames.length
            ? `: ${skippedNames.slice(0, 5).join(", ")}${
                skippedNames.length > 5 ? " etc." : ""
              }.`
            : ".");
      }
      if (missingCount > 0) {
        message += ` ${missingCount} more tags no longer exist and were ignored.`;
      }
      this.setSkillTagStatus(
        message,
        skippedCount > 0 || missingCount > 0 ? "warning" : "success",
      );
    } catch (error) {
      this.setSkillTagStatus(
        `Failed to bulk-move tags: ${error.message || error}`,
        "error",
      );
    }
  }

  showSkillTagContextMenu(event, items) {
    event.preventDefault();
    event.stopPropagation();
    this.hideSkillTagContextMenu();
    const menu = createElement("nav", "astral-am-skill-tag-context-menu");
    menu.setAttribute("role", "menu");
    for (const item of items) {
      const button = createElement(
        "button",
        `astral-am-skill-tag-context-item${item.danger ? " is-danger" : ""}`,
        item.label,
      );
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.addEventListener("click", () => {
        this.hideSkillTagContextMenu();
        void item.action();
      });
      menu.append(button);
    }
    document.body.append(menu);
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(
      margin,
      Math.min(event.clientX + 3, window.innerWidth - rect.width - margin),
    )}px`;
    menu.style.top = `${Math.max(
      margin,
      Math.min(event.clientY + 3, window.innerHeight - rect.height - margin),
    )}px`;
    const close = (pointerEvent) => {
      if (pointerEvent?.target && menu.contains(pointerEvent.target)) return;
      this.hideSkillTagContextMenu();
    };
    const keydown = (keyboardEvent) => {
      if (keyboardEvent.key === "Escape") this.hideSkillTagContextMenu();
    };
    window.setTimeout(() => {
      if (this.skillTagContextMenu?.element !== menu) return;
      document.addEventListener("pointerdown", close, true);
      document.addEventListener("keydown", keydown, true);
    }, 0);
    this.skillTagContextMenu = { element: menu, close, keydown };
  }

  hideSkillTagContextMenu() {
    const menu = this.skillTagContextMenu;
    if (!menu) return;
    document.removeEventListener("pointerdown", menu.close, true);
    document.removeEventListener("keydown", menu.keydown, true);
    menu.element.remove();
    this.skillTagContextMenu = null;
  }

  bindSkillTagDrag(
    element,
    kind,
    id,
    index,
    parentCategoryId = "",
  ) {
    element.addEventListener("dragstart", (event) => {
      this.skillTagDrag = { kind, id, parentCategoryId };
      element.classList.add("is-dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", `${kind}:${id}`);
      }
    });
    element.addEventListener("dragend", () => {
      this.skillTagDrag = null;
      element.classList.remove("is-dragging");
      this.skillTagList
        ?.querySelectorAll(".is-drop-target")
        .forEach((item) => item.classList.remove("is-drop-target"));
      this.skillTagCategoryList
        ?.querySelectorAll(".is-drop-target")
        .forEach((item) => item.classList.remove("is-drop-target"));
    });
    element.addEventListener("dragover", (event) => {
      if (
        !this.skillTagDrag ||
        this.skillTagDrag.kind !== kind ||
        this.skillTagDrag.id === id ||
        (kind === "subcategories" &&
          this.skillTagDrag.parentCategoryId !== parentCategoryId)
      ) {
        return;
      }
      event.preventDefault();
      element.classList.add("is-drop-target");
    });
    element.addEventListener("dragleave", () => {
      element.classList.remove("is-drop-target");
    });
    element.addEventListener("drop", (event) => {
      event.preventDefault();
      element.classList.remove("is-drop-target");
      if (
        !this.skillTagDrag ||
        this.skillTagDrag.kind !== kind ||
        this.skillTagDrag.id === id ||
        (kind === "subcategories" &&
          this.skillTagDrag.parentCategoryId !== parentCategoryId)
      ) {
        return;
      }
      const records =
        kind === "categories"
          ? this.skillTagState.categories
          : kind === "subcategories"
            ? this.skillTagState.subcategories
            : this.skillTagState.tags;
      const orderedIds = records.map((item) => item.id);
      const sourceIndex = orderedIds.indexOf(this.skillTagDrag.id);
      const targetIndex = orderedIds.indexOf(id);
      if (sourceIndex < 0 || targetIndex < 0) return;
      orderedIds.splice(sourceIndex, 1);
      orderedIds.splice(targetIndex, 0, this.skillTagDrag.id);
      void this.saveSkillTagOrder(kind, orderedIds);
      this.skillTagDrag = null;
    });
  }

  async saveSkillTagOrder(kind, orderedIds) {
    try {
      const payload = await fetchJson("/assets-astral/skill-tags/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, orderedIds }),
      });
      this.applySkillTagState(payload);
      this.setSkillTagStatus("Order saved.", "success");
    } catch (error) {
      this.setSkillTagStatus(
        `Failed to save order: ${error.message || error}`,
        "error",
      );
      await this.loadSkillTags(true);
    }
  }

  setSkillStatus(message, kind = "") {
    updateStatusPreservingScroll(
      this.skillStatus,
      message,
      kind,
      this.skillList,
      "data-skill-id",
    );
  }

  async loadSkills(force = false, preserveScroll = false) {
    if (this.skillsPromise && !force) return this.skillsPromise;
    this.hideSkillPreview();
    if (force) this.skillContentCache.clear();
    this.skillRefreshButton.disabled = true;
    this.setSkillStatus("Scanning custom_nodes and input...", "loading");
    this.skillsPromise = fetchJson("/assets-astral/skills")
      .then((payload) => {
        this.skills = Array.isArray(payload?.items) ? payload.items : [];
        this.skillRoots = Array.isArray(payload?.roots)
          ? payload.roots.filter(Boolean).map(String)
          : payload?.root
            ? [String(payload.root)]
            : [];
        this.skillRoot = this.skillRoots.join("; ") || payload?.root || "";
        this.skillRootLabel.textContent = this.skillRoots.length
          ? `Skill scan directories: ${this.skillRoots.join("; ")}`
          : "";
        this.skillSummary.textContent = `${this.skills.length} Skills`;
        this.renderSkills(preserveScroll);
        this.setSkillStatus(
          this.skills.length
            ? ""
            : "No Skills found. Add SKILL.md files to a custom_nodes package or the input directory.",
          this.skills.length ? "" : "empty",
        );
        this.skillsLoaded = true;
        this.renderChatSelection();
      })
      .catch((error) => {
        this.skillsPromise = null;
        this.setSkillStatus(`Failed to read Skills: ${error.message || error}`, "error");
      })
      .finally(() => {
        this.skillRefreshButton.disabled = false;
      });
    return this.skillsPromise;
  }

  renderSkills(preserveScroll = false) {
    const replaceList = (children = null) => {
      if (preserveScroll) {
        replaceChildrenPreservingScroll(
          this.skillList,
          children,
          "data-skill-id",
        );
      } else if (children === null) {
        this.skillList.replaceChildren();
      } else {
        this.skillList.replaceChildren(children);
      }
    };
    this.hideSkillPreview();
    if (!this.skills.length) {
      this.skillSummary.textContent = "0 Skills";
      replaceList();
      return;
    }
    const query = this.skillSearch?.value.trim() || "";
    const matchingSkills = this.skills.filter((skill) =>
      this.skillMatchesSearch(skill, query),
    );
    this.skillSummary.textContent =
      query
        ? `Found ${matchingSkills.length} / ${this.skills.length} Skills`
        : `${this.skills.length} Skills`;
    if (!matchingSkills.length) {
      replaceList(
        createElement(
          "p",
          "astral-am-skill-search-empty",
          `No Skills match "${query}". Try a different keyword.`,
        ),
      );
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const skill of matchingSkills) {
      const card = createElement("article", "astral-am-skill-card");
      const header = createElement("div", "astral-am-skill-header");
      const heading = createElement("div", "astral-am-skill-heading");
      heading.append(
        createElement("strong", "", skill.name),
        createElement("span", "astral-am-skill-id", skill.id),
      );
      header.append(
        heading,
        createElement("span", "astral-am-muted", formatBytes(skill.size)),
      );
      const description = createElement(
        "p",
        "astral-am-skill-description",
        skill.description || "This Skill has no frontmatter description.",
      );
      const meta = createElement("div", "astral-am-skill-meta");
      meta.append(
        ...(skill.source
          ? [createElement("span", "astral-am-chip", `Source: ${skill.source}`)]
          : []),
        createElement("span", "astral-am-chip", skill.fileName),
        ...(Array.isArray(skill.references)
          ? skill.references.map((reference) =>
              createElement("span", "astral-am-chip", reference),
            )
          : []),
      );
      const actions = createElement("div", "astral-am-template-actions");
      const preview = createElement(
        "button",
        "astral-am-button is-small",
        "View SKILL",
      );
      const openDirectory = createElement(
        "button",
        "astral-am-button is-small",
        "Open folder",
      );
      const isCurrentSkill = this.pendingSkillIds.includes(skill.id);
      const hasCurrentSkill = this.pendingSkillIds.length > 0;
      const addToChat = createElement(
        "button",
        "astral-am-button is-small is-primary",
        isCurrentSkill
          ? "Current Session Skill"
          : hasCurrentSkill
            ? "Switch to this Skill"
            : "Add to Conversation",
      );
      preview.type = "button";
      openDirectory.type = "button";
      addToChat.type = "button";
    openDirectory.title = "Open this Skill's folder in the system file manager and select it.";
      addToChat.dataset.chatSkillId = skill.id;
      addToChat.disabled = isCurrentSkill;
      addToChat.title = isCurrentSkill
        ? "This Skill is already loaded in the session."
        : hasCurrentSkill
          ? "Switching replaces the Skill in the current conversation."
          : "Add this Skill to the current conversation.";
      card.dataset.skillId = skill.id;
      card.classList.toggle("is-current", isCurrentSkill);
      preview.addEventListener("click", () => void this.showSkillContent(skill));
      openDirectory.addEventListener(
        "click",
        () => void this.openSkillDirectory(skill),
      );
      addToChat.addEventListener(
        "click",
        () => void this.addSkillToChat(skill.id),
      );
      actions.append(preview, openDirectory, addToChat);
      card.append(header, description, meta, actions);
      fragment.append(card);
    }
    replaceList(fragment);
  }

  async openSkillDirectory(skill) {
    this.setSkillStatus(`Locating "${skill.name}"...`, "loading");
    try {
      const result = await fetchJson("/assets-astral/skills/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: skill.id }),
      });
      this.setSkillStatus(
        result?.revealMode === "selected"
          ? `Selected ${skill.fileName} in system file manager.`
          : `Opened the folder containing "${skill.name}"; the current file manager did not confirm automatic selection of ${skill.fileName}.`,
        "success",
      );
    } catch (error) {
      this.setSkillStatus(
        `Failed to open Skill directory: ${error.message || error}`,
        "error",
      );
    }
  }

  skillMatchesSearch(skill, query) {
    const tokens = String(query || "")
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (!tokens.length) return true;
    const fields = [
      skill?.name,
      skill?.label,
      skill?.id,
      skill?.description,
      skill?.source,
      skill?.fileName,
      skill?.relativeDirectory,
      ...(Array.isArray(skill?.references) ? skill.references : []),
    ];
    const haystack = fields
      .filter((value) => typeof value === "string" && value)
      .join("\n")
      .toLocaleLowerCase();
    return tokens.every((token) => haystack.includes(token));
  }

  ensureSkillPreviewElement() {
    if (!this.skillPreviewElement) {
      this.skillPreviewElement = createElement(
        "aside",
        "astral-am-skill-hover-preview",
      );
      this.skillPreviewElement.hidden = true;
      this.skillPreviewElement.setAttribute("role", "tooltip");
    }
    if (!this.skillPreviewElement.isConnected) {
      document.body.append(this.skillPreviewElement);
    }
    return this.skillPreviewElement;
  }

  positionSkillPreview(anchor) {
    const preview = this.skillPreviewElement;
    if (!preview || preview.hidden || !anchor?.isConnected) return;
    const margin = 12;
    const gap = 10;
    const anchorRect = anchor.getBoundingClientRect();
    preview.style.visibility = "hidden";
    const previewRect = preview.getBoundingClientRect();
    const width = previewRect.width;
    const height = previewRect.height;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    let left = anchorRect.right + gap;
    let top = anchorRect.top;

    if (left > maxLeft) {
      const leftSide = anchorRect.left - width - gap;
      left =
        leftSide >= margin
          ? leftSide
          : Math.min(maxLeft, Math.max(margin, anchorRect.left));
    }
    if (top + height > window.innerHeight - margin) {
      top = anchorRect.bottom + gap;
      if (top + height > window.innerHeight - margin) {
        top = anchorRect.top - height - gap;
      }
    }
    top = Math.min(maxTop, Math.max(margin, top));

    preview.style.left = `${Math.round(left)}px`;
    preview.style.top = `${Math.round(top)}px`;
    preview.style.visibility = "visible";
  }

  renderSkillPreview(
    skill,
    content,
    anchor,
    state = "",
    previewLabel = "Hover Preview · Excerpt",
  ) {
    const preview = this.ensureSkillPreviewElement();
    const header = createElement("div", "astral-am-skill-preview-header");
    header.append(
      createElement("strong", "", skill.name),
      createElement(
        "span",
        "",
        state === "loading" ? "Loading content..." : previewLabel,
      ),
    );
    const body = createElement(
      "div",
      `astral-am-skill-preview-body${state ? ` is-${state}` : ""}`,
      content,
    );
    preview.replaceChildren(header, body);
    preview.hidden = false;
    this.positionSkillPreview(anchor);
  }

  scheduleSkillPreview(skill, anchor) {
    this.hideSkillPreview();
    const requestId = ++this.skillPreviewRequestId;
    this.skillPreviewAnchor = anchor;
    this.skillPreviewTimer = window.setTimeout(() => {
      this.skillPreviewTimer = null;
      if (
        this.mode !== "chat" ||
        this.skillPreviewAnchor !== anchor ||
        !anchor.isConnected
      ) {
        return;
      }
      const cached = this.skillContentCache.get(skill.id);
      if (cached) {
        this.renderSkillPreview(
          skill,
          skillPreviewExcerpt(cached.content),
          anchor,
        );
        return;
      }
      this.renderSkillPreview(
        skill,
        "Loading Skill content...",
        anchor,
        "loading",
      );
      void this.loadSkillContent(skill.id)
        .then((detail) => {
          if (
            requestId !== this.skillPreviewRequestId ||
            this.skillPreviewAnchor !== anchor ||
            !anchor.isConnected
          ) {
            return;
          }
          this.renderSkillPreview(
            skill,
            skillPreviewExcerpt(detail.content),
            anchor,
          );
        })
        .catch((error) => {
          if (
            requestId !== this.skillPreviewRequestId ||
            this.skillPreviewAnchor !== anchor
          ) {
            return;
          }
          this.renderSkillPreview(
            skill,
            `Preview failed: ${error.message || error}`,
            anchor,
            "error",
          );
        });
    }, 320);
  }

  scheduleSystemPromptPreview(template, anchor) {
    this.hideSkillPreview();
    this.skillPreviewAnchor = anchor;
    this.skillPreviewTimer = window.setTimeout(() => {
      this.skillPreviewTimer = null;
      if (
        this.mode !== "chat" ||
        this.skillPreviewAnchor !== anchor ||
        !anchor.isConnected
      ) {
        return;
      }
      this.renderSkillPreview(
        { name: template.title || "System Prompt" },
        skillPreviewExcerpt(template.content),
        anchor,
        "",
        "System Prompt · Hover to Preview",
      );
    }, 320);
  }

  hideSkillPreview(anchor = null) {
    if (
      anchor &&
      this.skillPreviewAnchor &&
      this.skillPreviewAnchor !== anchor
    ) {
      return;
    }
    if (this.skillPreviewTimer !== null) {
      window.clearTimeout(this.skillPreviewTimer);
      this.skillPreviewTimer = null;
    }
    this.skillPreviewRequestId += 1;
    this.skillPreviewAnchor = null;
    if (this.skillPreviewElement) {
      this.skillPreviewElement.hidden = true;
      this.skillPreviewElement.style.visibility = "";
    }
  }

  async loadSkillContent(skillId) {
    if (this.skillContentCache.has(skillId)) {
      return this.skillContentCache.get(skillId);
    }
    const detail = await fetchJson(
      `/assets-astral/skills/content?${queryString({ id: skillId })}`,
    );
    this.skillContentCache.set(skillId, detail);
    return detail;
  }

  async showSkillContent(skill) {
    this.hideSkillPreview();
    try {
      const detail = await this.loadSkillContent(skill.id);
      const dialog = createElement("dialog", "astral-am-skill-dialog");
      const shell = createElement("div", "astral-am-skill-dialog-shell");
      const header = createElement("div", "astral-am-editor-header");
      const heading = createElement("div", "astral-am-skill-dialog-heading");
      heading.append(
        createElement("strong", "", skill.name),
        createElement(
          "span",
          "astral-am-muted",
          `${detail.fileName || skill.fileName} · ${skill.id}`,
        ),
      );
      const close = createElement("button", "astral-am-icon-button", "×");
      close.type = "button";
      close.addEventListener("click", () => dialog.close());
      header.append(heading, close);
      const content = createElement(
        "pre",
        "astral-am-skill-content",
        detail.content || "",
      );
      shell.append(header, content);
      dialog.append(shell);
      document.body.append(dialog);
      dialog.addEventListener("close", () => dialog.remove());
      dialog.showModal();
    } catch (error) {
      this.setSkillStatus(`Failed to read Skill content: ${error.message || error}`, "error");
    }
  }
}

class LoraSourceBrowser {
  constructor() {
    this.items = [];
    this.offset = 0;
    this.total = 0;
    this.query = "";
    this.loading = false;
    this.hasMore = false;
    this.requestId = 0;
    this.selected = new Map();
    this.selectionPool = new Map();
    this.selectionScopeComplete = false;
    this.selectionLoading = false;
    this.operationBusy = false;
    this.results = new Map();
    this.loadingSources = new Set();
    this.roots = [];
    this.rootIndex = 0;
    this.currentPath = "";
    this.build();
  }

  build() {
    const section = createElement("section", "astral-am-pane astral-am-loras-pane");
    const toolbar = createElement("div", "astral-am-toolbar");

    const search = createElement("input", "astral-am-search");
    search.type = "search";
    search.placeholder = "Search local LoRA files";
    search.autocomplete = "off";
    search.setAttribute("aria-label", "Search LoRAs");

    const querySelected = createElement("button", "astral-am-button is-primary", "Query Selected");
    querySelected.type = "button";
    querySelected.disabled = true;

    const selectAll = createElement("button", "astral-am-button", "Select All");
    selectAll.type = "button";
    const invertSelection = createElement("button", "astral-am-button", "Invert");
    invertSelection.type = "button";

    const thumbnailToggle = createElement("label", "astral-am-check");
    const thumbnailCheckbox = createElement("input");
    thumbnailCheckbox.type = "checkbox";
    thumbnailCheckbox.checked = showLoraThumbnails();
    thumbnailToggle.append(thumbnailCheckbox, document.createTextNode("Show thumbnails"));
    toolbar.append(
      search,
      selectAll,
      invertSelection,
      querySelected,
      thumbnailToggle,
    );

    const location = markUntranslated(
      createElement("div", "astral-am-model-location"),
    );
    const browser = createElement(
      "div",
      "astral-am-model-browser astral-am-lora-browser",
    );
    const tree = markUntranslated(
      createElement("aside", "astral-am-model-tree astral-am-lora-tree"),
    );
    const content = createElement("div", "astral-am-model-content");

    const fileActions = createElement("div", "astral-am-file-actions");
    const clearSelection = createElement(
      "button",
      "astral-am-button is-small",
      "Clear Selection",
    );
    const moveSelected = createElement(
      "button",
      "astral-am-button is-small",
      "Move to Folder",
    );
    const insertSelected = createElement(
      "button",
      "astral-am-button is-small",
      "Add to Canvas",
    );
    const deleteSelected = createElement(
      "button",
      "astral-am-button is-small is-danger",
      "Delete Selected",
    );
    for (const button of [
      clearSelection,
      moveSelected,
      insertSelected,
      deleteSelected,
    ]) {
      button.type = "button";
    }
    moveSelected.title = "Move selected LoRAs to another LoRA folder.";
    insertSelected.title =
      `Place the checked LoRAs on the current canvas using the official LoRA Loader node; up to ${MAX_LORA_CANVAS_BATCH} at a time`;
    deleteSelected.title = "Move selected LoRAs to the Windows Recycle Bin.";
    fileActions.append(
      clearSelection,
      moveSelected,
      insertSelected,
      deleteSelected,
    );

    const summary = createElement("div", "astral-am-summary");
    const status = createElement("div", "astral-am-status");
    const list = createElement(
      "div",
      "astral-am-lora-list astral-am-lora-browser-list",
    );

    const locationHeader = createElement("div", "astral-am-model-header");
    locationHeader.append(location, fileActions);
    content.append(summary, status, list);
    browser.append(tree, content);
    section.append(toolbar, locationHeader, browser);
    this.element = section;
    this.search = search;
    this.selectAll = selectAll;
    this.invertSelectionButton = invertSelection;
    this.querySelected = querySelected;
    this.thumbnailCheckbox = thumbnailCheckbox;
    this.breadcrumb = location;
    this.browser = browser;
    this.tree = tree;
    this.content = content;
    this.actionBar = fileActions;
    this.clearSelectionButton = clearSelection;
    this.moveSelectedButton = moveSelected;
    this.insertSelectedButton = insertSelected;
    this.deleteSelectedButton = deleteSelected;
    this.summary = summary;
    this.status = status;
    this.list = list;

    search.addEventListener(
      "input",
      debounce(() => {
        this.query = search.value.trim();
        this.clearSelection();
        void this.load(true);
      }, 250),
    );
    selectAll.addEventListener("click", () => void this.selectAllItems());
    invertSelection.addEventListener("click", () => void this.invertSelection());
    querySelected.addEventListener("click", () => void this.querySelectedSources());
    thumbnailCheckbox.addEventListener("change", () => {
      setShowLoraThumbnails(thumbnailCheckbox.checked);
      this.renderList();
    });
    clearSelection.addEventListener("click", () => this.clearSelection());
    moveSelected.addEventListener("click", () => void this.moveSelectedItems());
    insertSelected.addEventListener("click", () => this.insertSelectedItems());
    deleteSelected.addEventListener("click", () => void this.recycleSelected());
    installAutoLoadOnScroll(
      list,
      () => this.hasMore && !this.loading,
      () => void this.load(false),
    );
  }

  setStatus(message, kind = "") {
    updateStatusPreservingScroll(
      this.status,
      message,
      kind,
      this.list,
      "data-lora-key",
    );
  }

  selectedItems() {
    return [...this.selected.values()];
  }

  updateSelectionButtons() {
    const count = this.selected.size;
    const busy =
      this.operationBusy ||
      this.loading ||
      this.selectionLoading;
    this.querySelected.disabled =
      busy || count === 0 || this.loadingSources.size > 0;
    this.querySelected.textContent = count ? `Query Selected (${count})` : "Query Selected";
    const hasItems = this.total > 0;
    const allSelected =
      hasItems &&
      this.selectionScopeComplete &&
      this.selectionPool.size > 0 &&
      [...this.selectionPool.keys()].every((key) => this.selected.has(key));
    this.selectAll.disabled = busy || !hasItems || allSelected;
    this.invertSelectionButton.disabled = busy || !hasItems;
    this.clearSelectionButton.disabled = busy || count === 0;
    this.moveSelectedButton.disabled = busy || count === 0;
    this.insertSelectedButton.disabled = busy || count === 0;
    this.deleteSelectedButton.disabled = busy || count === 0;
    this.selectAll.textContent = this.selectionLoading
      ? "Selecting all..."
      : hasItems
        ? `Select All (${this.total})`
        : "Select All";
    this.moveSelectedButton.textContent = count
      ? `Move to Folder (${count})`
      : "Move to Folder";
    this.insertSelectedButton.textContent =
      count > MAX_LORA_CANVAS_BATCH
        ? `Add to Canvas (first ${MAX_LORA_CANVAS_BATCH}/${count})`
        : count
          ? `Add to Canvas (${count})`
          : "Add to Canvas";
    this.deleteSelectedButton.textContent = count
      ? `Delete Selected (${count})`
      : "Delete Selected";
    this.actionBar.dataset.selectedCount = String(count);
    this.summary.textContent =
      `${this.total} LoRAs in the current folder and subfolders, showing ${this.items.length}` +
      (count ? ` · ${count} selected` : "");
  }

  syncSelectionRows() {
    for (const row of this.list.querySelectorAll("[data-lora-key]")) {
      const selected = this.selected.has(row.dataset.loraKey);
      row.classList.toggle("is-selected", selected);
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (checkbox) checkbox.checked = selected;
    }
    this.updateSelectionButtons();
  }

  clearSelection() {
    this.selected.clear();
    this.syncSelectionRows();
  }

  resetSelectionScope() {
    this.selectionPool.clear();
    this.selectionScopeComplete = false;
    this.clearSelection();
  }

  scopeSignature() {
    return JSON.stringify([
      Number(this.rootIndex) || 0,
      this.currentPath,
      this.search.value.trim(),
    ]);
  }

  async fetchSelectionScope() {
    const signature = this.scopeSignature();
    const collected = [];
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const payload = await fetchJson(
        `/assets-astral/loras?${queryString({
          root_index: Number(this.rootIndex) || 0,
          path: this.currentPath,
          q: this.search.value.trim(),
          offset,
          limit: 500,
        })}`,
      );
      if (signature !== this.scopeSignature()) return null;
      const page = Array.isArray(payload?.items) ? payload.items : [];
      collected.push(...page);
      offset += page.length;
      hasMore = Boolean(payload?.hasMore) && page.length > 0;
    }
    return collected;
  }

  async selectAllItems() {
    if (
      this.operationBusy ||
      this.selectionLoading ||
      this.total <= 0
    ) {
      return;
    }
    this.selectionLoading = true;
    this.updateSelectionButtons();
    this.setStatus("Loading every LoRA in the current folder and its subdirectories...", "loading");
    try {
      const items = await this.fetchSelectionScope();
      if (!items) return;
      this.selectionPool = new Map(
        items.map((item) => [loraSelectionKey(item), item]),
      );
      this.selectionScopeComplete = true;
      this.selected = new Map(this.selectionPool);
      this.syncSelectionRows();
      this.setStatus(
        `Selected all ${this.selected.size} LoRAs in the current folder and subfolders, including files not yet loaded.`,
        "success",
      );
    } catch (error) {
      this.setStatus(`Select All failed: ${error.message || error}`, "error");
    } finally {
      this.selectionLoading = false;
      this.updateSelectionButtons();
    }
  }

  async invertSelection() {
    if (
      this.operationBusy ||
      this.selectionLoading ||
      this.total <= 0
    ) {
      return;
    }
    this.selectionLoading = true;
    this.updateSelectionButtons();
    this.setStatus("Loading every LoRA in the current folder and its subdirectories...", "loading");
    try {
      const items = await this.fetchSelectionScope();
      if (!items) return;
      const previous = new Set(this.selected.keys());
      this.selectionPool = new Map(
        items.map((item) => [loraSelectionKey(item), item]),
      );
      this.selectionScopeComplete = true;
      this.selected = new Map();
      for (const [key, item] of this.selectionPool) {
        if (!previous.has(key)) this.selected.set(key, item);
      }
      this.syncSelectionRows();
      this.setStatus(
        `Inverted selection, ${this.selected.size} LoRAs selected.`,
        "success",
      );
    } catch (error) {
      this.setStatus(`Invert failed: ${error.message || error}`, "error");
    } finally {
      this.selectionLoading = false;
      this.updateSelectionButtons();
    }
  }

  async load(reset, preserveScroll = false) {
    // Let a newer search replace an in-flight query instead of dropping it.
    if (this.loading && !reset) return;
    const scrollState =
      !reset || preserveScroll
        ? captureScrollState(this.list, "data-lora-key")
        : null;
    this.loading = true;
    this.requestId += 1;
    const requestId = this.requestId;
    if (reset) {
      this.offset = 0;
      this.items = [];
      this.hasMore = false;
      this.selectionPool.clear();
      this.selectionScopeComplete = false;
      if (!scrollState) this.list.replaceChildren();
    }
    this.setStatus(reset ? "Loading LoRAs..." : "Loading more LoRAs...", "loading");
    try {
      const payload = await fetchJson(
        `/assets-astral/loras?${queryString({
          root_index: Number(this.rootIndex) || 0,
          path: this.currentPath,
          q: this.search.value.trim(),
          offset: this.offset,
          limit: LORA_PAGE_SIZE,
        })}`,
      );
      if (requestId !== this.requestId) return;
      const page = Array.isArray(payload?.items) ? payload.items : [];
      this.items.push(...page);
      if (Array.isArray(payload?.roots)) this.roots = payload.roots;
      this.offset += page.length;
      this.total = Number(payload?.total) || 0;
      this.hasMore = Boolean(payload?.hasMore);
      await this.restoreCachedSources(page);
      if (requestId !== this.requestId) return;
      for (const item of page) {
        this.selectionPool.set(loraSelectionKey(item), item);
      }
      if (!this.hasMore) this.selectionScopeComplete = true;
      this.summary.textContent =
        `${this.total} LoRAs in the current folder and subfolders, showing ${this.items.length}` +
        (this.selected.size ? ` · ${this.selected.size} selected` : "");
      if (reset) {
        this.renderList(scrollState);
      } else {
        const fragment = document.createDocumentFragment();
        for (const item of page) fragment.append(this.createRow(item));
        appendChildrenPreservingScroll(
          this.list,
          fragment,
          "data-lora-key",
          scrollState,
        );
        this.updateSelectionButtons();
      }
      this.setStatus(page.length ? "" : this.items.length ? "No more LoRAs" : "No LoRAs found", "empty");
    } catch (error) {
      if (requestId === this.requestId) this.setStatus(`Read failed: ${error.message || error}`, "error");
    } finally {
      if (requestId === this.requestId) {
        this.loading = false;
        this.updateSelectionButtons();
      }
    }
  }

  async restoreCachedSources(items) {
    const files = [
      ...new Set(
        (Array.isArray(items) ? items : [])
          .map((item) => String(item?.file || "").trim())
          .filter(Boolean),
      ),
    ];
    if (!files.length) return;
    try {
      const payload = await fetchJson("/assets-astral/loras/sources/cached", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
      for (const result of payload?.items || []) {
        if (result?.file && !this.results.has(result.file)) {
          this.results.set(result.file, result);
        }
      }
    } catch (error) {
      console.warn(
        "[Astral Asset Management] Unable to restore persisted LoRA source data.",
        error,
      );
    }
  }

  async loadTree() {
    this.tree.replaceChildren(
      createElement("span", "astral-am-muted", "Loading LoRA folders..."),
    );
    try {
      const primaryPayload = await fetchJson(
        `/assets-astral/loras/tree?${queryString({
          root_index: this.roots.length
            ? Number(this.rootIndex) || 0
            : undefined,
          path: this.currentPath,
        })}`,
      );
      if (Array.isArray(primaryPayload?.roots)) {
        this.roots = primaryPayload.roots;
      }
      this.rootIndex = Number(primaryPayload?.rootIndex) || 0;
      const payloads = [{ payload: primaryPayload }];
      const otherRoots = this.roots.filter(
        (root) =>
          root.exists !== false &&
          Number(root.index) !== Number(primaryPayload?.rootIndex),
      );
      const secondary = await Promise.all(
        otherRoots.map(async (root) => {
          try {
            const payload = await fetchJson(
              `/assets-astral/loras/tree?${queryString({
                root_index: root.index,
                path: "",
              })}`,
            );
            return { payload };
          } catch (error) {
            return { root, error };
          }
        }),
      );
      payloads.push(...secondary);
      this.renderTree(payloads);
    } catch (error) {
      this.tree.replaceChildren(
        createElement(
          "span",
          "astral-am-source-error",
          `Failed to read LoRA directory: ${error.message || error}`,
        ),
      );
    }
  }

  navigate(rootIndex, path = "") {
    this.rootIndex = Number(rootIndex) || 0;
    this.currentPath = String(path || "");
    this.resetSelectionScope();
    this.results.clear();
    void this.loadTree();
    void this.load(true);
  }

  renderTree(payloads) {
    const fragment = document.createDocumentFragment();
    const crumbs = createElement("div", "astral-am-breadcrumb-items");
    const currentRoot =
      this.roots.find(
        (root) => Number(root.index) === Number(this.rootIndex),
      ) || null;
    const currentPayload = payloads.find(
      (entry) => Number(entry.payload?.rootIndex) === Number(this.rootIndex),
    )?.payload;
    const currentRootPath =
      currentRoot?.path || currentPayload?.rootPath || "";
    const rootLabel = pathBasename(currentRootPath);
    const rootButton = createElement("button", "astral-am-crumb", rootLabel);
    rootButton.type = "button";
    rootButton.title = currentRootPath || "LoRA";
    rootButton.addEventListener("click", () => this.navigate(this.rootIndex, ""));
    crumbs.append(rootButton);
    const currentParts = this.currentPath
      ? this.currentPath.split("/").filter(Boolean)
      : [];
    currentParts.forEach((part, index) => {
      crumbs.append(createElement("span", "astral-am-crumb-separator", "/"));
      const path = currentParts.slice(0, index + 1).join("/");
      const button = createElement("button", "astral-am-crumb", part);
      button.type = "button";
      button.addEventListener("click", () => this.navigate(this.rootIndex, path));
      crumbs.append(button);
    });
    this.breadcrumb.replaceChildren(crumbs);
    if (currentRootPath) {
      const locationLine = createElement(
        "span",
        "astral-am-location-path",
        this.currentPath
          ? `${currentRootPath} / ${this.currentPath}`
          : `${currentRootPath} (root)`,
      );
      this.breadcrumb.append(locationLine);
    }

    for (const entry of payloads) {
      const payload = entry.payload;
      const rootIndex = Number(
        payload?.rootIndex ?? entry.root?.index ?? this.rootIndex,
      );
      const rootData =
        this.roots.find((root) => Number(root.index) === rootIndex) ||
        entry.root ||
        null;
      const group = createElement("section", "astral-am-tree-root");
      const rootRow = createElement("div", "astral-am-tree-row");
      const treePath =
        rootIndex === Number(this.rootIndex) ? this.currentPath : "";
      const rootPath = payload?.rootPath || rootData?.path || "";
      const rootTitle = treePath
        ? pathBasename(treePath, pathBasename(rootPath))
        : pathBasename(rootPath);
      const rootHeader = createElement(
        "button",
        "astral-am-tree-root-button",
        rootTitle,
      );
      rootHeader.type = "button";
      rootHeader.title = treePath ? `${rootPath} / ${treePath}` : rootPath;
      rootHeader.classList.toggle(
        "is-current",
        rootIndex === Number(this.rootIndex),
      );
      rootHeader.addEventListener(
        "click",
        () => this.navigate(rootIndex, treePath),
      );
      const openRoot = createElement("button", "astral-am-tree-open", "📁");
      openRoot.type = "button";
    openRoot.title = `Open ${rootPath}${treePath ? ` / ${treePath}` : ""} in system file manager`;
      openRoot.addEventListener(
        "click",
        () => void this.openLocation(rootIndex, treePath, false),
      );
      rootRow.append(rootHeader, openRoot);
      group.append(rootRow);

      if (entry.error) {
        group.append(
          createElement(
            "span",
            "astral-am-source-error",
            String(entry.error.message || entry.error),
          ),
        );
      } else {
        const directories = Array.isArray(payload?.directories)
          ? payload.directories
          : [];
        if (!directories.length) {
          group.append(
            createElement(
              "span",
              "astral-am-muted astral-am-tree-empty",
              "No subdirectories",
            ),
          );
        } else {
          const list = createElement("div", "astral-am-tree-children");
          for (const directory of directories) {
            const row = createElement("div", "astral-am-tree-row");
            const button = createElement(
              "button",
              "astral-am-tree-item",
              `▸ ${directory.name}`,
            );
            button.type = "button";
            button.title = directory.path;
            button.classList.toggle(
              "is-current",
              rootIndex === Number(this.rootIndex) &&
                this.currentPath === directory.path,
            );
            button.addEventListener(
              "click",
              () => this.navigate(rootIndex, directory.path),
            );
            const openDirectory = createElement(
              "button",
              "astral-am-tree-open",
              "📁",
            );
            openDirectory.type = "button";
    openDirectory.title = `Open ${directory.path} in system file manager`;
            openDirectory.addEventListener(
              "click",
              () =>
                void this.openLocation(
                  rootIndex,
                  directory.path,
                  false,
                ),
            );
            row.append(button, openDirectory);
            list.append(row);
          }
          group.append(list);
        }
      }
      fragment.append(group);
    }
    this.tree.replaceChildren(fragment);
  }

  async openLocation(rootIndex, path = "", select = false) {
    try {
      const result = await fetchJson("/assets-astral/loras/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rootIndex: Number(rootIndex) || 0,
          path,
          kind: select && path ? "file" : "directory",
        }),
      });
      this.setStatus(
        result?.revealMode === "selected"
          ? `Revealed in system file manager: ${path}`
          : `Opened: ${result?.absolutePath || path || "LoRA root"}`,
        "success",
      );
    } catch (error) {
      this.setStatus(
        `Failed to open LoRA directory: ${error.message || error}`,
        "error",
      );
    }
  }

  renderList(scrollState = null) {
    const fragment = document.createDocumentFragment();
    for (const item of this.items) fragment.append(this.createRow(item));
    replaceChildrenPreservingScroll(
      this.list,
      fragment,
      "data-lora-key",
      scrollState,
    );
    this.updateSelectionButtons();
  }

  updateRowsPreservingScroll(files, scrollState = null) {
    const wanted = new Set(files);
    if (!wanted.size) return;
    const state =
      scrollState || captureScrollState(this.list, "data-lora-key");
    const itemsByKey = new Map(
      this.items.map((item) => [loraSelectionKey(item), item]),
    );
    // Source queries only change the requested rows. Replacing the entire list
    // recreates unrelated thumbnails and text cards, whose asynchronous layout
    // can move the viewport after the scroll anchor has already been restored.
    for (const row of [...this.list.querySelectorAll("[data-lora-key]")]) {
      const item = itemsByKey.get(row.dataset.loraKey);
      if (!item || !wanted.has(item.file)) continue;
      row.replaceWith(this.createRow(item));
    }
    this.updateSelectionButtons();
    restoreScrollStateAfterLayout(this.list, state);
  }

  createRow(item) {
    const row = createElement("article", "astral-am-lora-row");
    const key = loraSelectionKey(item);
    row.dataset.loraKey = key;
    const selected = this.selected.has(key);
    if (selected) row.classList.add("is-selected");

    const content = createElement("div", "astral-am-lora-content");
    const header = createElement("div", "astral-am-lora-header");
    const checkbox = createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected;
    checkbox.setAttribute("aria-label", `Select ${item.name}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) this.selected.set(key, item);
      else this.selected.delete(key);
      row.classList.toggle("is-selected", checkbox.checked);
      this.updateSelectionButtons();
    });

    const titleWrap = createElement("div", "astral-am-lora-title");
    titleWrap.append(
      createElement("strong", "", item.name),
      createElement(
        "span",
        "",
        `${item.relativePath || item.file} · ${formatBytes(item.size)}`,
      ),
    );
    const rowActions = createElement("div", "astral-am-lora-row-actions");
    const refresh = createElement(
      "button",
      "astral-am-button is-small",
      this.loadingSources.has(item.file) ? "Checking..." : "Refresh Sources",
    );
    refresh.type = "button";
    refresh.disabled = this.loadingSources.has(item.file);
    refresh.title = "Query Civitai, Hugging Face, and ModelScope again.";
    refresh.addEventListener("click", () => void this.queryFiles([item.file], true));
    const insert = createElement(
      "button",
      "astral-am-button is-small",
      "Add to Canvas",
    );
    insert.type = "button";
    insert.title = "Add to the current canvas using the official LoRA Loader node.";
    insert.addEventListener("click", () => this.insertItemsToCanvas([item]));
    rowActions.append(refresh, insert);
    const thumbnail = this.createThumbnail(item);
    header.append(checkbox, titleWrap, rowActions);

    const sources = createElement("div", "astral-am-source-grid");
    const result = this.results.get(item.file);
    const loading = this.loadingSources.has(item.file);
    sources.append(
      this.createSourceCard("civitai", "Civitai", item, result, loading),
      this.createSourceCard("huggingface", "Hugging Face", item, result, loading),
      this.createSourceCard("modelscope", "ModelScope", item, result, loading),
    );
    content.append(header, sources);
    row.classList.toggle("has-thumbnail", Boolean(thumbnail));
    if (thumbnail) row.append(thumbnail);
    row.append(content);
    return row;
  }

  createThumbnail(item) {
    const result = this.results.get(item.file);
    const hasThumbnail = Boolean(
      result?.thumbnailUrl || result?.thumbnailLocalUrl,
    );
    if (!showLoraThumbnails() || !result || result.error || !hasThumbnail) {
      return null;
    }
    const wrapper = createElement("div", "astral-am-lora-thumbnail");
    const image = createElement("img");
    image.src = sourceThumbnailUrl(result, null);
    image.alt = `${item.name} model thumbnail`;
    image.loading = "lazy";
    image.decoding = "async";
    image.title = result.thumbnailSource
      ? `${result.thumbnailSource} thumbnail`
      : "LoRA thumbnail";
    image.addEventListener("error", () => {
      const row = wrapper.closest(".astral-am-lora-row");
      row?.classList.remove("has-thumbnail");
      wrapper.remove();
    });
    wrapper.append(image);
    return wrapper;
  }

  createSourceCard(sourceName, label, item, result, loading) {
    const card = createElement("div", `astral-am-source-card is-${sourceName}`);
    const heading = createElement("div", "astral-am-source-heading");
    heading.append(createElement("strong", "", label));
    if (sourceName !== "civitai") {
      const source = result?.sources?.[sourceName];
      const primary = Array.isArray(source?.candidates) ? source.candidates[0] : null;
      const exact = primary?.matchType === "sha256";
      heading.append(
        createElement(
          "span",
          "astral-am-source-mode",
          exact ? "Exact SHA256 match" : "Name/metadata candidate",
        ),
      );
    }
    card.append(heading);

    if (loading) {
      card.append(createElement("span", "astral-am-muted", "Checking..."));
      return card;
    }
    if (!result) {
      card.append(createElement("span", "astral-am-muted", "Not checked yet"));
      return card;
    }
    if (result.error) {
      card.append(createElement("span", "astral-am-source-error", result.error));
      return card;
    }
    const source = result.sources?.[sourceName];
    if (!source) {
      card.append(createElement("span", "astral-am-source-error", "This source returned no data."));
      return card;
    }
    if (!source.ok) {
      card.append(createElement("span", "astral-am-source-error", source.error || "Query failed"));
      if (sourceName === "civitai") this.appendAggregateModelInfo(card, result, source);
      return card;
    }

    if (sourceName === "civitai") {
      if (source.url) card.append(sourceLink(source.url, "Open Civitai model"));
      else card.append(createElement("span", "astral-am-muted", "Civitai did not provide a public link."));
      this.appendAggregateModelInfo(card, result, source);
      return card;
    }

    const candidates = Array.isArray(source.candidates) ? source.candidates : [];
    if (!candidates.length) {
      card.append(createElement("span", "astral-am-muted", `No candidates found for "${source.query || item.name}"`));
      return card;
    }
    card.append(sourceLink(source.url, candidates[0].name || candidates[0].id));
    const primary = candidates[0];
    const matchLabel =
      primary.matchLabel || source.matchLabel || "Name candidate; not confirmed by file hash";
    card.append(
      createElement(
        "span",
        primary.matchType === "sha256" ? "astral-am-source-match" : "astral-am-muted",
        primary.matchedFile
          ? `${matchLabel}: ${primary.matchedFile}`
          : `${matchLabel}; found ${candidates.length} candidates for "${source.query}"`,
      ),
    );
    if (candidates.length > 1) {
      const more = createElement("details", "astral-am-candidates");
      more.append(createElement("summary", "", "View other candidates"));
      for (const candidate of candidates.slice(1)) {
        more.append(sourceLink(candidate.url, candidate.name || candidate.id));
      }
      card.append(more);
    }
    return card;
  }

  appendAggregateModelInfo(card, result, source) {
    const recommendation = result?.recommendedStrength || source?.recommendedStrength;
    const strength = createElement("div", "astral-am-source-detail");
    strength.append(
      createElement("span", "astral-am-source-label", "Strength"),
      createElement(
        "span",
        "",
        recommendation?.text
          ? `${recommendation.text}${recommendation.source ? ` · ${recommendation.source}` : ""}`
          : "No reliable recommendation found",
      ),
    );
    card.append(strength);

    const triggers = Array.isArray(result?.triggers)
      ? result.triggers
      : Array.isArray(source?.triggers)
        ? source.triggers
        : [];
    const triggerWrap = createElement("div", "astral-am-trigger-list");
    if (triggers.length) {
      for (const trigger of triggers.slice(0, 12)) {
        triggerWrap.append(createElement("span", "astral-am-trigger", trigger));
      }
      if (triggers.length > 12) {
        triggerWrap.append(createElement("span", "astral-am-muted", `${triggers.length - 12} more`));
      }
      const triggersSource = result?.triggersSource || source?.triggersSource;
      if (triggersSource) {
        triggerWrap.append(createElement("span", "astral-am-muted", `Trigger word source: ${triggersSource}`));
      }
    } else {
      triggerWrap.append(createElement("span", "astral-am-muted", "No reliable trigger words found"));
    }
    card.append(triggerWrap);
  }

  async reloadPreservingLoadedCount(targetCount, preserveScroll = false) {
    const desiredCount = Math.max(
      LORA_PAGE_SIZE,
      Number(targetCount) || 0,
    );
    await Promise.all([
      this.loadTree(),
      this.load(true, preserveScroll),
    ]);
    while (this.items.length < desiredCount && this.hasMore) {
      const previousCount = this.items.length;
      await this.load(false);
      if (this.items.length === previousCount) break;
    }
  }

  async runLoraOperation(label, endpoint, payload) {
    if (this.operationBusy) return;
    const loadedCount = this.items.length;
    this.operationBusy = true;
    this.updateSelectionButtons();
    this.setStatus(`${label} LoRA...`, "loading");
    try {
      const result = await fetchJson(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      this.selected.clear();
      await this.reloadPreservingLoadedCount(loadedCount, true);
      this.setStatus(
        `${label} complete, processed ${Number(result?.count) || 0} LoRAs.`,
        "success",
      );
    } catch (error) {
      this.setStatus(`${label} failed: ${error.message || error}`, "error");
    } finally {
      this.operationBusy = false;
      this.updateSelectionButtons();
    }
  }

  async moveSelectedItems() {
    const items = this.selectedItems();
    if (!items.length || this.operationBusy) return;
    this.setStatus("Loading available LoRA destination folders...", "loading");
    try {
      const payload = await fetchJson("/assets-astral/loras/directories");
      const directories = Array.isArray(payload?.directories)
        ? payload.directories
        : [];
      if (!directories.length) {
        throw new Error("No destination LoRA folder is available.");
      }
      const sourceDirectories = new Set(
        items.map((item) => {
          const parent = String(item.relativePath || item.file || "")
            .replaceAll("\\", "/")
            .split("/")
            .slice(0, -1)
            .join("/");
          return JSON.stringify([Number(item.rootIndex) || 0, parent]);
        }),
      );
      const options = directories.map((directory) => {
        const rootIndex = Number(directory.rootIndex) || 0;
        const path = String(directory.relativePath || "");
        const rootName = pathBasename(directory.rootPath);
        return {
          value: JSON.stringify({ rootIndex, path }),
          label: path ? `${rootName} / ${path}` : `${rootName} (root)`,
          disabled: sourceDirectories.has(JSON.stringify([rootIndex, path])),
        };
      });
      const initial = options.find((option) => !option.disabled)?.value || "";
      const selected = await showAstralSelect({
        title: "Move LoRA",
        message: `Which folder should the selected ${items.length} LoRAs be moved to? Files with the same name are not overwritten.`,
        label: "Destination folder",
        options,
        initialValue: initial,
        confirmLabel: "Move",
      });
      if (!selected) return;
      const target = JSON.parse(selected);
      await this.runLoraOperation(
        "Move",
        "/assets-astral/loras/move",
        {
          items: loraSelectionPayload(items),
          target,
        },
      );
    } catch (error) {
      this.setStatus(`Move failed: ${error.message || error}`, "error");
    }
  }

  async recycleSelected() {
    const items = this.selectedItems();
    if (!items.length || this.operationBusy) return;
    const confirmed = await showAstralConfirm({
      title: "Move LoRA to Recycle Bin",
      message:
        `Move the selected ${items.length} LoRAs to the Windows Recycle Bin?\n\n` +
        "Files go to the Recycle Bin, but related workflows may stop working.",
      confirmLabel: "Move to Recycle Bin",
    });
    if (!confirmed) return;
    await this.runLoraOperation(
      "Delete",
      "/assets-astral/loras/recycle",
      {
        items: loraSelectionPayload(items),
        confirm: true,
      },
    );
  }

  insertSelectedItems() {
    const items = this.selectedItems();
    if (items.length) this.insertItemsToCanvas(items);
  }

  insertItemsToCanvas(items) {
    const allWanted = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!allWanted.length) return;
    const wanted = allWanted.slice(0, MAX_LORA_CANVAS_BATCH);
    const skippedCount = allWanted.length - wanted.length;
    try {
      if (
        typeof LiteGraph === "undefined" ||
        typeof LiteGraph.createNode !== "function" ||
        typeof app === "undefined" ||
        !app?.graph
      ) {
        throw new Error("The current ComfyUI canvas is not ready.");
      }
      const canvas = app.canvas;
      const canvasElement = canvas?.canvas;
      const viewport = canvasElement?.getBoundingClientRect?.();
      let center = null;
      if (viewport && typeof canvas?.convertEventToCanvasOffset === "function") {
        center = canvas.convertEventToCanvasOffset({
          clientX: viewport.left + viewport.width / 2,
          clientY: viewport.top + viewport.height / 2,
        });
      } else if (
        viewport &&
        typeof canvas?.clientPosToCanvasPos === "function"
      ) {
        center = canvas.clientPosToCanvasPos([
          viewport.left + viewport.width / 2,
          viewport.top + viewport.height / 2,
        ]);
      }
      if (!Array.isArray(center) || center.length < 2) {
        center = canvas?.graph_offset
          ? [
              -canvas.graph_offset[0] / (canvas.ds?.scale || 1) + 80,
              -canvas.graph_offset[1] / (canvas.ds?.scale || 1) + 80,
            ]
          : [80, 80];
      }
      const nodes = [];
      for (const item of wanted) {
        const loader = LiteGraph.createNode("LoraLoader");
        if (!loader) throw new Error("ComfyUI has not registered the official LoraLoader node.");
        const widget = loader.widgets?.find((entry) => entry.name === "lora_name");
        if (!widget) throw new Error("The lora_name input was not found in LoraLoader.");
        const value = item.nativeFile || item.file || item.relativePath;
        if (!value) throw new Error(`${item.name || "LoRA"} is missing a file path`);
        widget.value = value;
        if (
          Array.isArray(widget.options?.values) &&
          !widget.options.values.includes(value)
        ) {
          widget.options.values.push(value);
        }
        loader.title = `LoRA Loader · ${item.name || value}`;
        nodes.push(loader);
      }
      nodes.forEach((node, index) => {
        app.graph.add(node);
        const [nodeWidth, nodeHeight] = Array.isArray(node.size)
          ? node.size
          : [220, 120];
        node.pos = [
          Number(center[0]) - nodeWidth / 2 + index * 28,
          Number(center[1]) - nodeHeight / 2 + index * 28,
        ];
        node.setDirtyCanvas?.(true, true);
      });
      app.graph.setDirtyCanvas?.(true, true);
      const last = nodes[nodes.length - 1];
      if (typeof app.canvas?.selectNode === "function") {
        app.canvas.selectNode(last);
      }
      this.setStatus(
        skippedCount
          ? `Placed the first ${nodes.length} LoRA Loaders on the current canvas; up to ${MAX_LORA_CANVAS_BATCH} at a time, so the other ${skippedCount} were not placed.`
          : `Placed ${nodes.length} LoRA Loaders in the current canvas view.`,
        skippedCount ? "warning" : "success",
      );
    } catch (error) {
      this.setStatus(`Failed to place on canvas: ${error.message || error}`, "error");
    }
  }

  async querySelectedSources() {
    await this.queryFiles(
      this.selectedItems()
        .map((item) => item.file)
        .filter(Boolean),
      false,
    );
  }

  async queryFiles(files, refresh) {
    const wanted = [...new Set(files)].filter(Boolean);
    if (!wanted.length || this.loadingSources.size) return;
    // Keep one viewport anchor for the whole async operation. Source results
    // update their rows in place, so unrelated media and text do not reflow.
    const scrollState = captureScrollState(this.list, "data-lora-key");
    for (const file of wanted) this.loadingSources.add(file);
    this.updateRowsPreservingScroll(wanted, scrollState);
    this.setStatus(
      `${refresh ? "Force-refreshing" : "Reading or querying"} the sources of ${wanted.length} LoRAs...`,
      "loading",
    );
    let completed = 0;
    try {
      for (let index = 0; index < wanted.length; index += SOURCE_CHUNK_SIZE) {
        const chunk = wanted.slice(index, index + SOURCE_CHUNK_SIZE);
        const payload = await fetchJson("/assets-astral/loras/sources", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: chunk, refresh }),
        });
        for (const result of payload?.items || []) {
          this.results.set(result.file, result);
          this.loadingSources.delete(result.file);
          completed += 1;
        }
        this.updateRowsPreservingScroll(
          (payload?.items || []).map((result) => result.file),
          scrollState,
        );
        this.setStatus(`Queried ${completed}/${wanted.length} LoRAs...`, "loading");
      }
      const failures = wanted.filter((file) => {
        const result = this.results.get(file);
        return result?.error || !result;
      }).length;
      this.setStatus(
        failures
          ? `Source query complete; ${failures} LoRAs could not be fully queried. Check the failure reason on each row.`
          : refresh
            ? "Source refresh complete and saved beside the LoRA file."
            : "Source query complete; existing results were prioritized from the local cache beside each LoRA.",
        failures ? "warning" : "success",
      );
    } catch (error) {
      this.setStatus(`Source query failed: ${error.message || error}`, "error");
    } finally {
      this.loadingSources.clear();
      this.updateRowsPreservingScroll(wanted, scrollState);
    }
  }
}

const MISSING_MODEL_FILE_PATTERN =
  /\.(?:bin|ckpt|gguf|onnx|pkl|pt|pt2|pth|safetensors|sft)$/i;
const SHA256_VALUE_PATTERN = /^[0-9a-f]{64}$/i;
const MISSING_MODEL_RESOLVE_CHUNK_SIZE = 250;
const MISSING_MODEL_STATE_LABELS = {
  match: "Reliable match",
  candidate: "Same-name candidate",
  ambiguous: "Multiple same-name matches",
  conflict: "Hash conflict",
  missing: "Not Found",
};

function normalizedModelValue(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/+/g, "/")
    .toLocaleLowerCase();
}

function modelComboValues(widget) {
  const values = widget?.options?.values;
  if (!Array.isArray(values)) return [];
  return values.filter((value) => typeof value === "string");
}

function similarModelPath(left, right) {
  const normalizedLeft = normalizedModelValue(left);
  const normalizedRight = normalizedModelValue(right);
  return Boolean(normalizedLeft) && normalizedLeft === normalizedRight;
}

function modelValueName(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function normalizedHashRecord(record) {
  if (!record) return null;
  if (typeof record === "string") {
    return SHA256_VALUE_PATTERN.test(record.trim())
      ? { sha256: record.trim().toLowerCase(), size: 0 }
      : null;
  }
  if (typeof record !== "object" || Array.isArray(record)) return null;
  let sha256 = "";
  for (const key of [
    "sha256",
    "sha256sum",
    "hash_sha256",
    "modelSha256",
    "model_sha256",
    "hash",
  ]) {
    const value = String(record[key] || "").trim();
    if (SHA256_VALUE_PATTERN.test(value)) {
      sha256 = value.toLowerCase();
      break;
    }
  }
  if (!sha256) return null;
  const size = Math.max(
    0,
    Number(record.size ?? record.fileSize ?? record.bytes) || 0,
  );
  return { sha256, size };
}

function matchingPropertyModelRecord(node, value) {
  const records = node?.properties?.models;
  if (!Array.isArray(records)) return null;
  const wanted = normalizedModelValue(value);
  const wantedName = normalizedModelValue(modelValueName(value));
  return (
    records.find((record) => {
      if (!record || typeof record !== "object") return false;
      const name = String(record.name || record.filename || "");
      return (
        normalizedModelValue(name) === wanted ||
        normalizedModelValue(modelValueName(name)) === wantedName
      );
    }) || null
  );
}

function workflowHashRecordForModel(node, widget, value) {
  const graph = app?.graph;
  const graphExtras = graph?.extra;
  const possibleMaps = [
    graphExtras?.anomalous_hashes,
    graphExtras?.model_hashes,
    graphExtras?.modelHashes,
  ];
  const variants = new Set([
    String(value || ""),
    String(value || "").replace(/\\/g, "/"),
    String(value || "").replace(/\//g, "\\"),
  ]);
  const keys = new Set(variants);
  keys.add(modelValueName(value));
  for (const variant of variants) {
    keys.add(`${node?.id}_${variant}`);
  }
  for (const records of possibleMaps) {
    if (!records || typeof records !== "object" || Array.isArray(records)) {
      continue;
    }
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(records, key)) {
        const record = normalizedHashRecord(records[key]);
        if (record) return record;
      }
    }
  }

  const propertyModel = matchingPropertyModelRecord(node, value);
  const directRecords = [
    propertyModel,
    node?.properties,
    node,
    widget,
  ];
  for (const record of directRecords) {
    const normalized = normalizedHashRecord(record);
    if (normalized) return normalized;
  }
  return null;
}

function inferMissingModelCategories(node, widget, value) {
  const categories = [];
  const add = (...values) => {
    for (const item of values) {
      const category = String(item || "").trim();
      if (category) categories.push(category);
    }
  };
  const propertyModel = matchingPropertyModelRecord(node, value);
  if (propertyModel?.directory) add(propertyModel.directory);

  const widgetName = String(widget?.name || "").toLocaleLowerCase();
  const nodeType = String(node?.type || "").toLocaleLowerCase();
  const key = `${widgetName} ${nodeType}`;

  if (nodeType === "modelpatchloader" || key.includes("model_patch")) {
    add("model_patches");
  }
  if (
    key.includes("clip_vision") ||
    key.includes("clip vision") ||
    nodeType.includes("clipvision")
  ) {
    add("clip_vision");
  }
  if (key.includes("vae_approx") || key.includes("vae approx")) {
    add("vae_approx");
  } else if (
    widgetName.includes("vae") ||
    nodeType === "vaeloader" ||
    key.includes("vae loader")
  ) {
    add("vae");
  }
  if (widgetName.includes("lora") || key.includes("lora")) {
    add("loras");
  }
  if (
    widgetName.includes("control_net") ||
    widgetName.includes("controlnet") ||
    key.includes("controlnet")
  ) {
    add("controlnet");
  }
  if (
    widgetName.includes("ckpt") ||
    widgetName.includes("checkpoint") ||
    key.includes("checkpoint")
  ) {
    add("checkpoints");
  }
  if (
    widgetName.includes("unet") ||
    widgetName.includes("diffusion_model") ||
    nodeType.includes("unet") ||
    key.includes("unet loader") ||
    key.includes("diffusion model")
  ) {
    add("diffusion_models", "unet");
  }
  if (
    widgetName.includes("clip_name") ||
    widgetName.includes("text_encoder") ||
    nodeType.includes("cliploader")
  ) {
    add("text_encoders", "clip");
  }
  if (
    nodeType.includes("upscalemodel") ||
    widgetName.includes("upscale_model")
  ) {
    add("upscale_models");
  }
  if (key.includes("style_model")) add("style_models");
  if (key.includes("gligen")) add("gligen");
  if (key.includes("ipadapter") || key.includes("ip-adapter")) {
    add("ipadapter");
  }
  if (key.includes("instantid")) add("instantid");
  if (key.includes("photomaker")) add("photomaker");
  return [...new Set(categories)];
}

function isModelComboWidget(widget) {
  if (String(widget?.type || "").toLocaleLowerCase() !== "combo") {
    return false;
  }
  return modelComboValues(widget).some((value) =>
    MISSING_MODEL_FILE_PATTERN.test(value),
  );
}

function modelOptionForCandidate(widget, candidate) {
  const options = modelComboValues(widget);
  for (const value of [candidate?.relativePath, candidate?.nativePath]) {
    const target = options.find((option) => similarModelPath(option, value));
    if (target) return target;
  }
  return "";
}

function modelCandidateTargets(widget, candidates) {
  const targets = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const target = modelOptionForCandidate(widget, candidate);
    if (!target) continue;
    const key = normalizedModelValue(target);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ candidate, target });
  }
  return targets;
}

class ModelManagerBrowser {
  constructor(root, loraBrowser) {
    this.root = root;
    this.loraBrowser = loraBrowser;
    this.categories = [];
    this.categoriesPromise = null;
    this.mode = "loras";
    this.duplicateResult = null;
    this.missingModelResult = null;
    this.missingModelScanned = false;
    this.missingModelScanToken = 0;
    this.autoFillMissingModels = false;
    this.lorasLoaded = false;
    this.scanTaskId = null;
    this.scanPollTimer = null;
    this.scanPollGeneration = 0;
    this.scanPollFailures = 0;
    this.build();
  }

  build() {
    const section = createElement("section", "astral-am-pane astral-am-models-pane");
    const modeTabs = createElement("nav", "astral-am-subtabs");
    modeTabs.setAttribute("aria-label", "Model management tools");
    this.loraModeButton = createElement("button", "astral-am-subtab is-active", "LoRA Management");
    this.duplicateModeButton = createElement("button", "astral-am-subtab", "Duplicate Model Cleanup");
    this.missingModeButton = createElement(
      "button",
      "astral-am-subtab",
      "Fill Missing Models",
    );
    this.duplicateModeButton.type = "button";
    this.loraModeButton.type = "button";
    this.missingModeButton.type = "button";
    modeTabs.append(
      this.missingModeButton,
      this.loraModeButton,
      this.duplicateModeButton,
    );

    this.duplicatePane = this.buildDuplicatePane();
    this.missingModelPane = this.buildMissingModelPane();
    this.loraPane = createElement("div", "astral-am-model-tool is-active");
    this.loraPane.append(this.loraBrowser.element);
    section.append(
      modeTabs,
      this.loraPane,
      this.duplicatePane,
      this.missingModelPane,
    );
    this.element = section;

    this.duplicateModeButton.addEventListener("click", () => this.setMode("duplicates"));
    this.missingModeButton.addEventListener("click", () => this.setMode("missing"));
    this.loraModeButton.addEventListener("click", () => this.setMode("loras"));
  }

  buildDuplicatePane() {
    const pane = createElement("div", "astral-am-model-tool");
    pane.hidden = true;
    const toolbar = createElement("div", "astral-am-toolbar");
    const scope = createCustomDropdown("astral-am-category-dropdown");
    scope.element.setAttribute("aria-label", "Duplicate scan scope");
    const scan = createElement("button", "astral-am-button is-primary", "Scan Duplicate Models");
    scan.type = "button";
    const cancel = createElement("button", "astral-am-button is-danger", "Cancel Scan");
    cancel.type = "button";
    cancel.hidden = true;
    toolbar.append(scope.element, scan, cancel);

    const note = createElement(
      "p",
      "astral-am-note",
      "Group files by size, then calculate SHA256. Deleting only moves regular model files to the Windows Recycle Bin after confirmation; model directories are never removed.",
    );
    const status = createElement("div", "astral-am-status");
    const progress = createElement("div", "astral-am-duplicate-progress");
    progress.hidden = true;
    const progressBar = document.createElement("progress");
    progressBar.max = 1;
    progressBar.value = 0;
    progressBar.setAttribute("aria-label", "Duplicate model scan progress");
    const progressText = createElement("div", "astral-am-duplicate-progress-text");
    const currentFile = createElement("div", "astral-am-duplicate-current-file");
    progress.append(progressBar, progressText, currentFile);
    const summary = createElement("div", "astral-am-summary");
    const groups = createElement("div", "astral-am-duplicate-groups");
    pane.append(toolbar, note, status, progress, summary, groups);

    this.duplicateScope = scope;
    this.scanButton = scan;
    this.cancelScanButton = cancel;
    this.duplicateStatus = status;
    this.duplicateProgress = progress;
    this.duplicateProgressBar = progressBar;
    this.duplicateProgressText = progressText;
    this.duplicateCurrentFile = currentFile;
    this.duplicateSummary = summary;
    this.duplicateGroups = groups;
    scan.addEventListener("click", () => void this.scanDuplicates());
    cancel.addEventListener("click", () => void this.cancelDuplicateScan());
    return pane;
  }

  buildMissingModelPane() {
    const pane = createElement("div", "astral-am-model-tool astral-am-missing-pane");
    pane.hidden = true;
    const toolbar = createElement("div", "astral-am-toolbar");
    const scan = createElement(
      "button",
      "astral-am-button is-primary",
      "Scan Current Workflow for Missing Models",
    );
    scan.type = "button";
    const autoFill = createElement(
      "label",
      "astral-am-check astral-am-missing-autofill",
    );
    autoFill.title =
      "After scanning, auto-fill models matching by SHA256 or original path, plus unique local same-name matches.";
    const autoFillCheckbox = createElement("input");
    autoFillCheckbox.type = "checkbox";
    autoFillCheckbox.checked = this.autoFillMissingModels;
    autoFillCheckbox.setAttribute("aria-label", "Auto-fill after scan");
    autoFill.append(
      autoFillCheckbox,
      document.createTextNode("Auto-fill after scan"),
    );
    toolbar.append(scan, autoFill);

    const note = createElement(
      "p",
      "astral-am-note",
      "Find stale model dropdown values in the current workflow. When SHA256 is available, match by content only and never replace a different model by name; " +
        "When Auto-fill after scan is enabled, only models matching by hash, original path, or a unique local name are filled automatically." +
        "Multiple same-name matches and hash conflicts still require confirmation. Filling only changes the current workflow; it does not copy, move, or delete local model files.",
    );
    const status = createElement("div", "astral-am-status");
    const summary = createElement("div", "astral-am-summary");
    const list = createElement("div", "astral-am-missing-list");
    pane.append(toolbar, note, status, summary, list);

    this.missingScanButton = scan;
    this.missingAutoFillCheckbox = autoFillCheckbox;
    this.missingModelStatus = status;
    this.missingModelSummary = summary;
    this.missingModelList = list;
    scan.addEventListener("click", () => void this.scanMissingModels());
    autoFillCheckbox.addEventListener("change", () => {
      this.autoFillMissingModels = autoFillCheckbox.checked;
    });
    return pane;
  }

  setDuplicateStatus(message, kind = "") {
    updateStatusPreservingScroll(
      this.duplicateStatus,
      message,
      kind,
      this.duplicateGroups,
      "data-duplicate-sha",
    );
  }

  setMissingModelStatus(message, kind = "") {
    updateStatusPreservingScroll(
      this.missingModelStatus,
      message,
      kind,
      this.missingModelList,
      "data-missing-key",
    );
  }

  collectMissingModelReferences() {
    const graph = app?.graph;
    const nodes = Array.isArray(graph?._nodes) ? graph._nodes : [];
    const references = [];
    const seenWidgets = new Set();
    for (const node of nodes) {
      const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
      for (let widgetIndex = 0; widgetIndex < widgets.length; widgetIndex += 1) {
        const widget = widgets[widgetIndex];
        const value = widget?.value;
        if (
          typeof value !== "string" ||
          !MISSING_MODEL_FILE_PATTERN.test(value) ||
          !isModelComboWidget(widget) ||
          seenWidgets.has(widget)
        ) {
          continue;
        }
        seenWidgets.add(widget);
        if (
          modelComboValues(widget).some((option) =>
            similarModelPath(option, value),
          )
        ) {
          continue;
        }
        const hashRecord = workflowHashRecordForModel(node, widget, value);
        const categories = inferMissingModelCategories(node, widget, value);
        const key = `missing:${String(node?.id ?? "")}:${widgetIndex}:${references.length}`;
        references.push({
          key,
          node,
          widget,
          widgetIndex,
          nodeId: String(node?.id ?? ""),
          nodeTitle: String(node?.title || node?.type || "Untitled Node"),
          widgetName: String(widget?.name || `Widget ${widgetIndex + 1}`),
          value,
          categories,
          sha256: hashRecord?.sha256 || "",
          size: Number(hashRecord?.size) || 0,
        });
      }
    }
    return references;
  }

  setMissingModelScanControls(active) {
    this.missingScanButton.disabled = Boolean(active);
    this.missingAutoFillCheckbox.disabled = Boolean(active);
    this.missingScanButton.textContent = active
      ? "Scanning..."
      : "Scan Current Workflow for Missing Models";
  }

  async scanMissingModels() {
    if (this.missingScanButton.disabled) return;
    const scanToken = ++this.missingModelScanToken;
    this.setMissingModelScanControls(true);
    this.missingModelSummary.textContent = "";
    replaceChildrenPreservingScroll(
      this.missingModelList,
      null,
      "data-missing-key",
    );
    this.setMissingModelStatus("Reading model references in the current workflow...", "loading");

    try {
      const references = this.collectMissingModelReferences();
      if (!references.length) {
        this.missingModelResult = {
          entries: [],
          scannedFiles: 0,
          hashedFiles: 0,
          failedHashFiles: 0,
        };
        this.missingModelScanned = true;
        this.renderMissingModels();
        this.setMissingModelStatus(
          "No model references outside the local model dropdowns were found in the current workflow.",
          "success",
        );
        return;
      }

      this.setMissingModelStatus(
        `Matching ${references.length} missing model references...`,
        "loading",
      );
      const rawResults = [];
      let scannedFiles = 0;
      let hashedFiles = 0;
      let failedHashFiles = 0;
      for (
        let offset = 0;
        offset < references.length;
        offset += MISSING_MODEL_RESOLVE_CHUNK_SIZE
      ) {
        const chunk = references.slice(
          offset,
          offset + MISSING_MODEL_RESOLVE_CHUNK_SIZE,
        );
        const payload = await fetchJson(
          "/assets-astral/models/missing/resolve",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              items: chunk.map((reference) => ({
                key: reference.key,
                value: reference.value,
                categories: reference.categories,
                sha256: reference.sha256,
                size: reference.size,
              })),
            }),
          },
        );
        if (scanToken !== this.missingModelScanToken) return;
        rawResults.push(...(Array.isArray(payload?.results) ? payload.results : []));
        scannedFiles = Math.max(
          scannedFiles,
          Math.max(0, Number(payload?.scannedFiles) || 0),
        );
        hashedFiles = Math.max(
          hashedFiles,
          Math.max(0, Number(payload?.hashedFiles) || 0),
        );
        failedHashFiles = Math.max(
          failedHashFiles,
          Math.max(0, Number(payload?.failedHashFiles) || 0),
        );
      }
      if (scanToken !== this.missingModelScanToken) return;

      const resultsByKey = new Map(
        rawResults.map((result) => [String(result?.key || ""), result]),
      );
      const entries = references.map((reference) => {
        const result = resultsByKey.get(reference.key) || {
          key: reference.key,
          value: reference.value,
          state: "missing",
          via: "",
          candidates: [],
          rejectedCandidates: [],
        };
        const candidateTargets = modelCandidateTargets(
          reference.widget,
          result.candidates,
        );
        return {
          ...reference,
          result,
          candidateTargets,
          selectedTarget: candidateTargets[0]?.target || "",
          filledTarget: "",
        };
      });
      this.missingModelResult = {
        entries,
        scannedFiles,
        hashedFiles,
        failedHashFiles,
      };
      this.missingModelScanned = true;

      const reliable = this.reliableMissingModelEntries().length;
      const candidates = entries.filter(
        (entry) => entry.result.state === "candidate",
      ).length;
      const ambiguous = entries.filter(
        (entry) => entry.result.state === "ambiguous",
      ).length;
      const conflicts = entries.filter(
        (entry) => entry.result.state === "conflict",
      ).length;
      const missing = entries.filter(
        (entry) => entry.result.state === "missing",
      ).length;
      const autoFillResult = this.missingAutoFillCheckbox.checked
        ? this.autoFillDeterminedMissingModels(entries)
        : null;
      this.renderMissingModels();
      const statusParts = [
        `Scan complete: ${reliable} reliable matches, ${candidates} unique same-name candidates, ` +
          `${ambiguous} multiple same-name, ${conflicts} hash conflicts, ${missing} not found.`,
      ];
      if (autoFillResult) {
        if (autoFillResult.failures.length) {
          statusParts.push(
            `Auto-filled ${autoFillResult.filled}, ${autoFillResult.failures.length} failed: ` +
              autoFillResult.failures.join("; "),
          );
        } else if (autoFillResult.filled) {
          statusParts.push(
            `Auto-filled ${autoFillResult.filled} models with the same hash, matching original path, or a unique same-name.`,
          );
        } else {
          statusParts.push("Auto-fill after scan is enabled, but no model can be filled safely.");
        }
      }
      this.setMissingModelStatus(
        statusParts.join(" "),
        conflicts || missing || autoFillResult?.failures.length
          ? "warning"
          : "success",
      );
    } catch (error) {
      if (scanToken !== this.missingModelScanToken) return;
      this.missingModelScanned = false;
      this.setMissingModelStatus(
        `Scan for missing models failed: ${error.message || error}`,
        "error",
      );
    } finally {
      if (scanToken === this.missingModelScanToken) {
        this.setMissingModelScanControls(false);
      }
    }
  }

  reliableMissingModelEntries() {
    const entries = Array.isArray(this.missingModelResult?.entries)
      ? this.missingModelResult.entries
      : [];
    return entries.filter(
      (entry) =>
        !entry.filledTarget &&
        entry.result?.state === "match" &&
        Boolean(entry.selectedTarget),
    );
  }

  autoFillableMissingModelEntries(entries = []) {
    return entries.filter((entry) => {
      if (entry.filledTarget || !entry.selectedTarget) return false;
      if (entry.result?.state === "match") return true;
      return (
        entry.result?.state === "candidate" &&
        entry.result?.via === "name" &&
        Array.isArray(entry.candidateTargets) &&
        entry.candidateTargets.length === 1
      );
    });
  }

  autoFillDeterminedMissingModels(entries) {
    const fillable = this.autoFillableMissingModelEntries(entries);
    const result = {
      attempted: fillable.length,
      filled: 0,
      failures: [],
    };
    if (!fillable.length) return result;

    const graph = app?.graph;
    graph?.beforeChange?.();
    try {
      for (const entry of fillable) {
        try {
          this.applyMissingModelTarget(entry, entry.selectedTarget);
          result.filled += 1;
        } catch (error) {
          result.failures.push(
            `${entry.nodeTitle} · ${entry.widgetName}: ${error.message || error}`,
          );
        }
      }
    } finally {
      graph?.afterChange?.();
    }
    if (result.filled) graph?.setDirtyCanvas?.(true, true);
    return result;
  }

  renderMissingModels() {
    const entries = Array.isArray(this.missingModelResult?.entries)
      ? this.missingModelResult.entries
      : [];
    const reliable = this.reliableMissingModelEntries().length;
    const filled = entries.filter((entry) => Boolean(entry.filledTarget)).length;
    const candidates = entries.filter(
      (entry) => entry.result?.state === "candidate",
    ).length;
    const ambiguous = entries.filter(
      (entry) => entry.result?.state === "ambiguous",
    ).length;
    const conflicts = entries.filter(
      (entry) => entry.result?.state === "conflict",
    ).length;
    const missing = entries.filter(
      (entry) => entry.result?.state === "missing",
    ).length;

    if (!entries.length) {
      this.missingModelSummary.textContent = "";
      replaceChildrenPreservingScroll(
        this.missingModelList,
        null,
        "data-missing-key",
      );
      return;
    }
    this.missingModelSummary.textContent =
      `The current workflow has ${entries.length} missing model references: ` +
      `${reliable} reliably fillable, ${candidates} unique same-name candidates, ` +
      `${ambiguous} multiple same-name, ${conflicts} hash conflicts, ${missing} not found` +
      (filled ? `; ${filled} filled.` : ".");

    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      fragment.append(this.createMissingModelRow(entry));
    }
    replaceChildrenPreservingScroll(
      this.missingModelList,
      fragment,
      "data-missing-key",
    );
  }

  missingModelStateDescription(entry) {
    const state = entry.result?.state || "missing";
    if (
      ["match", "candidate", "ambiguous"].includes(state) &&
      Array.isArray(entry.result?.candidates) &&
      entry.result.candidates.length &&
      !entry.candidateTargets?.length
    ) {
      return "The model exists locally, but its value is missing from this node's dropdown. Refresh the model list and scan again.";
    }
    if (state === "match" && entry.result?.via === "sha256") {
      return "The workflow SHA256 matches the local file and can be filled safely.";
    }
    if (state === "match" && entry.result?.via === "path") {
      return "The missing value's canonical relative path matches the local model and can be filled safely.";
    }
    if (state === "candidate") {
      return "The workflow has no usable hash and only one local file has this name. Confirm before filling.";
    }
    if (state === "ambiguous") {
      return "The workflow has no usable hash and multiple local files have this name. Select one.";
    }
    if (state === "conflict") {
      return "A local file has the same name, but its SHA256 differs from the workflow record. Name-based replacement was blocked.";
    }
    return "No local model matched by hash or name.";
  }

  createMissingModelRow(entry) {
    const state = entry.filledTarget
      ? "filled"
      : entry.result?.state || "missing";
    const row = createElement(
      "article",
      `astral-am-missing-row is-${state}`,
    );
    row.dataset.missingKey = entry.key;

    const header = createElement("div", "astral-am-missing-header");
    const heading = createElement("div", "astral-am-missing-heading");
    heading.append(
      createElement("strong", "", entry.nodeTitle),
      createElement(
        "span",
        "astral-am-muted",
        `Node #${entry.nodeId || "?"} · Widget ${entry.widgetName}`,
      ),
    );
    const badge = createElement(
      "span",
      "astral-am-missing-badge",
      state === "filled"
        ? "Filled"
        : MISSING_MODEL_STATE_LABELS[state] || "Not Found",
    );
    header.append(heading, badge);

    const reference = createElement("div", "astral-am-missing-reference");
    reference.append(
      createElement("span", "", "Original value"),
      markUntranslated(createElement("code", "", entry.value)),
    );
    const description = createElement(
      "p",
      "astral-am-missing-description",
      entry.filledTarget
        ? `The current workflow has been changed to ${entry.filledTarget}.`
        : this.missingModelStateDescription(entry),
    );
    row.append(header, reference, description);

    const candidates =
      state === "conflict"
        ? entry.result?.rejectedCandidates
        : entry.result?.candidates;
    if (Array.isArray(candidates) && candidates.length) {
      const candidateList = createElement(
        "div",
        "astral-am-missing-candidates",
      );
      for (const candidate of candidates) {
        const candidateRow = createElement(
          "div",
          "astral-am-missing-candidate",
        );
        candidateRow.append(
          createElement(
            "span",
            "astral-am-missing-candidate-path",
            `${candidate.category} / ${candidate.relativePath}`,
          ),
          createElement(
            "span",
            "astral-am-muted",
            candidate.size ? formatBytes(candidate.size) : "",
          ),
        );
        candidateList.append(candidateRow);
      }
      row.append(candidateList);
    }

    if (entry.filledTarget) return row;
    const availableTargets = Array.isArray(entry.candidateTargets)
      ? entry.candidateTargets
      : [];
    if (!["match", "candidate", "ambiguous"].includes(state) ||
        !availableTargets.length) {
      return row;
    }

    const actions = createElement("div", "astral-am-missing-actions");
    if (availableTargets.length > 1) {
      const select = createCustomDropdown(
        "astral-am-missing-candidate-dropdown",
      );
      select.element.setAttribute("aria-label", `Replacement model for ${entry.widgetName}`);
      select.setOptions(
        availableTargets.map(({ candidate, target }) => ({
          value: target,
          label: `${candidate.category} / ${candidate.relativePath}`,
          title: `Replace ${entry.value} with ${target}`,
        })),
        entry.selectedTarget,
      );
      entry.selectedTarget = select.value;
      select.onChange((value) => {
        entry.selectedTarget = value;
      });
      actions.append(select.element);
    } else {
      const target = availableTargets[0].target;
      entry.selectedTarget = target;
      actions.append(
        markUntranslated(
          createElement("code", "astral-am-missing-target", target),
        ),
      );
    }
    const fill = createElement(
      "button",
      "astral-am-button is-small is-primary",
      state === "candidate" ? "Confirm Fill" : "Fill",
    );
    fill.type = "button";
    fill.title = `Only changes ${entry.nodeTitle} · ${entry.widgetName} in the current workflow`;
    fill.addEventListener("click", () =>
      void this.fillMissingModelEntry(entry),
    );
    actions.append(fill);
    row.append(actions);
    return row;
  }

  applyMissingModelTarget(entry, target) {
    const graph = app?.graph;
    const nodes = Array.isArray(graph?._nodes) ? graph._nodes : [];
    const liveNode =
      typeof graph?.getNodeById === "function"
        ? graph.getNodeById(entry.node?.id)
        : nodes.includes(entry.node)
          ? entry.node
          : null;
    if (!liveNode || liveNode !== entry.node) {
      throw new Error("The node is no longer on the current canvas. Scan again.");
    }
    const widgetIndex = Array.isArray(liveNode.widgets)
      ? liveNode.widgets.indexOf(entry.widget)
      : -1;
    if (widgetIndex < 0) {
      throw new Error("The model widget changed. Scan again.");
    }
    if (entry.widget.value !== entry.value) {
      throw new Error("The model value changed after scanning. Scan again.");
    }
    const option = modelComboValues(entry.widget).find(
      (value) => value === target || similarModelPath(value, target),
    );
    if (!option) {
      throw new Error("The target model is no longer in the node dropdown. Refresh the model list and scan again.");
    }
    const oldValue = entry.widget.value;
    entry.widget.value = option;
    if (
      Array.isArray(liveNode.widgets_values) &&
      widgetIndex < liveNode.widgets_values.length
    ) {
      liveNode.widgets_values[widgetIndex] = option;
    }
    entry.widget.callback?.(
      option,
      app.canvas,
      liveNode,
      app.canvas?.graph_mouse,
      null,
    );
    liveNode.onWidgetChanged?.(
      entry.widget.name,
      option,
      oldValue,
      entry.widget,
    );
    if (app.lastNodeErrors?.[liveNode.id]) {
      delete app.lastNodeErrors[liveNode.id];
    }
    liveNode.setDirtyCanvas?.(true, true);
    entry.filledTarget = option;
    entry.selectedTarget = option;
    return option;
  }

  async fillMissingModelEntry(entry) {
    const target = entry.selectedTarget;
    if (!target) {
      this.setMissingModelStatus("Select an available local model first.", "warning");
      return false;
    }
    const graph = app?.graph;
    graph?.beforeChange?.();
    let applied = "";
    try {
      applied = this.applyMissingModelTarget(entry, target);
    } catch (error) {
      this.setMissingModelStatus(
        `Fill failed: ${error.message || error}`,
        "error",
      );
      return false;
    } finally {
      graph?.afterChange?.();
    }
    graph?.setDirtyCanvas?.(true, true);
    this.renderMissingModels();
    this.setMissingModelStatus(
      `${entry.nodeTitle} · ${entry.widgetName} filled with ${applied}.` +
        " Only the current workflow was modified; the workflow has not been saved.",
      "success",
    );
    return true;
  }

  setMode(mode) {
    this.mode = mode;
    this.duplicatePane.hidden = mode !== "duplicates";
    this.duplicatePane.classList.toggle("is-active", mode === "duplicates");
    this.loraPane.hidden = mode !== "loras";
    this.loraPane.classList.toggle("is-active", mode === "loras");
    this.missingModelPane.hidden = mode !== "missing";
    this.missingModelPane.classList.toggle("is-active", mode === "missing");
    this.duplicateModeButton.classList.toggle("is-active", mode === "duplicates");
    this.loraModeButton.classList.toggle("is-active", mode === "loras");
    this.missingModeButton.classList.toggle("is-active", mode === "missing");
    if (mode === "loras" && !this.lorasLoaded) {
      this.lorasLoaded = true;
      void Promise.all([
        this.loraBrowser.loadTree(),
        this.loraBrowser.load(true),
      ]);
    }
    if (mode === "duplicates") {
      void this.loadCategories().then(() => this.resumeDuplicateScan());
    }
    if (mode === "missing" && !this.missingModelScanned) {
      void this.scanMissingModels();
    }
  }

  async load(reset = false, preserveScroll = false) {
    if (this.mode === "duplicates") {
      await this.loadCategories();
      await this.resumeDuplicateScan();
    }
    if (this.mode === "missing" && (reset || !this.missingModelScanned)) {
      await this.scanMissingModels();
    }
    if (!this.lorasLoaded || reset) {
      this.lorasLoaded = true;
      await Promise.all([
        this.loraBrowser.loadTree(),
        this.loraBrowser.load(true, preserveScroll),
      ]);
    }
  }

  async loadCategories() {
    if (this.categoriesPromise) return this.categoriesPromise;
    this.categoriesPromise = fetchJson("/assets-astral/models/categories")
      .then((payload) => {
        const rawCategories = Array.isArray(payload?.categories)
          ? payload.categories
          : [];
        const uniqueCategories = new Map();
        for (const category of rawCategories) {
          if (!isPhysicalModelCategory(category)) continue;
          const key = String(category?.name || "")
            .trim()
            .toLocaleLowerCase();
          if (!key || uniqueCategories.has(key)) continue;
          uniqueCategories.set(key, category);
        }
        this.categories = [...uniqueCategories.values()];
        this.updateDuplicateScopes();
        if (!this.categories.length) {
          this.setDuplicateStatus("ComfyUI did not return any model categories to clean up.", "error");
        }
        return this.categories;
      })
      .catch((error) => {
        this.categoriesPromise = null;
        this.setDuplicateStatus(`Failed to read model categories: ${error.message || error}`, "error");
        return [];
      });
    return this.categoriesPromise;
  }

  updateDuplicateScopes() {
    const previous = this.duplicateScope.value;
    this.duplicateScope.setOptions(
      [
        { value: "", label: "All Categories" },
        ...this.categories.map((category) => ({
          value: category.name,
          label: category.name,
          title: category.name,
        })),
      ],
      previous,
    );
  }

  async recycleModel(item) {
    const label = `${item.category} / ${item.relativePath}`;
    const confirmed = await showAstralConfirm({
      title: "Move Model to Recycle Bin",
      message:
        `Move the following model to the Windows Recycle Bin?\n\n${label}\n\n` +
        "Files go to the Recycle Bin, but related workflows may stop working.",
      confirmLabel: "Move to Recycle Bin",
    });
    if (!confirmed) return false;
    this.setDuplicateStatus(`Moving ${item.name} to the Recycle Bin...`, "loading");
    try {
      await fetchJson("/assets-astral/models/recycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: item.category,
          rootIndex: item.rootIndex,
          relativePath: item.relativePath,
          confirm: true,
        }),
      });
      const removedFromResults = this.removeDuplicateResultItem(item);
      this.setDuplicateStatus(
        removedFromResults
          ? `${label} moved to the Windows Recycle Bin; the current results were updated. Click Scan manually to re-verify.`
          : `${label} moved to the Windows Recycle Bin.`,
        "success",
      );
      return true;
    } catch (error) {
      this.setDuplicateStatus(`Delete failed: ${error.message || error}`, "error");
      return false;
    }
  }

  removeDuplicateResultItem(item) {
    const result = this.duplicateResult;
    if (!result || !Array.isArray(result.groups)) return false;
    let removed = false;
    const groups = [];
    for (const group of result.groups) {
      const items = Array.isArray(group?.items) ? group.items : [];
      const remaining = items.filter((candidate) => {
        const sameFile =
          candidate.category === item.category &&
          candidate.relativePath === item.relativePath &&
          Number(candidate.rootIndex) === Number(item.rootIndex);
        if (sameFile) removed = true;
        return !sameFile;
      });
      if (remaining.length >= 2) groups.push({ ...group, items: remaining });
    }
    if (!removed) return false;
    const fileCount = groups.reduce(
      (total, group) => total + group.items.length,
      0,
    );
    const reclaimableBytes = groups.reduce(
      (total, group) => total + (Number(group.size) || 0) * (group.items.length - 1),
      0,
    );
    this.duplicateResult = {
      ...result,
      groups,
      groupCount: groups.length,
      fileCount,
      reclaimableBytes,
    };
    this.renderDuplicates(this.duplicateResult);
    return true;
  }

  async scanDuplicates() {
    if (this.scanButton.disabled) return;
    this.duplicateGroups.replaceChildren();
    this.duplicateSummary.textContent = "";
    this.setScanControls(true);
    this.setDuplicateStatus(
      "Starting a background scan. It continues even if Asset Manager is closed.",
      "loading",
    );
    try {
      await this.loadCategories();
      const payload = await fetchJson("/assets-astral/models/duplicates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: this.duplicateScope.value }),
      });
      const task = payload?.task;
      if (!task?.taskId) throw new Error("The backend did not return a scan task.");
      if (!payload.started) {
        this.setDuplicateStatus(
          "A scan is already running in the background. Attaching to its live progress.",
          "warning",
        );
      }
      this.monitorDuplicateTask(task);
    } catch (error) {
      this.stopDuplicateMonitoring();
      this.setScanControls(false);
      this.setDuplicateStatus(`Scan failed: ${error.message || error}`, "error");
    }
  }

  setScanControls(active, cancelling = false) {
    this.scanButton.disabled = Boolean(active);
    this.scanButton.textContent = active ? "Scanning in background..." : "Scan Duplicate Models";
    this.duplicateScope.setDisabled(Boolean(active));
    this.cancelScanButton.hidden = !active;
    this.cancelScanButton.disabled = Boolean(cancelling);
    this.cancelScanButton.textContent = cancelling ? "Cancelling..." : "Cancel Scan";
    this.duplicateProgress.hidden = !active;
  }

  monitorDuplicateTask(task) {
    const taskId = String(task?.taskId || "");
    if (!taskId) return;
    const status = String(task.status || "");
    if (["succeeded", "failed", "cancelled"].includes(status)) {
      this.finishDuplicateTask(task);
      return;
    }
    if (this.scanTaskId === taskId) {
      this.applyDuplicateTaskProgress(task);
      return;
    }

    this.stopDuplicateMonitoring();
    this.scanTaskId = taskId;
    this.scanPollFailures = 0;
    if (task.category !== undefined && task.category !== null) {
      this.duplicateScope.value = String(task.category);
    }
    this.applyDuplicateTaskProgress(task);
    this.scheduleDuplicatePoll();
  }

  scheduleDuplicatePoll(delay = DUPLICATE_SCAN_POLL_MS) {
    if (!this.scanTaskId) return;
    if (this.scanPollTimer !== null) window.clearTimeout(this.scanPollTimer);
    const generation = this.scanPollGeneration;
    this.scanPollTimer = window.setTimeout(
      () => void this.pollDuplicateTask(generation),
      Math.max(0, delay),
    );
  }

  async pollDuplicateTask(generation) {
    this.scanPollTimer = null;
    if (generation !== this.scanPollGeneration || !this.scanTaskId) return;
    try {
      const payload = await fetchJson(
        `/assets-astral/models/duplicates/status?${queryString({
          task_id: this.scanTaskId,
        })}`,
      );
      if (generation !== this.scanPollGeneration) return;
      const task = payload?.task;
      if (!task) throw new Error("The backend did not return a scan task status.");
      this.scanPollFailures = 0;
      this.applyDuplicateTaskProgress(task);
      if (["queued", "running", "cancelling"].includes(String(task.status))) {
        this.scheduleDuplicatePoll();
      } else {
        this.finishDuplicateTask(task);
      }
    } catch (error) {
      if (generation !== this.scanPollGeneration) return;
      this.scanPollFailures += 1;
      if (this.scanPollFailures >= 4) {
        this.stopDuplicateMonitoring();
        this.setScanControls(false);
        this.setDuplicateStatus(
          `Unable to read background scan progress for now: ${error.message || error}. The scan may still be running; re-enter this page later to reconnect.`,
          "warning",
        );
        return;
      }
      this.setDuplicateStatus(
        `Failed to read scan progress, retrying (${this.scanPollFailures}/4)...`,
        "warning",
      );
      this.scheduleDuplicatePoll(1500);
    }
  }

  async resumeDuplicateScan() {
    if (this.scanTaskId) return;
    try {
      const payload = await fetchJson(
        "/assets-astral/models/duplicates/status",
      );
      const task = payload?.task;
      if (!task) return;
      if (["queued", "running", "cancelling"].includes(String(task.status))) {
        this.monitorDuplicateTask(task);
      } else if (task.status === "succeeded" && task.result) {
        this.duplicateScope.value = String(task.category || "");
        this.renderDuplicates(task.result);
        this.setDuplicateStatus(
          "Restored the last completed duplicate-model scan.",
          "success",
        );
      }
    } catch {
      // A missing or unavailable task endpoint must not block the manager.
    }
  }

  applyDuplicateTaskProgress(task) {
    const status = String(task?.status || "");
    const phase = String(task?.phase || "");
    const cancelling = status === "cancelling";
    this.setScanControls(true, cancelling);

    if (status === "queued" || phase === "starting") {
      this.duplicateProgressBar.removeAttribute("value");
      this.duplicateProgressText.textContent = "Preparing the background scan...";
      this.duplicateCurrentFile.textContent = "";
      this.duplicateCurrentFile.title = "";
      this.setDuplicateStatus("Scan started and is preparing the file list.", "loading");
      return;
    }

    if (cancelling) {
      const progress = Math.max(0, Math.min(1, Number(task?.progress) || 0));
      this.duplicateProgressBar.value = progress;
      this.duplicateProgressText.textContent =
        `Safely stopping the scan, ${Math.round(progress * 100)}% done...`;
      this.duplicateCurrentFile.textContent = "";
      this.duplicateCurrentFile.title = "";
      this.setDuplicateStatus("Cancelling the background scan. Please wait...", "warning");
      return;
    }

    if (phase === "discovering" || phase === "queued") {
      this.duplicateProgressBar.removeAttribute("value");
      this.duplicateProgressText.textContent =
        `Scanning model directories, found ${Number(task.scannedFiles) || 0} model files...`;
      const currentLabel = task.currentFile
        ? `Current: ${task.currentFile.category} / ${task.currentFile.relativePath}`
        : "";
      this.duplicateCurrentFile.textContent = currentLabel;
      this.duplicateCurrentFile.title = currentLabel;
      this.setDuplicateStatus(
        "Organizing file sizes in the background, then calculating SHA256 for duplicate candidates.",
        "loading",
      );
      return;
    }

    if (phase === "hashing" || phase === "finalizing") {
      const progress = Math.max(0, Math.min(1, Number(task.progress) || 0));
      this.duplicateProgressBar.value = progress;
      const fileCount = Math.max(0, Number(task.totalFilesToHash) || 0);
      const hashedCount = Math.max(0, Number(task.hashedFiles) || 0);
      const failedCount = Math.max(0, Number(task.failedFiles) || 0);
      const totalBytes = Math.max(0, Number(task.totalBytesToHash) || 0);
      const hashedBytes = Math.max(0, Number(task.hashedBytes) || 0);
      const details = [];
      if (fileCount) details.push(`${hashedCount}/${fileCount} files hashed`);
      if (failedCount) details.push(`${failedCount} files could not be read`);
      if (totalBytes) {
        details.push(`${formatBytes(hashedBytes)} / ${formatBytes(totalBytes)}`);
      }
      details.push(`${Math.round(progress * 100)}%`);
      if (Number(task.bytesPerSecond) > 0) {
        details.push(`${formatBytes(task.bytesPerSecond)}/s`);
      }
      if (Number(task.etaSeconds) > 0 && progress < 1) {
        details.push(`${formatDuration(task.etaSeconds)} remaining`);
      }
      this.duplicateProgressText.textContent = details.join(" · ");
      const current = task.currentFile;
      const currentLabel = current
        ? `Current: ${current.category} / ${current.relativePath}`
        : phase === "finalizing"
          ? "Organizing duplicate groups..."
          : "";
      this.duplicateCurrentFile.textContent = currentLabel;
      this.duplicateCurrentFile.title = currentLabel;
      this.setDuplicateStatus(
        "Calculating SHA256 in the background. You may close Asset Manager; the scan will continue.",
        "loading",
      );
    }
  }

  finishDuplicateTask(task) {
    this.stopDuplicateMonitoring();
    this.setScanControls(false);
    if (task?.status === "cancelled") {
      this.setDuplicateStatus("Scan cancelled. You can start again.", "warning");
      return;
    }
    if (task?.status === "failed") {
      this.setDuplicateStatus(
        `Scan failed: ${task.error || "The backend scan ended unexpectedly."}`,
        "error",
      );
      return;
    }
    const result = task?.result;
    if (!result) {
      this.setDuplicateStatus("Scan ended, but the backend returned no result.", "error");
      return;
    }
    this.duplicateResult = result;
    this.renderDuplicates(result);
    this.setDuplicateStatus(
      result.groupCount
        ? "Scan complete. Keep one file per group and remove the other copies."
        : "Scan complete. No model files with identical content were found.",
      result.groupCount ? "success" : "empty",
    );
  }

  stopDuplicateMonitoring() {
    this.scanPollGeneration += 1;
    if (this.scanPollTimer !== null) {
      window.clearTimeout(this.scanPollTimer);
      this.scanPollTimer = null;
    }
    this.scanTaskId = null;
    this.scanPollFailures = 0;
  }

  async cancelDuplicateScan() {
    if (!this.scanTaskId || this.cancelScanButton.disabled) return;
    const taskId = this.scanTaskId;
    this.setScanControls(true, true);
    this.setDuplicateStatus("Requesting background scan cancellation...", "warning");
    try {
      const payload = await fetchJson(
        "/assets-astral/models/duplicates/cancel",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId }),
        },
      );
      const task = payload?.task;
      if (!task) throw new Error("The backend did not return a scan task.");
      this.applyDuplicateTaskProgress(task);
      if (["succeeded", "failed", "cancelled"].includes(String(task.status))) {
        if (this.scanTaskId === taskId) this.finishDuplicateTask(task);
      } else if (this.scanTaskId === taskId) {
        this.scheduleDuplicatePoll(300);
      }
    } catch (error) {
      this.setScanControls(true);
      this.setDuplicateStatus(
        `Failed to cancel scan: ${error.message || error}. The scan is still running in the background.`,
        "error",
      );
    }
  }

  renderDuplicates(result) {
    const groups = Array.isArray(result?.groups) ? result.groups : [];
    const failedFiles = Math.max(0, Number(result?.failedFiles) || 0);
    this.duplicateSummary.textContent =
      `Scanned ${Number(result?.scannedFiles) || 0} models and hashed ${Number(result?.hashedFiles) || 0} files; ` +
      (failedFiles ? `${failedFiles} files could not be read; ` : "") +
      `found ${groups.length} duplicate groups, reclaimable ${formatBytes(result?.reclaimableBytes)}.`;
    const fragment = document.createDocumentFragment();
    for (const group of groups) fragment.append(this.createDuplicateGroup(group));
    replaceChildrenPreservingScroll(
      this.duplicateGroups,
      fragment,
      "data-duplicate-sha",
    );
  }

  createDuplicateGroup(group) {
    const card = createElement("article", "astral-am-duplicate-group");
    card.dataset.duplicateSha = group.sha256;
    const header = createElement("div", "astral-am-duplicate-header");
    const heading = createElement("div", "astral-am-duplicate-heading");
    heading.append(
      createElement("strong", "", `${group.items.length} identical files`),
      createElement("span", "astral-am-muted", `SHA256 ${String(group.sha256).slice(0, 16)}…`),
    );
    header.append(
      heading,
      createElement(
        "span",
        "astral-am-duplicate-size",
        `${formatBytes(group.size)} / reclaimable ${formatBytes(group.size * (group.items.length - 1))}`,
      ),
    );
    card.append(header);
    for (const item of group.items) {
      const row = createElement("div", "astral-am-duplicate-row");
      const info = createElement("div", "astral-am-model-row-main");
      info.append(
        createElement("strong", "", item.name),
        createElement("span", "astral-am-model-path", `${item.category} / ${item.relativePath}`),
      );
      const actions = createElement("div", "astral-am-model-actions");
      const locate = createElement("button", "astral-am-button is-small", "Locate");
      locate.type = "button";
      locate.addEventListener("click", () => void this.openLocation(item));
      const remove = createElement("button", "astral-am-button is-small is-danger", "Move to Recycle Bin");
      remove.type = "button";
      remove.addEventListener("click", () => void this.recycleModel(item));
      actions.append(locate, remove);
      row.append(info, actions);
      card.append(row);
    }
    return card;
  }

  async openLocation(item) {
    const label = `${item.category} / ${item.relativePath}`;
    this.setDuplicateStatus(`Locating ${item.name} in system file manager...`, "loading");
    try {
      const result = await fetchJson("/assets-astral/models/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: item.category,
          rootIndex: item.rootIndex,
          relativePath: item.relativePath,
        }),
      });
      this.setDuplicateStatus(
        result?.revealMode === "selected"
          ? `Revealed in system file manager: ${label}`
          : `Opened containing folder: ${label}`,
        "success",
      );
    } catch (error) {
      this.setDuplicateStatus(`Locate failed: ${error.message || error}`, "error");
    }
  }
}

class MediaViewer {
  constructor(managerRoot) {
    this.managerRoot = managerRoot;
    this.asset = null;
    this.detail = null;
    this.build();
  }

  build() {
    const dialog = document.createElement("dialog");
    dialog.className = "astral-am-viewer";
    const shell = createElement("div", "astral-am-viewer-shell");
    const header = createElement("header", "astral-am-viewer-header");
    const title = createElement("div", "astral-am-viewer-title");
    const close = createElement("button", "astral-am-icon-button", "×");
    close.type = "button";
    close.title = "Close preview";
    close.addEventListener("click", () => dialog.close());
    header.append(title, close);

    const body = createElement("div", "astral-am-viewer-body");
    const preview = createElement("div", "astral-am-viewer-preview");
    const sidebar = createElement("aside", "astral-am-viewer-sidebar");
    body.append(preview, sidebar);
    shell.append(header, body);
    dialog.append(shell);
    document.body.append(dialog);
    registerLocalizationRoot(dialog);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      preview.replaceChildren();
    });

    this.dialog = dialog;
    this.title = title;
    this.preview = preview;
    this.sidebar = sidebar;
  }

  async open(asset) {
    this.asset = asset;
    this.detail = null;
    this.title.replaceChildren(
      createElement("strong", "", asset.name),
      createElement("span", "", `${asset.root}/${asset.path}`),
    );
    this.preview.replaceChildren(createElement("div", "astral-am-loading", "Loading asset information..."));
    this.sidebar.replaceChildren();
    if (!this.dialog.open) this.dialog.showModal();
    try {
      this.detail = await fetchJson(
        `/assets-astral/assets/detail?${queryString({
          root: asset.root,
          path: asset.path,
        })}`,
      );
      this.render();
    } catch (error) {
      this.preview.replaceChildren(
        createElement("div", "astral-am-error-box", `Read failed: ${error.message || error}`),
      );
    }
  }

  render() {
    const detail = this.detail;
    const asset = detail?.asset || this.asset;
    if (!asset) return;
    const source = assetMediaUrl(asset, false);
    if (asset.kind === "video") {
      const video = createElement("video", "astral-am-preview-media");
      video.src = source;
      video.controls = true;
      video.autoplay = true;
      video.loop = true;
      video.playsInline = true;
      this.preview.replaceChildren(video);
    } else if (asset.kind === "audio") {
      const audio = createElement("audio", "astral-am-preview-audio");
      audio.src = source;
      audio.controls = true;
      audio.preload = "metadata";
      this.preview.replaceChildren(audio);
    } else {
      const image = createElement("img", "astral-am-preview-media");
      image.src = source;
      image.alt = asset.name;
      this.preview.replaceChildren(image);
    }

    const info = createElement("section", "astral-am-view-section");
    info.append(
      createElement("h3", "", "Asset Information"),
      this.createDefinition("Location", `${asset.root}/${asset.path}`),
      this.createDefinition("Size", formatBytes(asset.size)),
      this.createDefinition("Modified", formatDate(asset.modified)),
      this.createDefinition("Format", asset.mime || detail?.properties?.format || "Unknown"),
    );

    const promptSection = createElement("section", "astral-am-view-section");
    const promptHeader = createElement("div", "astral-am-section-header");
    promptHeader.append(createElement("h3", "", "Prompt"));
    const promptText = createElement(
      "pre",
      "astral-am-prompt",
      detail?.prompt || "No reliable prompt metadata was found in this asset.",
    );
    if (detail?.prompt) {
      const copyPrompt = createElement("button", "astral-am-button is-small", "Copy Prompt");
      copyPrompt.type = "button";
      copyPrompt.addEventListener("click", async () => {
        try {
          await copyText(detail.prompt);
          this.setActionStatus("Prompt copied.", "success");
        } catch (error) {
          this.setActionStatus(`Copy failed: ${error.message || error}`, "error");
        }
      });
      promptHeader.append(copyPrompt);
    }
    promptSection.append(promptHeader, promptText);

    const metadata = createElement("section", "astral-am-view-section");
    const fields = detail?.metadata?.fields || [];
    metadata.append(createElement("h3", "", "Embedded Data"));
    const badges = createElement("div", "astral-am-detail-badges");
    badges.append(
      this.createBadge(detail?.metadata?.hasPrompt ? "Prompt" : "No prompt", detail?.metadata?.hasPrompt),
      this.createBadge(detail?.metadata?.hasWorkflow ? "Loadable workflow" : "No UI workflow", detail?.metadata?.hasWorkflow),
      this.createBadge(detail?.metadata?.hasApiPrompt ? "API workflow" : "No API workflow", detail?.metadata?.hasApiPrompt),
    );
    metadata.append(badges);
    if (fields.length) {
      metadata.append(createElement("p", "astral-am-muted", `Metadata fields: ${fields.join(", ")}`));
    }
    if (detail?.metadata?.sidecars?.length) {
      metadata.append(
        createElement("p", "astral-am-muted", `Same-name metadata files read: ${detail.metadata.sidecars.join(", ")}`),
      );
    }

    const actions = createElement("section", "astral-am-view-section astral-am-actions");
    const copyPath = createElement("button", "astral-am-button", "Copy File Path");
    copyPath.type = "button";
    copyPath.addEventListener("click", async () => {
      try {
        await copyText(asset.absolutePath);
        this.setActionStatus("Absolute path copied.", "success");
      } catch (error) {
        this.setActionStatus(`Copy failed: ${error.message || error}`, "error");
      }
    });

    const copyMedia = createElement(
      "button",
      "astral-am-button",
      asset.kind === "video" ? "Copy Video" : "Copy Image",
    );
    copyMedia.type = "button";
    copyMedia.addEventListener("click", () => void this.copyMedia(asset, copyMedia));

    const loadWorkflow = createElement("button", "astral-am-button", "Load Embedded Workflow");
    loadWorkflow.type = "button";
    loadWorkflow.disabled = !detail?.workflow?.available;
    loadWorkflow.title = "Loading replaces the workflow currently on the canvas.";
    loadWorkflow.addEventListener("click", () => void this.loadWorkflow(detail.workflow?.data));

    const insertNode = createElement("button", "astral-am-button is-primary", "Add to Canvas");
    insertNode.type = "button";
    insertNode.addEventListener("click", () => this.insertLoader(asset));

    actions.append(copyPath);
    if (asset.kind === "image" || asset.kind === "video") {
      actions.append(copyMedia);
    }
    actions.append(loadWorkflow, insertNode);
    const actionStatus = createElement("div", "astral-am-action-status");
    this.actionStatus = actionStatus;
    this.sidebar.replaceChildren(info, promptSection, metadata, actions, actionStatus);
  }

  createDefinition(label, value) {
    const row = createElement("div", "astral-am-definition");
    row.append(createElement("span", "", label), createElement("strong", "", value || "Unknown"));
    return row;
  }

  createBadge(text, active) {
    const badge = createElement("span", "astral-am-detail-badge", text);
    badge.classList.toggle("is-active", Boolean(active));
    return badge;
  }

  setActionStatus(message, kind = "") {
    if (!this.actionStatus) return;
    this.actionStatus.textContent = message || "";
    this.actionStatus.className = `astral-am-action-status${kind ? ` is-${kind}` : ""}`;
  }

  async copyMedia(
    asset,
    button,
    report = (message, kind = "") => this.setActionStatus(message, kind),
  ) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Copying...";
    report("");
    try {
      const response = await api.fetchApi(assetMediaUrl(asset, false), { cache: "no-store" });
      if (!response.ok) throw new Error(`Failed to read media (HTTP ${response.status})`);
      let blob = await response.blob();
      if (!window.ClipboardItem || !navigator.clipboard?.write) {
        throw new Error("This browser does not support writing media to the clipboard.");
      }

      if (asset.kind === "image") {
        const mime = blob.type || asset.mime || "image/png";
        const supportsMime =
          typeof window.ClipboardItem.supports === "function"
            ? window.ClipboardItem.supports(mime)
            : mime === "image/png";
        if (!supportsMime) {
          blob = await imageBlobToPng(blob);
        }
        try {
          await navigator.clipboard.write([
            new window.ClipboardItem({ [blob.type || "image/png"]: blob }),
          ]);
        } catch (error) {
          throw new Error(`The browser refused to write the image to the clipboard: ${error.message || error}`);
        }
      } else {
        try {
          await navigator.clipboard.write([
            new window.ClipboardItem({ [blob.type || asset.mime]: blob }),
          ]);
        } catch (error) {
          throw new Error(
            `Browsers usually do not allow copying video files: ${error.message || error}`,
          );
        }
      }
      report(
        asset.kind === "video" ? "Video copied to the clipboard." : "Image copied to the clipboard.",
        "success",
      );
    } catch (error) {
      report(`Copy failed: ${error.message || error}`, "error");
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  async loadWorkflow(workflow) {
    if (!workflow) {
      this.setActionStatus("This asset contains no loadable UI workflow.", "error");
      return;
    }
    try {
      const loadGraphData =
        (typeof app.loadGraphData === "function" && app.loadGraphData.bind(app)) ||
        (typeof app.workflowManager?.loadGraphData === "function" &&
          app.workflowManager.loadGraphData.bind(app.workflowManager));
      if (!loadGraphData) throw new Error("The current ComfyUI frontend does not expose a workflow-loading API.");
      await loadGraphData(workflow);
      this.setActionStatus("Workflow loaded.", "success");
      this.dialog.close();
      this.managerRoot.close();
    } catch (error) {
      this.setActionStatus(`Failed to load workflow: ${error.message || error}`, "error");
    }
  }

  insertLoader(
    asset,
    report = (message, kind = "") => this.setActionStatus(message, kind),
  ) {
    try {
      const nodeType =
        asset.kind === "video"
          ? "LoadVideo"
          : asset.kind === "audio"
            ? "LoadAudio"
            : "LoadImage";
      const widgetName =
        asset.kind === "video" ? "file" : asset.kind === "audio" ? "audio" : "image";
      const loader = LiteGraph.createNode(nodeType);
      if (!loader) throw new Error(`The current ComfyUI has not registered the official node ${nodeType}`);
      const widget = loader.widgets?.find((item) => item.name === widgetName);
      if (!widget) throw new Error(`${widgetName} input not found in ${nodeType}`);
      const value = asset.root === "output" ? `${asset.path} [output]` : asset.path;
      widget.value = value;
      if (Array.isArray(widget.options?.values) && !widget.options.values.includes(value)) {
        widget.options.values.push(value);
      }
      loader.title = `${nodeType} · ${asset.name}`;
      const canvas = app.canvas;
      const canvasElement = canvas?.canvas;
      const viewport = canvasElement?.getBoundingClientRect?.();
      let graphPosition = null;
      if (viewport && typeof canvas?.convertEventToCanvasOffset === "function") {
        graphPosition = canvas.convertEventToCanvasOffset({
          clientX: viewport.left + viewport.width / 2,
          clientY: viewport.top + viewport.height / 2,
        });
      } else if (
        viewport &&
        typeof canvas?.clientPosToCanvasPos === "function"
      ) {
        graphPosition = canvas.clientPosToCanvasPos([
          viewport.left + viewport.width / 2,
          viewport.top + viewport.height / 2,
        ]);
      }
      if (!Array.isArray(graphPosition) || graphPosition.length < 2) {
        graphPosition = canvas?.graph_offset
          ? [
              -canvas.graph_offset[0] / (canvas.ds?.scale || 1) + 80,
              -canvas.graph_offset[1] / (canvas.ds?.scale || 1) + 80,
            ]
          : [80, 80];
      }
      app.graph.add(loader);
      const [nodeWidth, nodeHeight] = Array.isArray(loader.size)
        ? loader.size
        : [220, 120];
      loader.pos = [
        Number(graphPosition[0]) - nodeWidth / 2,
        Number(graphPosition[1]) - nodeHeight / 2,
      ];
      app.graph.setDirtyCanvas?.(true, true);
      loader.setDirtyCanvas?.(true, true);
      if (typeof app.canvas?.selectNode === "function") {
        app.canvas.selectNode(loader);
      }
      this.dialog.close();
      this.managerRoot.close();
    } catch (error) {
      report(`Failed to insert node: ${error.message || error}`, "error");
    }
  }
}

async function imageBlobToPng(blob) {
  if (typeof createImageBitmap !== "function") {
    throw new Error("This browser cannot convert the image to PNG.");
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create an image conversion canvas.");
  context.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const png = await new Promise((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) resolve(value);
      else reject(new Error("Failed to convert the image to PNG."));
    }, "image/png");
  });
  return png;
}

class WorkspaceBrowser {
  constructor() {
    this.root = "";
    this.path = "";
    this.requestId = 0;
    this.build();
  }

  build() {
    const section = createElement(
      "section",
      "astral-am-pane astral-am-workspace-pane",
    );
    const toolbar = createElement("div", "astral-am-toolbar");
    const back = createElement("button", "astral-am-button is-small", "Up One Level");
    back.type = "button";
    const refresh = createElement("button", "astral-am-button is-small", "Reload");
    refresh.type = "button";
    const location = markUntranslated(
      createElement("div", "astral-am-workspace-location"),
    );
    toolbar.append(back, refresh, location);

    const summary = createElement("div", "astral-am-summary");
    const status = createElement("div", "astral-am-status");
    const list = createElement("div", "astral-am-workspace-list");
    section.append(toolbar, summary, status, list);

    this.element = section;
    this.backButton = back;
    this.refreshButton = refresh;
    this.location = location;
    this.summary = summary;
    this.status = status;
    this.list = list;

    back.addEventListener("click", () => {
      if (!this.root || !this.path) return;
      const parts = this.path.split("/").filter(Boolean);
      parts.pop();
      void this.navigate(this.root, parts.join("/"));
    });
    refresh.addEventListener("click", () => void this.load(true));
  }

  setStatus(message, kind = "") {
    updateStatusPreservingScroll(
      this.status,
      message,
      kind,
      this.list,
      "data-workspace-path",
    );
  }

  async navigate(root, path = "") {
    this.root = root;
    this.path = String(path || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    this.list.scrollTop = 0;
    await this.load(false);
  }

  async load(preserveScroll = false) {
    if (!this.root) return;
    this.requestId += 1;
    const requestId = this.requestId;
    this.refreshButton.disabled = true;
    this.backButton.disabled = !this.path;
    this.setStatus("Loading folders...", "loading");
    try {
      const payload = await fetchJson(
        `/assets-astral/workspace/entries?${queryString({
          root: this.root,
          path: this.path,
        })}`,
      );
      if (requestId !== this.requestId) return;
      this.root = payload?.root || this.root;
      this.path = payload?.path || "";
      this.render(payload, preserveScroll);
      this.setStatus(
        payload?.items?.length ? "" : "This folder is empty.",
        payload?.items?.length ? "" : "empty",
      );
    } catch (error) {
      if (requestId === this.requestId) {
        if (!preserveScroll) this.list.replaceChildren();
        this.setStatus(`Failed to read directory: ${error.message || error}`, "error");
      }
    } finally {
      if (requestId === this.requestId) {
        this.refreshButton.disabled = false;
        this.backButton.disabled = !this.path;
      }
    }
  }

  render(payload, preserveScroll = false) {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    this.location.textContent = `${this.root} / ${this.path || "(root)"}`;
    this.location.title = payload?.absolutePath || this.location.textContent;
    this.summary.textContent =
      `${Number(payload?.directoryCount) || 0} folders, ` +
      `${Number(payload?.fileCount) || 0} files`;

    const fragment = document.createDocumentFragment();
    for (const item of items) {
      if (item.kind === "directory") {
        const button = createElement(
          "button",
          "astral-am-workspace-item is-directory",
        );
        button.type = "button";
        button.title = item.path;
        button.dataset.workspacePath = item.path;
        button.append(
          createElement("span", "astral-am-workspace-icon", "📁"),
          createElement("strong", "", item.name),
          createElement("span", "astral-am-muted", "Folder"),
        );
        button.addEventListener("click", () => {
          void this.navigate(this.root, item.path);
        });
        fragment.append(button);
      } else {
        const itemElement = createElement(
          "div",
          "astral-am-workspace-item is-file",
        );
        itemElement.title = item.path;
        itemElement.dataset.workspacePath = item.path;
        itemElement.append(
          createElement("span", "astral-am-workspace-icon", "📄"),
          createElement("strong", "", item.name),
          createElement("span", "astral-am-muted", formatBytes(item.size)),
        );
        fragment.append(itemElement);
      }
    }
    if (preserveScroll) {
      replaceChildrenPreservingScroll(
        this.list,
        fragment,
        "data-workspace-path",
      );
    } else {
      this.list.replaceChildren(fragment);
    }
  }
}

class AssetManager {
  constructor() {
    ensureStyles();
    this.build();
    this.promptBrowser = new PromptBrowser(this);
    this.assetBrowser = new AssetBrowser(this);
    this.loraBrowser = new LoraSourceBrowser();
    this.modelBrowser = new ModelManagerBrowser(this, this.loraBrowser);
    this.workspaceBrowser = new WorkspaceBrowser();
    this.viewer = new MediaViewer(this);
    this.unsubscribeLanguage = onLanguageChange(() => {
      this.syncLanguageToggle();
      this.syncShortcutButton();
    });
    this.promptPane.append(this.promptBrowser.element);
    this.assetPane.append(this.assetBrowser.element);
    this.modelPane.append(this.modelBrowser.element);
    this.workspacePane.append(this.workspaceBrowser.element);
    this.promptsLoaded = false;
    this.assetsLoaded = false;
    this.modelsLoaded = false;
  }

  build() {
    const backdrop = createElement("div", "astral-am-backdrop");
    backdrop.hidden = true;
    const windowElement = createElement("section", "astral-am-window");
    windowElement.setAttribute("role", "dialog");
    windowElement.setAttribute("aria-label", "Astral Asset Manager");

    const header = createElement("header", "astral-am-header");
    header.title = "Drag the title bar to move the window.";
    const heading = createElement("div", "astral-am-heading");
    const headingLinks = createElement("h2", "astral-am-heading-links");
    const authorLink = createElement(
      "a",
      "astral-am-heading-link",
      "Astral星芒",
    );
    authorLink.href = "https://space.bilibili.com/176339505";
    authorLink.target = "_blank";
    authorLink.rel = "noopener noreferrer";
    authorLink.title = "Visit Astral星芒 on Bilibili";
    const starLink = createElement(
      "a",
      "astral-am-heading-link astral-am-heading-star",
      "Download updates",
    );
    starLink.href = "https://pan.quark.cn/s/7626ec1f29c7";
    starLink.target = "_blank";
    starLink.rel = "noopener noreferrer";
    starLink.title = "Download updates from Quark Drive";
    starLink.setAttribute("aria-label", "Download updates from Quark Drive");
    this.languageToggleButton = createElement(
      "button",
      "astral-am-language-toggle",
    );
    this.languageToggleButton.type = "button";
    const chineseOption = createElement(
      "span",
      "astral-am-language-option",
      "中",
    );
    chineseOption.dataset.language = "zh";
    const englishOption = createElement(
      "span",
      "astral-am-language-option",
      "EN",
    );
    englishOption.dataset.language = "en";
    this.languageToggleButton.append(chineseOption, englishOption);
    this.languageToggleButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleLanguage();
    });
    const starControl = createElement("span", "astral-am-heading-star-control");
    starControl.append(starLink, this.languageToggleButton);
    headingLinks.append(
      authorLink,
      createElement("span", "astral-am-heading-divider", "·"),
      starControl,
    );
    const projectLink = createElement(
      "a",
      "astral-am-kicker astral-am-kicker-link",
      "ComfyUI-Astral-Manage",
    );
    projectLink.href =
      "https://github.com/Astral-xm/ComfyUI-Astral-Manage/releases";
    projectLink.target = "_blank";
    projectLink.rel = "noopener noreferrer";
    projectLink.title = "Open the GitHub release page for ComfyUI-Astral-Manage";
    heading.append(projectLink, headingLinks);
    const headerActions = createElement("div", "astral-am-header-actions");
    headerActions.append(
      createElement(
        "span",
        "astral-am-directory-prompt",
        "Quick Open User Folders",
      ),
    );
    this.directoryButtons = new Map();
    for (const root of [
      "models",
      "custom_nodes",
      "input",
      "output",
      "workflows",
    ]) {
      const button = createElement(
        "button",
        "astral-am-header-button astral-am-directory-label",
      );
      button.type = "button";
      button.dataset.pathLabel = root;
      button.setAttribute("aria-label", `Open the ${root} folder`);
    button.title = `Show the ${root} folder in system file manager now`;
      markUntranslated(button);
      button.addEventListener("click", () => void this.openDirectory(root));
      this.directoryButtons.set(root, button);
      headerActions.append(button);
    }
    this.shortcutButtonLabel = createElement(
      "span",
      "astral-am-shortcut-button-label",
      "Shortcut",
    );
    this.shortcutButton = createElement(
      "button",
      "astral-am-header-button astral-am-shortcut-button",
    );
    this.shortcutButton.type = "button";
    this.shortcutButton.append(this.shortcutButtonLabel);
    this.shortcutButton.addEventListener(
      "click",
      () => void this.openShortcutEditor(),
    );
    this.refreshButton = createElement(
      "button",
      "astral-am-header-button is-primary",
      "Refresh",
    );
    this.refreshButton.type = "button";
    this.refreshButton.title = "Refresh ComfyUI node definitions, models, and workflows (same as R).";
    this.refreshButton.addEventListener(
      "click",
      () => void this.refreshComfyRegistries(),
    );
    headerActions.prepend(this.shortcutButton);
    headerActions.append(this.refreshButton);
    const close = createElement("button", "astral-am-icon-button", "×");
    close.type = "button";
    close.title = "Close";
    close.addEventListener("click", () => this.close());
    header.append(heading, headerActions, close);

    const tabs = createElement("nav", "astral-am-tabs");
    tabs.setAttribute("aria-label", "Asset manager tabs");
    this.promptTab = createElement("button", "astral-am-tab is-active", "Prompt Management");
    this.assetTab = createElement("button", "astral-am-tab", "Media Management");
    this.modelTab = createElement("button", "astral-am-tab", "Model Management");
    this.promptTab.type = "button";
    this.assetTab.type = "button";
    this.modelTab.type = "button";
    tabs.append(this.promptTab, this.assetTab, this.modelTab);

    const main = createElement("main", "astral-am-main");
    this.promptPane = createElement("div", "astral-am-pane-host");
    this.assetPane = createElement("div", "astral-am-pane-host");
    this.assetPane.hidden = true;
    this.modelPane = createElement("div", "astral-am-pane-host");
    this.modelPane.hidden = true;
    this.workspacePane = createElement("div", "astral-am-pane-host");
    this.workspacePane.hidden = true;
    main.append(
      this.promptPane,
      this.assetPane,
      this.modelPane,
      this.workspacePane,
    );
    windowElement.append(header, tabs, main);
    backdrop.append(windowElement);
    document.body.append(backdrop);

    this.backdrop = backdrop;
    this.windowElement = windowElement;
    this.windowOffset = { x: 0, y: 0 };
    this.windowDrag = null;
    this.promptTab.addEventListener("click", () => this.showTab("prompts"));
    this.assetTab.addEventListener("click", () => this.showTab("assets"));
    this.modelTab.addEventListener("click", () => this.showTab("models"));
    header.addEventListener(
      "pointerdown",
      (event) => this.startWindowDrag(event),
    );
    window.addEventListener(
      "pointermove",
      (event) => this.moveWindowDrag(event),
    );
    window.addEventListener(
      "pointerup",
      (event) => this.endWindowDrag(event),
    );
    window.addEventListener(
      "pointercancel",
      (event) => this.endWindowDrag(event),
    );
    window.addEventListener("resize", () => {
      this.promptBrowser?.hideSkillPreview();
      if (!backdrop.hidden) this.clampWindowToViewport();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !backdrop.hidden && !this.viewer?.dialog?.open) {
        this.close();
      }
    });
    registerLocalizationRoot(windowElement);
    this.syncLanguageToggle();
    this.syncShortcutButton();
  }

  syncLanguageToggle() {
    if (!this.languageToggleButton) return;
    const language = getLanguage();
    const isEnglish = language === "en";
    this.languageToggleButton.classList.toggle("is-en", isEnglish);
    this.languageToggleButton.setAttribute("aria-pressed", String(isEnglish));
    this.languageToggleButton.title = isEnglish
      ? "Switch to Chinese"
      : "Switch to English";
    this.languageToggleButton.setAttribute(
      "aria-label",
      isEnglish ? "Switch to Chinese" : "Switch to English",
    );
    if (this.windowElement) {
      this.windowElement.lang = isEnglish ? "en" : "zh-CN";
    }
  }

  syncShortcutButton() {
    if (!this.shortcutButton) return;
    const shortcutLabel = formatShortcut(getAssetManagerShortcut());
    this.shortcutButtonLabel.textContent = "Shortcut";
    const description = `Customize the Asset Manager shortcut (current: ${shortcutLabel})`;
    this.shortcutButton.title = description;
    this.shortcutButton.setAttribute("aria-label", description);
  }

  async openShortcutEditor() {
    const currentShortcut = getAssetManagerShortcut();
    const nextShortcut = await showAstralShortcutRecorder({
      title: "Customize Panel Shortcut",
      message:
        "Set the shortcut that opens the Asset Manager. It takes effect immediately and works while the panel is closed.",
      initialShortcut: currentShortcut,
      defaultShortcut: DEFAULT_ASSET_MANAGER_SHORTCUT,
      shortcutFromEvent: shortcutFromKeyboardEvent,
      validateShortcut: validateAssetManagerShortcut,
      formatShortcut,
    });
    if (!nextShortcut) return;
    activeAssetManagerShortcut = nextShortcut;
    this.syncShortcutButton();
    if (!saveAssetManagerShortcut(nextShortcut)) {
      await showAstralAlert({
        title: "Unable to Save Shortcut",
        message:
          "The browser denied local storage access. The new shortcut remains active for this session and resets to the default after a page refresh.",
        tone: "warning",
      });
    }
    window.setTimeout(() => this.shortcutButton?.focus(), 0);
  }

  open(tab = "prompts") {
    this.backdrop.hidden = false;
    this.showTab(tab);
    this.clampWindowToViewport();
    const activeTab = {
      prompts: this.promptTab,
      assets: this.assetTab,
      models: this.modelTab,
    }[this.activeTab];
    activeTab?.focus();
  }

  isOpen() {
    return Boolean(this.backdrop && !this.backdrop.hidden);
  }

  toggle(tab = this.activeTab || "prompts") {
    if (this.isOpen()) {
      this.close();
      return;
    }
    this.open(tab);
  }

  openChatAssetSelection(promptBrowser = this.promptBrowser) {
    this.open("assets");
    this.assetBrowser.beginChatSelection(promptBrowser);
  }

  openChatSkillSelection(promptBrowser = this.promptBrowser) {
    this.open("prompts");
    promptBrowser.setMode("skills");
    void promptBrowser.loadSkills();
  }

  openChatSystemPromptSelection(
    promptBrowser = this.promptBrowser,
    category = "all",
  ) {
    this.open("prompts");
    promptBrowser.setMode("templates");
    promptBrowser.templateSearch.value = "";
    const requestedCategory = String(category || "all");
    promptBrowser.templateCategory.value = [
      "all",
      ...PROMPT_CATEGORY_OPTIONS.map((option) => option.value),
    ].includes(requestedCategory)
      ? requestedCategory
      : "all";
    void promptBrowser.loadTemplates();
  }

  close() {
    this.promptBrowser?.hideSkillPreview();
    if (this.viewer?.dialog?.open) this.viewer.dialog.close();
    this.backdrop.hidden = true;
  }

  startWindowDrag(event) {
    const target = event.target;
    const interactive = target?.closest?.(
      "a, button, input, select, textarea, summary, [role='button'], [contenteditable='true']",
    );
    if (event.button !== 0 || interactive || this.windowDrag) return;
    const rect = this.windowElement.getBoundingClientRect();
    this.windowDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      offsetX: this.windowOffset.x,
      offsetY: this.windowOffset.y,
      baseLeft: rect.left - this.windowOffset.x,
      baseTop: rect.top - this.windowOffset.y,
      width: rect.width,
      height: rect.height,
    };
    this.windowElement.classList.add("is-dragging");
    try {
      this.windowElement.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is optional; document-level pointermove still works.
    }
    event.preventDefault();
  }

  moveWindowDrag(event) {
    const drag = this.windowDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const maxLeft = Math.max(
      WINDOW_VIEWPORT_MARGIN,
      window.innerWidth - drag.width - WINDOW_VIEWPORT_MARGIN,
    );
    const maxTop = Math.max(
      WINDOW_VIEWPORT_MARGIN,
      window.innerHeight - drag.height - WINDOW_VIEWPORT_MARGIN,
    );
    const desiredLeft = drag.startLeft + event.clientX - drag.startX;
    const desiredTop = drag.startTop + event.clientY - drag.startY;
    const nextLeft = Math.min(
      maxLeft,
      Math.max(WINDOW_VIEWPORT_MARGIN, desiredLeft),
    );
    const nextTop = Math.min(
      maxTop,
      Math.max(WINDOW_VIEWPORT_MARGIN, desiredTop),
    );
    this.windowOffset = {
      x: nextLeft - drag.baseLeft,
      y: nextTop - drag.baseTop,
    };
    this.applyWindowOffset();
    event.preventDefault();
  }

  endWindowDrag(event) {
    const drag = this.windowDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.windowDrag = null;
    this.windowElement.classList.remove("is-dragging");
    if (this.windowElement.hasPointerCapture?.(event.pointerId)) {
      this.windowElement.releasePointerCapture(event.pointerId);
    }
    this.clampWindowToViewport();
  }

  applyWindowOffset() {
    this.windowElement.style.transform =
      `translate3d(${this.windowOffset.x}px, ${this.windowOffset.y}px, 0)`;
  }

  clampWindowToViewport() {
    if (!this.windowElement || this.backdrop.hidden) return;
    const rect = this.windowElement.getBoundingClientRect();
    const maxLeft = Math.max(
      WINDOW_VIEWPORT_MARGIN,
      window.innerWidth - rect.width - WINDOW_VIEWPORT_MARGIN,
    );
    const maxTop = Math.max(
      WINDOW_VIEWPORT_MARGIN,
      window.innerHeight - rect.height - WINDOW_VIEWPORT_MARGIN,
    );
    const nextLeft = Math.min(maxLeft, Math.max(WINDOW_VIEWPORT_MARGIN, rect.left));
    const nextTop = Math.min(maxTop, Math.max(WINDOW_VIEWPORT_MARGIN, rect.top));
    this.windowOffset = {
      x: this.windowOffset.x + nextLeft - rect.left,
      y: this.windowOffset.y + nextTop - rect.top,
    };
    this.applyWindowOffset();
  }

  showTab(tab) {
    if (tab === "loras") tab = "models";
    if (!["prompts", "assets", "models", "workspace"].includes(tab)) {
      tab = "prompts";
    }
    if (tab !== "prompts") this.promptBrowser?.hideSkillPreview();
    this.activeTab = tab;
    this.promptPane.hidden = tab !== "prompts";
    this.assetPane.hidden = tab !== "assets";
    this.modelPane.hidden = tab !== "models";
    this.workspacePane.hidden = tab !== "workspace";
    this.promptTab.classList.toggle("is-active", tab === "prompts");
    this.assetTab.classList.toggle("is-active", tab === "assets");
    this.modelTab.classList.toggle("is-active", tab === "models");
    if (tab === "prompts" && !this.promptsLoaded) {
      this.promptsLoaded = true;
      void this.promptBrowser.load(true);
    }
    if (tab === "assets" && !this.assetsLoaded) {
      this.assetsLoaded = true;
      void this.assetBrowser.loadTree();
      void this.assetBrowser.load(true);
    }
    if (tab === "models" && !this.modelsLoaded) {
      this.modelsLoaded = true;
      void this.modelBrowser.load(true);
    }
  }

  async openDirectory(root) {
    const button = this.directoryButtons.get(root);
    if (button) button.disabled = true;
    try {
      await fetchJson("/assets-astral/workspace/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, path: "" }),
      });
    } catch (error) {
      await showAstralAlert({
        title: `Unable to open ${root}`,
        message: String(error.message || error),
        tone: "warning",
      });
    } finally {
      if (button) button.disabled = false;
    }
  }

  async refreshComfyRegistries() {
    if (this.refreshButton.disabled) return;
    this.refreshButton.disabled = true;
    this.refreshButton.textContent = "Refreshing";
    try {
      const command = app.extensionManager?.command;
      if (typeof command?.execute === "function") {
        await command.execute("Comfy.RefreshNodeDefinitions");
      } else if (typeof app.refreshComboInNodes === "function") {
        await app.refreshComboInNodes();
      } else {
        throw new Error("The current ComfyUI frontend does not expose a refresh API.");
      }

      this.modelBrowser.categoriesPromise = null;
      this.modelBrowser.lorasLoaded = false;
      this.loraBrowser.selected.clear();
      this.loraBrowser.selectionPool.clear();
      this.loraBrowser.selectionScopeComplete = false;
      this.loraBrowser.loadingSources.clear();
      this.assetsLoaded = false;
      this.modelsLoaded = false;

      if (this.activeTab === "models") {
        await this.modelBrowser.load(true, true);
      } else if (this.activeTab === "assets") {
        await this.assetBrowser.reloadPreservingLoadedCount(
          this.assetBrowser.items.length,
          true,
        );
      } else if (this.activeTab === "workspace" && this.workspaceBrowser.root) {
        await this.workspaceBrowser.load(true);
      }
    } catch (error) {
      await showAstralAlert({
        title: "Failed to Refresh ComfyUI Data",
        message: String(error.message || error),
        tone: "warning",
      });
    } finally {
      this.refreshButton.disabled = false;
      this.refreshButton.textContent = "Refresh";
    }
  }
}

function openAssetManager(tab = "prompts") {
  ensureStyles();
  manager ||= new AssetManager();
  manager.open(tab);
}

function openAstralApiConfig(section = "api") {
  ensureStyles();
  manager ||= new AssetManager();
  manager.open("prompts");
  manager.promptBrowser.openApiConfigSection(
    section === "local" ? "local" : "api",
  );
  void manager.promptBrowser.loadApiConfig();
}

function toggleAssetManager() {
  ensureStyles();
  manager ||= new AssetManager();
  manager.toggle();
}

function openAstralPromptCategory(category = "all") {
  ensureStyles();
  manager ||= new AssetManager();
  manager.openChatSystemPromptSelection(
    manager.promptBrowser,
    String(category || "all"),
  );
}

function installAstralMenuButton(attempt = 0) {
  // Load styles before inserting the button so the first paint never exposes
  // an unstyled browser-default button while app.menu is still initializing.
  ensureStyles();
  if (document.querySelector("[data-assets-astral-menu-button]")) return;
  const settingsGroup = app.menu?.settingsGroup?.element;
  if (!settingsGroup) {
    if (attempt < 40) {
      window.setTimeout(() => installAstralMenuButton(attempt + 1), 100);
    }
    return;
  }

  const group = createElement("div", "astral-am-menu-button-group");
  group.dataset.assetsAstralMenuButton = "true";
  const button = createElement("button", "astral-am-menu-button");
  button.type = "button";
  button.title = "Astral Asset Manager";
  button.setAttribute("aria-label", "Open or close Astral Asset Manager");
  button.textContent = "Assets";
  markUntranslated(button);
  registerLocalizationRoot(button);
  button.addEventListener("click", () => {
    toggleAssetManager();
    button.blur();
  });
  group.append(button);
  settingsGroup.before(group);
}

app.registerExtension({
  name: "ComfyUI-Astral-Manage.NodeTypeMigration",
  beforeConfigureGraph(graphData) {
    migrateLegacyNodeTypes(graphData);
  },
  beforeRegisterVueAppNodeDefs(nodeDefs) {
    hideLegacyNodeDefs(nodeDefs);
  },
  setup() {
    for (const legacyType of Object.keys(LEGACY_NODE_TYPES)) {
      LiteGraph.unregisterNodeType?.(legacyType);
    }
  },
});

app.registerExtension({
  name: "ComfyUI-Astral-Manage.AssetManager",
  setup() {
    window.openAssetsAstralManager = (tab = "prompts") =>
      openAssetManager(tab);
    window.openAssetsAstralPromptCategory = (category = "all") =>
      openAstralPromptCategory(category);
    window.openAssetsAstralApiConfig = (section = "api") =>
      openAstralApiConfig(section);
    installAssetManagerShortcut();
    installAstralMenuButton();
  },
});
