import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "LoRA Stack Loader";
const MAX_TRIGGERS = 6;
const MIN_NODE_WIDTH = 440;
const MAIN_ROW_HEIGHT = 20;
const TRIGGER_ROW_HEIGHT = 26;
const HEADER_HEIGHT = 20;
const BUTTON_HEIGHT = 20;
const THUMBNAIL_PREFERENCE = "assets-astral.show-lora-thumbnails";

let loraNamesPromise = null;
let lastPointerEvent = null;
let lastContextMenuEvent = null;
let lastAstralContextMenuAt = 0;
let loraInfoDialogPromise = null;
let activeTriggerEditor = null;
let pendingCursorRestoreCanvas = null;
const INFO_STYLE_URL = "/extensions/ComfyUI-Astral-Manage/asset_management.css";

window.addEventListener(
  "contextmenu",
  (event) => {
    lastContextMenuEvent = event;
    if (Date.now() - lastAstralContextMenuAt > 500) {
      const canvasEvent = window.rgthree?.lastCanvasMouseEvent;
      const graph = app.canvas?.getCurrentGraph?.() || app.graph;
      const node = canvasEvent
        ? graph?.getNodeOnPos?.(canvasEvent.canvasX, canvasEvent.canvasY)
        : null;
      const widget =
        node?.type === NODE_TYPE
          ? findLoraWidgetAt(node, canvasEvent.canvasY - node.pos[1])
          : null;
      if (widget) showLoraWidgetContextMenu(node, widget, canvasEvent);
    }
    if (Date.now() - lastAstralContextMenuAt <= 500) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }
  },
  true,
);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function moveArrayItem(array, item, index) {
  const currentIndex = array.indexOf(item);
  if (currentIndex < 0) return;
  array.splice(currentIndex, 1);
  array.splice(clamp(index, 0, array.length), 0, item);
}

function roundRect(ctx, x, y, width, height, radius = 4) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, width, height, radius);
  } else {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }
}

function fitText(ctx, text, width) {
  text = String(text ?? "");
  if (ctx.measureText(text).width <= width) return text;
  let result = text;
  while (result.length > 0 && ctx.measureText(`${result}...`).width > width) {
    result = result.slice(0, -1);
  }
  return result ? `${result}...` : "";
}

function inside(px, py, x, y, width, height) {
  return px >= x && px <= x + width && py >= y && py <= y + height;
}

function isRightButtonEvent(event) {
  return (
    event?.button === 2 ||
    event?.which === 3 ||
    (Number(event?.buttons) & 2) === 2
  );
}

function drawCheckbox(ctx, x, y, size, checked, disabled = false) {
  ctx.save();
  roundRect(ctx, x, y, size, size, 3);
  ctx.fillStyle = checked ? "#4f86c6" : "rgba(255,255,255,0.08)";
  ctx.strokeStyle = disabled ? "#666" : "#aaa";
  ctx.fill();
  ctx.stroke();
  if (checked) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + size * 0.22, y + size * 0.52);
    ctx.lineTo(x + size * 0.43, y + size * 0.73);
    ctx.lineTo(x + size * 0.82, y + size * 0.25);
    ctx.stroke();
  }
  ctx.restore();
}

