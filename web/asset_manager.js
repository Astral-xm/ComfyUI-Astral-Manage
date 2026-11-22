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
  if (!source) return "这个 Skill 的正文为空。";
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
  // height, such as when "刷新来源" replaces its metadata with a loading state.
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
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.ceil(seconds % 60);
  if (minutes < 60) return `${minutes} 分 ${remainder} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
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
      const contentType = response.headers.get("content-type") || "未知类型";
      const preview = text.replace(/\s+/g, " ").trim().slice(0, 160);
      throw new Error(
        `后端返回了无法解析的数据（HTTP ${response.status}，${contentType}）` +
          (preview ? `：${preview}` : ""),
      );
    }
  }
  if (!response.ok || payload?.error) {
    const error = new Error(
      payload?.error || `请求失败（HTTP ${response.status}）`,
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
    civitai: "C站",
    huggingface: "Hugging Face",
    modelscope: "魔搭",
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
  if (!copied) throw new Error("浏览器拒绝了剪贴板写入");
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
      label.textContent = "无可用选项";
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
    search.placeholder = "搜索文件名或子目录";
    search.autocomplete = "off";
    search.setAttribute("aria-label", "筛选素材关键词");

    const kind = createElement("select", "astral-am-select");
    kind.setAttribute("aria-label", "素材类型");
    for (const [value, label] of [
      ["all", "全部类型"],
      ["image", "图片"],
      ["video", "视频"],
    ]) {
      const option = createElement("option", "", label);
      option.value = value;
      kind.append(option);
    }

    const root = createElement("select", "astral-am-select");
    root.setAttribute("aria-label", "素材目录");
    for (const [value, label] of [
      ["all", "input + output"],
      ["input", "仅 input"],
      ["output", "仅 output"],
    ]) {
      const option = createElement("option", "", label);
      option.value = value;
      root.append(option);
    }

    const refresh = createElement("button", "astral-am-button", "刷新");
    refresh.type = "button";
    toolbar.append(root, kind, search, refresh);

    const directoryNav = createElement("div", "astral-am-directory-nav");
    const breadcrumb = createElement("div", "astral-am-breadcrumb");
    const tree = createElement("div", "astral-am-directory-tree");
    directoryNav.append(breadcrumb, tree);

    const fileActions = createElement("div", "astral-am-file-actions");
    const selectAll = createElement("button", "astral-am-button is-small", "全选");
    const invertSelection = createElement(
      "button",
      "astral-am-button is-small",
      "反选",
    );
    const clearSelection = createElement("button", "astral-am-button is-small", "清除选择");
    const renameSelected = createElement("button", "astral-am-button is-small", "重命名");
    const renamePrefix = createElement("button", "astral-am-button is-small", "按前缀改名");
    const deleteSelected = createElement("button", "astral-am-button is-small is-danger", "删除选中");
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
    renameSelected.title = "重命名一个选中的图片或视频";
    renamePrefix.title = "按 image1、image2 的递增规则批量重命名选中的图片";
    deleteSelected.title = "将选中素材移到 Windows 回收站";
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
    search.placeholder = "搜索文件名或子目录";
    search.autocomplete = "off";
    search.setAttribute("aria-label", "筛选素材关键词");

    const kind = createCustomDropdown("astral-am-category-dropdown");
    kind.element.setAttribute("aria-label", "素材类型");
    kind.setOptions([
      { value: "all", label: "全部类型" },
      { value: "image", label: "图片" },
      { value: "video", label: "视频" },
      { value: "audio", label: "音频" },
    ]);

    const root = createCustomDropdown("astral-am-category-dropdown");
    root.element.setAttribute("aria-label", "素材目录");
    root.setOptions([
      { value: "all", label: "input + output" },
      { value: "input", label: "input" },
      { value: "output", label: "output" },
    ]);

    const refresh = createElement("button", "astral-am-button", "刷新");
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
    const selectAll = createElement("button", "astral-am-button is-small", "全选");
    const invertSelection = createElement(
      "button",
      "astral-am-button is-small",
      "反选",
    );
    const clearSelection = createElement("button", "astral-am-button is-small", "清除选择");
    const renameSelected = createElement("button", "astral-am-button is-small", "重命名");
    const renamePrefix = createElement("button", "astral-am-button is-small", "按前缀改名");
    const addToChat = createElement("button", "astral-am-button is-small", "加入对话");
    const deleteSelected = createElement(
      "button",
      "astral-am-button is-small is-danger",
      "删除选中",
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
    renameSelected.title = "重命名一个选中的图片、视频或音频";
    renamePrefix.title = "按 image1、image2 的递增规则批量重命名选中的图片";
    addToChat.title = "将勾选的素材追加到当前 API 对话";
    deleteSelected.title = "将选中素材移到 Windows 回收站";
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
      `请勾选要加入当前 API 对话的素材，最多 ${this.chatSelectionTarget.chatComposerAttachmentLimit} 个。`,
    );
  }

  async addSelectedToChat() {
    const items = this.selectedItems();
    if (!items.length) {
      this.setStatus("请先勾选要加入对话的素材。", "warning");
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
      this.setStatus(result?.message || "加入对话失败。", "warning");
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
      ? "正在全选..."
      : allSelected
        ? `已全选 (${this.total})`
        : this.total
          ? `全选 (${this.total})`
          : "全选";
    this.addToChatButton.textContent = count
      ? count > chatAttachmentLimit
        ? `加入对话 (前 ${chatAttachmentLimit}/${count})`
        : `加入对话 (${count})`
      : "加入对话";
    this.deleteButton.textContent = count ? `删除选中 (${count})` : "删除选中";
    if (this.total) {
      this.summary.textContent =
        `共 ${this.total} 个素材，已显示 ${this.items.length} 个` +
        (count ? ` · 已选 ${count} 个` : "");
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
        ? "正在读取当前路径的全部素材并反选..."
        : "正在读取当前路径的全部素材...",
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
          ? `反选完成，当前选中 ${this.selected.size} 个素材。`
          : `已全选当前路径的 ${this.selected.size} 个素材，包括尚未加载显示的文件。`,
        "success",
      );
    } catch (error) {
      this.setStatus(
        `${invert ? "反选" : "全选"}失败：${error.message || error}`,
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
          ? `已在系统文件管理器中定位：${root}/${path}`
          : select && path
            ? `已打开文件所在目录：${result?.absolutePath || `${endpointRoot}/${path}`}`
            : `已打开系统文件管理器：${result?.absolutePath || `${endpointRoot}/${path}`}`,
        "success",
      );
    } catch (error) {
      this.setStatus(`打开系统文件管理器失败：${error.message || error}`, "error");
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
    this.setStatus(`正在${label}...`, "loading");
    try {
      const result = await fetchJson(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      this.selected.clear();
      await this.reloadPreservingLoadedCount(loadedCount, true);
      this.setStatus(`${label}完成，共处理 ${Number(result?.count) || 0} 个素材。`, "success");
    } catch (error) {
      this.setStatus(`${label}失败：${error.message || error}`, "error");
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
      title: "重命名素材",
      message: `输入“${item.name}”的新文件名。省略扩展名时会保留原扩展名。`,
      label: "新文件名",
      initialValue: item.name,
      confirmLabel: "重命名",
    });
    if (newName === null || !newName.trim() || newName.trim() === item.name) return;
    await this.runAssetOperation("重命名", "/assets-astral/assets/rename", {
      mode: "single",
      items: assetSelectionPayload(items),
      newName: newName.trim(),
    });
  }

  async renameItem(item) {
    if (this.operationBusy) return;
    const newName = await showAstralPrompt({
      title: "重命名素材",
      message: `输入“${item.name}”的新文件名。省略扩展名时会保留原扩展名。`,
      label: "新文件名",
      initialValue: item.name,
      confirmLabel: "重命名",
    });
    if (newName === null || !newName.trim() || newName.trim() === item.name) return;
    await this.runAssetOperation("重命名", "/assets-astral/assets/rename", {
      mode: "single",
      items: assetSelectionPayload([item]),
      newName: newName.trim(),
    });
  }

  async renameSelectedWithPrefix() {
    const items = this.selectedItems();
    if (!items.length || this.operationBusy) return;
    if (!items.every((item) => item.kind === "image")) {
      this.setStatus("按前缀批量改名目前只支持选中的图片。", "warning");
      return;
    }
    const prefix = await showAstralPrompt({
      title: "按前缀批量重命名",
      message: "将按选择顺序生成 image1、image2…",
      label: "文件名前缀",
      initialValue: "image",
      confirmLabel: "开始重命名",
    });
    if (prefix === null || !prefix.trim()) return;
    await this.runAssetOperation("按前缀批量改名", "/assets-astral/assets/rename", {
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
      title: "移至回收站",
      message:
        `将选中的 ${items.length} 个素材移到 Windows 回收站？\n\n` +
        "此操作会从 input/output 中移除文件；确认后执行。",
      confirmLabel: "移至回收站",
    });
    if (!confirmed) return;
    const loadedCount = this.items.length;
    let processed = 0;
    this.operationBusy = true;
    this.updateSelectionControls();
    this.setStatus(`正在将 ${items.length} 个素材移到回收站...`, "loading");
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
          `正在移至回收站：${processed}/${items.length}`,
          "loading",
        );
      }
      this.selected.clear();
      await this.reloadPreservingLoadedCount(loadedCount, true);
      this.setStatus(
        `删除完成，共将 ${processed} 个素材移到 Windows 回收站。`,
        "success",
      );
    } catch (error) {
      this.selected.clear();
      try {
        await this.reloadPreservingLoadedCount(loadedCount, true);
      } catch {
        // Keep the original backend error visible.
      }
      this.setStatus(`删除失败：${error.message || error}`, "error");
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
    this.setStatus(reset ? "正在读取素材..." : "正在加载更多素材...", "loading");

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
        page.length ? "" : this.items.length ? "没有更多素材" : "没有找到符合条件的素材",
        page.length ? "" : "empty",
      );
    } catch (error) {
      if (requestId === this.requestId) {
        this.setStatus(`读取失败：${error.message || error}`, "error");
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
    this.tree.replaceChildren(createElement("span", "astral-am-muted", "正在读取目录..."));
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
        createElement("span", "astral-am-source-error", `目录读取失败：${error.message || error}`),
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
        "正在浏览 input 与 output 的全部子目录",
      );
    } else if (!currentParts.length) {
      locationLine = createElement(
        "span",
        "astral-am-location-path",
        `当前目录：${this.assetRoot.value} /（根目录）`,
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
    openRoot.title = `在系统文件管理器中打开 ${treeLocation}`;
      openRoot.addEventListener(
        "click",
        () => void this.openLocation(root, treePath, false),
      );
      rootRow.append(rootHeader, openRoot);
      group.append(rootRow);
      const directories = Array.isArray(payload?.directories) ? payload.directories : [];
      if (!directories.length) {
        group.append(createElement("span", "astral-am-muted astral-am-tree-empty", "没有子目录"));
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
    openDirectory.title = `在系统文件管理器中打开 ${root}/${directory.path}`;
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
    preview.title = "点击预览";

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
    const kindLabels = { image: "图片", video: "视频", audio: "音频" };
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
    selection.title = "勾选后可批量加入对话、删除或按前缀改名";
    const checkbox = createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected;
    checkbox.setAttribute("aria-label", `选择 ${item.name}`);
    checkbox.addEventListener("change", () => {
      this.setCardSelected(item, checkbox.checked);
    });
    selection.append(checkbox);

    const actions = createElement("div", "astral-am-card-actions");
    const copyMedia = createElement(
      "button",
      "astral-am-card-action",
      item.kind === "video" ? "复制视频" : "复制图片",
    );
    copyMedia.type = "button";
    copyMedia.title =
      item.kind === "video" ? "将此视频复制到系统剪贴板" : "将此图片复制到系统剪贴板";
    copyMedia.addEventListener(
      "click",
      () =>
        void this.root.viewer.copyMedia(item, copyMedia, (message, kind) => {
          this.setStatus(message, kind);
        }),
    );
    const insertNode = createElement("button", "astral-am-card-action", "放入画布");
    insertNode.type = "button";
    insertNode.title = "使用官方加载节点放入当前画布";
    insertNode.addEventListener("click", () => {
      this.root.viewer.insertLoader(item, (message, kind) => {
        this.setStatus(message, kind);
      });
    });
    const addToChat = createElement("button", "astral-am-card-action", "加入对话");
    addToChat.type = "button";
    addToChat.title = "将此素材追加到当前 API 对话";
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
    search.placeholder = "搜索提示词或素材路径";
    search.autocomplete = "off";
    search.setAttribute("aria-label", "搜索提示词");

    const root = createElement("select", "astral-am-select");
    root.setAttribute("aria-label", "提示词素材目录");
    for (const [value, label] of [
      ["all", "input + output"],
      ["input", "仅 input"],
      ["output", "仅 output"],
    ]) {
      const option = createElement("option", "", label);
      option.value = value;
      root.append(option);
    }

    const refresh = createElement("button", "astral-am-button", "刷新");
    refresh.type = "button";
    toolbar.append(search, root, refresh);

    const note = createElement(
      "p",
      "astral-am-note",
      "从图片和视频的内嵌元数据、工作流及同名 JSON 文件中提取提示词。预览素材时会载入现有媒体查看器。",
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
    this.setStatus(reset ? "正在扫描素材提示词..." : "正在加载更多提示词...", "loading");
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
        `共 ${this.total} 条提示词，已显示 ${this.items.length} 条` +
        (payload?.scannedAssets ? ` · 扫描 ${payload.scannedAssets} 个素材` : "");
      this.setStatus(
        page.length ? "" : this.items.length ? "没有更多提示词" : "没有找到符合条件的提示词",
        page.length ? "" : "empty",
      );
    } catch (error) {
      if (requestId === this.requestId) {
        this.setStatus(`读取失败：${error.message || error}`, "error");
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
    const copy = createElement("button", "astral-am-button is-small", "复制提示词");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        await copyText(entry.prompt);
        copy.textContent = "已复制";
        window.setTimeout(() => {
          copy.textContent = "复制提示词";
        }, 1200);
      } catch (error) {
        this.setStatus(`复制失败：${error.message || error}`, "error");
      }
    });
    const preview = createElement("button", "astral-am-button is-small", "预览素材");
    preview.type = "button";
    preview.addEventListener("click", () => this.root.viewer.open(entry.asset));
    actions.append(copy, preview);
    footer.append(actions);
    card.append(header, prompt, footer);
    return card;
  }
}

const PROMPT_CATEGORY_OPTIONS = [
  { value: "text", label: "文本" },
  { value: "image", label: "图片" },
  { value: "audio", label: "音频" },
  { value: "video", label: "视频" },
  { value: "expand", label: "提示词扩写" },
  { value: "invert", label: "图像反推" },
];

const API_TASK_DEFINITIONS = [
  {
    id: "text",
    label: "纯文本模式",
    hint: "翻译、提示词扩写与优化",
    legacyIds: ["optimize", "translate"],
    legacyWriteIds: ["optimize", "translate"],
  },
  {
    id: "image",
    label: "图片模式",
    hint: "图像反推提示词",
    legacyIds: ["invert"],
    legacyWriteIds: ["invert"],
  },
  {
    id: "multimodal",
    label: "多模态模式",
    hint: "图像、视频、音频识别",
    legacyIds: ["chat"],
    legacyWriteIds: ["chat"],
  },
];
const LOCAL_CHAT_MODE_DEFINITION = Object.freeze({
  id: "local",
  label: "本地模式",
  hint: "使用 ComfyUI/models/LLM 中的 GGUF",
});
const CHAT_MODE_DEFINITIONS = [
  ...API_TASK_DEFINITIONS,
  LOCAL_CHAT_MODE_DEFINITION,
];
const TRANSLATION_LANGUAGES = [
  { value: "en", label: "英语 (English)" },
  { value: "zh", label: "简体中文" },
  { value: "ja", label: "日语 (日本語)" },
  { value: "ko", label: "韩语 (한국어)" },
  { value: "fr", label: "法语 (Français)" },
  { value: "de", label: "德语 (Deutsch)" },
  { value: "es", label: "西班牙语 (Español)" },
  { value: "ru", label: "俄语 (Русский)" },
  { value: "pt", label: "葡萄牙语 (Português)" },
  { value: "it", label: "意大利语 (Italiano)" },
  { value: "ar", label: "阿拉伯语 (العربية)" },
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
  systemPrompt: "你是一个严谨、有帮助的 AI 助手。",
});

const LOCAL_LLM_PARAMETER_HINTS = Object.freeze({
  nCtx: "模型一次可处理的最大上下文 Token 数。数值越大越占内存或显存。",
  nBatch: "提示词批处理大小。增大通常提高吞吐，但会占用更多内存。",
  nUbatch: "微批大小，影响推理速度和显存占用。通常保持默认即可。",
  maxTokens: "单次回复最多生成的 Token 数，不包含输入的 Token。",
  maxRounds: "多轮对话发送时携带的历史轮数；Prompt Processor 不携带历史。",
  temperature: "控制随机性。数值越低越稳定，越高越有创意和发散性。",
  topP: "核采样阈值。通常与 Temperature 只调整其中一个，常用 0.9–0.95。",
  topK: "每一步只从概率最高的 K 个候选 Token 中采样。",
  minP: "过滤概率低于最高候选指定比例的 Token，用于减少低概率噪声。",
  repeatPenalty: "降低最近出现过的 Token 再次重复的概率。",
  frequencyPenalty: "按 Token 出现频率进行惩罚，可减少重复用词。",
  presencePenalty: "Token 只要出现过就进行惩罚，可鼓励模型引入新内容。",
  gpuLayers: "-1 表示尽可能全部卸载到 GPU；0 表示只使用 CPU。",
  threads: "CPU 推理线程数。0 表示由推理库自动选择。",
  seed: "本地采样种子。固定值可复现，修改后可生成不同结果。",
  maxImageEdge: "图片送入模型前的最长边像素。越小越快，也越省内存。",
  imageJpegQuality: "图片转换为 JPEG 时的质量。越高越清晰，请求数据也越大。",
  contextCheckpoints: "llama.cpp 上下文检查点数量，用于复用长上下文；0 表示关闭。",
  flashAttention: "注意力计算加速选项。不兼容时可选择关闭或自动。",
  kvCacheTypeK: "K 侧 KV Cache 类型。Q8_0 可节省显存，但可能有少量精度损失。",
  kvCacheTypeV: "V 侧 KV Cache 类型。Q8_0 可节省显存，但可能有少量精度损失。",
  reasoningEffort: "Qwen3.8 的推理强度。XHigh 偏质量，Low 偏速度。",
  enableThinking: "启用模型思考过程。对 Qwen3.8、Qwen3.5/3.6 与 Gemma4 生效。",
  preserveThinking: "在历史上下文中保留 think 内容；关闭可节省上下文。",
  useMmap: "使用内存映射加载模型。默认开启；关闭会更快消耗物理内存。",
});
function promptCategoryLabel(category) {
  return (
    PROMPT_CATEGORY_OPTIONS.find((option) => option.value === category)?.label ||
    category ||
    "文本"
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
    modeTabs.setAttribute("aria-label", "提示词管理工具");
    this.skillTagModeButton = createElement(
      "button",
      "astral-am-subtab",
      "提示词灵感",
    );
    this.templateModeButton = createElement(
      "button",
      "astral-am-subtab is-active",
      "系统提示词管理",
    );
    this.skillModeButton = createElement("button", "astral-am-subtab", "Skill 管理");
    this.chatModeButton = createElement("button", "astral-am-subtab", "API 对话");
    this.apiConfigModeButton = createElement(
      "button",
      "astral-am-subtab",
      "API配置",
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
    this.templateSearch.placeholder = "搜索标题、分类或提示词内容";
    this.templateSearch.autocomplete = "off";
    this.templateSearch.setAttribute("aria-label", "搜索提示词模板");
    this.templateCategory = createCustomDropdown("astral-am-category-dropdown");
    this.templateCategory.element.setAttribute("aria-label", "提示词模板分类");
    this.templateCategory.setOptions([
      { value: "all", label: "全部分类" },
      ...PROMPT_CATEGORY_OPTIONS,
    ]);
    this.templateCreateButton = createElement(
      "button",
      "astral-am-button is-primary",
      "新建模板",
    );
    this.templateCreateButton.type = "button";
    this.templateRefreshButton = createElement("button", "astral-am-button", "刷新");
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
    this.apiProviderTabs.setAttribute("aria-label", "API 配置列表");
    this.apiProviderTabs.setAttribute("role", "tablist");
    this.apiProviderSelect = createElement("select", "astral-am-select");
    this.apiProviderSelect.setAttribute("aria-label", "选择要编辑的 API 配置");
    this.apiProviderSelect.hidden = true;
    this.addApiButton = createElement(
      "button",
      "astral-am-button is-small",
      "新增 API",
    );
    this.duplicateApiButton = createElement(
      "button",
      "astral-am-button is-small",
      "复制 API",
    );
    this.deleteApiButton = createElement(
      "button",
      "astral-am-button is-small is-danger",
      "删除 API",
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
    this.apiNameInput.placeholder = "例如 OpenAI、DeepSeek、本地 LM Studio";
    this.baseUrlInput = createElement("input", "astral-am-input");
    this.baseUrlInput.type = "url";
    this.baseUrlInput.placeholder = "https://api.openai.com/v1";
    this.modelInput = createElement("input", "astral-am-input");
    this.modelInput.placeholder = "输入模型名，或拉取后选择";
    this.providerModelList = createElement("datalist");
    this.providerModelList.id = "astral-am-provider-model-options";
    this.modelInput.setAttribute("list", this.providerModelList.id);
    this.fetchModelsButton = createElement(
      "button",
      "astral-am-button is-small",
      "拉取模型",
    );
    this.fetchModelsButton.type = "button";
    this.fetchModelsButton.title =
      "读取 OpenAI 兼容的 /models 列表；仍可手动输入模型名称";
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
    this.apiKeyInput.placeholder = "本地 API 可留空";

    for (const [label, input, hint] of [
      [
        "API 名称",
        this.apiNameInput,
        "仅用于区分多个 API 配置，不会发送给接口，也不影响生成结果。",
      ],
      [
        "API 地址",
        this.baseUrlInput,
        "OpenAI 兼容 API 的根地址，例如 https://api.openai.com/v1；通常不需要填写 /chat/completions。",
      ],
      [
        "API Key",
        this.apiKeyInput,
        "接口鉴权密钥。本地 API 可留空；保存后会以掩码显示。",
      ],
    ]) {
      configGrid.append(this.createField(label, input, "", hint));
    }
    configGrid.append(
      this.createField(
        "该 API 的默认模型",
        providerModelControl,
        "",
        "未在具体模式中单独填写模型时使用；可从 /models 拉取，也可手动输入。",
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
      createElement("strong", "", "通用生成参数"),
      createElement(
        "span",
        "astral-am-muted",
        "纯文本、图片和多模态三种外部 API 模式共用；接口不支持的可选字段会自动移除后重试。",
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
      if (optional) input.placeholder = "留空不发送";
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
      "控制随机性。提示词扩写常用 0.7–0.9，图片反推常用 0.4–0.7。",
    );
    runtimeNumberField(
      "topP",
      "Top P",
      0,
      1,
      "0.01",
      "核采样阈值。通常保持 0.9–0.95，并与 Temperature 配合调整。",
    );
    runtimeNumberField(
      "maxTokens",
      "最大输出 Token",
      1,
      128000,
      "1",
      "单次回复允许生成的最大 Token 数，不包含输入内容。",
    );
    runtimeNumberField(
      "maxRounds",
      "携带历史轮数",
      1,
      50,
      "1",
      "API 对话最多携带的历史消息轮数；Prompt Processor 无历史，不受此项影响。",
    );
    runtimeNumberField(
      "frequencyPenalty",
      "频率惩罚",
      -2,
      2,
      "0.05",
      "按 Token 出现频率进行惩罚，正值可减少重复用词。",
    );
    runtimeNumberField(
      "presencePenalty",
      "存在惩罚",
      -2,
      2,
      "0.05",
      "Token 只要出现过就进行惩罚，正值可鼓励模型引入新内容。",
    );
    runtimeNumberField(
      "seed",
      "API Seed",
      0,
      4294967295,
      "1",
      "请求接口的随机种子。留空则不发送；是否支持及能否完全复现取决于 API 服务商。",
      true,
    );
    runtimeChoiceField(
      "responseFormat",
      "响应格式",
      [
        ["default", "默认（不发送）"],
        ["text", "纯文本"],
        ["json_object", "JSON 对象"],
      ],
      "要求接口返回的格式。非“默认”选项会发送 response_format，不支持时自动重试。",
    );
    runtimeChoiceField(
      "reasoningEffort",
      "推理强度",
      [
        ["default", "默认（不发送）"],
        ["low", "Low（速度优先）"],
        ["medium", "Medium（均衡）"],
        ["high", "High（质量优先）"],
      ],
      "发送 reasoning_effort 可选参数。仅部分推理模型和 OpenAI 兼容接口支持。",
    );
    runtimeTextField(
      "stop",
      "停止序列",
      "每行填写一个停止序列。模型生成到任一片段时停止；留空则不发送。",
      "例如：\n</answer>\n<END>",
      2,
      true,
    );
    runtimeTextField(
      "systemPrompt",
      "通用系统提示词",
      "附加到 API 请求的系统指令。具体模式规则、Skill 和内置任务指令仍会追加。",
      "你是一个严谨、有帮助的 AI 助手。",
      3,
      true,
    );
    runtimePanel.append(runtimeHeading, runtimeGrid);
    this.populateApiRuntimeInputs();

    const taskSection = createElement("section", "astral-am-api-task-section");
    const taskHeading = createElement("div", "astral-am-api-task-heading");
    taskHeading.append(
      createElement("strong", "", "每种模式使用哪个 API 与模型"),
      createElement(
        "span",
        "astral-am-muted",
        "三种模式可分别选择 API 和模型；模型留空时使用该 API 的默认模型。",
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
      taskApiSelect.setAttribute("aria-label", `${task.label}使用的 API`);
      const taskModelInput = createElement("input", "astral-am-input");
      taskModelInput.placeholder = "选择默认模型或拉取后选择";
      const taskModelList = createElement("datalist");
      taskModelList.id = `astral-am-task-${task.id}-model-options`;
      taskModelInput.setAttribute("list", taskModelList.id);
      const taskFetchButton = createElement(
        "button",
        "astral-am-button is-small",
        "拉取模型",
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
          `选择“${task.label}”使用的 API 配置。`,
        ),
        this.createField(
          "模型",
          taskModelControl,
          "",
          `“${task.label}”使用的模型；留空时使用所选 API 的默认模型。`,
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
      "保存 API 设置",
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
      "新建会话",
    );
    this.deleteConversationButton = createElement(
      "button",
      "astral-am-button is-small is-danger",
      "删除会话",
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
      "加载系统提示词",
    );
    this.skillButton = createElement(
      "button",
      "astral-am-button is-small",
      "加载 Skill",
    );
    this.attachmentButton = createElement(
      "button",
      "astral-am-button is-small",
      "上传素材",
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
      "输入消息。可点击素材标签插入 image1、video1 等名称。";
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
      "开启后只翻译本次发送的文本，不发送历史、系统提示词、Skill 或素材";
    this.translationCheckbox = createElement("input");
    this.translationCheckbox.type = "checkbox";
    this.translationCheckbox.setAttribute("aria-label", "翻译模式");
    this.translationToggle.append(
      this.translationCheckbox,
      createElement("span", "astral-am-chat-translation-switch"),
      createElement("span", "", "翻译模式"),
    );
    this.translationLanguageSelect = createElement(
      "select",
      "astral-am-select astral-am-chat-translation-language",
    );
    this.translationLanguageSelect.setAttribute("aria-label", "翻译目标语言");
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
      "发送",
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
    modeButtons.setAttribute("aria-label", "选择对话模式");
    this.chatModeButtons.clear();
    for (const task of CHAT_MODE_DEFINITIONS) {
      const modeButton = createElement(
        "button",
        "astral-am-button is-small astral-am-chat-mode-button",
        task.label,
      );
      modeButton.type = "button";
      modeButton.title = `${task.label}：${task.hint}`;
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
      "打开 API配置",
    );
    this.openApiConfigButton.type = "button";
    this.openApiConfigButton.addEventListener("click", () =>
      this.openApiConfigSection("api"),
    );
    this.openLocalLlmConfigButton = createElement(
      "button",
      "astral-am-button is-small",
      "本地 LLM 配置",
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
    this.chatCurrentModelName = createElement("strong", "", "尚未配置");
    this.chatCurrentModel.append(
      createElement("span", "", "当前模型："),
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
          ? "翻译模式已开启：本次发送将忽略历史、系统提示词、Skill 和素材。"
          : "翻译模式已关闭。",
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
      createElement("strong", "", "多 API 与模式分工"),
      createElement(
        "span",
        "astral-am-muted",
        "配置保存在本机。上方管理外部 API，下方配置本地 GGUF 模型。",
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
      createElement("strong", "", "本地 GGUF 多模态模型"),
      createElement(
        "span",
        "astral-am-muted",
        "扫描 ComfyUI models/LLM。主模型负责对话，mmproj 提供图片、视频抽帧与 Gemma4 音频能力。",
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
      "尚未读取模型目录",
    );
    const modelToolbar = createElement(
      "div",
      "astral-am-local-llm-model-toolbar",
    );
    this.localLlmModelSelect = createElement(
      "select",
      "astral-am-select astral-am-local-llm-model-select",
    );
    this.localLlmModelSelect.setAttribute("aria-label", "选择本地 LLM 主模型");
    this.localLlmModelSelect.title =
      "选择用于本地对话和提示词处理的 GGUF 主模型；音频、图片和视频还需要匹配的 mmproj。";
    this.localLlmVisionModelSelect = createElement(
      "select",
      "astral-am-select astral-am-local-llm-model-select",
    );
    this.localLlmVisionModelSelect.setAttribute(
      "aria-label",
      "选择本地 LLM 视觉投影模型 mmproj",
    );
    this.localLlmVisionModelSelect.title =
      "选择与主模型同系列的 mmproj。纯文本可设为“无”；图片、视频抽帧和 Gemma4 音频需要它。";
    this.localLlmRefreshButton = createElement(
      "button",
      "astral-am-button is-small",
      "刷新模型",
    );
    this.localLlmRefreshButton.type = "button";
    this.localLlmRefreshButton.title =
      "重新扫描 ComfyUI/models/LLM，刷新主模型和 mmproj 列表。";
    modelToolbar.append(
      this.localLlmModelSelect,
      this.localLlmVisionModelSelect,
      this.localLlmRefreshButton,
    );
    this.localLlmModelHint = createElement(
      "div",
      "astral-am-muted astral-am-local-llm-model-hint",
      "主模型与 mmproj 需要来自同一模型系列。纯文本可把 mmproj 设为“无（纯文本）”。",
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
      numberField("nCtx", "上下文长度 n_ctx", 512, 131072, "256"),
      numberField("nBatch", "批处理 n_batch", 32, 65536, "32"),
      numberField("nUbatch", "微批 n_ubatch", 32, 65536, "32"),
      numberField("maxTokens", "最大输出 Token", 1, 32768),
      numberField("maxRounds", "携带历史轮数", 1, 50),
      numberField("temperature", "Temperature", 0, 2, "0.05"),
      numberField("topP", "Top P", 0.01, 1, "0.01"),
      numberField("topK", "Top K", 1, 200),
      numberField("minP", "Min P", 0, 1, "0.01"),
      numberField("repeatPenalty", "重复惩罚", 0.5, 2, "0.05"),
      numberField("frequencyPenalty", "频率惩罚", -2, 2, "0.05"),
      numberField("presencePenalty", "存在惩罚", -2, 2, "0.05"),
      numberField("gpuLayers", "GPU 层数", -1, 1000, "1", "-1 表示全部卸载"),
      numberField("threads", "CPU 线程", 0, 128, "1", "0 表示自动"),
      numberField("seed", "Seed", 0, 4294967295),
      numberField("maxImageEdge", "图片最大边", 256, 4096, "64"),
      numberField("imageJpegQuality", "JPEG 质量", 40, 100, "1"),
      numberField(
        "contextCheckpoints",
        "Context Checkpoints",
        0,
        64,
        "1",
        "0 表示关闭",
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
        ["auto", "自动（推荐）"],
        ["enabled", "开启"],
        ["disabled", "关闭"],
      ]),
      choiceField("kvCacheTypeK", "KV Cache K", [
        ["default", "默认"],
        ["q8_0", "Q8_0"],
      ]),
      choiceField("kvCacheTypeV", "KV Cache V", [
        ["default", "默认"],
        ["q8_0", "Q8_0"],
      ]),
      choiceField("reasoningEffort", "Qwen3.8 推理强度", [
        ["xhigh", "XHigh（质量优先）"],
        ["medium", "Medium（均衡）"],
        ["low", "Low（速度优先）"],
      ]),
      toggleField(
        "enableThinking",
        "启用思考",
        "对 Qwen3.8、Qwen3.5/3.6 与 Gemma4 生效",
      ),
      toggleField(
        "preserveThinking",
        "保留历史 think",
        "关闭可节省上下文",
      ),
      toggleField(
        "useMmap",
        "使用 mmap",
        "默认开启；关闭会更快消耗物理内存",
      ),
    );

    const actions = createElement(
      "div",
      "astral-am-chat-config-actions",
    );
    const note = createElement(
      "span",
      "astral-am-muted",
      "配置保存在 ComfyUI 用户目录/assets-astral/local-llm-config.json",
    );
    this.saveLocalLlmConfigButton = createElement(
      "button",
      "astral-am-button is-primary",
      "保存本地 LLM 设置",
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
      "扫描 ComfyUI custom_nodes 和 input 目录中的 SKILL.cn.md 或 SKILL.md。每个会话最多加载 1 个 Skill，可随时切换；input 中的 Skill 会使用 input/... 命名空间。",
    );
    this.skillSearch = createElement("input", "astral-am-search");
    this.skillSearch.type = "search";
    this.skillSearch.placeholder = "搜索 Skill 名称、ID、描述或来源";
    this.skillSearch.autocomplete = "off";
    this.skillSearch.setAttribute("aria-label", "搜索 Skill");
    this.skillRefreshButton = createElement("button", "astral-am-button", "刷新 Skill");
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
    this.skillTagSearch.placeholder = "搜索标签名称或分类";
    this.skillTagSearch.autocomplete = "off";
    this.skillTagSearch.setAttribute("aria-label", "搜索提示词灵感标签");
    toolbar.append(this.skillTagSearch);
    const note = createElement(
      "p",
      "astral-am-note",
      "标签是提示词灵感素材。点击分类或二级分类旁的 + 可以批量新增标签；每行一个，也支持用逗号或分号分隔。",
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
      "分类",
    );
    const addCategoryInline = createElement(
      "button",
      "astral-am-icon-button",
      "+",
    );
    addCategoryInline.type = "button";
    addCategoryInline.title = "新建顶级分类（分类树最多两级）";
    addCategoryInline.setAttribute(
      "aria-label",
      "新建顶级分类，分类树最多两级",
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
    this.skillTagFavoriteCategoryButton.textContent = "★ 收藏";
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
    this.skillTagHeading = createElement("strong", "", "全部标签");
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
      "已选 0 个灵感标签",
    );
    inspirationHeading.append(
      this.inspirationSelectionCount,
      createElement(
        "span",
        "astral-am-muted",
        "随机组合会从不同分类各取一个标签",
      ),
    );
    this.inspirationRandomButton = createElement(
      "button",
      "astral-am-button is-small",
      "随机组合",
    );
    this.inspirationClearButton = createElement(
      "button",
      "astral-am-button is-small",
      "清空选择",
    );
    this.inspirationRandomButton.type = "button";
    this.inspirationClearButton.type = "button";
    this.inspirationRandomButton.title =
      "从不同分类随机组合标签；再次点击换一批";
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
      "输入基础画面想法，例如：一位少女站在雨夜街头；留空则让模型根据标签自由构思。";
    this.inspirationTargetInput = createElement(
      "select",
      "astral-am-select",
    );
    this.inspirationTargetInput.setAttribute(
      "aria-label",
      "提示词生成目标",
    );
    for (const [value, label] of [
      ["image", "文生图"],
      ["video", "文生视频"],
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
      "提示词输出语言",
    );
    for (const [value, label] of [
      ["en", "英文"],
      ["zh", "中文"],
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
      "提示词扩写生成方式",
    );
    for (const [value, label] of [
      ["api", "API纯文本模式"],
      ["local", "本地模式"],
    ]) {
      const option = createElement("option", "", label);
      option.value = value;
      this.inspirationModeInput.append(option);
    }
    this.inspirationGenerateButton = createElement(
      "button",
      "astral-am-button is-primary",
      "生成灵感提示词",
    );
    this.inspirationGenerateButton.type = "submit";
    const inspirationControls = createElement(
      "div",
      "astral-am-inspiration-controls",
    );
    inspirationControls.append(
      this.createField("基础画面想法", this.inspirationBasePromptInput),
      this.createField("生成目标", this.inspirationTargetInput),
      this.createField("输出语言", this.inspirationLanguageInput),
      this.createField("生成方式", this.inspirationModeInput),
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
      createElement("strong", "", "扩写结果"),
      (this.inspirationResultHint = createElement("span", "astral-am-muted")),
    );
    this.inspirationResultInput = createElement(
      "textarea",
      "astral-am-textarea astral-am-inspiration-result",
    );
    this.inspirationResultInput.rows = 5;
    this.inspirationResultInput.placeholder =
      "生成的灵感提示词会显示在这里。";
    const resultActions = createElement(
      "div",
      "astral-am-inspiration-result-actions",
    );
    this.inspirationCopyButton = createElement(
      "button",
      "astral-am-button is-small",
      "复制提示词",
    );
    this.inspirationUseAsBaseButton = createElement(
      "button",
      "astral-am-button is-small",
      "作为基础想法",
    );
    this.inspirationSendToChatButton = createElement(
      "button",
      "astral-am-button is-small is-primary",
      "加入 API 对话",
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
      "已勾选 0 个标签",
    );
    this.skillTagSelectAllButton = createElement(
      "button",
      "astral-am-button is-small",
      "全选当前结果",
    );
    this.skillTagClearSelectionButton = createElement(
      "button",
      "astral-am-button is-small",
      "清空勾选",
    );
    this.skillTagBatchDeleteButton = createElement(
      "button",
      "astral-am-button is-small is-danger",
      "批量删除",
    );
    this.skillTagBatchMoveButton = createElement(
      "button",
      "astral-am-button is-small is-primary",
      "移动分类",
    );
    for (const button of [
      this.skillTagSelectAllButton,
      this.skillTagClearSelectionButton,
      this.skillTagBatchDeleteButton,
      this.skillTagBatchMoveButton,
    ]) {
      button.type = "button";
    }
    this.skillTagSelectAllButton.title = "勾选当前分类或搜索结果中的全部标签";
    this.skillTagClearSelectionButton.title = "清除所有已勾选标签";
    this.skillTagBatchDeleteButton.title = "删除所有已勾选标签";
    this.skillTagBatchMoveButton.title =
      "把已勾选标签移动到其他分类或二级分类";
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
      button.title = `${task.label}：${task.hint}`;
    }
    if (!this.chatCurrentModelName) return;
    if (activeTask.id === LOCAL_CHAT_MODE_DEFINITION.id) {
      const modelPath = this.currentChatTaskModel(activeTask.id);
      const modelName = modelPath.split("/").pop() || "";
      this.chatCurrentModelName.textContent = modelName || "尚未配置";
      this.chatCurrentModel.title = modelPath
        ? `本地模式 · ComfyUI/models/LLM\n模型：${modelPath}`
        : "本地模式尚未选择 GGUF 模型，请打开“本地 LLM 配置”进行设置。";
      return;
    }
    const binding = this.taskBindings[activeTask.id] || {};
    const provider = this.apiProviderById(binding.apiId || this.activeApiId);
    const model = this.currentChatTaskModel(activeTask.id);
    this.chatCurrentModelName.textContent = model || "尚未配置";
    this.chatCurrentModel.title = model
      ? `${activeTask.label} · ${provider?.name || "未选择 API"}\n模型：${model}`
      : `${activeTask.label}还没有配置模型，请打开 API配置进行设置。`;
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
    this.setTemplateStatus("正在读取提示词模板...", "loading");
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
      this.templateSummary.textContent = `共 ${this.templates.length} 个提示词模板`;
      this.setTemplateStatus(
        this.templates.length ? "" : "还没有提示词模板，点击“新建模板”开始。",
        this.templates.length ? "" : "empty",
      );
      this.templatesLoaded = true;
    } catch (error) {
      if (requestId === this.templatesRequestId) {
        this.setTemplateStatus(`读取提示词模板失败：${error.message || error}`, "error");
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
      createElement("strong", "", template.title || "未命名模板"),
    );
    header.append(
      heading,
      createElement("span", "astral-am-muted", formatDate(template.updatedAt)),
    );
    const prompt = createElement("pre", "astral-am-template-text", template.prompt);
    const actions = createElement("div", "astral-am-template-actions");
    const edit = createElement("button", "astral-am-button is-small", "编辑");
    const copy = createElement("button", "astral-am-button is-small", "复制文本");
    const loaded =
      this.pendingSystemPromptTemplate?.id === template.id;
    const loadToChat = createElement(
      "button",
      "astral-am-button is-small",
      loaded ? "当前会话提示词" : "加载到会话",
    );
    const insert = createElement(
      "button",
      "astral-am-button is-small is-primary",
      "放入画布",
    );
    const remove = createElement(
      "button",
      "astral-am-button is-small is-danger",
      "删除",
    );
    for (const button of [edit, copy, loadToChat, insert, remove]) {
      button.type = "button";
    }
    loadToChat.disabled = loaded;
    loadToChat.title = loaded
      ? "当前会话已经加载这个系统提示词"
      : "将这份系统提示词加载到当前 API 对话";
    edit.addEventListener("click", () => this.openTemplateEditor(template));
    copy.addEventListener("click", async () => {
      try {
        await copyText(template.prompt);
        copy.textContent = "已复制";
        window.setTimeout(() => {
          copy.textContent = "复制文本";
        }, 1200);
      } catch (error) {
        this.setTemplateStatus(`复制失败：${error.message || error}`, "error");
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
    this.templateEditorTitle = createElement("strong", "", "新建提示词模板");
    const close = createElement("button", "astral-am-icon-button", "×");
    close.type = "button";
    close.title = "关闭";
    close.addEventListener("click", () => dialog.close());
    header.append(this.templateEditorTitle, close);

    const body = createElement("div", "astral-am-editor-body");
    this.templateTitleInput = createElement("input", "astral-am-input");
    this.templateTitleInput.placeholder = "例如：电影感人像";
    this.templateEditorCategory = createCustomDropdown("astral-am-category-dropdown");
    this.templateEditorCategory.setOptions(PROMPT_CATEGORY_OPTIONS);
    this.templatePromptInput = createElement("textarea", "astral-am-textarea");
    this.templatePromptInput.rows = 14;
    this.templatePromptInput.placeholder = "输入提示词正文";
    body.append(
      this.createField("标题", this.templateTitleInput),
      this.createField("分类", this.templateEditorCategory.element),
      this.createField("提示词", this.templatePromptInput),
    );
    this.templateEditorStatus = createElement("div", "astral-am-action-status");
    const footer = createElement("div", "astral-am-editor-footer");
    const cancel = createElement("button", "astral-am-button", "取消");
    this.templateEditorSave = createElement(
      "button",
      "astral-am-button is-primary",
      "保存模板",
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
      ? "编辑提示词模板"
      : "新建提示词模板";
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
      this.templateEditorStatus.textContent = "标题和提示词不能为空。";
      return;
    }
    this.templateEditorSave.disabled = true;
    this.templateEditorStatus.className = "astral-am-action-status";
    this.templateEditorStatus.textContent = "正在保存...";
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
      this.templateEditorStatus.textContent = `保存失败：${error.message || error}`;
    } finally {
      this.templateEditorSave.disabled = false;
    }
  }

  async deleteTemplate(template) {
    const confirmed = await showAstralConfirm({
      title: "删除提示词模板",
      message: `确定删除提示词模板“${template.title}”吗？\n\n删除后无法从此页面恢复。`,
      confirmLabel: "删除模板",
    });
    if (!confirmed) return;
    this.setTemplateStatus(`正在删除“${template.title}”...`, "loading");
    try {
      await fetchJson("/assets-astral/prompt-templates/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: template.id }),
      });
      await this.loadTemplates();
      this.setTemplateStatus("模板已删除。", "success");
    } catch (error) {
      this.setTemplateStatus(`删除模板失败：${error.message || error}`, "error");
    }
  }

  insertTemplateOnCanvas(template) {
    try {
      const node = LiteGraph.createNode(ASTRAL_PROMPT_NODE_ID);
      if (!node) {
        throw new Error("ComfyUI 未注册节点 Assets Prompt");
      }
      const titleWidget = node.widgets?.find((widget) => widget.name === "title");
      const promptWidget = node.widgets?.find((widget) => widget.name === "prompt");
      if (!titleWidget || !promptWidget) {
        throw new Error("Assets Prompt 节点缺少 title 或 prompt 控件");
      }
      titleWidget.value = template.title || "提示词";
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
      this.setTemplateStatus(`放入画布失败：${error.message || error}`, "error");
    }
  }

  async loadApiConfig() {
    try {
      const payload = await fetchJson("/assets-astral/chat/config");
      this.applyApiConfiguration(payload || {});
    } catch (error) {
      this.ensureApiProviderDraft();
      this.setConfigStatus(`读取 API 设置失败：${error.message || error}`, "error");
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
        name: "默认 API",
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
      "API 标签顺序已保存。",
      "正在保存 API 标签顺序...",
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
        `${provider.baseUrl || "尚未填写 API 地址"}\n拖动可调整 API 标签顺序`;
      button.addEventListener("click", () => this.selectApiProvider(provider.id));
      button.addEventListener("dragstart", (event) => {
        if (!event.dataTransfer) return;
        if (this.saveConfigButton.disabled) {
          event.preventDefault();
          this.setConfigStatus(
            "API 设置正在保存，请稍后再调整标签顺序。",
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
      "留空或保留掩码会继续使用已保存的 Key；输入新值会覆盖。";
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
      `正在编辑“${this.apiProviderById(providerId)?.name || providerId}”。`,
    );
  }

  addApiProvider() {
    this.commitApiProviderEditor();
    if (this.apiProviders.length >= 20) {
      this.setConfigStatus("最多保存 20 个 API 配置。", "warning");
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
    this.setConfigStatus("已新增 API，填写地址和 Key 后保存。", "success");
    this.apiNameInput.focus();
  }

  duplicateApiProvider() {
    this.commitApiProviderEditor();
    const source = this.apiProviderById();
    if (!source) return;
    if (this.apiProviders.length >= 20) {
      this.setConfigStatus("最多保存 20 个 API 配置。", "warning");
      return;
    }
    const provider = {
      ...source,
      id: this.createApiId(),
      name: `${source.name || "API"} 副本`.slice(0, 80),
      apiKey: "",
      apiKeyHint: source.hasApiKey
        ? "复制后请重新填写 API Key"
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
      "API 已复制。出于安全考虑，API Key 需要重新填写。",
      "warning",
    );
  }

  async deleteApiProvider() {
    this.commitApiProviderEditor();
    const provider = this.apiProviderById();
    if (!provider) return;
    if (this.apiProviders.length <= 1) {
      this.setConfigStatus("至少保留一个 API 配置。", "warning");
      return;
    }
    const confirmed = await showAstralConfirm({
      title: "删除 API 配置",
      message: `确定删除 API 配置“${provider.name || provider.id}”吗？`,
      confirmLabel: "删除 API",
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
    this.setConfigStatus("API 配置已删除。", "success");
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
      this.setConfigStatus("请先填写 API 地址，再拉取模型。", "warning");
      return;
    }
    button.disabled = true;
    button.textContent = "拉取中...";
    this.setConfigStatus(`正在从“${provider.name || provider.id}”拉取模型...`);
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
          ? `已拉取 ${models.length} 个模型，可在模型框中输入或从下拉建议中选择。`
          : "模型列表为空，可继续手动填写模型名称。",
        models.length ? "success" : "warning",
      );
    } catch (error) {
      this.setConfigStatus(
        `拉取模型失败：${error.message || error}`,
        "error",
      );
    } finally {
      button.disabled = false;
      button.textContent = "拉取模型";
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
    successMessage = "API 设置与模式分工已保存。",
    pendingMessage = "正在保存 API 设置...",
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
      this.setConfigStatus(`保存失败：${error.message || error}`, "error");
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
          ? "停止中..."
          : "停止"
        : "发送";
      this.sendButton.classList.toggle(
        "is-danger",
        this.chatGenerating,
      );
      this.sendButton.setAttribute(
        "aria-label",
        this.chatGenerating ? "停止当前生成" : "发送消息",
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
        `${normalizedSelected}（未找到）`,
      );
      missingOption.value = normalizedSelected;
      options.unshift(missingOption);
    }
    if (!options.length) {
      const emptyOption = createElement("option", "", "未找到 GGUF 模型");
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
    const noVisionOption = createElement("option", "", "无（纯文本）");
    noVisionOption.value = "";
    const normalizedVisionSelected = String(selectedVisionPath || "");
    if (
      normalizedVisionSelected &&
      !visionPaths.has(normalizedVisionSelected)
    ) {
      const missingVisionOption = createElement(
        "option",
        "",
        `${normalizedVisionSelected}（未找到）`,
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
      ? `模型目录：${this.localLlmModelsRoot}`
      : "尚未找到 ComfyUI/models/LLM 目录";
    this.localLlmModelHint.textContent =
      `已发现 ${models.length} 个主模型 / ${visionModels.length} 个视觉投影模型。`
      + " 图片和视频抽帧需要 mmproj；音频仅支持 Gemma4。";
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
      this.setLocalLlmStatus("正在读取本地 LLM 配置和模型...");
      try {
        const payload = await fetchJson("/assets-astral/local-llm/config");
        this.applyLocalLlmPayload(payload, true);
        this.localLlmLoaded = true;
        this.setLocalLlmStatus(
          this.localLlmModels.length
            ? `已读取配置，找到 ${this.localLlmModels.length} 个主模型和 ${this.localLlmVisionModels.length} 个视觉投影模型。`
            : "已读取配置，但 models/LLM 中没有可用 GGUF 主模型。",
          this.localLlmModels.length ? "success" : "warning",
        );
      } catch (error) {
        this.setLocalLlmStatus(
          `读取本地 LLM 配置失败：${error.message || error}`,
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
    this.localLlmRefreshButton.textContent = "刷新中...";
    const selectedPath =
      this.localLlmModelSelect.value ||
      String(this.localLlmConfig?.modelPath || "");
    const selectedVisionPath =
      this.localLlmVisionModelSelect.value ||
      String(this.localLlmConfig?.visionModelPath || "");
    this.setLocalLlmStatus("正在扫描 ComfyUI/models/LLM...");
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
          ? `已发现 ${this.localLlmModels.length} 个主模型和 ${this.localLlmVisionModels.length} 个视觉投影模型。`
          : "没有发现 GGUF 主模型，请检查 models/LLM 目录。",
        this.localLlmModels.length ? "success" : "warning",
      );
    } catch (error) {
      this.setLocalLlmStatus(
        `刷新模型失败：${error.message || error}`,
        "error",
      );
    } finally {
      this.localLlmRefreshButton.disabled = false;
      this.localLlmRefreshButton.textContent = "刷新模型";
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
      this.setLocalLlmStatus("请先选择一个 GGUF 模型。", "warning");
      return;
    }
    this.saveLocalLlmConfigButton.disabled = true;
    this.saveLocalLlmConfigButton.textContent = "正在保存...";
    this.setLocalLlmStatus("正在保存本地 LLM 设置...");
    try {
      const payload = await fetchJson("/assets-astral/local-llm/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      this.applyLocalLlmPayload(payload, true);
      this.localLlmLoaded = true;
      this.setLocalLlmStatus("本地 LLM 设置已保存。", "success");
    } catch (error) {
      this.setLocalLlmStatus(
        `保存失败：${error.message || error}`,
        "error",
      );
    } finally {
      this.saveLocalLlmConfigButton.disabled = false;
      this.saveLocalLlmConfigButton.textContent = "保存本地 LLM 设置";
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
      this.setChatStatus(`读取对话列表失败：${error.message || error}`, "error");
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
        createElement("span", "astral-am-muted", "还没有会话"),
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
      button.title = "单击切换会话，双击重命名";
      if (this.chatGenerating) {
        button.title = "请先停止当前生成";
      }
      button.setAttribute(
        "aria-label",
        `${conversation.title || "未命名会话"}，单击切换会话，双击重命名`,
      );
      button.append(
        createElement("strong", "", conversation.title || "未命名会话"),
        createElement(
          "span",
          "astral-am-muted",
          `${Number(conversation.messageCount) || 0} 条消息`,
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
      this.setChatStatus("请先停止当前生成，再新建会话。", "warning");
      return null;
    }
    try {
      const conversation = await fetchJson("/assets-astral/chat/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "新会话" }),
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
        this.setChatStatus("已新建会话。", "success");
      }
      return conversation;
    } catch (error) {
      this.setChatStatus(`新建会话失败：${error.message || error}`, "error");
      throw error;
    }
  }

  async selectConversation(conversationId) {
    if (!conversationId) return;
    if (this.chatGenerating) {
      this.setChatStatus("请先停止当前生成，再切换会话。", "warning");
      return;
    }
    this.clearChatPendingRequest();
    const requestId = ++this.conversationLoadSequence;
    this.setChatStatus("正在读取会话...", "loading");
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
                conversation.systemPromptTemplate.title || "系统提示词",
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
          ? `当前对话最多保留 ${this.chatComposerAttachmentLimit} 个素材，已忽略多出的 ${
              storedAttachments.length - this.pendingAttachments.length
            } 个。`
          : "",
        storedAttachments.length > this.pendingAttachments.length
          ? "warning"
          : "",
      );
    } catch (error) {
      if (requestId === this.conversationLoadSequence) {
        this.setChatStatus(`读取会话失败：${error.message || error}`, "error");
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
      chip.setAttribute("aria-label", `插入素材名称 ${mention}`);
      chip.title = `点击插入 ${mention}\n${pathLabel}`;
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
      remove.title = "移除附件";
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
          "还没有消息。可先加载系统提示词、Skill 或上传素材，再发送第一条消息。",
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
          this.chatStopping ? "正在停止" : "正在生成",
        ),
      );
      typing.append(
        typingHeader,
        createElement(
          "div",
          "astral-am-chat-message-content",
          this.chatStopping ? "正在结束当前操作..." : "正在等待模型回复...",
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
      message.role === "user" ? "你" : "AI",
    );
    const timestamp = formatMessageTimestamp(message.timestamp);
    let timeLabel = "";
    if (message.pendingState === "stopped") {
      timeLabel = timestamp
        ? `已发送 ${timestamp} · 已停止`
        : "已停止";
    } else if (message.pendingState === "sending") {
      timeLabel = timestamp
        ? `已发送 ${timestamp} · 等待回复`
        : "正在发送";
    } else if (timestamp) {
      timeLabel = `${
        message.role === "user" ? "已发送" : "已接收"
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
        "复制",
      );
      copyButton.type = "button";
      copyButton.title = "复制这条消息";
      copyButton.addEventListener("click", () => {
        void this.copyChatMessage(message);
      });
      actions.append(copyButton);
    }
    if (persisted && message.id) {
      const deleteButton = createElement(
        "button",
        "astral-am-chat-message-action is-danger",
        "删除",
      );
      deleteButton.type = "button";
      deleteButton.title = "删除这条消息（不可恢复）";
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
      link.title = attachment.name || attachment.path || "生成图片";
      const image = createElement("img");
      image.src = assetMediaUrl(attachment, false);
      image.alt = attachment.name || attachment.path || "AI 生成图片";
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
      if (!value) throw new Error("这条消息没有可复制的内容");
      await copyText(value);
      this.setChatStatus("消息内容已复制。", "success");
    } catch (error) {
      this.setChatStatus(`复制失败：${error.message || error}`, "error");
    }
  }

  async deleteChatMessage(message) {
    const conversationId = this.activeConversation?.id;
    if (!conversationId || !message?.id || this.chatGenerating) return;
    const roleLabel = message.role === "user" ? "用户" : "AI";
    const confirmed = await showAstralConfirm({
      title: "删除消息",
      message: `确定删除这条${roleLabel}消息吗？删除后不可恢复。`,
      confirmLabel: "删除消息",
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
      this.setChatStatus("消息已删除，且不可恢复。", "success");
    } catch (error) {
      this.setChatStatus(`删除消息失败：${error.message || error}`, "error");
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
          ? `当前对话已达到 ${limit} 个素材上限，请先移除部分素材后再试。`
          : "勾选的素材已经在当前对话中。",
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
        `已将 ${added} 个素材加入当前对话，当前共 ${nextAttachments.length}/${limit} 个。` +
        (retainedItems.length
          ? `已达到上限，另有 ${retainedItems.length} 个未加入并保持勾选。`
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
        `系统提示词: ${
          this.pendingSystemPromptTemplate.title || "系统提示词"
        }`,
      );
      chip.tabIndex = 0;
      chip.setAttribute(
        "aria-label",
        `已加载系统提示词：${
          this.pendingSystemPromptTemplate.title || "系统提示词"
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
      remove.title = "移除系统提示词";
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
      remove.title = "移除 Skill";
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
      ? `上传素材 (${this.pendingAttachments.length})`
      : "上传素材";
    this.skillButton.textContent = this.pendingSkillIds.length
      ? "加载 Skill (1)"
      : "加载 Skill";
    this.systemPromptButton.textContent = this.pendingSystemPromptTemplate
      ? "加载系统提示词 (1)"
      : "加载系统提示词";
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
        ? "当前会话 Skill"
        : hasCurrentContext
          ? "切换到此 Skill"
          : "加入会话";
      button.disabled = joined;
      button.title = joined
        ? "当前会话已经加载这个 Skill"
        : this.pendingSystemPromptTemplate
          ? "切换后会替换当前会话中的系统提示词"
          : hasJoinedSkill
          ? "切换后会替换当前会话中的 Skill"
          : "将此 Skill 加入当前会话";
    }
  }

  async addSkillToChat(skillId) {
    const skill = this.skills.find((item) => item.id === skillId);
    if (!skill) {
      this.setSkillStatus("未找到要加入会话的 Skill。", "warning");
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
      this.setSkillStatus("无法创建或读取当前会话，请稍后重试。", "error");
      return;
    }
    const previousSkillId = this.pendingSkillIds[0] || "";
    if (previousSkillId === skill.id) {
      this.setSkillStatus(`“${skill.name}”已经在当前会话中。`, "warning");
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
      ? `已将当前会话的系统提示词“${
          previousSystemPrompt.title || "系统提示词"
        }”切换为 Skill“${skill.name}”。`
      : previousSkillId
      ? `已将当前会话的 Skill 从“${
          previousSkill?.name || previousSkillId
        }”切换为“${skill.name}”。`
      : `已将“${skill.name}”加入当前会话。`;
    this.setSkillStatus(
      saved ? action : `${action}会话保存失败。`,
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
        `保存会话设置失败：${error.message || error}`,
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
      this.setTemplateStatus("这份系统提示词没有可加载的内容。", "warning");
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
      this.setTemplateStatus("无法创建或读取当前会话，请稍后重试。", "error");
      return;
    }

    const previousSkillId = this.pendingSkillIds[0] || "";
    const previousSkill = this.skills.find(
      (item) => item.id === previousSkillId,
    );
    this.pendingSkillIds = [];
    this.pendingSystemPromptTemplate = {
      id: String(template.id),
      title: String(template.title || "系统提示词"),
      content,
    };
    this.renderChatSelection();
    this.renderTemplates();
    const saved = await this.persistConversationSettings();
    const message = previousSkillId
      ? `已将当前会话的 Skill“${
          previousSkill?.name || previousSkillId
        }”切换为系统提示词“${this.pendingSystemPromptTemplate.title}”。`
      : `已将“${this.pendingSystemPromptTemplate.title}”加载到当前会话。`;
    this.setTemplateStatus(
      saved ? message : `${message}会话保存失败。`,
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
            `停止请求已发送，但服务端未确认：${error.message || error}`,
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
      "操作已停止。已停止的消息会继续显示。",
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
      this.setChatStatus("请先输入要翻译的消息。", "warning");
      return;
    }
    if (!translationEnabled && !message && !attachmentSnapshot.length) {
      this.setChatStatus("请先输入消息或选择素材。", "warning");
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
            ? "本地翻译需要先在“本地 LLM 配置”中选择 GGUF 模型。"
            : "翻译模式使用纯文本 API。请先在 API配置的“纯文本模式”中选择模型。"
          : useLocal
            ? "本地模式尚未选择 GGUF 模型，请先打开“本地 LLM 配置”。"
            : `“${activeTask.label}”尚未配置模型，请先在 API配置中为这个模式选择模型。`,
        "warning",
      );
      return;
    }
    const targetLanguage = TRANSLATION_LANGUAGES.find(
      (language) => language.value === this.translationLanguageSelect.value,
    );
    if (translationEnabled && !targetLanguage) {
      this.setChatStatus("请选择翻译目标语言。", "warning");
      return;
    }
    if (!this.activeConversation?.id) {
      await this.createConversation(true);
    }
    if (!this.activeConversation?.id) {
      this.setChatStatus("无法创建当前会话，请稍后重试。", "error");
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
        ? `正在将本次段落翻译为“${targetLanguage.label}”；历史、系统提示词、Skill 和素材不会发送。`
        : useLocal
          ? `正在使用本地模型“${activeModel.split("/").pop()}”推理。首次加载可能较慢。`
          : `正在使用“${activeTask.label}”和模型“${activeModel}”请求 API。${
              attachmentSnapshot.length
                ? "视频附件会先抽帧，较大素材可能需要更久。"
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
          ? "翻译结果已收到并保存到当前会话。"
          : useLocal
            ? "本地模型回复已收到并保存到当前会话。"
            : "回复已收到并保存到会话。",
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
      this.setChatStatus(`对话失败：${error.message || error}`, "error");
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
      this.setChatStatus("请先停止当前生成，再删除会话。", "warning");
      return;
    }
    const conversation = this.activeConversation;
    if (!conversation?.id) return;
    const confirmed = await showAstralConfirm({
      title: "删除会话",
      message: `确定删除会话“${conversation.title || conversation.id}”吗？`,
      confirmLabel: "删除会话",
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
      this.setChatStatus("会话已删除。", "success");
    } catch (error) {
      this.setChatStatus(`删除会话失败：${error.message || error}`, "error");
    }
  }

  async renameConversation(conversationId) {
    const conversation =
      this.activeConversation?.id === conversationId
        ? this.activeConversation
        : this.conversations.find((item) => item.id === conversationId);
    if (!conversation?.id) return;
    const title = await showAstralPrompt({
      title: "重命名会话",
      message: "输入新的会话标题。",
      label: "会话名称",
      initialValue: conversation.title || "新会话",
      confirmLabel: "保存名称",
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
      this.setChatStatus("会话标题已更新。", "success");
    } catch (error) {
      this.setChatStatus(`重命名失败：${error.message || error}`, "error");
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
    this.setSkillTagStatus("已清空灵感标签选择。", "");
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
      this.setSkillTagStatus("当前没有可用于随机组合的标签。", "warning");
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
      `已从 ${groupCount} 个不同分类随机组合灵感标签，再次点击可换一批。`,
      "success",
    );
  }

  renderInspirationSelection() {
    if (!this.inspirationSelectionCount) return;
    const selected = this.selectedInspirationTags();
    this.inspirationSelectionCount.textContent =
      `已选 ${selected.length} 个灵感标签`;
    this.inspirationClearButton.disabled = !selected.length;
    this.inspirationRandomButton.disabled =
      !this.skillTagState.tags.length || this.inspirationGenerating;
    const fragment = document.createDocumentFragment();
    if (!selected.length) {
      fragment.append(
        createElement(
          "span",
          "astral-am-inspiration-empty",
          "点击下方标签加入灵感，或点击“随机组合”跨分类抽取。",
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
        chip.title = `${this.skillTagPath(tag)} · 点击移出灵感`;
        chip.append(
          createElement("span", "astral-am-tag-color-dot"),
          createElement(
            "span",
            "",
            `${
              [category?.name, subcategory?.name]
                .filter(Boolean)
                .join(" / ") || "未分类"
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
        ? "结果可直接编辑，使用 API配置中的本地 GGUF 模型"
        : "结果可直接编辑，使用 API配置中的纯文本模式模型";
    }
  }

  async generateInspirationPrompt() {
    if (this.inspirationGenerating) return;
    const basePrompt = this.inspirationBasePromptInput.value.trim();
    const mode =
      this.inspirationModeInput.value === "local" ? "local" : "api";
    const tags = this.selectedInspirationTags().map((tag) => {
      const categoryName =
        this.skillTagCategoryById(tag.categoryId)?.name || "灵感";
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
        "请先输入基础画面想法，或选择至少一个灵感标签。",
        "warning",
      );
      return;
    }
    this.inspirationGenerating = true;
    this.inspirationGenerateButton.disabled = true;
    this.inspirationGenerateButton.textContent = "正在生成...";
    this.inspirationModeInput.disabled = true;
    this.inspirationResultInput.value = "";
    this.updateInspirationResultActions();
    this.setInspirationStatus(
      mode === "local"
        ? "正在使用本地 GGUF 模型扩写提示词..."
        : "正在使用纯文本模式 API 扩写提示词...",
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
      this.setInspirationStatus("灵感提示词已生成。", "success");
    } catch (error) {
      this.setInspirationStatus(
        `生成失败：${error.message || error}`,
        "error",
      );
    } finally {
      this.inspirationGenerating = false;
      this.inspirationGenerateButton.disabled = false;
      this.inspirationGenerateButton.textContent = "生成灵感提示词";
      this.inspirationModeInput.disabled = false;
      this.renderInspirationSelection();
    }
  }

  async copyInspirationResult() {
    const result = this.inspirationResultText();
    if (!result) return;
    try {
      await copyText(result);
      this.setInspirationStatus("提示词已复制到剪贴板。", "success");
    } catch (error) {
      this.setInspirationStatus(
        `复制失败：${error.message || error}`,
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
      "已将扩写结果放回基础画面想法，可继续调整后再次生成。",
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
      "灵感提示词已加入对话输入框，可继续补充要求后发送。",
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
    this.setSkillTagStatus("正在读取标签数据...", "loading");
    this.skillTagsPromise = fetchJson("/assets-astral/skill-tags")
      .then((payload) => {
        this.applySkillTagState(payload);
        this.setSkillTagStatus("标签已加载。", "success");
      })
      .catch((error) => {
        this.skillTagsPromise = null;
        this.setSkillTagStatus(
          `读取标签失败：${error.message || error}`,
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
    this.skillTagBatchCount.textContent = `已勾选 ${selectedCount} 个标签`;
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
      `已勾选当前结果中的 ${tags.length} 个标签。`,
      "success",
    );
  }

  clearSkillTagBatchSelection() {
    this.batchSelectedSkillTagIds.clear();
    this.renderSkillTagManager();
    this.setSkillTagStatus("已清空批量勾选。", "");
  }

  renderSkillTagManager() {
    if (!this.skillTagList) return;
    this.hideSkillTagContextMenu();
    const categories = this.skillTagState.categories || [];
    const subcategories = this.skillTagState.subcategories || [];
    const tags = this.skillTagState.tags || [];
    this.skillTagAllCategoryButton.replaceChildren(
      createElement("span", "", "全部标签"),
      createElement("span", "astral-am-tag-category-count", tags.length),
    );
    this.skillTagAllCategoryButton.classList.toggle(
      "is-active",
      this.activeSkillTagCategoryId === "all",
    );
    this.skillTagFavoriteCategoryButton.replaceChildren(
      createElement("span", "", "★ 收藏"),
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
    this.skillTagCategoryCount.textContent = `分类 · ${categories.length}`;

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
      toggle.title = isCollapsed ? "展开二级分类" : "收起二级分类";
      toggle.setAttribute("aria-expanded", String(!isCollapsed));
      toggle.setAttribute(
        "aria-label",
        `${isCollapsed ? "展开" : "收起"}${category.name}二级分类`,
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
      button.title = `${category.name} · ${count} 个标签\n右键管理分类`;
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
        `在“${category.name}”下新建子分类或批量新增标签`;
      addSubcategory.setAttribute(
        "aria-label",
        `在${category.name}下新建子分类或批量新增标签`,
      );
      addSubcategory.addEventListener("click", (event) => {
        this.showSkillTagContextMenu(event, [
          {
            label: "新建子分类",
            action: () => this.createSkillTagSubcategory(category),
          },
          {
            label: "批量新增标签",
            action: () => this.createSkillTagsBatch(category.id),
          },
        ]);
      });
      button.addEventListener("contextmenu", (event) =>
        this.showSkillTagContextMenu(event, [
          {
            label: "新建子分类",
            action: () => this.createSkillTagSubcategory(category),
          },
          {
            label: "批量新增标签",
            action: () => this.createSkillTagsBatch(category.id),
          },
          {
            label: "重命名分类",
            action: () => this.renameSkillTagCategory(category),
          },
          {
            label: "删除分类",
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
          `${subcategoryCount} 个标签\n右键管理二级分类`;
        subcategoryButton.addEventListener("click", () => {
          this.activeSkillTagCategoryId = category.id;
          this.activeSkillTagSubcategoryId = subcategory.id;
          this.renderSkillTagManager();
        });
        subcategoryButton.addEventListener("contextmenu", (event) =>
          this.showSkillTagContextMenu(event, [
            {
              label: "批量新增标签",
              action: () =>
                this.createSkillTagsBatch(category.id, subcategory.id),
            },
            {
              label: "重命名二级分类",
              action: () => this.renameSkillTagSubcategory(subcategory),
            },
            {
              label: "删除二级分类",
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
          `在“${subcategory.name}”下批量新增标签`;
        addChildTag.setAttribute(
          "aria-label",
          `在${subcategory.name}下批量新增标签`,
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
          createElement("span", "astral-am-tag-category-name", "未分类"),
          createElement(
            "span",
            "astral-am-tag-category-count",
            unclassifiedCount,
          ),
        );
        unclassified.title =
          `${category.name} / 未分类 · ${unclassifiedCount} 个标签`;
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
        ? "收藏标签"
        : activeCategory
          ? activeSubcategory
            ? `${activeCategory.name} / ${activeSubcategory.name}`
            : this.activeSkillTagSubcategoryId === "__unclassified__"
              ? `${activeCategory.name} / 未分类`
              : `${activeCategory.name} / 全部`
          : "全部标签";
    let visibleTags = this.visibleSkillTags();
    this.skillTagSummary.textContent =
      `${visibleTags.length} / ${tags.length} 个标签`;

    const fragment = document.createDocumentFragment();
    const editingTag = this.skillTagById(this.editingSkillTagId);
    if (editingTag) fragment.append(this.buildSkillTagEditor(editingTag));
    if (!visibleTags.length) {
      const message = this.skillTagQuery
        ? `没有匹配“${this.skillTagQuery}”的标签。`
        : "当前分类还没有标签。点击分类旁的“+”新建子分类或子标签。";
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
        `${this.skillTagPath(tag)}，${
          selected ? "已加入灵感" : "点击加入灵感"
        }，右键查看更多操作`,
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
      batchCheckbox.title = "勾选后批量删除或移动分类";
      batchCheckbox.setAttribute(
        "aria-label",
        `勾选标签“${tag.name}”用于批量管理`,
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
      favorite.title = tag.favorite ? "取消收藏" : "收藏标签";
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
          category?.name || "未分类",
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
          selected ? "✓ 已加入灵感" : "点击加入灵感",
        ),
      );
      const actions = createElement(
        "div",
        "astral-am-skill-tag-card-actions",
      );
      const edit = createElement(
        "button",
        "astral-am-button is-small",
        "编辑",
      );
      const selectTag = createElement(
        "button",
        "astral-am-button is-small",
        selected ? "移出灵感" : "加入灵感",
      );
      const remove = createElement(
        "button",
        "astral-am-button is-small is-danger",
        "删除",
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
            label: selected ? "移出灵感" : "加入灵感",
            action: () => this.toggleInspirationTag(tag.id),
          },
          {
            label: "编辑标签",
            action: () => this.openSkillTagEditor(tag),
          },
          {
            label: tag.favorite ? "取消收藏" : "收藏标签",
            action: () => this.toggleSkillTagFavorite(tag),
          },
          {
            label: "删除标签",
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
    heading.append(createElement("strong", "", "编辑标签"));
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
        "未分类",
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
    favoriteLabel.append(favorite, createElement("span", "", "收藏"));
    const grid = createElement("div", "astral-am-skill-tag-editor-grid");
    grid.append(
      this.createField("标签名称", name),
      this.createField("所属分类", category),
      this.createField("二级分类", subcategory),
      this.createField("标签颜色", color),
      favoriteLabel,
    );
    const actions = createElement("div", "astral-am-skill-tag-editor-actions");
    const save = createElement(
      "button",
      "astral-am-button is-primary",
      "保存",
    );
    save.type = "submit";
    const remove = createElement(
      "button",
      "astral-am-button is-danger",
      "删除标签",
    );
    remove.type = "button";
    const cancel = createElement("button", "astral-am-button", "取消");
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
      title: "新建标签分类",
      message: "分类用于组织标签，例如“绘画”“视频”“工具”。",
      label: "分类名称",
      confirmLabel: "创建分类",
      placeholder: "输入分类名称",
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
      this.setSkillTagStatus("标签分类已创建。", "success");
    } catch (error) {
      this.setSkillTagStatus(
        `创建分类失败：${error.message || error}`,
        "error",
      );
    }
  }

  async renameSkillTagCategory(category) {
    const name = await showAstralPrompt({
      title: "重命名分类",
      label: "分类名称",
      initialValue: category.name,
      confirmLabel: "保存名称",
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
      this.setSkillTagStatus("分类名称已更新。", "success");
    } catch (error) {
      this.setSkillTagStatus(
        `重命名分类失败：${error.message || error}`,
        "error",
      );
    }
  }

  async createSkillTagSubcategory(category) {
    const name = await showAstralPrompt({
      title: "新建二级分类",
      message: `二级分类会放在“${category.name}”下，例如数量、性别或发型。`,
      label: "二级分类名称",
      confirmLabel: "创建二级分类",
      placeholder: "输入二级分类名称",
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
      this.setSkillTagStatus("二级分类已创建。", "success");
    } catch (error) {
      this.setSkillTagStatus(
        `创建二级分类失败：${error.message || error}`,
        "error",
      );
    }
  }

  async renameSkillTagSubcategory(subcategory) {
    const name = await showAstralPrompt({
      title: "重命名二级分类",
      label: "二级分类名称",
      initialValue: subcategory.name,
      confirmLabel: "保存名称",
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
      this.setSkillTagStatus("二级分类名称已更新。", "success");
    } catch (error) {
      this.setSkillTagStatus(
        `重命名二级分类失败：${error.message || error}`,
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
      title: "删除二级分类",
      message:
        `将删除二级分类“${subcategory.name}”。其中 ${tagCount} 个标签` +
        `会移回“${category?.name || "父分类"} / 未分类”，标签本身不会删除。`,
      confirmLabel: "删除二级分类",
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
        "二级分类已删除，原有标签已移回未分类。",
        "success",
      );
    } catch (error) {
      this.setSkillTagStatus(
        `删除二级分类失败：${error.message || error}`,
        "error",
      );
    }
  }

  async deleteSkillTagCategory(category) {
    const tagCount = this.skillTagState.tags.filter(
      (tag) => tag.categoryId === category.id,
    ).length;
    const confirmed = await showAstralConfirm({
      title: "删除标签分类",
      message: `将删除“${category.name}”及其中 ${tagCount} 个灵感标签。`,
      confirmLabel: "删除分类",
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
      this.setSkillTagStatus("分类及其标签已删除。", "success");
    } catch (error) {
      this.setSkillTagStatus(
        `删除分类失败：${error.message || error}`,
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
      this.setSkillTagStatus("请先新建一个标签分类。", "warning");
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
      title: "批量新增标签",
      message:
        `标签将新增到“${categoryPath}”。` +
        "每行一个标签，也支持英文逗号、中文逗号或分号分隔。",
      label: "标签列表",
      confirmLabel: "批量新增",
      placeholder: "银发\n雨夜\n复古夹克\n机械翅膀",
      multiline: true,
    });
    if (rawNames === null) return;
    const names = String(rawNames)
      .split(/[\r\n,，;；]+/u)
      .map((name) => name.trim())
      .filter(Boolean);
    if (!names.length) {
      this.setSkillTagStatus("没有可新增的标签。", "warning");
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
      let message = `新增 ${created} 个，跳过 ${skipped} 个重复标签。`;
      if (warnings.length) message += ` ${warnings[0]}`;
      this.setSkillTagStatus(
        message,
        warnings.length ? "warning" : "success",
      );
    } catch (error) {
      this.setSkillTagStatus(
        `批量新增标签失败：${error.message || error}`,
        "error",
      );
    }
  }

  async saveSkillTagEditor(tag, changes) {
    const name = String(changes.name || "").trim();
    if (!name) {
      this.setSkillTagStatus("标签名称不能为空。", "warning");
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
      this.setSkillTagStatus("标签已保存。", "success");
    } catch (error) {
      this.setSkillTagStatus(
        `保存标签失败：${error.message || error}`,
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
        tag.favorite ? "已取消收藏。" : "已加入收藏。",
        "success",
      );
    } catch (error) {
      this.setSkillTagStatus(
        `更新收藏失败：${error.message || error}`,
        "error",
      );
    }
  }

  async deleteSkillTag(tag) {
    const confirmed = await showAstralConfirm({
      title: "删除标签",
      message: `确定删除灵感标签“${tag.name}”吗？此操作不会影响任何 Skill。`,
      confirmLabel: "删除标签",
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
      this.setSkillTagStatus("标签已删除。", "success");
    } catch (error) {
      this.setSkillTagStatus(
        `删除标签失败：${error.message || error}`,
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
      this.setSkillTagStatus("请先勾选要删除的标签。", "warning");
      return;
    }
    const previewNames = selectedTags
      .slice(0, 6)
      .map((tag) => `“${tag.name}”`)
      .join("、");
    const remaining = selectedTags.length - 6;
    const confirmed = await showAstralConfirm({
      title: "批量删除标签",
      message:
        `确定删除已勾选的 ${selectedTags.length} 个标签吗？\n` +
        `${previewNames}${remaining > 0 ? ` 等 ${selectedTags.length} 个标签` : ""}\n` +
        "删除后无法撤销，但不会删除任何 Skill 文件。",
      confirmLabel: `删除 ${selectedTags.length} 个标签`,
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
      let message = `已删除 ${deletedCount} 个标签。`;
      if (missingCount > 0) {
        message += ` 另有 ${missingCount} 个标签已不存在，已忽略。`;
      }
      this.setSkillTagStatus(
        message,
        missingCount > 0 ? "warning" : "success",
      );
    } catch (error) {
      this.setSkillTagStatus(
        `批量删除标签失败：${error.message || error}`,
        "error",
      );
    }
  }

  async moveSkillTagsBatch() {
    const tagIds = [...this.batchSelectedSkillTagIds];
    if (!tagIds.length) {
      this.setSkillTagStatus("请先勾选要移动的标签。", "warning");
      return;
    }
    const options = [];
    for (const category of this.skillTagState.categories || []) {
      options.push({
        value: JSON.stringify([category.id, ""]),
        label: `${category.name} / 未分类`,
      });
      for (const subcategory of this.skillTagSubcategories(category.id)) {
        options.push({
          value: JSON.stringify([category.id, subcategory.id]),
          label: `${category.name} / ${subcategory.name}`,
        });
      }
    }
    if (!options.length) {
      this.setSkillTagStatus("没有可用的目标分类。", "warning");
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
      title: "移动标签分类",
      message:
        `将已勾选的 ${tagIds.length} 个标签移动到指定分类或二级分类。` +
        "目标分类中已有同名标签时会自动跳过。",
      label: "目标分类",
      options,
      initialValue,
      confirmLabel: "移动标签",
    });
    if (selectedValue === null) return;
    let targetCategoryId = "";
    let targetSubcategoryId = "";
    try {
      const parsed = JSON.parse(String(selectedValue));
      if (!Array.isArray(parsed) || parsed.length < 2) {
        throw new Error("目标分类格式错误");
      }
      [targetCategoryId, targetSubcategoryId] = parsed.map(String);
    } catch (error) {
      this.setSkillTagStatus(
        `移动分类失败：${error.message || error}`,
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
        targetSubcategory?.name || "未分类",
      ]
        .filter(Boolean)
        .join(" / ");
      let message = `已将 ${movedCount} 个标签移动到“${targetPath}”。`;
      if (skippedCount > 0) {
        message +=
          ` 跳过 ${skippedCount} 个同名标签` +
          (skippedNames.length
            ? `：${skippedNames.slice(0, 5).join("、")}${
                skippedNames.length > 5 ? " 等" : ""
              }。`
            : "。");
      }
      if (missingCount > 0) {
        message += ` 另有 ${missingCount} 个标签已不存在，已忽略。`;
      }
      this.setSkillTagStatus(
        message,
        skippedCount > 0 || missingCount > 0 ? "warning" : "success",
      );
    } catch (error) {
      this.setSkillTagStatus(
        `批量移动标签失败：${error.message || error}`,
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
      this.setSkillTagStatus("排序已保存。", "success");
    } catch (error) {
      this.setSkillTagStatus(
        `保存排序失败：${error.message || error}`,
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
    this.setSkillStatus("正在扫描 custom_nodes 与 input 目录...", "loading");
    this.skillsPromise = fetchJson("/assets-astral/skills")
      .then((payload) => {
        this.skills = Array.isArray(payload?.items) ? payload.items : [];
        this.skillRoots = Array.isArray(payload?.roots)
          ? payload.roots.filter(Boolean).map(String)
          : payload?.root
            ? [String(payload.root)]
            : [];
        this.skillRoot = this.skillRoots.join("；") || payload?.root || "";
        this.skillRootLabel.textContent = this.skillRoots.length
          ? `Skill 扫描目录：${this.skillRoots.join("；")}`
          : "";
        this.skillSummary.textContent = `共 ${this.skills.length} 个 Skill`;
        this.renderSkills(preserveScroll);
        this.setSkillStatus(
          this.skills.length
            ? ""
            : "没有找到 Skill。可在 custom_nodes 节点包或 input 目录中创建 SKILL.md。",
          this.skills.length ? "" : "empty",
        );
        this.skillsLoaded = true;
        this.renderChatSelection();
      })
      .catch((error) => {
        this.skillsPromise = null;
        this.setSkillStatus(`读取 Skill 失败：${error.message || error}`, "error");
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
      this.skillSummary.textContent = "共 0 个 Skill";
      replaceList();
      return;
    }
    const query = this.skillSearch?.value.trim() || "";
    const matchingSkills = this.skills.filter((skill) =>
      this.skillMatchesSearch(skill, query),
    );
    this.skillSummary.textContent =
      query
        ? `找到 ${matchingSkills.length} / 共 ${this.skills.length} 个 Skill`
        : `共 ${this.skills.length} 个 Skill`;
    if (!matchingSkills.length) {
      replaceList(
        createElement(
          "p",
          "astral-am-skill-search-empty",
          `没有匹配“${query}”的 Skill，请调整关键词。`,
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
        skill.description || "此 Skill 没有提供 frontmatter description。",
      );
      const meta = createElement("div", "astral-am-skill-meta");
      meta.append(
        ...(skill.source
          ? [createElement("span", "astral-am-chip", `来源：${skill.source}`)]
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
        "查看 SKILL",
      );
      const openDirectory = createElement(
        "button",
        "astral-am-button is-small",
        "打开目录",
      );
      const isCurrentSkill = this.pendingSkillIds.includes(skill.id);
      const hasCurrentSkill = this.pendingSkillIds.length > 0;
      const addToChat = createElement(
        "button",
        "astral-am-button is-small is-primary",
        isCurrentSkill
          ? "当前会话 Skill"
          : hasCurrentSkill
            ? "切换到此 Skill"
            : "加入会话",
      );
      preview.type = "button";
      openDirectory.type = "button";
      addToChat.type = "button";
    openDirectory.title = "在系统文件管理器中打开此 Skill 所在目录并选中文件";
      addToChat.dataset.chatSkillId = skill.id;
      addToChat.disabled = isCurrentSkill;
      addToChat.title = isCurrentSkill
        ? "当前会话已经加载这个 Skill"
        : hasCurrentSkill
          ? "切换后会替换当前会话中的 Skill"
          : "将此 Skill 加入当前会话";
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
    this.setSkillStatus(`正在定位“${skill.name}”...`, "loading");
    try {
      const result = await fetchJson("/assets-astral/skills/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: skill.id }),
      });
      this.setSkillStatus(
        result?.revealMode === "selected"
          ? `已在系统文件管理器中选中 ${skill.fileName}。`
          : `已打开“${skill.name}”所在目录；当前文件管理器未确认自动选中 ${skill.fileName}。`,
        "success",
      );
    } catch (error) {
      this.setSkillStatus(
        `打开 Skill 目录失败：${error.message || error}`,
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
    previewLabel = "悬停预览 · 正文节选",
  ) {
    const preview = this.ensureSkillPreviewElement();
    const header = createElement("div", "astral-am-skill-preview-header");
    header.append(
      createElement("strong", "", skill.name),
      createElement(
        "span",
        "",
        state === "loading" ? "正在读取正文…" : previewLabel,
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
        "正在读取 Skill 正文…",
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
            `预览失败：${error.message || error}`,
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
        { name: template.title || "系统提示词" },
        skillPreviewExcerpt(template.content),
        anchor,
        "",
        "系统提示词 · 悬停预览",
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
      this.setSkillStatus(`读取 Skill 内容失败：${error.message || error}`, "error");
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
    search.placeholder = "搜索本地 LoRA 文件";
    search.autocomplete = "off";
    search.setAttribute("aria-label", "搜索 LoRA");

    const querySelected = createElement("button", "astral-am-button is-primary", "批量查询选中");
    querySelected.type = "button";
    querySelected.disabled = true;

    const selectAll = createElement("button", "astral-am-button", "全选");
    selectAll.type = "button";
    const invertSelection = createElement("button", "astral-am-button", "反选");
    invertSelection.type = "button";

    const thumbnailToggle = createElement("label", "astral-am-check");
    const thumbnailCheckbox = createElement("input");
    thumbnailCheckbox.type = "checkbox";
    thumbnailCheckbox.checked = showLoraThumbnails();
    thumbnailToggle.append(thumbnailCheckbox, document.createTextNode("显示缩略图"));
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
      "清除选择",
    );
    const moveSelected = createElement(
      "button",
      "astral-am-button is-small",
      "移到文件夹",
    );
    const insertSelected = createElement(
      "button",
      "astral-am-button is-small",
      "放入画布",
    );
    const deleteSelected = createElement(
      "button",
      "astral-am-button is-small is-danger",
      "删除选中",
    );
    for (const button of [
      clearSelection,
      moveSelected,
      insertSelected,
      deleteSelected,
    ]) {
      button.type = "button";
    }
    moveSelected.title = "把勾选的 LoRA 移动到另一个 LoRA 文件夹";
    insertSelected.title =
      `用官方 LoRA Loader 节点把勾选的 LoRA 放入当前画布；一次最多 ${MAX_LORA_CANVAS_BATCH} 个`;
    deleteSelected.title = "将勾选的 LoRA 移到 Windows 回收站";
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
    this.querySelected.textContent = count ? `查询选中 (${count})` : "批量查询选中";
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
      ? "正在全选..."
      : hasItems
        ? `全选 (${this.total})`
        : "全选";
    this.moveSelectedButton.textContent = count
      ? `移到文件夹 (${count})`
      : "移到文件夹";
    this.insertSelectedButton.textContent =
      count > MAX_LORA_CANVAS_BATCH
        ? `放入画布 (前 ${MAX_LORA_CANVAS_BATCH}/${count})`
        : count
          ? `放入画布 (${count})`
          : "放入画布";
    this.deleteSelectedButton.textContent = count
      ? `删除选中 (${count})`
      : "删除选中";
    this.actionBar.dataset.selectedCount = String(count);
    this.summary.textContent =
      `当前目录及子目录共 ${this.total} 个 LoRA，已显示 ${this.items.length} 个` +
      (count ? ` · 已选 ${count} 个` : "");
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
    this.setStatus("正在读取当前目录及子目录的全部 LoRA...", "loading");
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
        `已全选当前目录及子目录的 ${this.selected.size} 个 LoRA，包括尚未加载显示的文件。`,
        "success",
      );
    } catch (error) {
      this.setStatus(`全选失败：${error.message || error}`, "error");
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
    this.setStatus("正在读取当前目录及子目录的全部 LoRA...", "loading");
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
        `反选完成，当前选中 ${this.selected.size} 个 LoRA。`,
        "success",
      );
    } catch (error) {
      this.setStatus(`反选失败：${error.message || error}`, "error");
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
    this.setStatus(reset ? "正在读取 LoRA..." : "正在加载更多 LoRA...", "loading");
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
        `当前目录及子目录共 ${this.total} 个 LoRA，已显示 ${this.items.length} 个` +
        (this.selected.size ? ` · 已选 ${this.selected.size} 个` : "");
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
      this.setStatus(page.length ? "" : this.items.length ? "没有更多 LoRA" : "没有找到 LoRA", "empty");
    } catch (error) {
      if (requestId === this.requestId) this.setStatus(`读取失败：${error.message || error}`, "error");
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
      createElement("span", "astral-am-muted", "正在读取 LoRA 目录..."),
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
          `LoRA 目录读取失败：${error.message || error}`,
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
          : `${currentRootPath}（根目录）`,
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
    openRoot.title = `在系统文件管理器中打开 ${rootPath}${treePath ? ` / ${treePath}` : ""}`;
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
              "没有子目录",
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
    openDirectory.title = `在系统文件管理器中打开 ${directory.path}`;
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
          ? `已在系统文件管理器中定位：${path}`
          : `已打开：${result?.absolutePath || path || "LoRA 根目录"}`,
        "success",
      );
    } catch (error) {
      this.setStatus(
        `打开 LoRA 目录失败：${error.message || error}`,
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
    checkbox.setAttribute("aria-label", `选择 ${item.name}`);
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
      this.loadingSources.has(item.file) ? "查询中..." : "刷新来源",
    );
    refresh.type = "button";
    refresh.disabled = this.loadingSources.has(item.file);
    refresh.title = "重新请求 C站、Hugging Face 和魔搭";
    refresh.addEventListener("click", () => void this.queryFiles([item.file], true));
    const insert = createElement(
      "button",
      "astral-am-button is-small",
      "放入画布",
    );
    insert.type = "button";
    insert.title = "使用官方 LoRA Loader 节点放入当前画布";
    insert.addEventListener("click", () => this.insertItemsToCanvas([item]));
    rowActions.append(refresh, insert);
    const thumbnail = this.createThumbnail(item);
    header.append(checkbox, titleWrap, rowActions);

    const sources = createElement("div", "astral-am-source-grid");
    const result = this.results.get(item.file);
    const loading = this.loadingSources.has(item.file);
    sources.append(
      this.createSourceCard("civitai", "C站", item, result, loading),
      this.createSourceCard("huggingface", "Hugging Face", item, result, loading),
      this.createSourceCard("modelscope", "魔搭社区", item, result, loading),
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
    image.alt = `${item.name} 模型缩略图`;
    image.loading = "lazy";
    image.decoding = "async";
    image.title = result.thumbnailSource
      ? `${result.thumbnailSource} 缩略图`
      : "LoRA 缩略图";
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
          exact ? "SHA256 精确匹配" : "名称/元数据候选",
        ),
      );
    }
    card.append(heading);

    if (loading) {
      card.append(createElement("span", "astral-am-muted", "正在查询..."));
      return card;
    }
    if (!result) {
      card.append(createElement("span", "astral-am-muted", "尚未查询"));
      return card;
    }
    if (result.error) {
      card.append(createElement("span", "astral-am-source-error", result.error));
      return card;
    }
    const source = result.sources?.[sourceName];
    if (!source) {
      card.append(createElement("span", "astral-am-source-error", "没有返回此来源的数据"));
      return card;
    }
    if (!source.ok) {
      card.append(createElement("span", "astral-am-source-error", source.error || "查询失败"));
      if (sourceName === "civitai") this.appendAggregateModelInfo(card, result, source);
      return card;
    }

    if (sourceName === "civitai") {
      if (source.url) card.append(sourceLink(source.url, "打开 C站模型"));
      else card.append(createElement("span", "astral-am-muted", "C站未提供公开链接"));
      this.appendAggregateModelInfo(card, result, source);
      return card;
    }

    const candidates = Array.isArray(source.candidates) ? source.candidates : [];
    if (!candidates.length) {
      card.append(createElement("span", "astral-am-muted", `未找到“${source.query || item.name}”候选`));
      return card;
    }
    card.append(sourceLink(source.url, candidates[0].name || candidates[0].id));
    const primary = candidates[0];
    const matchLabel =
      primary.matchLabel || source.matchLabel || "名称候选，未经文件哈希确认";
    card.append(
      createElement(
        "span",
        primary.matchType === "sha256" ? "astral-am-source-match" : "astral-am-muted",
        primary.matchedFile
          ? `${matchLabel}：${primary.matchedFile}`
          : `${matchLabel}；按“${source.query}”找到 ${candidates.length} 个候选`,
      ),
    );
    if (candidates.length > 1) {
      const more = createElement("details", "astral-am-candidates");
      more.append(createElement("summary", "", "查看其他候选"));
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
      createElement("span", "astral-am-source-label", "推荐强度"),
      createElement(
        "span",
        "",
        recommendation?.text
          ? `${recommendation.text}${recommendation.source ? ` · ${recommendation.source}` : ""}`
          : "未找到可靠推荐",
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
        triggerWrap.append(createElement("span", "astral-am-muted", `另 ${triggers.length - 12} 个`));
      }
      const triggersSource = result?.triggersSource || source?.triggersSource;
      if (triggersSource) {
        triggerWrap.append(createElement("span", "astral-am-muted", `触发词来源：${triggersSource}`));
      }
    } else {
      triggerWrap.append(createElement("span", "astral-am-muted", "未找到可靠触发词"));
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
    this.setStatus(`正在${label} LoRA...`, "loading");
    try {
      const result = await fetchJson(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      this.selected.clear();
      await this.reloadPreservingLoadedCount(loadedCount, true);
      this.setStatus(
        `${label}完成，共处理 ${Number(result?.count) || 0} 个 LoRA。`,
        "success",
      );
    } catch (error) {
      this.setStatus(`${label}失败：${error.message || error}`, "error");
    } finally {
      this.operationBusy = false;
      this.updateSelectionButtons();
    }
  }

  async moveSelectedItems() {
    const items = this.selectedItems();
    if (!items.length || this.operationBusy) return;
    this.setStatus("正在读取可用的 LoRA 目标文件夹...", "loading");
    try {
      const payload = await fetchJson("/assets-astral/loras/directories");
      const directories = Array.isArray(payload?.directories)
        ? payload.directories
        : [];
      if (!directories.length) {
        throw new Error("没有可用的 LoRA 目标文件夹");
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
          label: path ? `${rootName} / ${path}` : `${rootName}（根目录）`,
          disabled: sourceDirectories.has(JSON.stringify([rootIndex, path])),
        };
      });
      const initial = options.find((option) => !option.disabled)?.value || "";
      const selected = await showAstralSelect({
        title: "移动 LoRA",
        message: `将选中的 ${items.length} 个 LoRA 移动到哪个文件夹？同名文件不会被覆盖。`,
        label: "目标文件夹",
        options,
        initialValue: initial,
        confirmLabel: "移动",
      });
      if (!selected) return;
      const target = JSON.parse(selected);
      await this.runLoraOperation(
        "移动",
        "/assets-astral/loras/move",
        {
          items: loraSelectionPayload(items),
          target,
        },
      );
    } catch (error) {
      this.setStatus(`移动失败：${error.message || error}`, "error");
    }
  }

  async recycleSelected() {
    const items = this.selectedItems();
    if (!items.length || this.operationBusy) return;
    const confirmed = await showAstralConfirm({
      title: "LoRA 移至回收站",
      message:
        `将选中的 ${items.length} 个 LoRA 移到 Windows 回收站？\n\n` +
        "文件会进入回收站，但相关工作流可能因此失效。",
      confirmLabel: "移至回收站",
    });
    if (!confirmed) return;
    await this.runLoraOperation(
      "删除",
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
        throw new Error("当前 ComfyUI 画布尚未就绪");
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
        if (!loader) throw new Error("当前 ComfyUI 未注册官方节点 LoraLoader");
        const widget = loader.widgets?.find((entry) => entry.name === "lora_name");
        if (!widget) throw new Error("LoraLoader 中未找到 lora_name 输入");
        const value = item.nativeFile || item.file || item.relativePath;
        if (!value) throw new Error(`${item.name || "LoRA"} 缺少文件路径`);
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
          ? `已将前 ${nodes.length} 个 LoRA Loader 放入当前画布；一次最多放入 ${MAX_LORA_CANVAS_BATCH} 个，其余 ${skippedCount} 个未放入。`
          : `已将 ${nodes.length} 个 LoRA Loader 放入当前画布显示区域。`,
        skippedCount ? "warning" : "success",
      );
    } catch (error) {
      this.setStatus(`放入画布失败：${error.message || error}`, "error");
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
      `${refresh ? "正在强制刷新" : "正在读取或查询"} ${wanted.length} 个 LoRA 的来源...`,
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
        this.setStatus(`已查询 ${completed}/${wanted.length} 个 LoRA...`, "loading");
      }
      const failures = wanted.filter((file) => {
        const result = this.results.get(file);
        return result?.error || !result;
      }).length;
      this.setStatus(
        failures
          ? `来源查询完成，${failures} 个 LoRA 未能完整查询，请查看各行失败原因。`
          : refresh
            ? "来源刷新完成，并已保存到 LoRA 同目录。"
            : "来源查询完成；已有结果已优先使用 LoRA 同目录中的本地缓存。",
        failures ? "warning" : "success",
      );
    } catch (error) {
      this.setStatus(`来源查询失败：${error.message || error}`, "error");
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
  match: "可靠匹配",
  candidate: "同名候选",
  ambiguous: "多个同名",
  conflict: "哈希冲突",
  missing: "未找到",
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
    modeTabs.setAttribute("aria-label", "模型管理工具");
    this.loraModeButton = createElement("button", "astral-am-subtab is-active", "LoRA 管理");
    this.duplicateModeButton = createElement("button", "astral-am-subtab", "重复模型清理");
    this.missingModeButton = createElement(
      "button",
      "astral-am-subtab",
      "填充缺失模型",
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
    scope.element.setAttribute("aria-label", "重复扫描范围");
    const scan = createElement("button", "astral-am-button is-primary", "扫描重复模型");
    scan.type = "button";
    const cancel = createElement("button", "astral-am-button is-danger", "取消扫描");
    cancel.type = "button";
    cancel.hidden = true;
    toolbar.append(scope.element, scan, cancel);

    const note = createElement(
      "p",
      "astral-am-note",
      "先按文件大小分组，再计算 SHA256。删除只会把普通模型文件移到 Windows 回收站，并在操作前显示确认；不会删除模型目录。",
    );
    const status = createElement("div", "astral-am-status");
    const progress = createElement("div", "astral-am-duplicate-progress");
    progress.hidden = true;
    const progressBar = document.createElement("progress");
    progressBar.max = 1;
    progressBar.value = 0;
    progressBar.setAttribute("aria-label", "重复模型扫描进度");
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
      "扫描当前工作流缺失模型",
    );
    scan.type = "button";
    const autoFill = createElement(
      "label",
      "astral-am-check astral-am-missing-autofill",
    );
    autoFill.title =
      "扫描后自动填充 SHA256 或原路径一致的模型，以及本地唯一同名模型";
    const autoFillCheckbox = createElement("input");
    autoFillCheckbox.type = "checkbox";
    autoFillCheckbox.checked = this.autoFillMissingModels;
    autoFillCheckbox.setAttribute("aria-label", "扫描后自动填充");
    autoFill.append(
      autoFillCheckbox,
      document.createTextNode("扫描后自动填充"),
    );
    toolbar.append(scan, autoFill);

    const note = createElement(
      "p",
      "astral-am-note",
      "扫描当前工作流中已经失效的模型下拉项。有 SHA256 时只按内容匹配，不会用同名文件替代不同模型；" +
        "勾选“扫描后自动填充”时，只自动填充哈希/原路径一致或本地唯一同名的模型；" +
        "多个同名和哈希冲突仍需人工确认。填充只修改当前工作流，不复制、移动或删除本地模型文件。",
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
          nodeTitle: String(node?.title || node?.type || "未命名节点"),
          widgetName: String(widget?.name || `控件 ${widgetIndex + 1}`),
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
      ? "正在扫描…"
      : "扫描当前工作流缺失模型";
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
    this.setMissingModelStatus("正在读取当前工作流中的模型引用…", "loading");

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
          "当前工作流没有检测到本地模型下拉列表之外的模型引用。",
          "success",
        );
        return;
      }

      this.setMissingModelStatus(
        `正在匹配 ${references.length} 个缺失模型引用…`,
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
        `扫描完成：${reliable} 个可靠匹配，${candidates} 个唯一同名候选，` +
          `${ambiguous} 个多个同名，${conflicts} 个哈希冲突，${missing} 个未找到。`,
      ];
      if (autoFillResult) {
        if (autoFillResult.failures.length) {
          statusParts.push(
            `已自动填充 ${autoFillResult.filled} 个，${autoFillResult.failures.length} 项失败：` +
              autoFillResult.failures.join("；"),
          );
        } else if (autoFillResult.filled) {
          statusParts.push(
            `已自动填充 ${autoFillResult.filled} 个同哈希、原路径一致或唯一同名模型。`,
          );
        } else {
          statusParts.push("已开启扫描后自动填充，但没有可安全自动填充的模型。");
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
        `扫描缺失模型失败：${error.message || error}`,
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
            `${entry.nodeTitle} · ${entry.widgetName}：${error.message || error}`,
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
      `当前工作流有 ${entries.length} 个缺失模型引用：` +
      `${reliable} 个可可靠填充，${candidates} 个唯一同名候选，` +
      `${ambiguous} 个多个同名，${conflicts} 个哈希冲突，${missing} 个未找到` +
      (filled ? `；已填充 ${filled} 个。` : "。");

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
      return "本地已经找到模型，但当前节点的下拉列表里没有该值；请刷新模型列表后重新扫描。";
    }
    if (state === "match" && entry.result?.via === "sha256") {
      return "工作流记录的 SHA256 与本地文件一致，可以安全填充。";
    }
    if (state === "match" && entry.result?.via === "path") {
      return "缺失值的规范相对路径与本地模型一致，可以安全填充。";
    }
    if (state === "candidate") {
      return "工作流没有可用哈希，本地只有一个同名文件；请确认后填充。";
    }
    if (state === "ambiguous") {
      return "工作流没有可用哈希，本地有多个同名文件；必须选择一个。";
    }
    if (state === "conflict") {
      return "本地找到同名文件，但 SHA256 与工作流记录不一致，已阻止按名称替代。";
    }
    return "本地模型目录中没有找到与哈希或名称匹配的文件。";
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
        `节点 #${entry.nodeId || "?"} · 控件 ${entry.widgetName}`,
      ),
    );
    const badge = createElement(
      "span",
      "astral-am-missing-badge",
      state === "filled"
        ? "已填充"
        : MISSING_MODEL_STATE_LABELS[state] || "未找到",
    );
    header.append(heading, badge);

    const reference = createElement("div", "astral-am-missing-reference");
    reference.append(
      createElement("span", "", "原值"),
      markUntranslated(createElement("code", "", entry.value)),
    );
    const description = createElement(
      "p",
      "astral-am-missing-description",
      entry.filledTarget
        ? `当前工作流已改为 ${entry.filledTarget}。`
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
      select.element.setAttribute("aria-label", `${entry.widgetName} 的替代模型`);
      select.setOptions(
        availableTargets.map(({ candidate, target }) => ({
          value: target,
          label: `${candidate.category} / ${candidate.relativePath}`,
          title: `将 ${entry.value} 替换为 ${target}`,
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
      state === "candidate" ? "确认填充" : "填充",
    );
    fill.type = "button";
    fill.title = `仅修改当前工作流中的 ${entry.nodeTitle} · ${entry.widgetName}`;
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
      throw new Error("节点已不在当前画布中，请重新扫描");
    }
    const widgetIndex = Array.isArray(liveNode.widgets)
      ? liveNode.widgets.indexOf(entry.widget)
      : -1;
    if (widgetIndex < 0) {
      throw new Error("模型控件已经变化，请重新扫描");
    }
    if (entry.widget.value !== entry.value) {
      throw new Error("模型值在扫描后被修改，请重新扫描");
    }
    const option = modelComboValues(entry.widget).find(
      (value) => value === target || similarModelPath(value, target),
    );
    if (!option) {
      throw new Error("目标模型已经不在节点下拉列表中，请刷新模型列表后重新扫描");
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
      this.setMissingModelStatus("请先选择一个可用的本地模型。", "warning");
      return false;
    }
    const graph = app?.graph;
    graph?.beforeChange?.();
    let applied = "";
    try {
      applied = this.applyMissingModelTarget(entry, target);
    } catch (error) {
      this.setMissingModelStatus(
        `填充失败：${error.message || error}`,
        "error",
      );
      return false;
    } finally {
      graph?.afterChange?.();
    }
    graph?.setDirtyCanvas?.(true, true);
    this.renderMissingModels();
    this.setMissingModelStatus(
      `${entry.nodeTitle} · ${entry.widgetName} 已填充为 ${applied}。` +
        " 只修改了当前工作流，尚未保存工作流。",
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
          this.setDuplicateStatus("ComfyUI 没有返回可清理的模型分类。", "error");
        }
        return this.categories;
      })
      .catch((error) => {
        this.categoriesPromise = null;
        this.setDuplicateStatus(`读取模型分类失败：${error.message || error}`, "error");
        return [];
      });
    return this.categoriesPromise;
  }

  updateDuplicateScopes() {
    const previous = this.duplicateScope.value;
    this.duplicateScope.setOptions(
      [
        { value: "", label: "全部分类" },
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
      title: "模型移至回收站",
      message:
        `确定将以下模型移至 Windows 回收站吗？\n\n${label}\n\n` +
        "文件会进入回收站，但相关工作流可能因此失效。",
      confirmLabel: "移至回收站",
    });
    if (!confirmed) return false;
    this.setDuplicateStatus(`正在将 ${item.name} 移至回收站...`, "loading");
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
          ? `${label} 已移至 Windows 回收站，当前结果已更新。需要重新核对时请手动点击扫描。`
          : `${label} 已移至 Windows 回收站。`,
        "success",
      );
      return true;
    } catch (error) {
      this.setDuplicateStatus(`删除失败：${error.message || error}`, "error");
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
      "正在启动后台扫描。扫描会继续运行，即使关闭资产管理器也不会中断。",
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
      if (!task?.taskId) throw new Error("后端没有返回扫描任务");
      if (!payload.started) {
        this.setDuplicateStatus(
          "已有一个扫描任务在后台运行，正在接入该任务的实时进度。",
          "warning",
        );
      }
      this.monitorDuplicateTask(task);
    } catch (error) {
      this.stopDuplicateMonitoring();
      this.setScanControls(false);
      this.setDuplicateStatus(`扫描失败：${error.message || error}`, "error");
    }
  }

  setScanControls(active, cancelling = false) {
    this.scanButton.disabled = Boolean(active);
    this.scanButton.textContent = active ? "正在后台扫描…" : "扫描重复模型";
    this.duplicateScope.setDisabled(Boolean(active));
    this.cancelScanButton.hidden = !active;
    this.cancelScanButton.disabled = Boolean(cancelling);
    this.cancelScanButton.textContent = cancelling ? "正在取消…" : "取消扫描";
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
      if (!task) throw new Error("后端没有返回扫描任务状态");
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
          `暂时无法读取后台扫描进度：${error.message || error}。扫描可能仍在后台继续，稍后重新进入此页面可再次接入。`,
          "warning",
        );
        return;
      }
      this.setDuplicateStatus(
        `读取扫描进度失败，正在重试（${this.scanPollFailures}/4）…`,
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
          "已恢复上次完成的重复模型扫描结果。",
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
      this.duplicateProgressText.textContent = "正在准备后台扫描任务…";
      this.duplicateCurrentFile.textContent = "";
      this.duplicateCurrentFile.title = "";
      this.setDuplicateStatus("扫描任务已启动，正在准备文件列表。", "loading");
      return;
    }

    if (cancelling) {
      const progress = Math.max(0, Math.min(1, Number(task?.progress) || 0));
      this.duplicateProgressBar.value = progress;
      this.duplicateProgressText.textContent =
        `正在安全停止扫描，已完成 ${Math.round(progress * 100)}%…`;
      this.duplicateCurrentFile.textContent = "";
      this.duplicateCurrentFile.title = "";
      this.setDuplicateStatus("正在取消后台扫描，请稍候…", "warning");
      return;
    }

    if (phase === "discovering" || phase === "queued") {
      this.duplicateProgressBar.removeAttribute("value");
      this.duplicateProgressText.textContent =
        `正在扫描模型目录，已发现 ${Number(task.scannedFiles) || 0} 个模型文件…`;
      const currentLabel = task.currentFile
        ? `当前：${task.currentFile.category} / ${task.currentFile.relativePath}`
        : "";
      this.duplicateCurrentFile.textContent = currentLabel;
      this.duplicateCurrentFile.title = currentLabel;
      this.setDuplicateStatus(
        "正在后台整理文件大小，随后会计算重复候选的 SHA256。",
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
      if (fileCount) details.push(`已计算 ${hashedCount}/${fileCount} 个文件`);
      if (failedCount) details.push(`${failedCount} 个文件读取失败`);
      if (totalBytes) {
        details.push(`${formatBytes(hashedBytes)} / ${formatBytes(totalBytes)}`);
      }
      details.push(`${Math.round(progress * 100)}%`);
      if (Number(task.bytesPerSecond) > 0) {
        details.push(`${formatBytes(task.bytesPerSecond)}/秒`);
      }
      if (Number(task.etaSeconds) > 0 && progress < 1) {
        details.push(`预计剩余 ${formatDuration(task.etaSeconds)}`);
      }
      this.duplicateProgressText.textContent = details.join(" · ");
      const current = task.currentFile;
      const currentLabel = current
        ? `当前：${current.category} / ${current.relativePath}`
        : phase === "finalizing"
          ? "正在整理重复分组…"
          : "";
      this.duplicateCurrentFile.textContent = currentLabel;
      this.duplicateCurrentFile.title = currentLabel;
      this.setDuplicateStatus(
        "正在后台计算 SHA256。你可以关闭资产管理器，扫描会继续运行。",
        "loading",
      );
    }
  }

  finishDuplicateTask(task) {
    this.stopDuplicateMonitoring();
    this.setScanControls(false);
    if (task?.status === "cancelled") {
      this.setDuplicateStatus("扫描已取消，可以重新开始。", "warning");
      return;
    }
    if (task?.status === "failed") {
      this.setDuplicateStatus(
        `扫描失败：${task.error || "后端扫描任务异常结束"}`,
        "error",
      );
      return;
    }
    const result = task?.result;
    if (!result) {
      this.setDuplicateStatus("扫描结束，但后端没有返回结果。", "error");
      return;
    }
    this.duplicateResult = result;
    this.renderDuplicates(result);
    this.setDuplicateStatus(
      result.groupCount
        ? "扫描完成。建议每组保留一份，删除其余副本。"
        : "扫描完成，没有发现内容相同的模型文件。",
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
    this.setDuplicateStatus("正在请求取消后台扫描…", "warning");
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
      if (!task) throw new Error("后端没有返回扫描任务");
      this.applyDuplicateTaskProgress(task);
      if (["succeeded", "failed", "cancelled"].includes(String(task.status))) {
        if (this.scanTaskId === taskId) this.finishDuplicateTask(task);
      } else if (this.scanTaskId === taskId) {
        this.scheduleDuplicatePoll(300);
      }
    } catch (error) {
      this.setScanControls(true);
      this.setDuplicateStatus(
        `取消扫描失败：${error.message || error}。扫描仍在后台运行。`,
        "error",
      );
    }
  }

  renderDuplicates(result) {
    const groups = Array.isArray(result?.groups) ? result.groups : [];
    const failedFiles = Math.max(0, Number(result?.failedFiles) || 0);
    this.duplicateSummary.textContent =
      `扫描 ${Number(result?.scannedFiles) || 0} 个模型，计算 ${Number(result?.hashedFiles) || 0} 个文件的哈希；` +
      (failedFiles ? `${failedFiles} 个文件读取失败；` : "") +
      `发现 ${groups.length} 组重复，可回收 ${formatBytes(result?.reclaimableBytes)}。`;
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
      createElement("strong", "", `${group.items.length} 个相同文件`),
      createElement("span", "astral-am-muted", `SHA256 ${String(group.sha256).slice(0, 16)}…`),
    );
    header.append(
      heading,
      createElement(
        "span",
        "astral-am-duplicate-size",
        `${formatBytes(group.size)} / 可回收 ${formatBytes(group.size * (group.items.length - 1))}`,
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
      const locate = createElement("button", "astral-am-button is-small", "定位");
      locate.type = "button";
      locate.addEventListener("click", () => void this.openLocation(item));
      const remove = createElement("button", "astral-am-button is-small is-danger", "移至回收站");
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
    this.setDuplicateStatus(`正在系统文件管理器中定位 ${item.name}...`, "loading");
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
          ? `已在系统文件管理器中定位：${label}`
          : `已打开文件所在目录：${label}`,
        "success",
      );
    } catch (error) {
      this.setDuplicateStatus(`定位失败：${error.message || error}`, "error");
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
    close.title = "关闭预览";
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
    this.preview.replaceChildren(createElement("div", "astral-am-loading", "正在读取素材信息..."));
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
        createElement("div", "astral-am-error-box", `读取失败：${error.message || error}`),
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
      createElement("h3", "", "素材信息"),
      this.createDefinition("位置", `${asset.root}/${asset.path}`),
      this.createDefinition("大小", formatBytes(asset.size)),
      this.createDefinition("修改时间", formatDate(asset.modified)),
      this.createDefinition("格式", asset.mime || detail?.properties?.format || "未知"),
    );

    const promptSection = createElement("section", "astral-am-view-section");
    const promptHeader = createElement("div", "astral-am-section-header");
    promptHeader.append(createElement("h3", "", "提示词"));
    const promptText = createElement(
      "pre",
      "astral-am-prompt",
      detail?.prompt || "未在素材中找到可靠的提示词元数据。",
    );
    if (detail?.prompt) {
      const copyPrompt = createElement("button", "astral-am-button is-small", "复制提示词");
      copyPrompt.type = "button";
      copyPrompt.addEventListener("click", async () => {
        try {
          await copyText(detail.prompt);
          this.setActionStatus("提示词已复制。", "success");
        } catch (error) {
          this.setActionStatus(`复制失败：${error.message || error}`, "error");
        }
      });
      promptHeader.append(copyPrompt);
    }
    promptSection.append(promptHeader, promptText);

    const metadata = createElement("section", "astral-am-view-section");
    const fields = detail?.metadata?.fields || [];
    metadata.append(createElement("h3", "", "内嵌数据"));
    const badges = createElement("div", "astral-am-detail-badges");
    badges.append(
      this.createBadge(detail?.metadata?.hasPrompt ? "提示词" : "无提示词", detail?.metadata?.hasPrompt),
      this.createBadge(detail?.metadata?.hasWorkflow ? "可加载工作流" : "无 UI 工作流", detail?.metadata?.hasWorkflow),
      this.createBadge(detail?.metadata?.hasApiPrompt ? "API 工作流" : "无 API 工作流", detail?.metadata?.hasApiPrompt),
    );
    metadata.append(badges);
    if (fields.length) {
      metadata.append(createElement("p", "astral-am-muted", `元数据字段：${fields.join("、")}`));
    }
    if (detail?.metadata?.sidecars?.length) {
      metadata.append(
        createElement("p", "astral-am-muted", `读取了同名元数据文件：${detail.metadata.sidecars.join("、")}`),
      );
    }

    const actions = createElement("section", "astral-am-view-section astral-am-actions");
    const copyPath = createElement("button", "astral-am-button", "复制文件路径");
    copyPath.type = "button";
    copyPath.addEventListener("click", async () => {
      try {
        await copyText(asset.absolutePath);
        this.setActionStatus("绝对路径已复制。", "success");
      } catch (error) {
        this.setActionStatus(`复制失败：${error.message || error}`, "error");
      }
    });

    const copyMedia = createElement(
      "button",
      "astral-am-button",
      asset.kind === "video" ? "复制视频" : "复制图片",
    );
    copyMedia.type = "button";
    copyMedia.addEventListener("click", () => void this.copyMedia(asset, copyMedia));

    const loadWorkflow = createElement("button", "astral-am-button", "加载内嵌工作流");
    loadWorkflow.type = "button";
    loadWorkflow.disabled = !detail?.workflow?.available;
    loadWorkflow.title = "加载后会替换当前画布中的工作流";
    loadWorkflow.addEventListener("click", () => void this.loadWorkflow(detail.workflow?.data));

    const insertNode = createElement("button", "astral-am-button is-primary", "放入画布");
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
    row.append(createElement("span", "", label), createElement("strong", "", value || "未知"));
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
    button.textContent = "正在复制...";
    report("");
    try {
      const response = await api.fetchApi(assetMediaUrl(asset, false), { cache: "no-store" });
      if (!response.ok) throw new Error(`读取媒体失败（HTTP ${response.status}）`);
      let blob = await response.blob();
      if (!window.ClipboardItem || !navigator.clipboard?.write) {
        throw new Error("当前浏览器不支持媒体剪贴板写入");
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
          throw new Error(`浏览器拒绝写入图片剪贴板：${error.message || error}`);
        }
      } else {
        try {
          await navigator.clipboard.write([
            new window.ClipboardItem({ [blob.type || asset.mime]: blob }),
          ]);
        } catch (error) {
          throw new Error(
            `浏览器通常不允许复制视频文件：${error.message || error}`,
          );
        }
      }
      report(
        asset.kind === "video" ? "视频已复制到剪贴板。" : "图片已复制到剪贴板。",
        "success",
      );
    } catch (error) {
      report(`复制失败：${error.message || error}`, "error");
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  async loadWorkflow(workflow) {
    if (!workflow) {
      this.setActionStatus("该素材中没有可加载的 UI 工作流。", "error");
      return;
    }
    try {
      const loadGraphData =
        (typeof app.loadGraphData === "function" && app.loadGraphData.bind(app)) ||
        (typeof app.workflowManager?.loadGraphData === "function" &&
          app.workflowManager.loadGraphData.bind(app.workflowManager));
      if (!loadGraphData) throw new Error("当前 ComfyUI 前端没有提供工作流加载接口");
      await loadGraphData(workflow);
      this.setActionStatus("工作流已加载。", "success");
      this.dialog.close();
      this.managerRoot.close();
    } catch (error) {
      this.setActionStatus(`加载工作流失败：${error.message || error}`, "error");
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
      if (!loader) throw new Error(`当前 ComfyUI 未注册官方节点 ${nodeType}`);
      const widget = loader.widgets?.find((item) => item.name === widgetName);
      if (!widget) throw new Error(`${nodeType} 中未找到 ${widgetName} 输入`);
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
      report(`插入节点失败：${error.message || error}`, "error");
    }
  }
}

async function imageBlobToPng(blob) {
  if (typeof createImageBitmap !== "function") {
    throw new Error("当前浏览器不支持把该图片转换为 PNG");
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建图片转换画布");
  context.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const png = await new Promise((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) resolve(value);
      else reject(new Error("图片转为 PNG 失败"));
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
    const back = createElement("button", "astral-am-button is-small", "上一级");
    back.type = "button";
    const refresh = createElement("button", "astral-am-button is-small", "重新读取");
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
    this.setStatus("正在读取目录...", "loading");
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
        payload?.items?.length ? "" : "此文件夹为空",
        payload?.items?.length ? "" : "empty",
      );
    } catch (error) {
      if (requestId === this.requestId) {
        if (!preserveScroll) this.list.replaceChildren();
        this.setStatus(`读取目录失败：${error.message || error}`, "error");
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
    this.location.textContent = `${this.root} / ${this.path || "（根目录）"}`;
    this.location.title = payload?.absolutePath || this.location.textContent;
    this.summary.textContent =
      `${Number(payload?.directoryCount) || 0} 个文件夹，` +
      `${Number(payload?.fileCount) || 0} 个文件`;

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
          createElement("span", "astral-am-muted", "文件夹"),
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
    windowElement.setAttribute("aria-label", "Astral 素材管理器");

    const header = createElement("header", "astral-am-header");
    header.title = "拖动标题栏移动窗口";
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
    authorLink.title = "访问 Astral星芒的 B 站主页";
    const starLink = createElement(
      "a",
      "astral-am-heading-link astral-am-heading-star",
      "更新下载",
    );
    starLink.href = "https://pan.quark.cn/s/7626ec1f29c7";
    starLink.target = "_blank";
    starLink.rel = "noopener noreferrer";
    starLink.title = "更新下载：访问夸克网盘下载页";
    starLink.setAttribute("aria-label", "更新下载，访问夸克网盘下载页");
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
    heading.append(
      createElement("span", "astral-am-kicker", "ComfyUI-Astral-Manage"),
      headingLinks,
    );
    const headerActions = createElement("div", "astral-am-header-actions");
    headerActions.append(
      createElement(
        "span",
        "astral-am-directory-prompt",
        "快速打开用户目录",
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
      button.setAttribute("aria-label", `打开 ${root} 文件夹`);
    button.title = `立即在系统文件管理器中显示 ${root} 文件夹`;
      markUntranslated(button);
      button.addEventListener("click", () => void this.openDirectory(root));
      this.directoryButtons.set(root, button);
      headerActions.append(button);
    }
    this.shortcutButtonLabel = createElement(
      "span",
      "astral-am-shortcut-button-label",
      "快捷键",
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
      "刷新",
    );
    this.refreshButton.type = "button";
    this.refreshButton.title = "刷新 ComfyUI 节点定义、模型和工作流列表（等同于按 R）";
    this.refreshButton.addEventListener(
      "click",
      () => void this.refreshComfyRegistries(),
    );
    headerActions.prepend(this.shortcutButton);
    headerActions.append(this.refreshButton);
    const close = createElement("button", "astral-am-icon-button", "×");
    close.type = "button";
    close.title = "关闭";
    close.addEventListener("click", () => this.close());
    header.append(heading, headerActions, close);

    const tabs = createElement("nav", "astral-am-tabs");
    tabs.setAttribute("aria-label", "资产管理器页签");
    this.promptTab = createElement("button", "astral-am-tab is-active", "提示词管理");
    this.assetTab = createElement("button", "astral-am-tab", "媒体管理");
    this.modelTab = createElement("button", "astral-am-tab", "模型管理");
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
      : "切换为英文";
    this.languageToggleButton.setAttribute(
      "aria-label",
      isEnglish ? "Switch to Chinese" : "切换为英文",
    );
    if (this.windowElement) {
      this.windowElement.lang = isEnglish ? "en" : "zh-CN";
    }
  }

  syncShortcutButton() {
    if (!this.shortcutButton) return;
    const isEnglish = getLanguage() === "en";
    const shortcutLabel = formatShortcut(getAssetManagerShortcut());
    this.shortcutButtonLabel.textContent = isEnglish
      ? "Shortcut"
      : "快捷键";
    const description = isEnglish
      ? `Customize the Asset Manager shortcut (current: ${shortcutLabel})`
      : `自定义打开资产管理器的快捷键（当前：${shortcutLabel}）`;
    this.shortcutButton.title = description;
    this.shortcutButton.setAttribute("aria-label", description);
  }

  async openShortcutEditor() {
    const currentShortcut = getAssetManagerShortcut();
    const nextShortcut = await showAstralShortcutRecorder({
      title: "自定义面板快捷键",
      message:
        "设置打开资产管理器的快捷键。保存后立即生效，关闭面板后也可以使用。",
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
        title: "无法保存快捷键",
        message:
          "浏览器拒绝写入本地存储；新的快捷键在本次会话中仍然有效，刷新页面后会恢复默认值。",
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
        title: `无法打开 ${root}`,
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
    this.refreshButton.textContent = "刷新中";
    try {
      const command = app.extensionManager?.command;
      if (typeof command?.execute === "function") {
        await command.execute("Comfy.RefreshNodeDefinitions");
      } else if (typeof app.refreshComboInNodes === "function") {
        await app.refreshComboInNodes();
      } else {
        throw new Error("当前 ComfyUI 前端没有提供刷新接口");
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
        title: "刷新 ComfyUI 数据失败",
        message: String(error.message || error),
        tone: "warning",
      });
    } finally {
      this.refreshButton.disabled = false;
      this.refreshButton.textContent = "刷新";
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
  button.title = "Astral 资产管理器";
  button.setAttribute("aria-label", "打开或关闭 Astral 资产管理器");
  button.textContent = "资产管理";
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
