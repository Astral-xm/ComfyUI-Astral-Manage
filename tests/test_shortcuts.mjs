import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const modulePath = path.join(packageRoot, "web", "astral_shortcuts.js");
const {
  ASSET_MANAGER_SHORTCUT_STORAGE_KEY,
  DEFAULT_ASSET_MANAGER_SHORTCUT,
  formatShortcut,
  matchesShortcut,
  normalizeShortcut,
  readAssetManagerShortcut,
  saveAssetManagerShortcut,
  shortcutFromKeyboardEvent,
  shortcutsEqual,
  validateAssetManagerShortcut,
} = await import(pathToFileURL(modulePath).href);

assert.deepEqual(DEFAULT_ASSET_MANAGER_SHORTCUT, {
  code: "KeyM",
  ctrl: true,
  alt: true,
  shift: false,
  meta: false,
});
assert.equal(formatShortcut(DEFAULT_ASSET_MANAGER_SHORTCUT), "Ctrl + Alt + M");
assert.equal(
  formatShortcut({
    code: "Digit1",
    ctrl: true,
    alt: false,
    shift: true,
    meta: false,
  }),
  "Ctrl + Shift + 1",
);
assert.deepEqual(
  normalizeShortcut({
    code: "KeyK",
    ctrl: 1,
    alt: 0,
    extra: "ignored",
  }),
  {
    code: "KeyK",
    ctrl: true,
    alt: false,
    shift: false,
    meta: false,
  },
);
assert.equal(normalizeShortcut(null), null);
assert.equal(normalizeShortcut({ ctrl: true }), null);

const shortcutEvent = shortcutFromKeyboardEvent({
  code: "KeyK",
  ctrlKey: true,
  altKey: true,
  shiftKey: false,
  metaKey: false,
});
assert.deepEqual(shortcutEvent, {
  code: "KeyK",
  ctrl: true,
  alt: true,
  shift: false,
  meta: false,
});
assert.equal(
  shortcutFromKeyboardEvent({
    code: "ControlLeft",
    ctrlKey: true,
  }),
  null,
);
assert.equal(
  shortcutFromKeyboardEvent({
    code: "KeyK",
    ctrlKey: true,
    repeat: true,
  }),
  null,
);
assert.equal(
  shortcutFromKeyboardEvent({
    code: "KeyK",
    ctrlKey: true,
    isComposing: true,
  }),
  null,
);

assert.equal(shortcutsEqual(DEFAULT_ASSET_MANAGER_SHORTCUT, shortcutEvent), false);
assert.equal(
  shortcutsEqual(DEFAULT_ASSET_MANAGER_SHORTCUT, {
    code: "KeyM",
    ctrl: true,
    alt: true,
  }),
  true,
);

assert.equal(validateAssetManagerShortcut(DEFAULT_ASSET_MANAGER_SHORTCUT), "");
for (const invalidShortcut of [
  { code: "KeyM" },
  { code: "KeyM", ctrl: true },
  { code: "KeyT", ctrl: true, shift: true },
  { code: "F4", alt: true },
  { code: "F12", ctrl: true },
  { code: "Delete", ctrl: true, alt: true },
  { code: "Escape", ctrl: true, shift: true },
  { code: "KeyM", meta: true },
  { code: "Tab", ctrl: true, alt: true },
  { code: "Enter", ctrl: true, alt: true },
  { code: "CapsLock", ctrl: true, alt: true },
]) {
  assert.notEqual(
    validateAssetManagerShortcut(invalidShortcut),
    "",
    `${formatShortcut(invalidShortcut)} should be rejected`,
  );
}
for (const comfyUiShortcut of [
  { code: "KeyM", alt: true },
  { code: "KeyM", alt: true, shift: true },
  { code: "Comma", ctrl: true },
  { code: "Backquote", ctrl: true },
  { code: "Equal", alt: true },
  { code: "Minus", alt: true },
]) {
  assert.equal(
    validateAssetManagerShortcut(comfyUiShortcut),
    "该组合会被 ComfyUI 快捷键占用，请换一组。",
    `${formatShortcut(comfyUiShortcut)} must not override a ComfyUI shortcut`,
  );
}

const matchingEvent = {
  code: "KeyM",
  ctrlKey: true,
  altKey: true,
  shiftKey: false,
  metaKey: false,
  repeat: false,
  isComposing: false,
  getModifierState: () => false,
};
assert.equal(matchesShortcut(matchingEvent, DEFAULT_ASSET_MANAGER_SHORTCUT), true);
assert.equal(
  matchesShortcut(
    { ...matchingEvent, shiftKey: true },
    DEFAULT_ASSET_MANAGER_SHORTCUT,
  ),
  false,
);
assert.equal(
  matchesShortcut(
    { ...matchingEvent, code: "KeyN" },
    DEFAULT_ASSET_MANAGER_SHORTCUT,
  ),
  false,
);
assert.equal(
  matchesShortcut(
    { ...matchingEvent, repeat: true },
    DEFAULT_ASSET_MANAGER_SHORTCUT,
  ),
  false,
);
assert.equal(
  matchesShortcut(
    {
      ...matchingEvent,
      getModifierState: (name) => name === "AltGraph",
    },
    DEFAULT_ASSET_MANAGER_SHORTCUT,
  ),
  false,
);

function createStorage(initialValue = null) {
  const values = new Map();
  if (initialValue !== null) {
    values.set(ASSET_MANAGER_SHORTCUT_STORAGE_KEY, initialValue);
  }
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    values,
  };
}

const storage = createStorage();
assert.deepEqual(readAssetManagerShortcut(storage), DEFAULT_ASSET_MANAGER_SHORTCUT);
assert.equal(
  saveAssetManagerShortcut(
    {
      code: "KeyK",
      ctrl: true,
      alt: true,
    },
    storage,
  ),
  true,
);
assert.deepEqual(readAssetManagerShortcut(storage), {
  code: "KeyK",
  ctrl: true,
  alt: true,
  shift: false,
  meta: false,
});
assert.equal(
  saveAssetManagerShortcut({ code: "KeyM", ctrl: true }, storage),
  false,
);
assert.deepEqual(readAssetManagerShortcut(storage), {
  code: "KeyK",
  ctrl: true,
  alt: true,
  shift: false,
  meta: false,
});

assert.deepEqual(
  readAssetManagerShortcut(createStorage("{not json")),
  DEFAULT_ASSET_MANAGER_SHORTCUT,
);
assert.deepEqual(
  readAssetManagerShortcut(
    createStorage(JSON.stringify({ code: "KeyM", ctrl: true })),
  ),
  DEFAULT_ASSET_MANAGER_SHORTCUT,
);

const blockedStorage = {
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("blocked");
  },
};
assert.deepEqual(
  readAssetManagerShortcut(blockedStorage),
  DEFAULT_ASSET_MANAGER_SHORTCUT,
);
assert.equal(
  saveAssetManagerShortcut(DEFAULT_ASSET_MANAGER_SHORTCUT, blockedStorage),
  false,
);

console.log("Asset manager shortcut checks passed.");
