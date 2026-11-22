import { app } from "../../scripts/app.js";

const MODE = 1001;
const MODE_TEXT = "直角曲线";
const STUB = 12;
const LANE_PITCH = 10;
const RADIUS = 10;

const frameLanes = new Map();
const state = { patched: false, option: false };

function isActive() {
  return Number(app.canvas?.links_render_mode) === MODE;
}

function resetFrameLanes() {
  frameLanes.clear();
}

function dist(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function measure(pts) {
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const length = dist(pts[i - 1], pts[i]);
    seg.push(length);
    total += length;
  }
  return { seg, total };
}

function dedupe(pts) {
  const out = [];
  for (const point of pts) {
    const previous = out[out.length - 1];
    if (previous && Math.abs(previous[0] - point[0]) < 0.5 && Math.abs(previous[1] - point[1]) < 0.5) {
      continue;
    }
    out.push(point);
  }
  return out;
}

function laneFor(linkData, orientation) {
  const s = linkData.startPoint;
  const e = linkData.endPoint;
  const key =
    orientation === "horizontal"
      ? `H|${Math.round(s.y / 8)}`
      : `V|${Math.round(s.x / 8)}|${Math.round(e.x / 8)}`;
  let group = frameLanes.get(key);
  if (!group) {
    group = new Map();
    frameLanes.set(key, group);
  }
  const id = String(linkData.id);
  if (!group.has(id)) group.set(id, group.size);
  const index = group.get(id);
  const step = Math.ceil(index / 2);
  return (index % 2 ? -step : step) * LANE_PITCH;
}

function buildRoute(linkData) {
  if (linkData.startDirection !== "right" || linkData.endDirection !== "left") {
    return null;
  }

  const s = linkData.startPoint;
  const e = linkData.endPoint;
  const ax = s.x + STUB;
  const bx = e.x - STUB;

  const horizontal =
    e.x - s.x > 0 &&
    Math.abs(e.x - s.x) >= Math.abs(e.y - s.y) * 1.5;

  let pts;
  if (horizontal) {
    const lane = laneFor(linkData, "horizontal");
    const laneY = s.y + lane;
    pts = dedupe([
      [s.x, s.y],
      [ax, s.y],
      [ax, laneY],
      [bx, laneY],
      [bx, e.y],
      [e.x, e.y],
    ]);
  } else {
    const lane = laneFor(linkData, "vertical");
    let midX;
    if (bx - ax >= 16) {
      midX = (ax + bx) / 2 + lane;
      const low = Math.min(ax, bx) + 4;
      const high = Math.max(ax, bx) - 4;
      if (low < high) midX = Math.max(low, Math.min(high, midX));
    } else {
      midX = Math.max(ax, bx) + STUB + Math.abs(lane);
    }
    pts = dedupe([
      [s.x, s.y],
      [ax, s.y],
      [midX, s.y],
      [midX, e.y],
      [bx, e.y],
      [e.x, e.y],
    ]);
  }
  if (pts.length < 2) return null;
  return { pts, measure: measure(pts) };
}

function emitRounded(path, pts) {
  path.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const previous = pts[i - 1];
    const corner = pts[i];
    const next = pts[i + 1];
    const radius = Math.min(
      RADIUS,
      dist(previous, corner) / 3,
      dist(corner, next) / 3,
    );
    path.arcTo(
      corner[0],
      corner[1],
      next[0],
      next[1],
      Math.max(0.5, radius),
    );
  }
  const last = pts[pts.length - 1];
  path.lineTo(last[0], last[1]);
}

function pointAt(pts, measured, t) {
  let target = Math.max(0, Math.min(1, t)) * measured.total;
  for (let i = 0; i < measured.seg.length; i++) {
    if (target <= measured.seg[i] || i === measured.seg.length - 1) {
      const f = measured.seg[i] > 0 ? target / measured.seg[i] : 0;
      const a = pts[i];
      const b = pts[i + 1];
      return {
        x: a[0] + (b[0] - a[0]) * f,
        y: a[1] + (b[1] - a[1]) * f,
        angle: Math.atan2(b[1] - a[1], b[0] - a[0]),
      };
    }
    target -= measured.seg[i];
  }
  const last = pts[pts.length - 1];
  return { x: last[0], y: last[1], angle: 0 };
}

function applyCenter(linkData, route) {
  const { pts, measure: measured } = route;
  let best = 0;
  let bestLength = -1;
  for (let i = 0; i < measured.seg.length; i++) {
    if (measured.seg[i] > bestLength) {
      bestLength = measured.seg[i];
      best = i;
    }
  }
  const a = pts[best];
  const b = pts[best + 1] || pts[best];
  linkData.centerPos = {
    x: (a[0] + b[0]) / 2,
    y: (a[1] + b[1]) / 2,
  };
  linkData.centerAngle = Math.atan2(b[1] - a[1], b[0] - a[0]);
}