function drawToggle(ctx, x, y, width, height, enabled) {
  ctx.save();
  roundRect(ctx, x, y, width, height, height / 2);
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = enabled === null ? "#789" : enabled ? "#89b" : "#888";
  const knobRadius = height * 0.36;
  const knobX =
    enabled === null ? x + width / 2 : enabled ? x + width - height / 2 : x + height / 2;
  ctx.beginPath();
  ctx.arc(knobX, y + height / 2, knobRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawSmallButton(ctx, x, y, width, height, label, enabled = true, color = "#3a7d44") {
  ctx.save();
  roundRect(ctx, x, y, width, height, 4);
  ctx.fillStyle = enabled ? color : "#555";
  ctx.globalAlpha = enabled ? 0.9 : 0.45;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + width / 2, y + height / 2 + 0.5);
  ctx.restore();
}

function drawInfoButton(ctx, x, y, size, enabled = true) {
  ctx.save();
  roundRect(ctx, x, y, size, size, 3);
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.strokeStyle = enabled ? "#aaa" : "#666";
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = enabled ? "#ddd" : "#777";
  ctx.font = `bold italic ${Math.max(11, size * 0.68)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("i", x + size / 2, y + size / 2 + 0.5);
  ctx.restore();
}

function drawStrength(ctx, x, y, height, value) {
  const arrowWidth = 9;
  const numberWidth = 32;
  const innerMargin = 3;
  const midY = y + height / 2;
  const leftX = x;
  const valueX = leftX + arrowWidth + innerMargin;
  const rightX = valueX + numberWidth + innerMargin;

  ctx.save();
  ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
  ctx.beginPath();
  ctx.moveTo(leftX, midY);
  ctx.lineTo(leftX + arrowWidth, midY + 5);
  ctx.lineTo(leftX + arrowWidth, midY - 5);
  ctx.closePath();
  ctx.fill();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(Number(value || 0).toFixed(2), valueX + numberWidth / 2, midY);

  ctx.beginPath();
  ctx.moveTo(rightX, midY - 5);
  ctx.lineTo(rightX + arrowWidth, midY);
  ctx.lineTo(rightX, midY + 5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  return {
    left: [leftX, arrowWidth],
    value: [valueX, numberWidth],
    right: [rightX, arrowWidth],
  };
}

function normalizeStrength(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeTriggers(triggers) {
  if (!Array.isArray(triggers)) return [];
  return triggers.slice(0, MAX_TRIGGERS).map((trigger) => {
    if (typeof trigger === "string") {
      return { enabled: true, text: trigger };
    }
    return {
      enabled: trigger?.enabled !== false,
      text: String(trigger?.text ?? ""),
    };
  });
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

function thumbnailProxyUrl(url) {
  if (String(url || "").startsWith("/assets-astral/loras/thumbnail?")) {
    return url;
  }
  return `/assets-astral/thumbnails/proxy?url=${encodeURIComponent(url)}`;
}

function normalizeRow(value) {
  return {
    on: value?.on !== false,
    lora: value?.lora ?? null,
    strength: normalizeStrength(value?.strength),
    strengthTwo:
      value?.strengthTwo === null || value?.strengthTwo === undefined
        ? null
        : normalizeStrength(value.strengthTwo),
    triggers: normalizeTriggers(value?.triggers),
  };
}

async function getLoraNames(force = false) {
  if (!force && loraNamesPromise) return loraNamesPromise;
  loraNamesPromise = api
    .fetchApi("/object_info/LoraLoader")
    .then((response) => response.json())
    .then((info) => {
      const values = info?.LoraLoader?.input?.required?.lora_name?.[0];
      return Array.isArray(values) ? values : [];
    })
    .catch((error) => {
      loraNamesPromise = null;
      console.warn("[Astral Asset Management] Unable to read the LoRA list.", error);
      return [];
    });
  return loraNamesPromise;
}

function ensureInfoStyles() {
  if (document.querySelector('link[data-assets-astral-styles="true"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = INFO_STYLE_URL;
  link.dataset.assetsAstralStyles = "true";
  document.head.append(link);
}

class AstralLoraInfoDialog {
  constructor(DialogBase, lora, widget, node) {
    ensureInfoStyles();
    this.lora = lora;
    this.widget = widget;
    this.node = node;
    this.info = null;
    this.fetching = false;
    this.error = "";
    this.notice = "";
    this.noticeKind = "";
    this.dialog = new DialogBase({
      class: "rgthree-info-dialog astral-lora-info-dialog",
      title: this.getTitle(),
      content: "",
      onBeforeClose: () => true,
    });
    this.render();
  }

  getTitle() {
    return this.info?.name || this.lora || "LoRA";
  }

  show() {
    this.dialog.show();
  }

  createRow(label, value) {
    const row = document.createElement("div");
    row.className = "astral-info-row";

    const key = document.createElement("div");
    key.className = "astral-info-label";
    key.textContent = label;

    const content = document.createElement("div");
    content.className = "astral-info-value";
    if (value instanceof Node) {
      content.append(value);
    } else {
      content.textContent = String(value ?? "");
    }

    row.append(key, content);
    return row;
  }

  createMuted(text) {
    const span = document.createElement("span");
    span.className = "astral-info-muted";
    span.textContent = text;
    return span;
  }

  getSource(sourceName) {
    const source = this.info?.sources?.[sourceName];
    if (source) return source;
    if (sourceName === "civitai" && this.info?.url) {
      return {
        ok: true,
        url: this.info.url,
        match: "sha256",
        matchLabel: "SHA256 精确匹配",
      };
    }
    return null;
  }

  createSourceLink(source, label) {
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = source.url;
    link.title = label;
    link.addEventListener("click", (event) => event.stopPropagation());
    return link;
  }

  appendSourceWarnings(container, source) {
    const warnings = Array.isArray(source.warnings) ? [...source.warnings] : [];
    const candidates = Array.isArray(source.candidates) ? source.candidates : [];
    const hashErrors = [
      ...new Set(
        candidates
          .map((candidate) => candidate?.hashVerificationError)
          .filter(Boolean),
      ),
    ];
    if (hashErrors.length) {
      warnings.push(`候选文件哈希核对失败：${hashErrors.join("；")}`);
    }
    if (!warnings.length) return;

    const warning = document.createElement("small");
    warning.className = "astral-info-source-warning";
    warning.textContent = `部分查询失败：${warnings.join("；")}`;
    container.append(warning);
  }

  createSourceValue(sourceName, withFetchButton = false) {
    const wrapper = document.createElement("div");
    wrapper.className = withFetchButton ? "astral-info-fetch" : "astral-info-source";
    const sourceWrap = document.createElement("div");
    sourceWrap.className = "astral-info-source-body";
    const source = this.getSource(sourceName);

    if (!this.info) {
      sourceWrap.append(this.createMuted("尚未拉取"));
    } else if (!source) {
      sourceWrap.append(this.createMuted("没有返回此来源的数据"));
    } else if (!source.ok) {
      const error = document.createElement("span");
      error.className = "astral-info-source-error";
      error.textContent = source.error || "查询失败";
      sourceWrap.append(error);
    } else if (!source.url) {
      sourceWrap.append(this.createMuted("未找到公开模型页"));
      this.appendSourceWarnings(sourceWrap, source);
    } else {
      const sourceLabels = {
        civitai: "在 C站打开此 LoRA",
        huggingface: "在 Hugging Face 打开模型页",
        modelscope: "在魔搭社区打开模型页",
      };
      sourceWrap.append(
        this.createSourceLink(source, sourceLabels[sourceName] || "打开模型详情页"),
      );

      const candidates = Array.isArray(source.candidates) ? source.candidates : [];
      const primary = candidates[0];
      const matchLabel =
        source.matchLabel ||
        primary?.matchLabel ||
        (sourceName === "civitai" ? "SHA256 精确匹配" : "名称候选");
      const detail = document.createElement("small");
      detail.className = `astral-info-match is-${source.matchType || primary?.matchType || "name"}`;
      const matchedFile = source.matchedFile || primary?.matchedFile;
      detail.textContent = matchedFile ? `${matchLabel}：${matchedFile}` : matchLabel;
      sourceWrap.append(detail);

      if (candidates.length > 1) {
        const more = document.createElement("details");
        more.className = "astral-info-candidates";
        more.append(
          document.createElement("summary")
        );
        more.firstElementChild.textContent = `其他候选（${candidates.length - 1}）`;
        const list = document.createElement("div");
        for (const candidate of candidates.slice(1, 6)) {
          if (!candidate?.url) continue;
          list.append(
            this.createSourceLink(
              candidate,
              `打开候选：${candidate.name || candidate.id || candidate.url}`,
            ),
          );
        }
        more.append(list);
        sourceWrap.append(more);
      }

      this.appendSourceWarnings(sourceWrap, source);
    }
    wrapper.append(sourceWrap);

    if (withFetchButton) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "astral-info-fetch-button";
      button.disabled = this.fetching;
      button.textContent = this.fetching ? "正在拉取..." : "Fetch model details";
      button.title = "同时拉取 C站、Hugging Face 和魔搭社区模型详情";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.fetchInfo();
      });
      wrapper.append(button);
    }
    return wrapper;
  }

  createStrengthValue() {
    if (!this.info) return this.createMuted("尚未拉取");
    const recommendation = this.info.recommendedStrength;
    if (!recommendation?.text) {
      return this.createMuted("未找到可靠推荐强度（未修改节点）");
    }

    const wrapper = document.createElement("div");
    wrapper.className = "astral-info-strength";
    const value = document.createElement("strong");
    value.textContent = recommendation.text;
    const source = document.createElement("small");
    source.textContent = recommendation.source || "C站";
    wrapper.append(value, source);
    return wrapper;
  }

  createTriggersValue() {
    if (!this.info) return this.createMuted("尚未拉取");
    const triggers = Array.isArray(this.info.triggers) ? this.info.triggers : [];
    if (!triggers.length) {
      return this.createMuted("未找到可靠触发词（未修改节点）");
    }

    const wrapper = document.createElement("div");
    wrapper.className = "astral-info-triggers";
    triggers.forEach((trigger, index) => {
      const chip = document.createElement("span");
      chip.className = "astral-info-trigger";
      if (index < MAX_TRIGGERS) chip.classList.add("is-filled");
      chip.textContent = trigger;
      chip.title = index < MAX_TRIGGERS ? "已填入节点" : "超出节点上限，未填入";
      wrapper.append(chip);
    });
    if (triggers.length > MAX_TRIGGERS) {
      const note = document.createElement("small");
      note.className = "astral-info-muted";
      note.textContent = `节点上限 ${MAX_TRIGGERS} 个，仅填入前 ${MAX_TRIGGERS} 个。`;
      wrapper.append(note);
    }
    if (this.info.triggersSource) {
      const source = document.createElement("small");
      source.className = "astral-info-muted";
      source.textContent = `来源：${this.info.triggersSource}`;
      wrapper.append(source);
    }
    return wrapper;
  }

  createThumbnailValue() {
    if (!this.info) return this.createMuted("尚未拉取");
    const thumbnailSource =
      this.info.thumbnailLocalUrl || this.info.thumbnailUrl;
    if (!thumbnailSource) return this.createMuted("没有可用的模型缩略图");

    const wrapper = document.createElement("div");
    wrapper.className = "astral-info-thumbnail";
    const toggle = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = showLoraThumbnails();
    checkbox.addEventListener("change", () => {
      setShowLoraThumbnails(checkbox.checked);
      image.hidden = !checkbox.checked;
    });
    toggle.append(checkbox, document.createTextNode("显示缩略图"));

    const image = document.createElement("img");
    image.src = thumbnailProxyUrl(thumbnailSource);
    image.alt = `${this.getTitle()} 缩略图`;
    image.loading = "lazy";
    image.hidden = !checkbox.checked;
    image.addEventListener("error", () => {
      image.hidden = true;
    });
    wrapper.append(toggle, image);
    if (this.info.thumbnailSource) {
      wrapper.append(this.createMuted(`来源：${this.info.thumbnailSource}`));
    }
    return wrapper;
  }

  createStatus() {
    if (this.error) {
      const error = document.createElement("div");
      error.className = "astral-info-status is-error";
      error.textContent = `拉取失败：${this.error}`;
      return error;
    }
    if (!this.notice) return null;
    const status = document.createElement("div");
    status.className = `astral-info-status is-${this.noticeKind || "info"}`;
    status.textContent = this.notice;
    return status;
  }

  render() {
    const content = document.createElement("div");
    content.className = "astral-info-content";

    const table = document.createElement("div");
    table.className = "astral-info-table";
    table.append(
      this.createRow("文件", this.lora),
      this.createRow("C站", this.createSourceValue("civitai", true)),
      this.createRow("Hugging Face", this.createSourceValue("huggingface")),
      this.createRow("魔搭", this.createSourceValue("modelscope")),
      this.createRow("缩略图", this.createThumbnailValue()),
      this.createRow("推荐强度", this.createStrengthValue()),
      this.createRow("触发词", this.createTriggersValue()),
    );
    content.append(table);

    const status = this.createStatus();
    if (status) content.append(status);
    this.dialog.setContent(content);
    this.dialog.setTitle(this.getTitle());
  }

  applyToWidget() {
    const notes = [];
    if (!this.widget?.value || !this.node) return "节点数据已不可用。";

    const recommendation = this.info?.recommendedStrength;
    const currentStrength = normalizeStrength(this.widget.value.strength).toFixed(2);
    if (recommendation?.text) {
      notes.push(
        `推荐强度 ${recommendation.text}（${recommendation.source || "C站"}）仅展示，当前强度 ${currentStrength} 保持不变。`,
      );
    } else {
      notes.push(
        `未找到可靠推荐强度，当前强度 ${currentStrength} 保持不变。`,
      );
    }

    const triggers = Array.isArray(this.info?.triggers)
      ? this.info.triggers.map((item) => String(item).trim()).filter(Boolean)
      : [];
    if (triggers.length) {
      const filled = triggers.slice(0, MAX_TRIGGERS);
      this.widget.value.triggers = normalizeTriggers(filled);
      notes.push(
        `已从${this.info?.triggersSource || "模型详情"}填入 ${filled.length} 个触发词。`,
      );
      if (triggers.length > MAX_TRIGGERS) {
        notes.push(`模型详情返回 ${triggers.length} 个，超出部分未填入。`);
      }
      resizeNodeToContent(this.node);
    } else {
      notes.push("未找到可靠触发词，保留现有触发词。");
    }

    redraw(this.node);
    return notes.join(" ");
  }

  async fetchInfo() {
    if (this.fetching) return;
    this.fetching = true;
    this.error = "";
    this.notice = "正在从 C站、Hugging Face 和魔搭社区拉取模型详情...";
    this.noticeKind = "info";
    this.render();

    try {
      const requestUrl =
        `/assets-astral/loras/info?file=${encodeURIComponent(this.lora)}` +
        `&refresh=${Date.now()}`;
      const response = await api.fetchApi(requestUrl, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        throw new Error("节点后端返回了无法解析的数据");
      }
      if (!response.ok || payload?.error) {
        throw new Error(payload?.error || `请求失败（HTTP ${response.status}）`);
      }

      this.info = payload;
      const sources = payload?.sources || {};
      const failures = Object.entries(sources)
        .filter(([, source]) => !source?.ok)
        .map(([name]) => {
          if (name === "civitai") return "C站";
          if (name === "huggingface") return "Hugging Face";
          if (name === "modelscope") return "魔搭";
          return name;
        });
      this.noticeKind = failures.length ? "warning" : "success";
      this.notice = failures.length
        ? `详情拉取完成，${failures.join("、")}未成功，已保留其他来源结果。${this.applyToWidget()}`
        : `详情拉取成功。${this.applyToWidget()}`;
    } catch (error) {
      this.error = String(error?.message || error || "未知错误");
      this.notice = "";
      this.noticeKind = "";
      console.warn("[Astral Asset Management] LoRA model detail fetch failed.", error);
    } finally {
      this.fetching = false;
      this.render();
    }
  }
}

async function showLoraInfoDialog(lora, widget, node) {
  if (!lora || lora === "None") return;
  try {
    loraInfoDialogPromise ??= import("../../rgthree/common/dialog.js");
    const { RgthreeDialog } = await loraInfoDialogPromise;
    new AstralLoraInfoDialog(RgthreeDialog, lora, widget, node).show();
  } catch (error) {
    console.error("[Astral Asset Management] Unable to open the LoRA info dialog.", error);
  }
}

function redraw(node) {
  node.graph?.setDirtyCanvas?.(true, true);
  node.setDirtyCanvas?.(true, true);
}

function resizeNodeToContent(node) {
  const computed = node.computeSize();
  const width = Math.max(node.size?.[0] ?? 0, computed[0] ?? 0);
  const height = Math.max(node.size?.[1] ?? 0, computed[1], 100);
  node.setSize([width, height]);
  redraw(node);
}

function restoredNodeSize(node, info, computed) {
  const savedWidth = Number(info?.size?.[0]);
  const savedHeight = Number(info?.size?.[1]);
  if (savedWidth > 0 && savedHeight > 0) {
    return [savedWidth, savedHeight];
  }
  return [
    Math.max(node?.size?.[0] ?? 0, computed?.[0] ?? 0, MIN_NODE_WIDTH),
    Math.max(node?.size?.[1] ?? 0, computed?.[1] ?? 0, 100),
  ];
}

function getLoraWidgets(node) {
  return (node.widgets || []).filter((widget) => widget.name?.startsWith("lora_"));
}

function promptText(event, title, current, callback) {
  return app.canvas?.prompt?.(title, current, callback, event);
}

function inlineEditorBounds(node, field, canvas = app.canvas) {
  const canvasElement = canvas?.canvas || canvas?.canvasEl || canvas?.element;
  const rect = canvasElement?.getBoundingClientRect?.();
  if (!rect || !field) return null;
  const scale = Number(canvas?.ds?.scale) || 1;
  const offset = canvas?.ds?.offset || [0, 0];
  return {
    left:
      rect.left +
      (Number(node?.pos?.[0] || 0) + Number(field.x || 0) + Number(offset[0] || 0)) *
        scale,
    top:
      rect.top +
      (Number(node?.pos?.[1] || 0) + Number(field.y || 0) + Number(offset[1] || 0)) *
        scale,
    width: Math.max(1, Number(field.width || 0) * scale),
    height: Math.max(1, Number(field.height || 0) * scale),
    scale,
  };
}

function restoreCanvasCursor(canvas = app.canvas) {
  const pointer = canvas?.pointer;
  if (!canvas) return;
  if (pointer?.isDown) {
    if (pendingCursorRestoreCanvas === canvas) return;
    pendingCursorRestoreCanvas = canvas;
    window.addEventListener(
      "pointerup",
      () => {
        if (pendingCursorRestoreCanvas === canvas) {
          pendingCursorRestoreCanvas = null;
        }
        queueMicrotask(() => restoreCanvasCursor(canvas));
      },
      { capture: true, once: true },
    );
    return;
  }
  pendingCursorRestoreCanvas = null;

  try {
    pointer?.reset?.();
  } catch (error) {
    console.warn("Failed to reset the ComfyUI pointer state:", error);
  }

  if (canvas.state) canvas.state.shouldSetCursor = true;
  try {
    canvas.hoveringOver = 0;
  } catch {
    // Older ComfyUI/LiteGraph versions may not expose this accessor.
  }

  const canvasElement = canvas.canvas || canvas.canvasEl || canvas.element;
  if (canvasElement?.style) canvasElement.style.cursor = "default";
  canvas.setDirty?.(true, true);
}

function closeTriggerInlineEditor(commit = true) {
  const editor = activeTriggerEditor;
  if (!editor) return false;
  activeTriggerEditor = null;
  if (commit) editor.trigger.text = editor.input.value;
  else editor.trigger.text = editor.initialText;
  editor.input.remove();
  restoreCanvasCursor();
  redraw(editor.node);
  return true;
}

function openTriggerInlineEditor(node, trigger, label, field) {
  if (!document?.body || !trigger || !field) return null;
  closeTriggerInlineEditor(true);
  ensureInfoStyles();

  const bounds = inlineEditorBounds(node, field);
  if (!bounds) return null;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "astral-lora-trigger-editor";
  input.value = String(trigger.text || "");
  input.placeholder = "Enter trigger word";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", label);
  Object.assign(input.style, {
    left: `${bounds.left}px`,
    top: `${bounds.top}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
    fontSize: `${Math.max(10, 12 * bounds.scale)}px`,
  });

  const editor = {
    node,
    trigger,
    input,
    initialText: trigger.text,
  };
  activeTriggerEditor = editor;

  input.addEventListener("input", () => {
    trigger.text = input.value;
    redraw(node);
  });
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      closeTriggerInlineEditor(false);
      return;
    }
    if (
      event.key === "Enter" &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      closeTriggerInlineEditor(true);
    }
  });
  input.addEventListener("blur", () => {
    if (activeTriggerEditor === editor) closeTriggerInlineEditor(true);
  });
  document.body.append(input);

  const focusEditor = () => {
    if (activeTriggerEditor !== editor) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  };
  focusEditor();
  window.requestAnimationFrame?.(() => {
    if (document.activeElement !== input) focusEditor();
  });
  return editor;
}

