import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(packageRoot, "web");
const webFiles = readdirSync(webRoot);
const jsFiles = webFiles.filter((name) => name.endsWith(".js"));
const cssFiles = webFiles.filter((name) => name.endsWith(".css"));
// The Skill loader deliberately offers a local file picker: loading a Skill
// from anywhere on the computer is a product requirement, and a hidden
// <input type="file"> is the only browser API that can do it.
const FILE_INPUT_ALLOWED = new Set(["prompt_skill_loader.js"]);

for (const fileName of jsFiles) {
  const source = readFileSync(path.join(webRoot, fileName), "utf8");
  assert.doesNotMatch(
    source,
    /(?<![.\w$])(?:alert|confirm|prompt)\s*\(/,
    `${fileName} must not use native browser dialogs`,
  );
  assert.doesNotMatch(
    source,
    /(?<!app\.canvas)(?<!canvas)\.(?:alert|confirm|prompt)\s*\(/,
    `${fileName} must not call native browser dialogs through an object`,
  );
  assert.doesNotMatch(
    source,
    /\b(?:showOpenFilePicker|showSaveFilePicker|showDirectoryPicker)\s*\(/,
    `${fileName} must not open native browser file pickers`,
  );
  if (!FILE_INPUT_ALLOWED.has(fileName)) {
    assert.doesNotMatch(
      source,
      /\.type\s*=\s*["']file["']|setAttribute\(\s*["']type["']\s*,\s*["']file["']/,
      `${fileName} must not create native browser file inputs`,
    );
  }
  assert.doesNotMatch(
    source,
    /\bwebkitdirectory\b/i,
    `${fileName} must use the Astral workspace browser`,
  );
}

for (const fileName of cssFiles) {
  const source = readFileSync(path.join(webRoot, fileName), "utf8");
  for (const match of source.matchAll(/([^{}]+::backdrop)\s*\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    const body = match[2];
    assert.match(
      body,
      /background:\s*transparent;/,
      `${fileName} ${selector} must not paint a full-window backdrop`,
    );
    assert.match(
      body,
      /backdrop-filter:\s*none;/,
      `${fileName} ${selector} must not blur the canvas`,
    );
    assert.doesNotMatch(
      body,
      /rgba?\(|#[0-9a-f]{3,8}\b|linear-gradient|radial-gradient/i,
      `${fileName} ${selector} must remain visually transparent`,
    );
  }
}

const mainSource = readFileSync(path.join(webRoot, "asset_manager.js"), "utf8");
const assetManagementSource = readFileSync(
  path.join(webRoot, "asset_management.js"),
  "utf8",
);
const setGetSource = readFileSync(path.join(webRoot, "set_get_groups.js"), "utf8");
const globalDialogSource = readFileSync(
  path.join(webRoot, "astral_dialogs.js"),
  "utf8",
);
assert.match(mainSource, /from "\.\/astral_dialogs\.js"/);
assert.match(assetManagementSource, /app\.canvas\?\.prompt\?\.\(/);
assert.doesNotMatch(assetManagementSource, /showAstralPrompt/);
assert.match(setGetSource, /app\.canvas\?\.prompt/);
assert.match(setGetSource, /prompt\.call\(/);
assert.doesNotMatch(setGetSource, /extensionManager\?\.dialog/);
assert.doesNotMatch(setGetSource, /showAstralPrompt/);
assert.doesNotMatch(
  globalDialogSource,
  /\.showModal\s*\(/,
  "Astral input and confirmation dialogs must not create a native modal backdrop",
);
assert.doesNotMatch(
  globalDialogSource,
  /createElement\(\s*["']dialog["']/,
  "Astral input and confirmation dialogs must use plain DOM overlays",
);
assert.doesNotMatch(
  globalDialogSource,
  /dialog\.(?:show|close)\s*\(/,
  "Astral input and confirmation dialogs must not invoke the native dialog API",
);

console.log("Browser dialog audit passed.");
