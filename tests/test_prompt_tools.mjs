import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";


const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourcePath = path.join(packageRoot, "web", "prompt_tools.js");
const cssPath = path.join(packageRoot, "web", "prompt_tools.css");
const source = readFileSync(sourcePath, "utf8");
const css = readFileSync(cssPath, "utf8");

let language = "zh";
let previousSelectionCalls = 0;
let clipboardText = "";
let fetchHandler = null;
let canvasSnapshot = null;
let timerId = 0;

class HTMLImageElement {}

function fakeClassList() {
  const values = new Set();
  return {
    add(name) {
      values.add(name);
    },
    remove(name) {
      values.delete(name);
    },
    contains(name) {
      return values.has(name);
    },
    toggle(name, force) {
      const enabled =
        force === undefined ? !values.has(name) : Boolean(force);
      if (enabled) values.add(name);
      else values.delete(name);
      return enabled;
    },
  };
}

function fakeControl(value = "") {
  const listeners = new Map();
  return {
    value,
    textContent: "",
    title: "",
    type: "",
    hidden: false,
    disabled: false,
    checked: false,
    className: "",
    dataset: {},
    style: {},
    options: [],
    children: [],
    childNodes: [],
    firstChild: null,
    firstElementChild: null,
    isConnected: true,
    classList: fakeClassList(),
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    fire(name, event = {}) {
      return listeners.get(name)?.(event);
    },
    append(...children) {
      this.children.push(...children);
      this.childNodes.push(...children);
      this.firstChild ||= children[0] || null;
      this.firstElementChild ||= children[0] || null;
    },
    replaceChildren(...children) {
      this.children = [...children];
      this.childNodes = [...children];
      this.firstChild = children[0] || null;
      this.firstElementChild = children[0] || null;
    },
    setAttribute(name, nextValue) {
      this[name] = String(nextValue);
    },
    querySelector(selector) {
      if (selector === "[data-icon]") {
        return this.children.find(
          (child) => child?.dataset?.icon,
        ) || null;
      }
      if (selector === "span") {
        return this.children.find(
          (child) => child?.tagName === "span",
        ) || this.children[0] || null;
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getBoundingClientRect() {
      return {
        left: 20,
        top: 30,
        right: 48,
        bottom: 58,
        width: 28,
        height: 28,
      };
    },
    getClientRects() {
      return [{ width: 100, height: 20 }];
    },
    matches(selector) {
      return selector.includes("textarea");
    },
    dispatchEvent() {
      return true;
    },
    contains() {
      return false;
    },
    remove() {},
    select() {},
  };
}

function fakeSelect(value = "") {
  const select = fakeControl(value);
  select.replaceChildren = () => {
    select.options = [];
    select.children = [];
    select.childNodes = [];
    select.firstChild = null;
    select.firstElementChild = null;
  };
  select.append = (...children) => {
    select.options.push(...children);
    select.children.push(...children);
  };
  return select;
}

function fakeField(label) {
  return {
    hidden: false,
    __label: fakeControl(label),
  };
}

function fakeToolButton(role, icon) {
  const button = fakeControl();
  button.dataset.role = role;
  const iconElement = fakeControl();
  iconElement.dataset.icon = icon;
  iconElement.tagName = "span";
  button.append(iconElement);
  return button;
}

function fakeLabel(textValue) {
  const label = fakeControl();
  const caption = fakeControl(textValue);
  caption.tagName = "span";
  label.append(caption);
  return label;
}

function fakePanelSource() {
  const sourceElement = fakeControl();
  sourceElement.replaceChildren = () => {
    sourceElement.childNodes = [];
    sourceElement.firstChild = null;
    sourceElement.children = [];
  };
  sourceElement.append = (...children) => {
    sourceElement.childNodes.push(...children);
    sourceElement.children.push(...children);
    sourceElement.firstChild ||= children[0] || null;
  };
  return sourceElement;
}

const widgetInput = fakeControl("portrait, soft light");
const widget = {
  name: "text",
  type: "customtext",
  value: "portrait, soft light",
  options: { multiline: true },
  inputEl: widgetInput,
  callbackCalls: [],
  callback(value) {
    this.callbackCalls.push(value);
  },
};

const textNode = {
  id: 1,
  type: "CLIPTextEncode",
  title: "Text",
  Flags: {},
  flags: {},
  pos: [80, 80],
  size: [320, 180],
  widgets: [widget],
};

const imageNode = {
  id: 2,
  type: "LoadImage",
  title: "Image",
  flags: {},
  pos: [460, 80],
  size: [300, 260],
  imgs: [],
  widgets: [],
};

const app = {
  extension: null,
  registerExtension(definition) {
    this.extension = definition;
  },
  canvas: {
    selected_nodes: [textNode],
    selected_widget: widget,
    graph: {
      _nodes: [textNode, imageNode],
      setDirtyCanvas() {},
    },
    setDirty() {},
    canvas: {
      getBoundingClientRect() {
        return {
          left: 0,
          top: 0,
          right: 1200,
          bottom: 800,
        };
      },
    },
    ds: { scale: 1, offset: [0, 0] },
    onSelectionChange() {
      previousSelectionCalls += 1;
    },
    onDrawForeground: null,
  },
};

const api = {
  fetchApi(url, options = {}) {
    if (fetchHandler) return fetchHandler(url, options);
    throw new Error(`Unexpected API request: ${url}`);
  },
};

const document = {
  activeElement: null,
  head: fakeControl(),
  body: fakeControl(),
  createElement(tag) {
    if (tag === "canvas") {
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            fillRect() {},
            drawImage() {},
            putImageData() {},
            set fillStyle(value) {},
          };
        },
        toDataURL(type) {
          canvasSnapshot = {
            width: this.width,
            height: this.height,
            type,
          };
          return "data:image/jpeg;base64,dGVzdA==";
        },
      };
    }
    if (tag === "option") {
      const option = fakeControl();
      option.tagName = "option";
      return option;
    }
    if (tag === "textarea") {
      const textarea = fakeControl();
      textarea.tagName = "textarea";
      return textarea;
    }
    return fakeControl();
  },
  querySelector() {
    return null;
  },
  addEventListener() {},
  execCommand() {
    return false;
  },
};

