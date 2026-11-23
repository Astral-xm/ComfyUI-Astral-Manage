import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

class FakeText {
  constructor(value, parentElement = null) {
    this.nodeType = 3;
    this.nodeValue = value;
    this.parentElement = parentElement;
  }
}

class FakeElement {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.parentElement = null;
    this.children = [];
    this.attributes = new Map();
    this.textNodes = [];
    this.classes = new Set();
  }

  set className(value) {
    this.classes = new Set(String(value || "").split(/\s+/).filter(Boolean));
  }

  get className() {
    return [...this.classes].join(" ");
  }

  get classList() {
    return {
      contains: (name) => this.classes.has(name),
    };
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node?.nodeType === 3) {
        node.parentElement = this;
        this.textNodes.push(node);
      } else {
        node.parentElement = this;
        this.children.push(node);
      }
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  matches(selector) {
    const trimmed = selector.trim();
    if (trimmed.startsWith(".")) return this.classes.has(trimmed.slice(1));
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const [name, rawValue] = trimmed.slice(1, -1).split("=");
      if (rawValue === undefined) return this.attributes.has(name);
      return this.attributes.get(name) === rawValue.replace(/^["']|["']$/g, "");
    }
    return this.tagName === trimmed.toUpperCase();
  }

  closest(selector) {
    const selectors = selector.split(",").map((item) => item.trim());
    let element = this;
    while (element) {
      if (selectors.some((candidate) => element.matches(candidate))) {
        return element;
      }
      element = element.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    if (selector !== "*") {
      throw new Error(`Unexpected selector in i18n test: ${selector}`);
    }
    const descendants = [];
    const visit = (element) => {
      for (const child of element.children) {
        descendants.push(child);
        visit(child);
      }
    };
    visit(this);
    return descendants;
  }
}

function collectTextNodes(root) {
  const nodes = [];
  const visit = (element) => {
    nodes.push(...element.textNodes);
    for (const child of element.children) visit(child);
  };
  visit(root);
  return nodes;
}

globalThis.NodeFilter = { SHOW_TEXT: 4 };

globalThis.document = {
  createTreeWalker(root) {
    const nodes = collectTextNodes(root);
    let index = 0;
    return {
      nextNode() {
        return nodes[index++] || null;
      },
    };
  },
};

const storedValues = new Map();
globalThis.window = {
  localStorage: {
    getItem(key) {
      return storedValues.get(key) ?? null;
    },
    setItem(key, value) {
      storedValues.set(key, String(value));
    },
  },
};

// Pin the host locale so the language-default assertions are deterministic.
// The production fallback otherwise follows navigator.language, which varies
// between machines running this test.
Object.defineProperty(globalThis, "navigator", {
  value: { language: "en-US" },
  configurable: true,
});

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const modulePath = path.join(packageRoot, "web", "astral_i18n.js");
const moduleUrl = pathToFileURL(modulePath).href;
const dictionaryPath = path.join(packageRoot, "web", "astral_i18n_dict.js");
const dictionaryFileSource = readFileSync(dictionaryPath, "utf8");
const dictionarySource = dictionaryFileSource.slice(
  dictionaryFileSource.indexOf("export const EN_TO_ZH"),
  dictionaryFileSource.indexOf("export const DYNAMIC_EN_TO_ZH"),
);
const dictionaryKeys = [
  ...dictionarySource.matchAll(/^  "((?:\\.|[^"])*)"\s*:/gm),
].map((match) => match[1]);
const duplicateDictionaryKeys = [
  ...new Set(
    dictionaryKeys.filter(
      (key, index) => dictionaryKeys.indexOf(key) !== index,
    ),
  ),
];
assert.deepEqual(
  duplicateDictionaryKeys,
  [],
  "astral_i18n_dict.js must not contain duplicate English keys.",
);

const { DYNAMIC_EN_TO_ZH, EN_TO_ZH } = await import(
  `${pathToFileURL(dictionaryPath).href}?test=${Date.now()}`
);
for (const key of Object.keys(EN_TO_ZH)) {
  assert.ok(
    !key.includes("${"),
    `static translation keys must not hold template source: ${key}`,
  );
}
for (const [pattern, replacement] of DYNAMIC_EN_TO_ZH) {
  assert.ok(pattern instanceof RegExp, "dynamic entries must be RegExp");
  assert.equal(
    pattern.test(""),
    false,
    `dynamic pattern must not match empty text: ${pattern}`,
  );
  assert.ok(
    typeof replacement === "string" && replacement.length > 0,
    `dynamic pattern has no replacement: ${pattern}`,
  );
}

