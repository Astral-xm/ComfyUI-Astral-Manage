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

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const modulePath = path.join(packageRoot, "web", "astral_i18n.js");
const moduleUrl = pathToFileURL(modulePath).href;
const i18nSource = readFileSync(modulePath, "utf8");
const dictionarySource = i18nSource.slice(
  i18nSource.indexOf("const ZH_TO_EN"),
  i18nSource.indexOf("const localizationObservers"),
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
assert.deepEqual(duplicateDictionaryKeys, []);
const {
  LANGUAGE_STORAGE_KEY,
  getLanguage,
  registerLocalizationRoot,
  setLanguage,
  translateUiText,
} = await import(`${moduleUrl}?test=${Date.now()}`);

const root = new FakeElement("section");
const button = new FakeElement("button");
const label = new FakeText("保存", button);
button.append(label);

const chatContent = new FakeElement("p");
chatContent.className = "astral-am-chat-message-content";
const chatText = new FakeText("你好，请生成一张雨夜人像", chatContent);
chatContent.append(chatText);

const cardTitle = new FakeElement("strong");
cardTitle.className = "astral-am-card-title";
const filename = new FakeText("雨夜人像.png", cardTitle);
cardTitle.append(filename);

const toggle = new FakeElement("span");
toggle.setAttribute("data-astral-i18n-skip", "true");
const toggleText = new FakeText("中", toggle);
toggle.append(toggleText);

const input = new FakeElement("input");
input.setAttribute("placeholder", "输入内容");
const chatInput = new FakeElement("textarea");
chatInput.setAttribute(
  "placeholder",
  "输入消息。可点击素材标签插入 image1、video1 等名称。",
);
const chatInputDraft = new FakeText("保留这段中文草稿", chatInput);
chatInput.append(chatInputDraft);
const messageCount = new FakeElement("span");
const messageCountText = new FakeText("8 条消息", messageCount);
messageCount.append(messageCountText);
const skillSource = new FakeElement("span");
const skillSourceText = new FakeText("来源：custom_nodes", skillSource);
skillSource.append(skillSourceText);
const skillRoots = new FakeElement("span");
const skillRootsText = new FakeText(
  "Skill 扫描目录：custom_nodes；input",
  skillRoots,
);
skillRoots.append(skillRootsText);
const titleTarget = new FakeElement("div");
titleTarget.setAttribute("title", "正在保存...");
const textMode = new FakeElement("button");
textMode.setAttribute("title", "纯文本模式：翻译、提示词扩写与优化");
const imageMode = new FakeElement("button");
imageMode.setAttribute("title", "图片模式：图像反推提示词");
const multimodalMode = new FakeElement("button");
multimodalMode.setAttribute(
  "title",
  "多模态模式：图像、视频、音频识别",
);
const localMode = new FakeElement("button");
localMode.setAttribute(
  "title",
  "本地模式：使用 ComfyUI/models/LLM 中的 GGUF",
);
const currentModel = new FakeElement("div");
currentModel.setAttribute(
  "title",
  "纯文本模式 · 火山方舟\n模型：deepseek-v4",
);
const savedApiKeyStatus = new FakeElement("div");
const savedApiKeyStatusText = new FakeText("已保存", savedApiKeyStatus);
savedApiKeyStatus.append(savedApiKeyStatusText);
const categoryCount = new FakeElement("span");
const categoryCountText = new FakeText("分类 · 4", categoryCount);
categoryCount.append(categoryCountText);
const skillCount = new FakeElement("div");
const skillCountText = new FakeText("共 39 个 Skill", skillCount);
skillCount.append(skillCountText);
const loraSource = new FakeElement("span");
const loraSourceText = new FakeText("C站模型", loraSource);
loraSource.append(loraSourceText);
const loraCache = new FakeElement("span");
const loraCacheText = new FakeText("本地缓存", loraCache);
loraCache.append(loraCacheText);
const noCandidates = new FakeElement("span");
const noCandidatesText = new FakeText(
  "未找到“Astral Mix”候选",
  noCandidates,
);
noCandidates.append(noCandidatesText);
const missingModelsNote = new FakeElement("p");
const missingModelsNoteText = new FakeText(
  "扫描当前工作流中已经失效的模型下拉项。有 SHA256 时只按内容匹配，不会用同名文件替代不同模型；勾选“扫描后自动填充”时，只自动填充哈希/原路径一致或本地唯一同名的模型；多个同名和哈希冲突仍需人工确认。填充只修改当前工作流，不复制、移动或删除本地模型文件。",
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

assert.equal(getLanguage(), "zh");
assert.equal(label.nodeValue, "保存");
assert.equal(input.getAttribute("placeholder"), "输入内容");
assert.equal(
  chatInput.getAttribute("placeholder"),
  "输入消息。可点击素材标签插入 image1、video1 等名称。",
);

setLanguage("en");
assert.equal(label.nodeValue, "Save");
assert.equal(input.getAttribute("placeholder"), "Enter Content");
assert.equal(
  chatInput.getAttribute("placeholder"),
  "Enter a message. Click an asset chip to insert names such as image1 or video1.",
);
assert.equal(titleTarget.getAttribute("title"), "Saving...");
assert.equal(
  textMode.getAttribute("title"),
  "Text-only Mode: Translation, prompt expansion, and refinement",
);
assert.equal(
  imageMode.getAttribute("title"),
  "Image Mode: Reverse-engineer a prompt from an image",
);
assert.equal(
  multimodalMode.getAttribute("title"),
  "Multimodal Mode: Recognize images, video, and audio",
);
assert.equal(
  localMode.getAttribute("title"),
  "Local Mode: Use a GGUF model from ComfyUI/models/LLM",
);
assert.equal(
  currentModel.getAttribute("title"),
  "Text-only Mode · 火山方舟\nModel: deepseek-v4",
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
assert.equal(
  missingModelsNoteText.nodeValue,
  "Find stale model dropdown values in the current workflow. When SHA256 is available, match by content only and never replace a different model by name. With Auto-fill after scan enabled, only models matching by hash, original path, or a unique local name are filled automatically; multiple same-name matches and hash conflicts still require confirmation. Filling only changes the current workflow and does not copy, move, or delete local model files.",
);
assert.equal(chatText.nodeValue, "你好，请生成一张雨夜人像");
assert.equal(filename.nodeValue, "雨夜人像.png");
assert.equal(
  chatInputDraft.nodeValue,
  "保留这段中文草稿",
  "Textarea content is user-authored and must remain untranslated.",
);
assert.equal(messageCountText.nodeValue, "8 messages");
assert.equal(skillSourceText.nodeValue, "Source: custom_nodes");
assert.equal(
  skillRootsText.nodeValue,
  "Skill scan directories: custom_nodes；input",
);
assert.equal(toggleText.nodeValue, "中");
assert.equal(storedValues.get(LANGUAGE_STORAGE_KEY), "en");

label.nodeValue = "正在保存...";
setLanguage("en");
assert.equal(
  label.nodeValue,
  "Saving...",
  "A dynamic text update must not reuse the previous source text.",
);

titleTarget.setAttribute("title", "正在保存 API 设置...");
setLanguage("en");
assert.equal(titleTarget.getAttribute("title"), "Saving API settings...");

setLanguage("zh");
assert.equal(label.nodeValue, "正在保存...");
assert.equal(titleTarget.getAttribute("title"), "正在保存 API 设置...");
assert.equal(
  chatInput.getAttribute("placeholder"),
  "输入消息。可点击素材标签插入 image1、video1 等名称。",
);
assert.equal(chatInputDraft.nodeValue, "保留这段中文草稿");
assert.equal(messageCountText.nodeValue, "8 条消息");
assert.equal(skillSourceText.nodeValue, "来源：custom_nodes");
assert.equal(
  skillRootsText.nodeValue,
  "Skill 扫描目录：custom_nodes；input",
);
assert.equal(savedApiKeyStatusText.nodeValue, "已保存");
assert.equal(categoryCountText.nodeValue, "分类 · 4");
assert.equal(skillCountText.nodeValue, "共 39 个 Skill");
assert.equal(loraSourceText.nodeValue, "C站模型");
assert.equal(loraCacheText.nodeValue, "本地缓存");
assert.equal(noCandidatesText.nodeValue, "未找到“Astral Mix”候选");

label.nodeValue = "删除";
setLanguage("zh");
assert.equal(
  label.nodeValue,
  "删除",
  "A new Chinese source must not be overwritten by a stale cached original.",
);

setLanguage("en");
assert.equal(label.nodeValue, "Delete");
assert.equal(
  translateUiText("分类 · 12"),
  "Category · 12",
);
assert.equal(
  translateUiText("未找到“另一个模型”候选"),
  'No candidates found for "另一个模型"',
);
assert.equal(translateUiText("0 / 0 个标签"), "0 / 0 tags");
assert.equal(
  translateUiText("收起人物二级分类"),
  "Collapse 人物 subcategories",
);
assert.equal(
  translateUiText("在“人物”下新建子分类或批量新增标签"),
  'Create a subcategory or add tags in batch under "人物".',
);
assert.equal(
  translateUiText("人物 · 12 个标签\n右键管理分类"),
  "人物 · 12 tags\nRight-click to manage category",
);
assert.equal(
  translateUiText("人物 / 未分类 · 3 个标签"),
  "人物 / Uncategorized · 3 tags",
);
assert.equal(
  translateUiText("D:\\ComfyUI-Astral\\ComfyUI\\models\\loras (根目录)"),
  "D:\\ComfyUI-Astral\\ComfyUI\\models\\loras (root)",
);
assert.equal(
  translateUiText("D:\\ComfyUI-Astral\\ComfyUI\\models\\loras（根目录）"),
  "D:\\ComfyUI-Astral\\ComfyUI\\models\\loras (root)",
);
assert.equal(
  translateUiText("模型目录：D:\\ComfyUI-Astral\\ComfyUI\\models\\LLM"),
  "Model directory: D:\\ComfyUI-Astral\\ComfyUI\\models\\LLM",
);
assert.equal(
  translateUiText("已发现 5 个主模型 / 3 个视觉投影模型。"),
  "Found 5 main models and 3 vision projection models.",
);
assert.equal(
  translateUiText(
    "已发现 5 个主模型 / 3 个视觉投影模型。 图片和视频抽帧需要 mmproj；音频仅支持 Gemma4。",
  ),
  "Found 5 main models and 3 vision projection models. Image and video frame extraction require mmproj; audio input is supported only by Gemma4.",
);
assert.equal(
  translateUiText("纯文本模式使用的 API"),
  "API for Text-only Mode",
);
assert.equal(
  translateUiText("图片模式使用的 API"),
  "API for Image Mode",
);
assert.equal(
  translateUiText("多模态模式使用的 API"),
  "API for Multimodal Mode",
);
assert.equal(
  translateUiText("0.8 · 本地缓存"),
  "0.8 · Local cache",
);
assert.equal(
  translateUiText("Trigger source: C站模型"),
  "Trigger source: Civitai model",
);
assert.equal(
  translateUiText("SHA256 精确匹配：example.safetensors"),
  "Exact SHA256 match: example.safetensors",
);
assert.equal(
  translateUiText("名称候选，未经文件哈希确认；按“example”找到 3 个候选"),
  'Name candidate; not confirmed by file hash. 3 candidates found for "example".',
);
assert.equal(
  translateUiText("C站哈希对应的名称引导候选；按“example”找到 2 个候选"),
  'Civitai hash-guided name candidate. 2 candidates found for "example".',
);
assert.equal(
  translateUiText("本地缓存未包含此来源；可点击“刷新来源”重新拉取"),
  "The local cache does not contain this source. Click Refresh Sources to retrieve it again.",
);
assert.equal(
  translateUiText("与C站建立 TLS 连接失败，请检查代理设置"),
  "Failed to establish a TLS connection to Civitai. Check proxy settings.",
);
assert.equal(
  translateUiText("魔搭模型卡"),
  "ModelScope model card",
);
assert.equal(
  translateUiText("0.8 - 1.2 · Hugging Face 模型卡"),
  "0.8 - 1.2 · Hugging Face model card",
);
assert.equal(
  translateUiText("Civitai 未收录缓存未过期"),
  "Civitai has not indexed this model; the cache has not expired.",
);
assert.equal(
  translateUiText("与魔搭社区建立 TLS 连接失败，请检查代理设置"),
  "Failed to establish a TLS connection to ModelScope. Check proxy settings.",
);
assert.equal(
  translateUiText("用官方 LoRA Loader 节点把勾选的 LoRA 放入当前画布；一次最多 10 个"),
  "Use the official LoRA Loader node to add the selected LoRAs to the current canvas; up to 10 at a time.",
);
assert.equal(translateUiText("自定义快捷键"), "Customize Shortcut");
assert.equal(translateUiText("快捷键"), "Shortcut");
assert.equal(translateUiText("自定义面板快捷键"), "Customize Panel Shortcut");
assert.equal(
  translateUiText(
    "设置打开资产管理器的快捷键。保存后立即生效，关闭面板后也可以使用。",
  ),
  "Set the shortcut that opens the Asset Manager. It takes effect immediately and works while the panel is closed.",
);
assert.equal(translateUiText("无法保存快捷键"), "Unable to Save Shortcut");
assert.equal(
  translateUiText(
    "浏览器拒绝写入本地存储；新的快捷键在本次会话中仍然有效，刷新页面后会恢复默认值。",
  ),
  "The browser denied local storage access. The new shortcut remains active for this session and resets to the default after a page refresh.",
);
assert.equal(translateUiText("等待按键…"), "Waiting for keys...");
assert.equal(
  translateUiText("按“保存”应用新的快捷键。"),
  'Press "Save" to apply the new shortcut.',
);
assert.equal(
  translateUiText("该组合会被 ComfyUI 快捷键占用，请换一组。"),
  "This combination is already used by a ComfyUI shortcut. Choose another one.",
);

setLanguage("zh");
assert.equal(translateUiText("0 / 0 个标签"), "0 / 0 个标签");

console.log("Astral i18n DOM checks passed.");