const sandbox = {
  AbortController,
  Blob,
  Date,
  DOMException,
  Error,
  Event,
  HTMLImageElement,
  InputEvent: globalThis.InputEvent || Event,
  JSON,
  Math,
  Number,
  Object,
  Promise,
  String,
  URL,
  app,
  api,
  console,
  document,
  getLanguage: () => language,
  translateUiText(value) {
    return value;
  },
  navigator: {
    clipboard: {
      async writeText(value) {
        clipboardText = value;
      },
    },
  },
  onLanguageChange() {
    return () => {};
  },
  registerLocalizationRoot() {},
  clearTimeout() {},
  setTimeout(callback, delay) {
    timerId += 1;
    if (Number(delay) === 0) callback();
    return timerId;
  },
};

const context = vm.createContext(sandbox);
context.window = context;
context.globalThis = context;
context.innerWidth = 1200;
context.innerHeight = 800;
context.requestAnimationFrame = (callback) => {
  callback();
  return 1;
};
context.addEventListener = () => {};

const executableSource = source.replace(
  /^import\s+[\s\S]*?from\s+"[^"]+";\s*$/gm,
  "",
);
vm.runInContext(executableSource, context, { filename: sourcePath });
const tools = context.__astralPromptTools;
assert.ok(tools, "Prompt tools test API was not exposed");

const ui = tools.ui;

function buildUi() {
  Object.assign(ui, {
    toolbar: fakeControl(),
    expandButton: fakeToolButton("expand", "expand"),
    translateEnButton: fakeControl("英"),
    translateZhButton: fakeControl("中"),
    invertButton: fakeToolButton("invert", "caption-zh"),
    invertEnButton: fakeControl("EN"),
    settings: fakeControl(),
    settingsHeading: fakeControl(),
    settingsSource: fakeControl(),
    settingsRuleField: fakeField("系统提示词"),
    settingsRuleSelect: fakeSelect(),
    settingsSkillField: fakeField("Skill"),
    settingsSkillSelect: fakeSelect(),
    settingsServiceField: fakeField("服务"),
    settingsServiceSelect: fakeSelect("api"),
    settingsClearLabel: fakeLabel("任务后清理显存"),
    settingsClearVram: fakeControl(),
    settingsManageButton: fakeControl("规则管理"),
    settingsRefreshButton: fakeControl("刷新"),
    settingsCloseButton: fakeControl("×"),
    settingsHint: fakeControl(),
    panel: fakeControl(),
    panelHeading: fakeControl(),
    panelSource: fakePanelSource(),
    closeButton: fakeControl("×"),
    serviceField: fakeField("服务"),
    serviceSelect: fakeSelect("api"),
    languageField: fakeField("目标语言"),
    languageSelect: fakeSelect("en"),
    clearLabel: fakeLabel("任务后清理显存"),
    clearVram: fakeControl(),
    runButton: fakeControl("发送"),
    copyButton: fakeControl("复制"),
    applyButton: fakeControl("应用结果"),
    retryButton: fakeControl("重试"),
    sentTime: fakeControl(),
    receivedTime: fakeControl(),
    status: fakeControl(),
    resultLabel: fakeControl(),
    result: fakeControl(),
  });
  ui.toolbar.hidden = true;
  ui.panel.hidden = true;
  ui.settings.hidden = true;
  ui.status.hidden = true;
  ui.result.hidden = true;
  ui.resultLabel.hidden = true;
}

