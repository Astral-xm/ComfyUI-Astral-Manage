import { DYNAMIC_EN_TO_ZH, EN_TO_ZH } from "./astral_i18n_dict.js";

export const LANGUAGE_STORAGE_KEY = "assets-astral.ui-language";

const SUPPORTED_LANGUAGES = new Set(["zh", "en"]);
const TRANSLATABLE_ATTRIBUTES = ["title", "placeholder", "aria-label"];
const USER_CONTENT_SELECTOR = [
  "pre",
  "code",
  "textarea",
  ".astral-am-card-title",
  ".astral-am-card-path",
  ".astral-am-card-meta",
  ".astral-am-prompt-card-text",
  ".astral-am-prompt-source",
  ".astral-am-lora-title",
  ".astral-am-model-name",
  ".astral-am-model-path",
  ".astral-am-chat-message-content",
  ".astral-am-chat-message-attachments",
  ".astral-am-chat-message-images",
  ".astral-am-template-prompt",
  ".astral-am-skill-preview-content",
  ".astral-pt-user-content",
  ".astral-pt-result-content",
  ".astral-pt-attachment",
  ".astral-pp-user-content",
].join(",");

const textSources = new WeakMap();
const attributeSources = new WeakMap();
const localizationRoots = new Set();
const localizationObservers = new Map();
const languageListeners = new Set();

function normalizeLanguage(language) {
  return SUPPORTED_LANGUAGES.has(language) ? language : "en";
}

const COMFY_LOCALE_SETTING = "Comfy.Locale";

function readComfyLocale() {
  try {
    const settings = globalThis.app?.ui?.settings;
    const value =
      settings?.getSettingValue?.(COMFY_LOCALE_SETTING) ??
      globalThis.app?.extensionManager?.setting?.get?.(COMFY_LOCALE_SETTING);
    return String(value || "").toLowerCase();
  } catch {
    return "";
  }
}

function defaultLanguage() {
  // English is the source language; Chinese is shown only when ComfyUI's
  // own locale asks for it.
  return readComfyLocale().startsWith("zh") ? "zh" : "en";
}

function readStoredLanguage() {
  try {
    const stored = window.localStorage?.getItem(LANGUAGE_STORAGE_KEY);
    return stored ? normalizeLanguage(stored) : defaultLanguage();
  } catch {
    return defaultLanguage();
  }
}

let currentLanguage = readStoredLanguage();

function preserveWhitespace(source, translated) {
  const leading = source.match(/^\s*/)?.[0] || "";
  const trailing = source.match(/\s*$/)?.[0] || "";
  return `${leading}${translated}${trailing}`;
}

export function translateUiText(value, language = currentLanguage) {
  const source = String(value ?? "");
  if (normalizeLanguage(language) !== "zh" || !/[A-Za-z]/.test(source)) {
    return source;
  }
  const trimmed = source.trim();
  if (Object.hasOwn(EN_TO_ZH, trimmed)) {
    return preserveWhitespace(source, EN_TO_ZH[trimmed]);
  }
  for (const [pattern, replacement] of DYNAMIC_EN_TO_ZH) {
    if (pattern.test(trimmed)) {
      return preserveWhitespace(source, trimmed.replace(pattern, replacement));
    }
  }
  return source;
}

export function getLanguage() {
  return currentLanguage;
}

export function setLanguage(language, { persist = true } = {}) {
  const nextLanguage = normalizeLanguage(language);
  currentLanguage = nextLanguage;
  if (persist && typeof window !== "undefined") {
    try {
      window.localStorage?.setItem(LANGUAGE_STORAGE_KEY, nextLanguage);
    } catch {
      // The selected language still applies for this session.
    }
  }
  for (const root of localizationRoots) localizeTree(root);
  for (const listener of languageListeners) listener(nextLanguage);
  return currentLanguage;
}

export function toggleLanguage(options) {
  return setLanguage(currentLanguage === "zh" ? "en" : "zh", options);
}