function setComfyLocale(locale) {
  if (locale === undefined) {
    delete globalThis.app;
    return;
  }
  globalThis.app = {
    ui: {
      settings: {
        getSettingValue(name) {
          return name === "Comfy.Locale" ? locale : undefined;
        },
      },
    },
  };
}

let importSerial = 0;
function importI18n(caseName) {
  importSerial += 1;
  return import(`${moduleUrl}?case=${caseName}-${importSerial}`);
}

// English is the source language and the default when nothing is selected.
storedValues.clear();
setComfyLocale(undefined);
const defaultModule = await importI18n("default");
const { LANGUAGE_STORAGE_KEY } = defaultModule;
assert.equal(
  defaultModule.getLanguage(),
  "en",
  "With empty storage and no Comfy.Locale, the UI language must default to English.",
);

// ComfyUI's locale selects Chinese when it asks for zh.
storedValues.clear();
setComfyLocale("zh");
const localeZhModule = await importI18n("locale-zh");
assert.equal(
  localeZhModule.getLanguage(),
  "zh",
  "Comfy.Locale=zh must select Chinese.",
);

// The stored localStorage override still wins over Comfy.Locale.
storedValues.clear();
storedValues.set(LANGUAGE_STORAGE_KEY, "en");
setComfyLocale("zh");
const storedEnModule = await importI18n("stored-en");
assert.equal(
  storedEnModule.getLanguage(),
  "en",
  "A stored English override must win over Comfy.Locale=zh.",
);

storedValues.clear();
storedValues.set(LANGUAGE_STORAGE_KEY, "zh");
setComfyLocale(undefined);
const storedZhModule = await importI18n("stored-zh");
assert.equal(
  storedZhModule.getLanguage(),
  "zh",
  "A stored Chinese override must select Chinese when Comfy.Locale is absent.",
);

storedValues.clear();
setComfyLocale(undefined);
const {
  getLanguage,
  registerLocalizationRoot,
  setLanguage,
  translateUiText,
} = await importI18n("dom");

const root = new FakeElement("section");
const button = new FakeElement("button");
const label = new FakeText("Save", button);
button.append(label);

const chatContent = new FakeElement("p");
chatContent.className = "astral-am-chat-message-content";
const chatText = new FakeText("Save", chatContent);
chatContent.append(chatText);

const cardTitle = new FakeElement("strong");
cardTitle.className = "astral-am-card-title";
const filename = new FakeText("Civitai model", cardTitle);
cardTitle.append(filename);

const toggle = new FakeElement("span");
toggle.setAttribute("data-astral-i18n-skip", "true");
const toggleText = new FakeText("中", toggle);
toggle.append(toggleText);