function response(payload, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function resetState({
  kind = "text",
  sourceText = "portrait, soft light",
  expand = {},
  invert = {},
} = {}) {
  buildUi();
  app.canvas.selected_nodes = [textNode];
  textNode.flags.selected = false;
  language = "zh";
  clipboardText = "";
  canvasSnapshot = null;
  fetchHandler = null;
  tools.state.node = kind === "image" ? imageNode : textNode;
  tools.state.widget = kind === "image" ? null : widget;
  tools.state.kind = kind;
  tools.state.action = kind === "image" ? "invert" : "expand";
  tools.state.translationTarget = "en";
  tools.state.menuAction = "";
  tools.state.settingsAnchor = null;
  tools.state.anchorElement =
    kind === "image" ? null : widgetInput;
  tools.state.pointerOverTextWidget = false;
  tools.state.imageSource =
    kind === "image" ? { width: 64, height: 32 } : null;
  tools.state.imageLabel =
    kind === "image" ? "reference.png" : "";
  tools.state.running = false;
  tools.state.abortController = null;
  tools.state.requestId = "";
  tools.state.stopRequested = false;
  tools.state.result = "";
  tools.state.sentAt = 0;
  tools.state.receivedAt = 0;
  tools.state.lastTask = null;
  tools.state.status = { key: "", detail: "", kind: "" };
  tools.state.catalogs = {
    expand: [],
    invert: [],
    skills: [],
  };
  tools.state.loadedCategories.clear();
  tools.state.catalogLoading = null;
  tools.state.settings.expand = {
    ruleId: "",
    skillId: "",
    mode: "api",
    clearVram: false,
    ...expand,
  };
  tools.state.settings.invert = {
    ruleId: "",
    skillId: "",
    mode: "api",
    clearVram: false,
    ...invert,
  };
  widget.value = sourceText;
  widgetInput.value = sourceText;
  widget.callbackCalls = [];
  ui.serviceSelect.value = "api";
  ui.languageSelect.value = "en";
  ui.clearVram.checked = false;
  tools.refreshTexts();
}

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}


test("single-click expansion fills the prompt field immediately", async () => {
  resetState({
    expand: {
      ruleId: "expand-rule",
      mode: "local",
      clearVram: true,
    },
  });
  let request = null;
  fetchHandler = (url, options) => {
    assert.equal(url, "/assets-astral/prompt-task");
    request = JSON.parse(options.body);
    return Promise.resolve(response({
      text: "cinematic portrait, soft light",
      sentAt: 100,
      receivedAt: 101,
    }));
  };

  const task = tools.handleToolClick("expand");
  assert.equal(tools.state.running, true);
  assert.equal(ui.expandButton.dataset.running, "true");
  assert.match(ui.expandButton.title, /Stop prompt expansion/);
  assert.equal(ui.invertButton.disabled, true);
  await task;

  assert.equal(widget.value, "cinematic portrait, soft light");
  assert.equal(widgetInput.value, "cinematic portrait, soft light");
  assert.deepEqual(widget.callbackCalls, [
    "cinematic portrait, soft light",
  ]);
  assert.equal(request.task, "expand");
  assert.equal(request.mode, "local");
  assert.equal(request.ruleId, "expand-rule");
  assert.deepEqual(request.skillIds, []);
  assert.equal(request.clearVram, true);
  assert.match(ui.status.textContent, /Expansion complete\. The prompt field was updated\./);
  assert.equal(ui.result.hidden, true);
  assert.equal(ui.applyButton.hidden, true);
  assert.equal(ui.expandButton.dataset.running, "false");
  assert.equal(tools.state.running, false);
});


