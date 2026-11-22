import { app } from "../../scripts/app.js";

const MODE = 1001;
const MODE_TEXT = "直角曲线";
const RADIUS = 5;
const PORT_STUB = 10 + RADIUS;
const CLEARANCE = 20;
const CHANNEL_STEP = 10;
const CHANNEL_TOLERANCE = 8;
const MAX_DETOUR = 220;

const frameChannels = new Map();
let frameRects = [];
let frameRectsReady = false;
const state = { patched: false, option: false };

function isActive() {
  return Number(app.canvas?.links_render_mode) === MODE;
}

function collectNodeRects() {
  const graph = app.canvas?.graph || app.graph;
  const nodes = graph?._nodes || [];
  const title = Number(window.LiteGraph?.NODE_TITLE_HEIGHT) || 30;
  const rects = [];
  for (const node of nodes) {
    if (!node || node.flags?.collapsed) continue;
    const width = Number(node.size?.[0]) || 0;
    const height = Number(node.size?.[1]) || 0;
    if (width <= 0 || height <= 0) continue;
    rects.push({
      id: String(node.id),
      x1: node.pos[0] - CLEARANCE,
      y1: node.pos[1] - title - CLEARANCE,
      x2: node.pos[0] + width + CLEARANCE,
      y2: node.pos[1] + height + CLEARANCE,
    });
  }
  return rects;
}

function resetFrameLanes() {
  frameChannels.clear();
  frameRects = collectNodeRects();
  frameRectsReady = true;
}

function segmentHitsRect(x1, y1, x2, y2, rect) {
  if (Math.abs(x1 - x2) < 0.01) {
    return (
      x1 > rect.x1 &&
      x1 < rect.x2 &&
      Math.max(y1, y2) > rect.y1 &&
      Math.min(y1, y2) < rect.y2
    );
  }
  if (Math.abs(y1 - y2) < 0.01) {
    return (
      y1 > rect.y1 &&
      y1 < rect.y2 &&
      Math.max(x1, x2) > rect.x1 &&
      Math.min(x1, x2) < rect.x2
    );
  }
  return false;
}

function countNodeHits(pts, rects) {
  let hits = 0;
  for (const rect of rects) {
    for (let i = 1; i < pts.length; i++) {
      if (
        segmentHitsRect(
          pts[i - 1][0],
          pts[i - 1][1],
          pts[i][0],
          pts[i][1],
          rect,
        )
      ) {
        hits++;
        break;
      }
    }
  }
  return hits;
}

function countChannelHits(pts, channels) {
  let hits = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1];
    const [x2, y2] = pts[i];
    if (Math.abs(x1 - x2) > 0.01) continue;
    const ranges = channels.get(Math.round(x1 / CHANNEL_TOLERANCE));
    if (!ranges) continue;
    const low = Math.min(y1, y2);
    const high = Math.max(y1, y2);
    for (const range of ranges) {
      if (high > range[0] + 0.5 && low < range[1] - 0.5) {
        hits++;
        break;
      }
    }
  }
  return hits;
}

function registerChannels(pts, channels) {
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1];
    const [x2, y2] = pts[i];
    if (Math.abs(x1 - x2) > 0.01) continue;
    const key = Math.round(x1 / CHANNEL_TOLERANCE);
    let ranges = channels.get(key);
    if (!ranges) {
      ranges = [];
      channels.set(key, ranges);
    }
    ranges.push([Math.min(y1, y2), Math.max(y1, y2)]);
  }
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

function buildRoute(linkData) {
  if (linkData.startDirection !== "right" || linkData.endDirection !== "left") {
    return null;
  }

  const s = linkData.startPoint;
  const e = linkData.endPoint;

  if (Math.abs(e.y - s.y) <= 10 && e.x - s.x >= 10) {
    const pts = dedupe([
      [s.x, s.y],
      [e.x, e.y],
    ]);
    return pts.length < 2 ? null : { pts, measure: measure(pts) };
  }

  if (!frameRectsReady) {
    frameRects = collectNodeRects();
    frameRectsReady = true;
  }

  const graph = app.canvas?.graph || app.graph;
  const rawId = linkData.id;
  const link =
    graph?.getLink?.(rawId) || graph?.getLink?.(Number(rawId)) || null;
  const excluded = new Set();
  if (link) {
    excluded.add(String(link.origin_id));
    excluded.add(String(link.target_id));
  }

  const minX = Math.min(s.x, e.x) - MAX_DETOUR;
  const maxX = Math.max(s.x, e.x) + MAX_DETOUR;
  const minY = Math.min(s.y, e.y) - MAX_DETOUR;
  const maxY = Math.max(s.y, e.y) + MAX_DETOUR;
  const relevant = frameRects.filter(
    (rect) =>
      !excluded.has(rect.id) &&
      rect.x2 >= minX &&
      rect.x1 <= maxX &&
      rect.y2 >= minY &&
      rect.y1 <= maxY,
  );

  const makePoints = (midX) =>
    dedupe([
      [s.x, s.y],
      [midX, s.y],
      [midX, e.y],
      [e.x, e.y],
    ]);

  const scorePoints = (pts) => {
    const nodeHits = countNodeHits(pts, relevant);
    const channelHits = countChannelHits(pts, frameChannels);
    return { pts, score: nodeHits * 1000 + channelHits * 10000 };
  };

  const forward = e.x - s.x >= PORT_STUB * 2;
  let best = null;

  if (forward) {
    const startX = s.x + PORT_STUB;
    const endX = e.x - PORT_STUB;
    for (let midX = startX; midX <= endX + 0.01; midX += CHANNEL_STEP) {
      const candidate = scorePoints(makePoints(midX));
      if (!best || candidate.score < best.score) best = candidate;
      if (candidate.score === 0) break;
    }
    if (
      best &&
      best.score > 0 &&
      Math.abs((endX - startX) % CHANNEL_STEP) > 0.01
    ) {
      const candidate = scorePoints(makePoints(endX));
      if (candidate.score < best.score) best = candidate;
    }
  } else {
    // Backward or too-short forward: loop around so the input is entered
    // from the left, with a horizontal final segment into the port.
    const rightX = Math.max(s.x, e.x) + PORT_STUB;
    const leftX = e.x - PORT_STUB;
    const high = Math.min(s.y, e.y);
    const low = Math.max(s.y, e.y);
    const detourYs = [];
    for (const ratio of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      detourYs.push(s.y + (e.y - s.y) * ratio);
    }
    for (const offset of [70, 110, 150, 200, 260]) {
      detourYs.push(high - offset, low + offset);
    }
    for (const detourY of detourYs) {
      const pts = dedupe([
        [s.x, s.y],
        [rightX, s.y],
        [rightX, detourY],
        [leftX, detourY],
        [leftX, e.y],
        [e.x, e.y],
      ]);
      const candidate = scorePoints(pts);
      const crossesSource =
        leftX > Math.min(s.x, rightX) &&
        leftX < Math.max(s.x, rightX) &&
        s.y > Math.min(detourY, e.y) &&
        s.y < Math.max(detourY, e.y);
      const score = candidate.score + (crossesSource ? 500 : 0);
      if (!best || score < best.score) {
        best = { pts: candidate.pts, score };
      }
      if (score === 0) break;
    }
  }
  if (!best) return null;

  registerChannels(best.pts, frameChannels);
  return { pts: best.pts, measure: measure(best.pts) };
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