const input = new FakeElement("input");
input.setAttribute("placeholder", "Enter Content");
const chatInput = new FakeElement("textarea");
chatInput.setAttribute(
  "placeholder",
  "Enter a message. Click an asset chip to insert names such as image1 or video1.",
);
const chatInputDraft = new FakeText("Local cache", chatInput);
chatInput.append(chatInputDraft);
const messageCount = new FakeElement("span");
const messageCountText = new FakeText("8 messages", messageCount);
messageCount.append(messageCountText);
const skillSource = new FakeElement("span");
const skillSourceText = new FakeText("Source: custom_nodes", skillSource);
skillSource.append(skillSourceText);
const skillRoots = new FakeElement("span");
const skillRootsText = new FakeText(
  "Skill scan directories: custom_nodes；input",
  skillRoots,
);
skillRoots.append(skillRootsText);
const titleTarget = new FakeElement("div");
titleTarget.setAttribute("title", "Saving...");
const textMode = new FakeElement("button");
textMode.setAttribute(
  "title",
  "Text-only Mode: Translation, prompt expansion, and refinement",
);
const imageMode = new FakeElement("button");
imageMode.setAttribute(
  "title",
  "Image Mode: Reverse-engineer a prompt from an image",
);
const multimodalMode = new FakeElement("button");
multimodalMode.setAttribute(
  "title",
  "Multimodal Mode: Recognize images, video, and audio",
);
const localMode = new FakeElement("button");
localMode.setAttribute(
  "title",
  "Local Mode: Use a GGUF model from ComfyUI/models/LLM",
);
const currentModel = new FakeElement("div");
currentModel.setAttribute(
  "title",
  "Text-only Mode · 火山方舟\nModel: deepseek-v4",
);
const savedApiKeyStatus = new FakeElement("div");
const savedApiKeyStatusText = new FakeText("Saved", savedApiKeyStatus);
savedApiKeyStatus.append(savedApiKeyStatusText);
const categoryCount = new FakeElement("span");
const categoryCountText = new FakeText("Category · 4", categoryCount);
categoryCount.append(categoryCountText);
const skillCount = new FakeElement("div");
const skillCountText = new FakeText("39 Skills", skillCount);
skillCount.append(skillCountText);
const loraSource = new FakeElement("span");
const loraSourceText = new FakeText("Civitai model", loraSource);
loraSource.append(loraSourceText);
const loraCache = new FakeElement("span");
const loraCacheText = new FakeText("Local cache", loraCache);
loraCache.append(loraCacheText);
const noCandidates = new FakeElement("span");
const noCandidatesText = new FakeText(
  'No candidates found for "Astral Mix"',
  noCandidates,
);
noCandidates.append(noCandidatesText);
const missingModelsNote = new FakeElement("p");
const missingModelsNoteText = new FakeText(
  "Find stale model dropdown values in the current workflow. When SHA256 is available, match by content only and never replace a different model by name. With Auto-fill after scan enabled, only models matching by hash, original path, or a unique local name are filled automatically; multiple same-name matches and hash conflicts still require confirmation. Filling only changes the current workflow and does not copy, move, or delete local model files.",
  missingModelsNote,
);
missingModelsNote.append(missingModelsNoteText);

root.append(
  button,
  chatContent,
  cardTitle,
  toggle,
  input,
  chatInput,
  messageCount,
  skillSource,
  skillRoots,
  titleTarget,
  textMode,
  imageMode,
  multimodalMode,
  localMode,
  currentModel,
  savedApiKeyStatus,
  categoryCount,
  skillCount,
  loraSource,
  loraCache,
  noCandidates,
  missingModelsNote,
);
registerLocalizationRoot(root);

assert.equal(getLanguage(), "en");
assert.equal(label.nodeValue, "Save");
assert.equal(input.getAttribute("placeholder"), "Enter Content");
assert.equal(
  chatInput.getAttribute("placeholder"),
  "Enter a message. Click an asset chip to insert names such as image1 or video1.",
);

setLanguage("zh");
assert.equal(label.nodeValue, "保存");
assert.equal(input.getAttribute("placeholder"), "输入内容");
assert.equal(
  chatInput.getAttribute("placeholder"),
  "输入消息。可点击素材标签插入 image1、video1 等名称。",
);
assert.equal(titleTarget.getAttribute("title"), "正在保存...");
assert.equal(
  textMode.getAttribute("title"),
  "纯文本模式：翻译、提示词扩写与优化",
);
assert.equal(
  imageMode.getAttribute("title"),
  "图片模式：图像反推提示词",
);
assert.equal(
  multimodalMode.getAttribute("title"),
  "多模态模式：图像、视频、音频识别",
);
assert.equal(
  localMode.getAttribute("title"),
  "本地模式：使用 ComfyUI/models/LLM 中的 GGUF",
);
assert.equal(
  currentModel.getAttribute("title"),
  "纯文本模式 · 火山方舟\n模型：deepseek-v4",
);
assert.equal(savedApiKeyStatusText.nodeValue, "已保存");
assert.equal(categoryCountText.nodeValue, "分类 · 4");
assert.equal(skillCountText.nodeValue, "共 39 个 Skill");
assert.equal(loraSourceText.nodeValue, "C站模型");
assert.equal(loraCacheText.nodeValue, "本地缓存");
assert.equal(noCandidatesText.nodeValue, "未找到“Astral Mix”候选");
assert.equal(
  missingModelsNoteText.nodeValue,
  "扫描当前工作流中已经失效的模型下拉项。有 SHA256 时只按内容匹配，不会用同名文件替代不同模型；勾选“扫描后自动填充”时，只自动填充哈希/原路径一致或本地唯一同名的模型；多个同名和哈希冲突仍需人工确认。填充只修改当前工作流，不复制、移动或删除本地模型文件。",
);
assert.equal(chatText.nodeValue, "Save");
assert.equal(filename.nodeValue, "Civitai model");
assert.equal(
  chatInputDraft.nodeValue,
  "Local cache",
  "Textarea content is user-authored and must remain untranslated.",
);
assert.equal(messageCountText.nodeValue, "8 条消息");
assert.equal(skillSourceText.nodeValue, "来源：custom_nodes");
assert.equal(
  skillRootsText.nodeValue,
  "Skill 扫描目录：custom_nodes；input",
);
assert.equal(toggleText.nodeValue, "中");
assert.equal(storedValues.get(LANGUAGE_STORAGE_KEY), "zh");