test("single-click inversion copies the result instead of editing the prompt", async () => {
  resetState({
    kind: "image",
    invert: {
      skillId: "caption-skill",
      mode: "api",
    },
  });
  let request = null;
  fetchHandler = (url, options) => {
    assert.equal(url, "/assets-astral/prompt-task");
    request = JSON.parse(options.body);
    return Promise.resolve(response({
      text: "a weathered stone bridge over a quiet river",
      sentAt: 200,
      receivedAt: 201,
    }));
  };

  await tools.handleToolClick("invert");

  assert.equal(request.task, "invert");
  assert.equal(request.mode, "api");
  assert.deepEqual(request.skillIds, ["caption-skill"]);
  assert.equal(request.attachments.length, 1);
  assert.equal(
    clipboardText,
    "a weathered stone bridge over a quiet river",
  );
  assert.equal(widget.value, "portrait, soft light");
  assert.match(ui.status.textContent, /Inversion complete\. Copied to the clipboard\./);
  assert.equal(ui.result.hidden, true);
  assert.equal(
    ui.invertButton.firstElementChild.dataset.icon,
    "caption-zh",
  );

  language = "en";
  tools.refreshTexts();
  assert.equal(
    ui.invertEnButton.title,
    "English image inversion (left-click to run, right-click to configure)",
  );
  assert.equal(tools.state.settings.invert.skillId, "caption-skill");
});


test("right-click settings expose independent rule, Skill, mode, and VRAM controls", async () => {
  resetState();
  let requested = [];
  fetchHandler = (url) => {
    requested.push(url);
    if (url.includes("/prompt-templates")) {
      return Promise.resolve(response({
        items: [
          { id: "expand-rule", title: "Expand rule" },
        ],
      }));
    }
    assert.equal(url, "/assets-astral/skills");
    return Promise.resolve(response({
      items: [{ id: "skill-rule", title: "Skill rule" }],
    }));
  };
  const event = {
    clientX: 140,
    clientY: 110,
    currentTarget: ui.expandButton,
    prevented: false,
    stopped: false,
    preventDefault() {
      event.prevented = true;
    },
    stopPropagation() {
      event.stopped = true;
    },
  };

  tools.openSettings("expand", event);
  await tools.state.catalogLoading;

  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(ui.settings.hidden, false);
  assert.equal(ui.toolbar.hidden, true);
  assert.equal(tools.state.menuAction, "expand");
  assert.match(ui.settingsHeading.textContent, /Expand Prompt/);
  assert.ok(requested.some((url) => url.includes("category=expand")));
  assert.ok(requested.includes("/assets-astral/skills"));

  Object.assign(tools.state.settings.expand, {
    ruleId: "expand-rule",
    skillId: "",
    mode: "local",
    clearVram: true,
  });
  tools.refreshSettingsOptions();
  assert.equal(ui.settingsRuleSelect.value, "expand-rule");
  assert.equal(ui.settingsSkillSelect.disabled, true);
  assert.equal(ui.settingsServiceSelect.value, "local");
  assert.equal(ui.settingsClearLabel.hidden, false);
  assert.equal(ui.settingsClearVram.checked, true);

  Object.assign(tools.state.settings.expand, {
    ruleId: "",
    skillId: "skill-rule",
  });
  tools.refreshSettingsOptions();
  assert.equal(ui.settingsSkillSelect.value, "skill-rule");
  assert.equal(ui.settingsRuleSelect.disabled, true);

  language = "en";
  tools.refreshTexts();
  assert.equal(tools.state.settings.expand.skillId, "skill-rule");
  assert.equal(tools.state.settings.expand.mode, "local");
  assert.equal(tools.state.settings.expand.clearVram, true);
});