class AstralHeaderWidget {
  constructor() {
    this.name = "astral_asset_header";
    this.type = "custom";
    this.value = null;
    this.options = { serialize: false };
    this.y = 0;
    this.last_y = 0;
  }

  computeSize(width) {
    return [width, HEADER_HEIGHT];
  }

  draw(ctx, node, width, y, height) {
    const widgets = getLoraWidgets(node);
    if (!widgets.length) return;

    const onCount = widgets.filter((widget) => widget.value?.on !== false).length;
    const allState = onCount === widgets.length ? true : onCount === 0 ? false : null;
    const rowLayout = widgets[0].layout(width, y);

    ctx.save();
    drawToggle(ctx, 10, y + 3, 24, 14, allState);

    ctx.globalAlpha = (app.canvas?.editor_alpha ?? 1) * 0.55;
    ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("Toggle All", 42, y + height / 2);

    ctx.textAlign = "center";
    ctx.fillText(
      "Strength",
      rowLayout.strengthX + rowLayout.strengthWidth / 2,
      y + height / 2,
    );
    ctx.restore();
  }

  mouse(event, pos, node) {
    lastPointerEvent = event;
    if (event.type !== "pointerdown" || event.button === 2) return false;
    const widgets = getLoraWidgets(node);
    if (!widgets.length) return false;
    if (!inside(pos[0], pos[1], 8, this.last_y, 98, HEADER_HEIGHT)) return false;
    const allOn = widgets.length > 0 && widgets.every((widget) => widget.value?.on);
    for (const widget of widgets) {
      widget.value.on = !allOn;
    }
    redraw(node);
    return true;
  }
}

