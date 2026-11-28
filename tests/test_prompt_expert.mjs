import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { nextPromptExpertSize } from "../web/prompt_expert_size.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(
  path.join(packageRoot, "web", "prompt_expert.js"),
  "utf8",
);
const css = readFileSync(
  path.join(packageRoot, "web", "prompt_expert.css"),
  "utf8",
);

assert.match(source, /const NODE_TYPE = "Prompt Processor"/);
assert.match(source, /const CONTROL_MIN_WIDTH = 260/);
assert.match(source, /typeof node\.addDOMWidget !== "function"/);
assert.match(source, /const SECTION_DEFAULTS = Object\.freeze\(\{\s*api: false,\s*llm: false,\s*chat: true,?\s*\}\)/s);
assert.match(source, /node\.properties\.promptExpertSections/);
assert.match(source, /function storeSections\(node, sections\)/);
assert.match(source, /const HIDDEN_WIDGETS = \[[\s\S]*"prompt_text"[\s\S]*"chat_history"[\s\S]*"api_profiles"[\s\S]*"local_model"[\s\S]*\];/);
assert.doesNotMatch(source, /"api_base"|"api_key"|"api_model"/);
assert.doesNotMatch(source, /hideWidget\(widgets\.(mode|multi_turn|seed)\)/);
assert.match(source, /const PROFILE_LIMIT = 5/);
assert.match(source, /function parseProfiles\(raw\)/);
assert.match(source, /function serializeProfiles\(profiles\)/);
assert.match(source, /\/assets-astral\/prompt-expert\/models/);
assert.match(source, /const chatReady = \(\) => skillLinked\(\) && multiTurnOn\(\)/);
assert.match(source, /Connect a Skill loader to the skill input to start chatting\./);
assert.match(source, /Enable Multi-turn to start chatting\./);
assert.match(source, /send\.disabled = !ready \|\| state\.sending/);
assert.match(source, /"conversations"/);
assert.match(source, /"api_top_p"/);
assert.doesNotMatch(source, /"api_seed"/);
assert.doesNotMatch(source, /local_preserve_thinking/);
assert.match(source, /"api_history_rounds"/);
assert.match(source, /const apiResponseFormat = makeSelect/);
assert.match(source, /function parseConversations\(raw, fallback\)/);
assert.match(source, /const renderSessions = \(\) =>/);
assert.match(source, /const newConversation = \(\) =>/);
assert.match(source, /const deleteConversation = \(\) =>/);
assert.match(source, /const deleteMessage = \(message\) =>/);
assert.match(source, /function formatMessageTime\(value\)/);
assert.match(source, /async function copyToClipboard\(text\)/);
assert.match(source, /const FIELD_HELP = Object\.freeze\(/);
assert.match(source, /wrapper\.title = title/);
assert.match(source, /button\.addEventListener\("dblclick"/);
assert.match(source, /astral-pe-session-rename/);
assert.match(source, /const startRenamingSession = \(index, button, titleElement\) =>/);
assert.match(source, /input\.focus\(\)/);
assert.doesNotMatch(source, /showAstralPrompt/);
assert.match(source, /titleManual/);
assert.match(source, /const applyPanelLayout = \(\) =>/);
assert.match(source, /root\.style\.height = "auto"/);
assert.match(source, /root\.style\.height = `\$\{target\}px`/);
assert.match(source, /maxHeight: 100000/);
assert.match(source, /const base = Math\.max\(40, currentHeight - allocated\)/);
assert.match(source, /const minimumWidth = Math\.max\(\s*CONTROL_MIN_WIDTH,\s*Number\(computed\?\.\[0\]\) \|\| 0,?\s*\)/s);
assert.match(source, /const height = Math\.max\(minimumHeight, currentHeight\)/);
assert.match(source, /for \(const delay of \[180, 400, 900\]\)/);
assert.match(source, /fitControlHeight\(true\)/);
assert.match(source, /const wrappedDrawForeground = function \(ctx\)/);
assert.match(source, /restore\("onDrawForeground", originalDrawForeground, wrappedDrawForeground\)/);
assert.match(source, /const TEXT_PORTS = Object\.freeze\(\{[\s\S]*systemPrompt: "system_prompt"[\s\S]*skill: "skill"[\s\S]*userPrompt: "user_prompt"[\s\S]*\}\)/);
assert.match(source, /const portLinked = \(name\) =>/);
assert.match(source, /const syncPortState = \(\) =>/);
assert.match(source, /input\.disabled = !ready \|\| linkedPrompt/);
assert.doesNotMatch(source, /widgets\.expand_rule|widgets\.invert_rule|widgets\.user_prompt/);
assert.doesNotMatch(source, /expandRule|invertRule|Rules and Skills|operation/);
assert.match(source, /function syncWidget\(node, widget, value\)/);
assert.match(source, /registerLocalizationRoot\(root\)/);
assert.match(source, /unregisterLocalizationRoot\(root\)/);
assert.match(source, /nextPromptExpertSize\(\{/);
assert.match(source, /force: true/);
assert.match(source, /astral-pe-widget-shell/);
assert.match(source, /async function buildScopedPrompt\(node\)/);
assert.match(source, /api\.queuePrompt\(0, prompt\)/);
assert.match(source, /chat_history/);
assert.match(source, /report\b/);
assert.doesNotMatch(source, /window\.prompt\(/);
assert.doesNotMatch(source, /\.showModal\(/);
assert.doesNotMatch(source, /createElement\(\s*["']dialog["']/);
assert.doesNotMatch(source, /localStorage/);

assert.match(
  css,
  /\.astral-pe \{[^}]*pointer-events: none;/s,
);
assert.match(
  css,
  /\.astral-pe :is\(button, select, input, textarea, label, a, \[role="button"\]\) \{\s*pointer-events: auto;/,
);
assert.match(css, /\.astral-pe \[hidden\] \{\s*display: none !important;/);
assert.match(css, /\.astral-pe-field \{\s*display: flex;\s*flex: 0 0 auto;/);
assert.match(css, /\.astral-pe-messages \{[^}]*min-height: 160px;[^}]*overflow-y: auto;/s);
assert.match(css, /\.astral-pe-section\[data-section="chat"\] \{[^}]*flex: 1 1 auto;/s);
assert.doesNotMatch(css, /var\(--comfy-input-bg/);
assert.match(css, /\.astral-pe \{[^}]*background: #202327;/s);
assert.match(css, /\.astral-pe-section \{[^}]*background: #262b31;/s);
assert.match(css, /\.astral-pe-row \.astral-pe-button \{[^}]*white-space: nowrap;/s);
assert.match(css, /\.astral-pe-compose \{[^}]*display: flex;/s);
assert.match(css, /\.astral-pe-sessions \{[^}]*width: 132px;/s);
assert.match(css, /\.astral-pe-msg-time \{/);
assert.match(css, /\.astral-pe-msg-action \{/);

assert.deepEqual(nextPromptExpertSize({ content: 600 }), [420, 600]);
assert.deepEqual(
  nextPromptExpertSize({ content: 300, user: [500, 900], force: true }),
  [500, 300],
);
assert.deepEqual(
  nextPromptExpertSize({ content: 300, user: [500, 900] }),
  [500, 900],
);
assert.deepEqual(
  nextPromptExpertSize({ content: 1000, user: [500, 900] }),
  [500, 1000],
);
assert.deepEqual(
  nextPromptExpertSize({ content: 10.2, currentWidth: 640.4 }),
  [641, 11],
);

console.log("Prompt Processor frontend checks passed.");