test("the active icon becomes a stop control and cancellation never writes the prompt", async () => {
  resetState();
  let promptOptions = null;
  let rejectPrompt = null;
  let aborted = false;
  let cancelCalls = 0;
  const stopEvents = [];
  fetchHandler = (url, options) => {
    if (url === "/assets-astral/prompt-task") {
      promptOptions = options;
      options.signal.addEventListener("abort", () => {
        aborted = true;
        stopEvents.push("abort");
      });
      return new Promise((resolve, reject) => {
        rejectPrompt = reject;
      });
    }
    if (url === "/assets-astral/chat/cancel") {
      cancelCalls += 1;
      stopEvents.push("cancel");
      return Promise.resolve(response({ ok: true, cancelled: true }));
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const task = tools.handleToolClick("expand");
  assert.equal(ui.expandButton.dataset.running, "true");
  assert.equal(ui.expandButton.disabled, false);
  assert.equal(ui.translateEnButton.disabled, true);
  assert.equal(ui.translateZhButton.disabled, true);

  await tools.handleToolClick("expand");
  assert.equal(aborted, true);
  assert.equal(cancelCalls, 1);
  assert.deepEqual(stopEvents, ["cancel", "abort"]);
  assert.equal(tools.state.running, true);
  assert.match(promptOptions.body, /"task":"expand"/);

  rejectPrompt(new DOMException("Aborted", "AbortError"));
  await task;
  assert.equal(tools.state.running, false);
  assert.equal(ui.expandButton.dataset.running, "false");
  assert.equal(widget.value, "portrait, soft light");
  assert.deepEqual(widget.callbackCalls, []);
  assert.match(ui.status.textContent, /Action stopped\./);
});


test("translation shortcuts target English and Simplified Chinese", async () => {
  resetState();
  tools.openTranslation("en");
  assert.equal(ui.panel.hidden, false);
  assert.equal(ui.toolbar.hidden, true);
  assert.equal(tools.state.action, "translate");
  assert.equal(tools.state.translationTarget, "en");
  assert.equal(ui.languageSelect.value, "en");
  assert.equal(ui.translateEnButton.title, "Translate to English");
  assert.equal(ui.translateZhButton.title, "Translate to Simplified Chinese");
  ui.serviceSelect.value = "local";
  ui.clearVram.checked = true;

  let request = null;
  fetchHandler = (url, options) => {
    assert.equal(url, "/assets-astral/prompt-task");
    request = JSON.parse(options.body);
    return Promise.resolve(response({
      text: "穏やかな光の肖像画",
      sentAt: 300,
      receivedAt: 301,
    }));
  };

  await tools.runTask("translate");
  assert.equal(request.task, "translate");
  assert.equal(request.mode, "local");
  assert.equal(request.targetLanguage, "en");
  assert.equal(request.clearVram, true);
  assert.equal(ui.result.value, "穏やかな光の肖像画");
  assert.equal(ui.result.hidden, false);
  assert.match(ui.sentTime.textContent, /Send/);
  assert.match(ui.receivedTime.textContent, /Received/);

  tools.openTranslation("zh");
  assert.equal(tools.state.translationTarget, "zh");
  assert.equal(ui.languageSelect.value, "zh");
  assert.equal(ui.result.value, "");
  fetchHandler = (url, options) => {
    assert.equal(url, "/assets-astral/prompt-task");
    request = JSON.parse(options.body);
    return Promise.resolve(response({
      text: "柔光肖像",
      sentAt: 400,
      receivedAt: 401,
    }));
  };
  await tools.runTask("translate");
  assert.equal(request.task, "translate");
  assert.equal(request.targetLanguage, "zh");
  assert.equal(ui.result.value, "柔光肖像");

  language = "en";
  tools.refreshTexts();
  assert.equal(ui.translateEnButton.title, "Translate to English");
  assert.equal(
    ui.translateZhButton.title,
    "Translate to Simplified Chinese",
  );
});


test("image conversion produces a bounded JPEG attachment", async () => {
  resetState();
  const attachment = await tools.imageToJpegAttachment(
    { width: 4096, height: 2048 },
    "reference.png",
  );
  assert.equal(attachment.kind, "image");
  assert.equal(attachment.mimeType, "image/jpeg");
  assert.equal(attachment.name, "reference.jpg");
  assert.equal(attachment.data, "data:image/jpeg;base64,dGVzdA==");
  assert.deepEqual(canvasSnapshot, {
    width: 2048,
    height: 1024,
    type: "image/jpeg",
  });
});


test("selection hook preserves the previous callback and hides on clear", () => {
  previousSelectionCalls = 0;
  resetState();
  tools.state.node = null;
  ui.toolbar.hidden = false;
  app.canvas.onSelectionChange = function previousSelectionHook() {
    previousSelectionCalls += 1;
  };

  tools.installSelectionHook();
  assert.equal(typeof app.canvas.onSelectionChange, "function");
  const result = app.canvas.onSelectionChange([]);
  assert.equal(result, undefined);
  assert.equal(previousSelectionCalls, 1);
  assert.equal(ui.toolbar.hidden, true);
  assert.equal(tools.state.node, null);
});

test("text tools only appear for the selected node", () => {
  resetState();
  widgetInput.getBoundingClientRect = () => ({
    left: 100,
    top: 50,
    right: 500,
    bottom: 78,
    width: 400,
    height: 28,
  });

  app.canvas.selected_nodes = {};
  textNode.flags.selected = true;
  tools.handlePromptPointer({
    target: widgetInput,
    clientX: 300,
    clientY: 60,
  });
  assert.equal(ui.toolbar.hidden, true);

  textNode.flags.selected = false;
  app.canvas.selected_nodes = { 1: textNode };
  tools.handlePromptPointer({
    target: widgetInput,
    clientX: 300,
    clientY: 60,
  });
  assert.equal(ui.toolbar.hidden, false);

  app.canvas.selected_nodes = {};
  tools.handleSelection([]);
  assert.equal(ui.toolbar.hidden, true);
});

test("text tools stay below the editor without covering its last line", () => {
  resetState();
  widgetInput.getBoundingClientRect = () => ({
    left: 100,
    top: 50,
    right: 500,
    bottom: 78,
    width: 400,
    height: 28,
  });
  ui.toolbar.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 64,
    bottom: 32,
    width: 64,
    height: 32,
  });

  tools.handleSelection({ 1: textNode });
  assert.equal(ui.toolbar.hidden, true);

  const nodeContainer = { dataset: { nodeId: "1" } };
  const nodeEdge = {
    closest(selector) {
      return selector === "[data-node-id]" ? nodeContainer : null;
    },
  };
  tools.handlePromptPointer({
    target: nodeEdge,
    clientX: 390,
    clientY: 170,
  });
  assert.equal(ui.toolbar.hidden, true);

  tools.handlePromptPointer({
    target: widgetInput,
    clientX: 300,
    clientY: 60,
  });
  assert.equal(ui.toolbar.hidden, false);
  assert.equal(ui.toolbar.style.left, "432px");
  assert.equal(ui.toolbar.style.top, "76px");

  tools.handlePromptPointer({
    target: document.body,
    clientX: 700,
    clientY: 120,
  });
  assert.equal(ui.toolbar.hidden, true);
});