export function onLanguageChange(listener) {
  languageListeners.add(listener);
  return () => languageListeners.delete(listener);
}

function isUserContent(element) {
  return Boolean(
    element?.closest?.(
      `${USER_CONTENT_SELECTOR},[data-astral-i18n-skip="true"]`,
    ),
  );
}

function isExplicitlySkipped(element) {
  return Boolean(element?.closest?.('[data-astral-i18n-skip="true"]'));
}

function localizeTextNode(node) {
  if (!node?.parentElement || isUserContent(node.parentElement)) return;
  const currentValue = node.nodeValue || "";
  let state = textSources.get(node);

  if (currentLanguage === "en") {
    if (!state) return;
    if (currentValue === state.rendered) {
      if (currentValue !== state.source) node.nodeValue = state.source;
      state.rendered = state.source;
    } else {
      // The application replaced the text while English was active. Treat the
      // new value as the current source instead of restoring a stale original.
      state.source = currentValue;
      state.rendered = currentValue;
    }
    return;
  }

  if (!state || currentValue !== state.rendered) {
    state = { source: currentValue, rendered: currentValue };
    textSources.set(node, state);
  }
  const translated = translateUiText(state.source, currentLanguage);
  state.rendered = translated;
  if (translated !== currentValue) node.nodeValue = translated;
}

function localizeAttribute(element, attribute) {
  if (!element?.getAttribute || isExplicitlySkipped(element)) return;
  let originals = attributeSources.get(element);
  const currentValue = element.getAttribute(attribute);
  if (currentValue === null) return;
  if (!originals) {
    originals = new Map();
    attributeSources.set(element, originals);
  }

  if (currentLanguage === "en") {
    const state = originals.get(attribute);
    if (!state) return;
    if (currentValue === state.rendered) {
      if (currentValue !== state.source) {
        element.setAttribute(attribute, state.source);
      }
      state.rendered = state.source;
    } else {
      state.source = currentValue;
      state.rendered = currentValue;
    }
    return;
  }

  let state = originals.get(attribute);
  if (!state || currentValue !== state.rendered) {
    state = { source: currentValue, rendered: currentValue };
    originals.set(attribute, state);
  }
  const translated = translateUiText(state.source, currentLanguage);
  state.rendered = translated;
  if (translated !== currentValue) element.setAttribute(attribute, translated);
}

function localizeElement(element) {
  if (!element || element.nodeType !== 1) return;
  element.setAttribute("data-astral-language", currentLanguage);
  for (const attribute of TRANSLATABLE_ATTRIBUTES) {
    localizeAttribute(element, attribute);
  }
}

export function localizeTree(root) {
  if (!root) return;
  if (root.nodeType === 3) {
    localizeTextNode(root);
    return;
  }
  if (root.nodeType === 1) localizeElement(root);
  if (!root.querySelectorAll || typeof document === "undefined") return;
  for (const element of root.querySelectorAll("*")) localizeElement(element);
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  let node = walker.nextNode();
  while (node) {
    localizeTextNode(node);
    node = walker.nextNode();
  }
}

export function registerLocalizationRoot(root) {
  if (!root || localizationRoots.has(root)) return root;
  localizationRoots.add(root);
  localizeTree(root);
  if (
    typeof MutationObserver !== "function" ||
    typeof NodeFilter === "undefined"
  ) {
    return root;
  }
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") {
        localizeTextNode(record.target);
      } else if (record.type === "attributes") {
        localizeAttribute(record.target, record.attributeName);
      } else {
        for (const node of record.addedNodes) localizeTree(node);
      }
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANSLATABLE_ATTRIBUTES,
  });
  localizationObservers.set(root, observer);
  return root;
}

export function unregisterLocalizationRoot(root) {
  localizationRoots.delete(root);
  localizationObservers.get(root)?.disconnect();
  localizationObservers.delete(root);
}
