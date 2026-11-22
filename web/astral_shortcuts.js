export const ASSET_MANAGER_SHORTCUT_STORAGE_KEY =
  "assets-astral.asset-manager-shortcut";

export const DEFAULT_ASSET_MANAGER_SHORTCUT = Object.freeze({
  code: "KeyM",
  ctrl: true,
  alt: true,
  shift: false,
  meta: false,
});

const MODIFIER_CODES = new Set([
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
]);

const LOCK_CODES = new Set([
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "ContextMenu",
  "Pause",
  "PrintScreen",
]);

const SUPPORTED_CODE_PATTERN =
  /^(?:Key[A-Z]|Digit[0-9]|Numpad[0-9]|F(?:[1-9]|1[0-2])|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Insert|Delete|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;

const BROWSER_CTRL_CODES = new Set([
  "KeyA",
  "KeyB",
  "KeyC",
  "KeyD",
  "KeyE",
  "KeyF",
  "KeyG",
  "KeyH",
  "KeyI",
  "KeyJ",
  "KeyK",
  "KeyL",
  "KeyM",
  "KeyN",
  "KeyO",
  "KeyP",
  "KeyQ",
  "KeyR",
  "KeyS",
  "KeyT",
  "KeyU",
  "KeyV",
  "KeyW",
  "KeyX",
  "KeyY",
  "KeyZ",
  "Digit0",
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "Numpad0",
  "Numpad1",
  "Numpad2",
  "Numpad3",
  "Numpad4",
  "Numpad5",
  "Numpad6",
  "Numpad7",
  "Numpad8",
  "Numpad9",
  "Tab",
  "PageUp",
  "PageDown",
  "Equal",
  "Minus",
]);

const BROWSER_CTRL_SHIFT_CODES = new Set([
  "KeyB",
  "KeyC",
  "KeyI",
  "KeyJ",
  "KeyK",
  "KeyN",
  "KeyO",
  "KeyP",
  "KeyT",
  "KeyW",
  "Delete",
]);

const COMFYUI_RESERVED_SHORTCUTS = Object.freeze([
  { code: "Enter", ctrl: true },
  { code: "Enter", ctrl: true, shift: true },
  { code: "Enter", ctrl: true, alt: true },
  { code: "KeyR" },
  { code: "KeyW" },
  { code: "KeyN" },
  { code: "KeyM" },
  { code: "KeyA" },
  { code: "KeyM", alt: true },
  { code: "KeyS", ctrl: true },
  { code: "KeyO", ctrl: true },
  { code: "KeyG", ctrl: true },
  { code: "Comma", ctrl: true },
  { code: "Equal", alt: true },
  { code: "Equal", alt: true, shift: true },
  { code: "Minus", alt: true },
  { code: "KeyC", alt: true },
  { code: "KeyB", ctrl: true },
  { code: "KeyM", ctrl: true },
  { code: "Backquote", ctrl: true },
  { code: "KeyE", ctrl: true, shift: true },
  { code: "KeyM", alt: true, shift: true },
  { code: "KeyK", ctrl: true, shift: true },
  { code: "KeyA", ctrl: true },
  { code: "KeyV", ctrl: true, shift: true },
]);

const KEY_LABELS = Object.freeze({
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Delete: "Delete",
  End: "End",
  Equal: "=",
  Home: "Home",
  Insert: "Insert",
  Minus: "-",
  PageDown: "Page Down",
  PageUp: "Page Up",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
});

function codeLabel(code) {
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Num ${code.slice(6)}`;
  return code;
}

export function normalizeShortcut(value) {
  if (!value || typeof value !== "object") return null;
  const code = String(value.code || "");
  if (!code) return null;
  return {
    code,
    ctrl: Boolean(value.ctrl),
    alt: Boolean(value.alt),
    shift: Boolean(value.shift),
    meta: Boolean(value.meta),
  };
}

export function shortcutFromKeyboardEvent(event) {
  if (
    !event ||
    !event.code ||
    event.repeat ||
    event.isComposing ||
    MODIFIER_CODES.has(event.code)
  ) {
    return null;
  }
  return normalizeShortcut({
    code: event.code,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  });
}

export function shortcutsEqual(left, right) {
  const normalizedLeft = normalizeShortcut(left);
  const normalizedRight = normalizeShortcut(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return (
    normalizedLeft.code === normalizedRight.code &&
    normalizedLeft.ctrl === normalizedRight.ctrl &&
    normalizedLeft.alt === normalizedRight.alt &&
    normalizedLeft.shift === normalizedRight.shift &&
    normalizedLeft.meta === normalizedRight.meta
  );
}

export function formatShortcut(value) {
  const shortcut = normalizeShortcut(value);
  if (!shortcut) return "";
  const parts = [];
  if (shortcut.ctrl) parts.push("Ctrl");
  if (shortcut.alt) parts.push("Alt");
  if (shortcut.shift) parts.push("Shift");
  if (shortcut.meta) parts.push("Meta");
  parts.push(codeLabel(shortcut.code));
  return parts.join(" + ");
}

export function validateAssetManagerShortcut(value) {
  const shortcut = normalizeShortcut(value);
  if (!shortcut) return "请按下一个有效的组合键。";
  if (!SUPPORTED_CODE_PATTERN.test(shortcut.code) || LOCK_CODES.has(shortcut.code)) {
    return "请使用字母、数字或功能键，不要使用 Tab、Enter、Esc 或系统锁定键。";
  }
  if (shortcut.meta) {
    return "Windows 键组合会与系统快捷键冲突，请改用 Ctrl 或 Alt。";
  }
  if (!shortcut.ctrl && !shortcut.alt) {
    return "快捷键必须至少包含 Ctrl 或 Alt。";
  }
  if (
    COMFYUI_RESERVED_SHORTCUTS.some((reserved) =>
      shortcutsEqual(shortcut, reserved),
    )
  ) {
    return "该组合会被 ComfyUI 快捷键占用，请换一组。";
  }
  if (
    ["F5", "F11", "F12"].includes(shortcut.code) ||
    (shortcut.alt &&
      !shortcut.ctrl &&
      !shortcut.meta &&
      ["Tab", "F4"].includes(shortcut.code)) ||
    (shortcut.ctrl &&
      shortcut.shift &&
      !shortcut.alt &&
      shortcut.code === "Escape") ||
    (shortcut.ctrl &&
      shortcut.alt &&
      shortcut.code === "Delete")
  ) {
    return "该组合会与浏览器或操作系统快捷键冲突，请换一组。";
  }
  if (
    shortcut.ctrl &&
    !shortcut.alt &&
    !shortcut.meta &&
    !shortcut.shift &&
    BROWSER_CTRL_CODES.has(shortcut.code)
  ) {
    return "该组合会被浏览器或编辑器占用，请换一组。";
  }
  if (
    shortcut.ctrl &&
    shortcut.shift &&
    !shortcut.alt &&
    !shortcut.meta &&
    BROWSER_CTRL_SHIFT_CODES.has(shortcut.code)
  ) {
    return "该组合会被浏览器或编辑器占用，请换一组。";
  }
  if (
    shortcut.alt &&
    !shortcut.ctrl &&
    ["ArrowLeft", "ArrowRight", "Home"].includes(shortcut.code)
  ) {
    return "该组合会被浏览器导航占用，请换一组。";
  }
  return "";
}

export function matchesShortcut(event, value) {
  const shortcut = normalizeShortcut(value);
  if (
    !shortcut ||
    !event ||
    event.repeat ||
    event.isComposing ||
    event.getModifierState?.("AltGraph") ||
    event.code !== shortcut.code
  ) {
    return false;
  }
  return (
    Boolean(event.ctrlKey) === shortcut.ctrl &&
    Boolean(event.altKey) === shortcut.alt &&
    Boolean(event.shiftKey) === shortcut.shift &&
    Boolean(event.metaKey) === shortcut.meta
  );
}

function shortcutStorage(storage) {
  if (storage) return storage;
  try {
    return globalThis.window?.localStorage || null;
  } catch {
    return null;
  }
}

export function readAssetManagerShortcut(storage = null) {
  const target = shortcutStorage(storage);
  if (!target) return { ...DEFAULT_ASSET_MANAGER_SHORTCUT };
  try {
    const parsed = JSON.parse(
      target.getItem(ASSET_MANAGER_SHORTCUT_STORAGE_KEY) || "null",
    );
    const shortcut = normalizeShortcut(parsed);
    if (shortcut && !validateAssetManagerShortcut(shortcut)) return shortcut;
  } catch {
    // Fall back to the recommended shortcut when the stored value is invalid.
  }
  return { ...DEFAULT_ASSET_MANAGER_SHORTCUT };
}

export function saveAssetManagerShortcut(value, storage = null) {
  const shortcut = normalizeShortcut(value);
  if (!shortcut || validateAssetManagerShortcut(shortcut)) return false;
  const target = shortcutStorage(storage);
  if (!target) return false;
  try {
    target.setItem(ASSET_MANAGER_SHORTCUT_STORAGE_KEY, JSON.stringify(shortcut));
    return true;
  } catch {
    return false;
  }
}