class AstralButtonWidget {
  constructor(label, callback) {
    this.name = "astral_add_lora";
    this.type = "custom";
    this.value = "";
    this.options = { serialize: false };
    this.label = label;
    this.callback = callback;
    this.y = 0;
    this.last_y = 0;
    this.hovered = false;
  }

  computeSize(width) {
    return [width, BUTTON_HEIGHT];
  }

  draw(ctx, node, width, y, height) {
    ctx.save();
    roundRect(ctx, 15, y + 2, width - 30, height - 4, 5);
    ctx.fillStyle = this.hovered ? "#424242" : LiteGraph.WIDGET_BGCOLOR;
    ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(this.label, width / 2, y + height / 2);
    ctx.restore();
  }

  mouse(event, pos, node) {
    lastPointerEvent = event;
    if (event.type === "pointermove") {
      this.hovered = inside(pos[0], pos[1], 15, this.last_y, node.size[0] - 30, BUTTON_HEIGHT);
      redraw(node);
      return false;
    }
    if (event.type !== "pointerdown" || event.button === 2) return false;
    if (!inside(pos[0], pos[1], 15, this.last_y, node.size[0] - 30, BUTTON_HEIGHT)) {
      return false;
    }
    this.callback(event, node);
    return true;
  }
}

class AstralLoraRowWidget {
  constructor(name, value = {}) {
    this.name = name;
    this.type = "custom";
    this.value = normalizeRow(value);
    this.options = {};
    this.y = 0;
    this.last_y = 0;
  }