function withCoreLinkRenderer(callback) {
  const state = document.getElementById("ct-panel")?.__ct_state;
  if (!state) return callback();

  const saved = {
    hoverOnly: state.hoverOnly,
    chainColorEnabled: state.chainColorEnabled,
    effectsEnabled: state.effectsEnabled,
    linkIconEnabled: state.linkIconEnabled,
    lineStyleGlobal: state.lineStyleGlobal,
  };
  state.hoverOnly = false;
  state.chainColorEnabled = false;
  state.effectsEnabled = false;
  state.linkIconEnabled = false;
  state.lineStyleGlobal = "auto";
  try {
    return callback();
  } finally {
    Object.assign(state, saved);
  }
}

function installPatches() {
  const canvas = app.canvas;
  if (!canvas?.linkRenderer?.pathRenderer) return false;

  const rendererProto = Object.getPrototypeOf(canvas.linkRenderer.pathRenderer);
  if (rendererProto.__astralRoundedInstalled) {
    state.patched = true;
    return true;
  }
  rendererProto.__astralRoundedInstalled = true;

  const originalDrawLink = rendererProto.drawLink;
  rendererProto.drawLink = function (ctx, linkData, context) {
    linkData.__astralRounded = null;
    if (
      isActive() &&
      linkData.id !== "temp" &&
      linkData.id !== "dragging"
    ) {
      try {
        linkData.__astralRounded = buildRoute(linkData);
      } catch (error) {
        console.warn("[Astral-Manage] 直角曲线路径计算失败", error);
      }
    }
    return originalDrawLink.call(this, ctx, linkData, context);
  };

  const originalDrawLinkPath = rendererProto.drawLinkPath;
  rendererProto.drawLinkPath = function (
    ctx,
    path,
    linkData,
    context,
    lineWidth,
    color,
  ) {
    if (!linkData.__astralRounded) {
      return originalDrawLinkPath.call(
        this,
        ctx,
        path,
        linkData,
        context,
        lineWidth,
        color,
      );
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = "round";
    emitRounded(path, linkData.__astralRounded.pts);
    ctx.stroke(path);
  };

  const originalCenter = rendererProto.calculateCenterPoint;
  rendererProto.calculateCenterPoint = function (linkData, context) {
    if (linkData.__astralRounded) {
      applyCenter(linkData, linkData.__astralRounded);
      return;
    }
    return originalCenter.call(this, linkData, context);
  };

  const originalPoint = rendererProto.computeConnectionPoint;
  rendererProto.computeConnectionPoint = function (linkData, t, context) {
    if (linkData.__astralRounded) {
      return pointAt(
        linkData.__astralRounded.pts,
        linkData.__astralRounded.measure,
        t,
      );
    }
    return originalPoint.call(this, linkData, t, context);
  };

  const canvasProto = canvas.constructor.prototype;
  const originalDrawConnections = canvasProto.drawConnections;
  canvasProto.drawConnections = function (ctx, ...args) {
    if (this === app.canvas && isActive()) {
      resetFrameLanes();
      return withCoreLinkRenderer(() =>
        originalDrawConnections.call(this, ctx, ...args),
      );
    }
    return originalDrawConnections.call(this, ctx, ...args);
  };

  state.patched = true;
  return true;
}

function installOption() {
  const vueApp =
    document.querySelector("#vue-app")?.__vue_app__ ??
    document.querySelector("#app")?.__vue_app__;
  const pinia = vueApp?.config?.globalProperties?.$pinia;
  if (!pinia?._s) return false;

  for (const [, store] of pinia._s) {
    const bag = store.settingsById ?? store.settings;
    const definition =
      bag?.["Comfy.LinkRenderMode"] ?? bag?.get?.("Comfy.LinkRenderMode");
    if (!definition || !Array.isArray(definition.options)) continue;
    if (!definition.options.some((option) => Number(option.value) === MODE)) {
      definition.options.push({ value: MODE, text: MODE_TEXT });
    }
    state.option = true;
    return true;
  }
  return false;
}

app.registerExtension({
  name: "ComfyUI-Astral-Manage.RoundedLinkMode",
  setup() {
    let tries = 0;
    const timer = setInterval(() => {
      if (!state.patched) installPatches();
      if (!state.option) installOption();
      if (state.patched && state.option) {
        clearInterval(timer);
        return;
      }
      if (++tries > 120) clearInterval(timer);
    }, 250);
  },
});