label.nodeValue = "Saving...";
setLanguage("zh");
assert.equal(
  label.nodeValue,
  "正在保存...",
  "A dynamic text update must not reuse the previous source text.",
);

titleTarget.setAttribute("title", "Saving API settings...");
setLanguage("zh");
assert.equal(titleTarget.getAttribute("title"), "正在保存 API 设置...");

setLanguage("en");
assert.equal(label.nodeValue, "Saving...");
assert.equal(titleTarget.getAttribute("title"), "Saving API settings...");
assert.equal(
  chatInput.getAttribute("placeholder"),
  "Enter a message. Click an asset chip to insert names such as image1 or video1.",
);
assert.equal(chatInputDraft.nodeValue, "Local cache");
assert.equal(messageCountText.nodeValue, "8 messages");
assert.equal(skillSourceText.nodeValue, "Source: custom_nodes");
assert.equal(
  skillRootsText.nodeValue,
  "Skill scan directories: custom_nodes；input",
);
assert.equal(savedApiKeyStatusText.nodeValue, "Saved");
assert.equal(categoryCountText.nodeValue, "Category · 4");
assert.equal(skillCountText.nodeValue, "39 Skills");
assert.equal(loraSourceText.nodeValue, "Civitai model");
assert.equal(loraCacheText.nodeValue, "Local cache");
assert.equal(
  noCandidatesText.nodeValue,
  'No candidates found for "Astral Mix"',
);
assert.equal(storedValues.get(LANGUAGE_STORAGE_KEY), "en");

label.nodeValue = "Delete";
setLanguage("zh");
assert.equal(
  label.nodeValue,
  "删除",
  "A new English source must not be overwritten by a stale cached original.",
);

