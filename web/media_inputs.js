export const MEDIA_INPUT_LIMITS = Object.freeze({
  image: 9,
  video: 3,
  audio: 3,
});

export const MEDIA_INPUT_TYPES = Object.freeze({
  image: "IMAGE",
  video: "VIDEO",
  audio: "AUDIO",
});

const MEDIA_INPUT_RE = /^(image|video|audio)(?:_(\d+))?$/i;

export function parseMediaInput(input) {
  const name =
    typeof input === "string" ? input : String(input?.name || "");
  const match = name.match(MEDIA_INPUT_RE);
  if (!match) return null;
  const kind = match[1].toLowerCase();
  const index = match[2] == null ? 1 : Number(match[2]);
  const limit = MEDIA_INPUT_LIMITS[kind];
  if (
    !Number.isInteger(index) ||
    index < 1 ||
    index > limit
  ) {
    return null;
  }
  return { kind, index, name };
}

export function mediaInputName(kind, index) {
  return index === 1 ? kind : `${kind}_${index}`;
}

export function mediaInputLabel(kind, index) {
  return `${kind}${index}`;
}

export function isMediaInputConnected(input, slot = null, node = null) {
  if (!parseMediaInput(input)) return false;
  if (node && Number.isInteger(slot)) {
    if (typeof node.isInputConnected === "function") {
      return node.isInputConnected(slot);
    }
    try {
      return node.getInputLink?.(slot) != null;
    } catch {
      return false;
    }
  }
  return input?.link != null;
}

export function desiredMediaInputCount(
  inputs,
  kind,
  isConnected = (input) => input?.link != null,
) {
  const limit = MEDIA_INPUT_LIMITS[kind];
  if (!limit) return 0;
  let highestConnected = 0;
  for (const [slot, input] of (inputs || []).entries()) {
    const parsed = parseMediaInput(input);
    if (
      parsed?.kind === kind &&
      isConnected(input, slot) &&
      parsed.index > highestConnected
    ) {
      highestConnected = parsed.index;
    }
  }
  return highestConnected === 0
    ? 1
    : Math.min(limit, highestConnected + 1);
}