  computeSize(width) {
    const triggerRows = Math.ceil(this.value.triggers.length / 2);
    return [width, MAIN_ROW_HEIGHT + triggerRows * TRIGGER_ROW_HEIGHT];
  }

  serializeValue() {
    return {
      on: this.value.on !== false,
      lora: this.value.lora ?? null,
      strength: normalizeStrength(this.value.strength),
      strengthTwo: this.value.strengthTwo ?? null,
      triggers: normalizeTriggers(this.value.triggers),
    };
  }

  layout(width, y) {
    const margin = 10;
    const plusWidth = 20;
    const plusX = width - margin - plusWidth;
    const strengthWidth = 56;
    const strengthX = plusX - strengthWidth - 8;
    const infoSize = 14;
    const infoX = strengthX - infoSize - 6;
    const toggleX = margin;
    const toggleWidth = 24;
    const labelX = toggleX + toggleWidth + 7;
    const labelWidth = Math.max(30, infoX - labelX - 6);
    return {
      margin,
      plusX,
      plusWidth,
      strengthX,
      strengthWidth,
      infoX,
      infoSize,
      toggleX,
      toggleWidth,
      labelX,
      labelWidth,
      triggerStartY: y + MAIN_ROW_HEIGHT,
    };
  }

  triggerLayout(width, mainY, index) {
    const margin = 10;
    const gap = 8;
    const columnWidth = (width - margin * 2 - gap) / 2;
    const column = index % 2;
    const row = Math.floor(index / 2);
    const columnX = margin + column * (columnWidth + gap);
    const rowY = mainY + MAIN_ROW_HEIGHT + row * TRIGGER_ROW_HEIGHT;
    const boxY = rowY + 3;
    const boxHeight = 20;
    const checkboxX = columnX + 4;
    const numberX = columnX + 24;
    const fieldX = columnX + 50;
    const removeX = columnX + columnWidth - 16;
    return {
      columnX,
      columnWidth,
      rowY,
      boxY,
      boxHeight,
      checkboxX,
      checkboxHitX: columnX + 2,
      checkboxHitWidth: 46,
      numberX,
      fieldX,
      fieldWidth: Math.max(20, removeX - fieldX - 4),
      removeX,
      removeWidth: 16,
    };
  }