setLanguage("en");
assert.equal(label.nodeValue, "Delete");
assert.equal(
  translateUiText("Select All", "zh"),
  "全选",
  "English source text must map to the Chinese translation held by the dictionary.",
);
assert.equal(
  translateUiText("Category · 12", "zh"),
  "分类 · 12",
);
assert.equal(
  translateUiText('No candidates found for "另一个模型"', "zh"),
  "未找到“另一个模型”候选",
);
assert.equal(translateUiText("0 / 0 tags", "zh"), "0 / 0 个标签");
assert.equal(
  translateUiText("Collapse 人物 subcategories", "zh"),
  "收起人物二级分类",
);
assert.equal(
  translateUiText('Create a subcategory or add tags in batch under "人物".', "zh"),
  "在“人物”下新建子分类或批量新增标签",
);
assert.equal(
  translateUiText("人物 · 12 tags\nRight-click to manage category", "zh"),
  "人物 · 12 个标签\n右键管理分类",
);
assert.equal(
  translateUiText("人物 / Uncategorized · 3 tags", "zh"),
  "人物 / 未分类 · 3 个标签",
);
assert.equal(
  translateUiText(
    "D:\\ComfyUI-Astral\\ComfyUI\\models\\loras (root)",
    "zh",
  ),
  "D:\\ComfyUI-Astral\\ComfyUI\\models\\loras（根目录）",
);
assert.equal(
  translateUiText(
    "Model directory: D:\\ComfyUI-Astral\\ComfyUI\\models\\LLM",
    "zh",
  ),
  "模型目录：D:\\ComfyUI-Astral\\ComfyUI\\models\\LLM",
);
assert.equal(
  translateUiText("Found 5 main models and 3 vision projection models.", "zh"),
  "已发现 5 个主模型 / 3 个视觉投影模型。",
);
assert.equal(
  translateUiText(
    "Found 5 main models and 3 vision projection models. Image and video frame extraction require mmproj; audio input is supported only by Gemma4.",
    "zh",
  ),
  "已发现 5 个主模型 / 3 个视觉投影模型。图片和视频抽帧需要 mmproj；音频仅支持 Gemma4。",
);
assert.equal(
  translateUiText("API for Text-only Mode", "zh"),
  "纯文本模式使用的 API",
);
assert.equal(
  translateUiText("API for Image Mode", "zh"),
  "图片模式使用的 API",
);
assert.equal(
  translateUiText("API for Multimodal Mode", "zh"),
  "多模态模式使用的 API",
);
assert.equal(
  translateUiText("0.8 · Local cache", "zh"),
  "0.8 · 本地缓存",
);
assert.equal(
  translateUiText("Trigger source: Civitai model", "zh"),
  "触发词来源：C站模型",
);
assert.equal(
  translateUiText("Exact SHA256 match: example.safetensors", "zh"),
  "SHA256 精确匹配：example.safetensors",
);
assert.equal(
  translateUiText(
    'Name candidate; not confirmed by file hash. 3 candidates found for "example".',
    "zh",
  ),
  "名称候选，未经文件哈希确认；按“example”找到 3 个候选",
);
assert.equal(
  translateUiText(
    'Civitai hash-guided name candidate. 2 candidates found for "example".',
    "zh",
  ),
  "C站哈希对应的名称引导候选；按“example”找到 2 个候选",
);
assert.equal(
  translateUiText(
    "The local cache does not contain this source. Click Refresh Sources to retrieve it again.",
    "zh",
  ),
  "本地缓存未包含此来源；可点击“刷新来源”重新拉取",
);
assert.equal(
  translateUiText(
    "Failed to establish a TLS connection to Civitai. Check proxy settings.",
    "zh",
  ),
  "与C站建立 TLS 连接失败，请检查代理设置",
);
assert.equal(
  translateUiText("ModelScope model card", "zh"),
  "魔搭模型卡",
);
assert.equal(
  translateUiText("0.8 - 1.2 · Hugging Face model card", "zh"),
  "0.8 - 1.2 · Hugging Face 模型卡",
);
assert.equal(
  translateUiText("Civitai has not indexed this model; the cache has not expired.", "zh"),
  "Civitai 未收录缓存未过期",
);
assert.equal(
  translateUiText(
    "Failed to establish a TLS connection to ModelScope. Check proxy settings.",
    "zh",
  ),
  "与魔搭社区建立 TLS 连接失败，请检查代理设置",
);
assert.equal(
  translateUiText(
    "Use the official LoRA Loader node to add the selected LoRAs to the current canvas; up to 10 at a time.",
    "zh",
  ),
  "用官方 LoRA Loader 节点把勾选的 LoRA 放入当前画布；一次最多 10 个",
);
assert.equal(translateUiText("Customize Shortcut", "zh"), "自定义快捷键");
assert.equal(translateUiText("Shortcut", "zh"), "快捷键");
assert.equal(translateUiText("Customize Panel Shortcut", "zh"), "自定义面板快捷键");
assert.equal(
  translateUiText(
    "Set the shortcut that opens the Asset Manager. It takes effect immediately and works while the panel is closed.",
    "zh",
  ),
  "设置打开资产管理器的快捷键。保存后立即生效，关闭面板后也可以使用。",
);
assert.equal(translateUiText("Unable to Save Shortcut", "zh"), "无法保存快捷键");
assert.equal(
  translateUiText(
    "The browser denied local storage access. The new shortcut remains active for this session and resets to the default after a page refresh.",
    "zh",
  ),
  "浏览器拒绝写入本地存储；新的快捷键在本次会话中仍然有效，刷新页面后会恢复默认值。",
);
assert.equal(translateUiText("Waiting for keys...", "zh"), "等待按键…");
assert.equal(
  translateUiText('Press "Save" to apply the new shortcut.', "zh"),
  "按“保存”应用新的快捷键。",
);
assert.equal(
  translateUiText(
    "This combination is already used by a ComfyUI shortcut. Choose another one.",
    "zh",
  ),
  "该组合会被 ComfyUI 快捷键占用，请换一组。",
);

setLanguage("en");
assert.equal(
  translateUiText("0 / 0 tags"),
  "0 / 0 tags",
  "English source text must pass through unchanged while English is active.",
);

console.log("Astral i18n DOM checks passed.");
