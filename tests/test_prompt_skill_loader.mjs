import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(
  path.join(packageRoot, "web", "prompt_skill_loader.js"),
  "utf8",
);
const css = readFileSync(
  path.join(packageRoot, "web", "prompt_skill_loader.css"),
  "utf8",
);

assert.match(source, /const NODE_TYPE = "Prompt Skill Loader"/);
assert.match(source, /typeof node\.addDOMWidget !== "function"/);
assert.match(source, /const MAX_SKILL_BYTES = 4 \* 1024 \* 1024/);
assert.match(source, /accept = "\.md,\.txt,text\/markdown,text\/plain"/);
assert.match(source, /widgetByName\(node, "skill_path"\)/);
assert.match(source, /widgetByName\(node, "inline_content"\)/);
assert.match(source, /function syncWidget\(node, widget, value\)/);
assert.match(source, /registerLocalizationRoot\(root\)/);
assert.match(source, /unregisterLocalizationRoot\(root\)/);
assert.match(source, /Load Skill file/);
assert.match(source, /Clear file/);
assert.match(source, /createElement\("div", "astral-sl-actions"\)/);
assert.match(source, /const currentSignature = \(\) =>/);
assert.match(source, /const wrappedDraw = function \(ctx\)/);
assert.match(source, /lastSignature = signature/);
assert.match(source, /Choose a \.md or \.txt file\./);
assert.match(source, /Skill file must be 4 MB or smaller\./);
assert.doesNotMatch(source, /window\.prompt\(/);
assert.doesNotMatch(source, /\.showModal\(/);

assert.match(css, /\.astral-sl \{[^}]*pointer-events: none;/s);
assert.match(
  css,
  /\.astral-sl :is\(button, input, label\) \{\s*pointer-events: auto;/,
);
assert.match(css, /\.astral-sl-file \{\s*display: none;/);
assert.match(css, /\.astral-sl \{[^}]*flex-direction: column;/s);
assert.match(css, /\.astral-sl-actions \{[^}]*display: flex;/s);
assert.match(css, /\.astral-sl-button \{[^}]*flex: 1 1 0;/s);
assert.match(css, /\.astral-sl-status \{[^}]*text-align: center;/s);

console.log("Prompt Skill Loader frontend checks passed.");