  draw(ctx, node, width, y, height) {
    const layout = this.layout(width, y);
    const midY = y + MAIN_ROW_HEIGHT / 2;

    ctx.save();
    roundRect(ctx, layout.margin, y + 1, width - layout.margin * 2, MAIN_ROW_HEIGHT - 2, 5);
    ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR;
    ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 1;

    drawToggle(
      ctx,
      layout.toggleX,
      y + 4,
      layout.toggleWidth,
      12,
      this.value.on !== false,
    );

    ctx.globalAlpha = this.value.on === false ? 0.45 : 1;
    ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(
      fitText(ctx, this.value.lora || "None", layout.labelWidth),
      layout.labelX,
      midY,
    );

    drawInfoButton(
      ctx,
      layout.infoX,
      y + 3,
      layout.infoSize,
      Boolean(this.value.lora && this.value.lora !== "None"),
    );

    drawStrength(ctx, layout.strengthX, y, MAIN_ROW_HEIGHT, this.value.strength);
    ctx.globalAlpha = 1;

    const canAdd = this.value.triggers.length < MAX_TRIGGERS;
    drawSmallButton(
      ctx,
      layout.plusX,
      y + 3,
      layout.plusWidth,
      14,
      "+",
      canAdd,
      canAdd ? "#3a7d44" : "#555",
    );

    for (let index = 0; index < this.value.triggers.length; index++) {
      this.drawTrigger(ctx, width, y, index);
    }
    ctx.restore();
  }

  drawTrigger(ctx, width, y, index) {
    const trigger = this.value.triggers[index];
    const layout = this.triggerLayout(width, y, index);

    ctx.save();
    ctx.globalAlpha = trigger.enabled === false ? 0.55 : 1;
    drawCheckbox(
      ctx,
      layout.checkboxX,
      layout.boxY + 3,
      14,
      trigger.enabled !== false,
    );

    ctx.fillStyle = LiteGraph.WIDGET_SECONDARY_TEXT_COLOR || "#aaa";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(`#${index + 1}`, layout.numberX, layout.boxY + layout.boxHeight / 2);

    roundRect(ctx, layout.fieldX, layout.boxY, layout.fieldWidth, layout.boxHeight, 4);
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = trigger.text ? LiteGraph.WIDGET_TEXT_COLOR : "#888";
    ctx.fillText(
      fitText(ctx, trigger.text || "Click to enter trigger word", layout.fieldWidth - 14),
      layout.fieldX + 7,
      layout.boxY + layout.boxHeight / 2,
    );

    drawSmallButton(
      ctx,
      layout.removeX,
      layout.boxY,
      layout.removeWidth,
      layout.boxHeight,
      "×",
      true,
      "#6b3c3c",
    );
    ctx.restore();
  }