test("icon assets, compact CSS, direct actions, and legacy removal stay wired", () => {
  for (const asset of [
    "icon-expand.svg",
    "icon-caption-zh.svg",
    "icon-caption-en.svg",
  ]) {
    assert.equal(
      existsSync(path.join(packageRoot, "web", "assets", asset)),
      true,
    );
  }
  assert.match(
    css,
    /\.astral-pt-tool-icon\s*\{[\s\S]*?width:\s*18px;[\s\S]*?height:\s*18px;/,
  );
  assert.match(
    css,
    /data-icon="expand"[\s\S]*?icon-expand\.svg/,
  );
  assert.match(
    css,
    /data-icon="caption-zh"[\s\S]*?icon-caption-zh\.svg/,
  );
  assert.match(
    css,
    /\.astral-pt-tool-button\[data-running="true"\][\s\S]*?::before/,
  );
  assert.match(
    css,
    /\.astral-pt-settings\[hidden\],[\s\S]*?\.astral-pt-toast\[hidden\]\s*\{[\s\S]*?display:\s*none\s*!important;/,
  );
  assert.match(
    css,
    /\.astral-pt-toolbar\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?border:\s*0;[\s\S]*?box-shadow:\s*none;[\s\S]*?backdrop-filter:\s*none;/,
  );
  assert.doesNotMatch(source, /invert_expand|反推后扩写|反推并扩写/);
  assert.doesNotMatch(
    source,
    /ui\.(ruleSelect|skillSelect|manageButton|refreshButton|ruleField|skillField)/,
  );
  assert.doesNotMatch(source, /ui\.translateButton/);
  assert.match(source, /target === "zh" \? "ZH" : "EN"/);
  assert.match(
    source,
    /ui\.translateEnButton\.addEventListener\("click",[\s\S]*?openTranslation\("en"\)/,
  );
  assert.match(
    source,
    /ui\.translateZhButton\.addEventListener\("click",[\s\S]*?openTranslation\("zh"\)/,
  );
  assert.match(
    source,
    /if \(action === "expand"\)[\s\S]*?syncWidgetText/,
  );
  assert.match(
    source,
    /else if \(action === "invert"\)[\s\S]*?writeClipboardText/,
  );
});


for (const { name, run } of tests) {
  await run();
  console.log(`ok - ${name}`);
}
console.log("Prompt tools frontend checks passed.");