  mouse(event, pos, node) {
    lastPointerEvent = event;
    if (
      event.type === "pointerdown" &&
      isRightButtonEvent(event) &&
      pos[1] >= this.last_y &&
      pos[1] <= this.last_y + this.computeSize(node.size[0])[1]
    ) {
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
      showLoraWidgetContextMenu(node, this, event);
      return true;
    }
    if (event.type !== "pointerdown") return false;

    const layout = this.layout(node.size[0], this.last_y);
    const x = pos[0];
    const y = pos[1];
    const mainY = this.last_y;
    const inMainRow = y >= mainY && y <= mainY + MAIN_ROW_HEIGHT;

    if (inMainRow && inside(x, y, layout.toggleX, mainY, layout.toggleWidth, MAIN_ROW_HEIGHT)) {
      this.value.on = this.value.on === false;
      redraw(node);
      return true;
    }

    if (inMainRow && inside(x, y, layout.labelX, mainY, layout.labelWidth, MAIN_ROW_HEIGHT)) {
      node.showLoraChooser(event, (lora) => {
        this.value.lora = lora || null;
        node.setDirtyCanvas?.(true, true);
      });
      return true;
    }

    if (
      inMainRow &&
      inside(x, y, layout.infoX, mainY + 3, layout.infoSize, layout.infoSize)
    ) {
      showLoraInfoDialog(this.value.lora, this, node);
      return true;
    }

    if (inMainRow && x >= layout.strengthX && x <= layout.strengthX + layout.strengthWidth) {
      if (x < layout.strengthX + 12) {
        this.value.strength = Math.round((this.value.strength - 0.05) * 100) / 100;
      } else if (x > layout.strengthX + layout.strengthWidth - 12) {
        this.value.strength = Math.round((this.value.strength + 0.05) * 100) / 100;
      } else {
        promptText(event, "Value", this.value.strength, (value) => {
          const strength = Number.parseFloat(value);
          if (Number.isFinite(strength)) {
            this.value.strength = strength;
            redraw(node);
          }
        });
      }
      this.value.strengthTwo = null;
      redraw(node);
      return true;
    }

    if (inMainRow && inside(x, y, layout.plusX, mainY + 3, layout.plusWidth, 14)) {
      this.addTrigger(node, event);
      return true;
    }

    for (let index = 0; index < this.value.triggers.length; index++) {
      const triggerLayout = this.triggerLayout(node.size[0], this.last_y, index);
      if (y < triggerLayout.rowY || y > triggerLayout.rowY + TRIGGER_ROW_HEIGHT) continue;
      if (
        inside(
          x,
          y,
          triggerLayout.checkboxHitX,
          triggerLayout.rowY,
          triggerLayout.checkboxHitWidth,
          TRIGGER_ROW_HEIGHT,
        )
      ) {
        this.value.triggers[index].enabled = this.value.triggers[index].enabled === false;
        redraw(node);
        return true;
      }
      if (
        inside(
          x,
          y,
          triggerLayout.fieldX,
          triggerLayout.boxY,
          triggerLayout.fieldWidth,
          triggerLayout.boxHeight,
        )
      ) {
        this.editTrigger(node, event, index);
        return true;
      }
      if (
        inside(
          x,
          y,
          triggerLayout.removeX,
          triggerLayout.boxY,
          triggerLayout.removeWidth,
          triggerLayout.boxHeight,
        )
      ) {
        this.value.triggers.splice(index, 1);
        resizeNodeToContent(node);
        return true;
      }
    }
    return false;
  }

  addTrigger(node, event) {
    if (this.value.triggers.length >= MAX_TRIGGERS) return;
    const index = this.value.triggers.length;
    const trigger = { enabled: true, text: "" };
    this.value.triggers.push(trigger);
    resizeNodeToContent(node);
    event.preventDefault?.();
    event.stopPropagation?.();
    const layout = this.triggerLayout(node.size[0], this.last_y, index);
    openTriggerInlineEditor(
      node,
      trigger,
      `Trigger word #${index + 1}`,
      {
        x: layout.fieldX,
        y: layout.boxY,
        width: layout.fieldWidth,
        height: layout.boxHeight,
      },
    );
  }

  editTrigger(node, event, index) {
    const trigger = this.value.triggers[index];
    event.preventDefault?.();
    event.stopPropagation?.();
    const layout = this.triggerLayout(node.size[0], this.last_y, index);
    openTriggerInlineEditor(
      node,
      trigger,
      `Trigger word #${index + 1}`,
      {
        x: layout.fieldX,
        y: layout.boxY,
        width: layout.fieldWidth,
        height: layout.boxHeight,
      },
    );
  }
}

function findLoraWidgetAt(node, localY) {
  for (const widget of getLoraWidgets(node)) {
    const height = widget.computeSize?.(node.size[0])?.[1] ?? MAIN_ROW_HEIGHT;
    if (localY >= widget.last_y && localY <= widget.last_y + height) return widget;
  }
  return null;
}

function showLoraWidgetContextMenu(node, widget, event) {
  lastAstralContextMenuAt = Date.now();
  const index = node.widgets.indexOf(widget);
  const canMoveUp = Boolean(node.widgets[index - 1]?.name?.startsWith("lora_"));
  const canMoveDown = Boolean(node.widgets[index + 1]?.name?.startsWith("lora_"));
  new LiteGraph.ContextMenu(
    [
      {
        content: "ℹ️ Show Info",
        callback: () => showLoraInfoDialog(widget.value?.lora, widget, node),
      },
      null,
      {
        content: `${widget.value?.on ? "⚫" : "🟢"} Toggle ${widget.value?.on ? "Off" : "On"}`,
        callback: () => {
          widget.value.on = widget.value.on === false;
          redraw(node);
        },
      },
      {
        content: "⬆️ Move Up",
        disabled: !canMoveUp,
        callback: () => {
          moveArrayItem(node.widgets, widget, index - 1);
          redraw(node);
        },
      },
      {
        content: "⬇️ Move Down",
        disabled: !canMoveDown,
        callback: () => {
          moveArrayItem(node.widgets, widget, index + 1);
          redraw(node);
        },
      },
      {
        content: "🗑️ Remove",
        callback: () => node.removeLoraWidget(widget),
      },
    ],
    {
      event:
        event ||
        window.rgthree?.lastCanvasMouseEvent ||
        lastPointerEvent ||
        lastContextMenuEvent,
      title: "LORA WIDGET",
    },
  );
}

function addAstralNodeMethods(nodeType) {
  const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const result = originalOnNodeCreated?.apply(this, arguments);
    this.serialize_widgets = true;
    this._astralLoraCounter = 0;
    this._astralAddButton = null;
    this.addAstralChrome();
    this.setSize([Math.max(this.size?.[0] ?? 0, MIN_NODE_WIDTH), this.computeSize()[1]]);
    return result;
  };

  const originalConfigure = nodeType.prototype.configure;
  nodeType.prototype.configure = function () {
    const info = arguments[0] || {};
    while (this.widgets?.length) this.removeWidget(this.widgets[0]);
    this._astralLoraCounter = 0;
    this._astralAddButton = null;
    const result = originalConfigure?.apply(this, arguments);

    for (const widgetValue of info.widgets_values || []) {
      if (
        widgetValue &&
        typeof widgetValue === "object" &&
        Object.prototype.hasOwnProperty.call(widgetValue, "lora")
      ) {
        this.addNewLoraWidget(widgetValue, { resize: false });
      }
    }
    this.addAstralChrome();
    this.setSize(restoredNodeSize(this, info, this.computeSize()));
    redraw(this);
    return result;
  };

  nodeType.prototype.addAstralChrome = function () {
    if (this._astralAddButton) return;
    const header = this.addCustomWidget(new AstralHeaderWidget());
    moveArrayItem(this.widgets, header, 0);
    this._astralAddButton = this.addCustomWidget(
      new AstralButtonWidget("+ Add LoRA", (event, node) => {
        node.showLoraChooser(event, (lora) => {
          if (lora) node.addNewLoraWidget({ on: true, lora, strength: 1, triggers: [] });
        });
      }),
    );
  };

  nodeType.prototype.addNewLoraWidget = function (value = {}, options = {}) {
    this._astralLoraCounter = (this._astralLoraCounter || 0) + 1;
    const widget = this.addCustomWidget(
      new AstralLoraRowWidget(`lora_${this._astralLoraCounter}`, value),
    );
    const addButtonIndex = this.widgets.indexOf(this._astralAddButton);
    if (addButtonIndex >= 0) moveArrayItem(this.widgets, widget, addButtonIndex);
    if (options.resize !== false) resizeNodeToContent(this);
    return widget;
  };

  nodeType.prototype.removeLoraWidget = function (widget) {
    const index = this.widgets.indexOf(widget);
    if (index < 0) return;
    this.removeWidget(widget);
    resizeNodeToContent(this);
  };

  nodeType.prototype.showLoraChooser = async function (event, onChoose) {
    const loras = await getLoraNames();
    const options = ["None", ...loras];
    new LiteGraph.ContextMenu(options, {
      event,
      title: "Choose a LoRA",
      scale: Math.max(1, app.canvas?.ds?.scale ?? 1),
      className: "dark",
      callback: (value) => {
        const selected =
          typeof value === "string" ? value : value?.value ?? value?.content ?? "None";
        onChoose(selected === "None" ? null : String(selected));
        redraw(this);
      },
    });
  };

  const originalGetSlotInPosition = nodeType.prototype.getSlotInPosition;
  nodeType.prototype.getSlotInPosition = function (canvasX, canvasY) {
    const slot = originalGetSlotInPosition?.apply(this, arguments);
    if (slot) return slot;
    const widget = findLoraWidgetAt(this, canvasY - this.pos[1]);
    return widget ? { widget, output: { type: "LORA WIDGET" } } : undefined;
  };

  const originalGetSlotMenuOptions = nodeType.prototype.getSlotMenuOptions;
  nodeType.prototype.getSlotMenuOptions = function (slot) {
    if (!slot?.widget?.name?.startsWith("lora_")) {
      return originalGetSlotMenuOptions?.apply(this, arguments);
    }

    const widget = slot.widget;
    showLoraWidgetContextMenu(this, widget, window.rgthree?.lastCanvasMouseEvent);
    return undefined;
  };

  const originalRefreshComboInNode = nodeType.prototype.refreshComboInNode;
  nodeType.prototype.refreshComboInNode = function () {
    loraNamesPromise = null;
    return originalRefreshComboInNode?.apply(this, arguments);
  };
}

app.registerExtension({
  name: "ComfyUI-Astral-Manage.LoRAStackLoader",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === NODE_TYPE) {
      addAstralNodeMethods(nodeType);
    }
  },
});
