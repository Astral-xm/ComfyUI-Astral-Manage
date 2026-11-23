import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(
  path.join(packageRoot, "web", "asset_manager.js"),
  "utf8",
).replace(/\r\n/g, "\n");
const css = readFileSync(path.join(packageRoot, "web", "asset_manager.css"), "utf8");
const dialogSource = readFileSync(
  path.join(packageRoot, "web", "astral_dialogs.js"),
  "utf8",
);
const dialogCss = readFileSync(
  path.join(packageRoot, "web", "astral_dialogs.css"),
  "utf8",
);
const i18nSource = readFileSync(
  path.join(packageRoot, "web", "astral_i18n.js"),
  "utf8",
);
const shortcutSource = readFileSync(
  path.join(packageRoot, "web", "astral_shortcuts.js"),
  "utf8",
);

assert.doesNotMatch(source, /const NODE_TYPE = "Asset Manager"/);
assert.doesNotMatch(source, /Open Asset Manager/);
assert.doesNotMatch(source, /beforeRegisterNodeDef/);
assert.doesNotMatch(source, /registerNodeType\(/);
assert.match(source, /data-assets-astral-menu-button/);
assert.match(source, /function installAstralMenuButton[\s\S]*?ensureStyles\(\);/);
assert.match(source, /const AUTO_LOAD_BOTTOM_THRESHOLD = 96;/);
assert.match(
  source,
  /function installAutoLoadOnScroll\(element, canLoad, loadMore\)[\s\S]*?element\.scrollHeight - element\.scrollTop - element\.clientHeight/,
);
assert.match(
  source,
  /element\.addEventListener\("scroll", onScroll, \{ passive: true \}\)/,
);
assert.match(
  source,
  /\(\) => this\.hasMore && !this\.loading,[\s\S]*?\(\) => void this\.load\(false\)/,
);
assert.equal(
  (
    source.match(
      /installAutoLoadOnScroll\(\s*(?:section|grid|list),/g,
    ) || []
  ).length,
  4,
);
assert.equal(
  (source.match(/this\.hasMore = Boolean\(payload\?\.hasMore\);/g) || [])
    .length,
  3,
);
assert.doesNotMatch(source, /this\.loadMore|astral-am-load-more/);
assert.doesNotMatch(
  source,
  /createElement\(\s*"button",\s*"astral-am-button astral-am-load-more"/,
);
assert.match(source, /button\.textContent = "Assets"/);
assert.match(
  source,
  /response\.headers\.get\("content-type"\) \|\| "Unknown type"/,
);
assert.match(
  source,
  /text\.replace\(\/\\s\+\/g, " "\)\.trim\(\)\.slice\(0, 160\)/,
);
assert.match(
  source,
  /isOpen\(\) \{\s*return Boolean\(this\.backdrop && !this\.backdrop\.hidden\);/,
);
assert.match(
  source,
  /toggle\(tab = this\.activeTab \|\| "prompts"\) \{[\s\S]*?if \(this\.isOpen\(\)\) \{[\s\S]*?this\.close\(\);[\s\S]*?this\.open\(tab\);/,
);
assert.match(
  source,
  /function toggleAssetManager\(\) \{\s*ensureStyles\(\);[\s\S]*?manager \|\|= new AssetManager\(\);[\s\S]*?manager\.toggle\(\);/,
);
assert.match(
  source,
  /button\.addEventListener\("click", \(\) => \{\s*toggleAssetManager\(\);\s*button\.blur\(\);\s*\}\);/,
);
assert.match(
  source,
  /close\(\) \{[\s\S]*?this\.backdrop\.hidden = true;[\s\S]*?\n  \}/,
);
assert.doesNotMatch(source, /assets\/astral-star\.svg/);
assert.doesNotMatch(source, /createElement\([^)]*"Astral Asset Manager"\)/);
assert.match(source, /"Astral星芒"/);
assert.match(source, /authorLink\.href = "https:\/\/space\.bilibili\.com\/176339505"/);
assert.match(source, /"Download updates"/);
assert.doesNotMatch(source, /astral-am-heading-star-icon/);
assert.match(source, /starLink\.href = "https:\/\/pan\.quark\.cn\/s\/7626ec1f29c7"/);
assert.match(
  source,
  /const starControl = createElement\("span", "astral-am-heading-star-control"\);\s*starControl\.append\(starLink, this\.languageToggleButton\);\s*headingLinks\.append\(\s*authorLink,\s*createElement\("span", "astral-am-heading-divider", "·"\),\s*starControl,?\s*\)/,
);
assert.match(
  source,
  /from "\.\/astral_i18n\.js";/,
);
assert.match(
  source,
  /this\.languageToggleButton = createElement\(\s*"button",\s*"astral-am-language-toggle",?\s*\)/,
);
assert.match(source, /"astral-am-language-option",\s*"中"/);
assert.match(source, /"astral-am-language-option",\s*"EN"/);
assert.match(source, /toggleLanguage\(\)/);
assert.match(source, /syncLanguageToggle\(\)/);
assert.match(
  source,
  /languageToggleButton\.classList\.toggle\("is-en", isEnglish\)/,
);
assert.match(source, /registerLocalizationRoot\(windowElement\)/);
assert.match(source, /registerLocalizationRoot\(button\)/);
assert.match(dialogSource, /unregisterLocalizationRoot\(dialog\)/);
assert.match(
  dialogSource,
  /document\.body\.append\(dialog\);\s*registerLocalizationRoot\(dialog\);/,
);
assert.match(
  i18nSource,
  /export const LANGUAGE_STORAGE_KEY = "assets-astral\.ui-language";/,
);
assert.match(i18nSource, /export function translateUiText/);
assert.match(i18nSource, /export function toggleLanguage/);
assert.match(i18nSource, /function isUserContent\(element\)/);
assert.match(i18nSource, /\.astral-am-chat-message-content/);
assert.match(i18nSource, /\.astral-am-prompt-card-text/);
assert.match(i18nSource, /const TRANSLATABLE_ATTRIBUTES = \["title", "placeholder", "aria-label"\]/);
assert.match(i18nSource, /new MutationObserver/);
assert.match(
  css,
  /\.astral-am-heading-star-control\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?align-items:\s*center;[\s\S]*?gap:\s*5px;/,
);
assert.match(
  css,
  /\.astral-am-language-toggle\s*\{[\s\S]*?position:\s*relative;[\s\S]*?top:\s*-5px;/,
);
assert.match(css, /\.astral-am-language-toggle\.is-en .*data-language="en"/);
assert.match(css, /\.astral-am-menu-button\s*\{[\s\S]*?width:\s*auto;/);
assert.match(css, /\.astral-am-heading-links\s*\{/);
assert.match(css, /\.astral-am-heading-star\s*\{/);
assert.match(css, /\.astral-am-heading-star-icon\s*\{/);
assert.match(source, /"Prompt Management"/);
assert.match(source, /"System Prompt Management"/);
assert.doesNotMatch(source, /"Template Library"/);
assert.match(
  source,
  /modeTabs\.append\(\s*this\.skillTagModeButton,\s*this\.templateModeButton,\s*this\.skillModeButton,\s*this\.chatModeButton,\s*this\.apiConfigModeButton,?\s*\)/,
);
assert.doesNotMatch(source, /localLlmConfigModeButton/);
assert.match(
  source,
  /this\.skillTagModeButton = createElement\(\s*"button",\s*"astral-am-subtab",\s*"Prompt Inspiration",?\s*\)/,
);
assert.match(source, /mode === "skillTags"/);
assert.match(
  source,
  /if \(mode === "skillTags" && !this\.skillTagsLoaded\) \{\s*void this\.loadSkillTags\(\);/,
);
assert.match(source, /\/assets-astral\/skill-tags/);
assert.match(source, /\/assets-astral\/skill-tags\/categories\/create/);
assert.match(source, /\/assets-astral\/skill-tags\/categories\/rename/);
assert.match(source, /\/assets-astral\/skill-tags\/categories\/delete/);
assert.match(source, /\/assets-astral\/skill-tags\/subcategories\/create/);
assert.match(source, /\/assets-astral\/skill-tags\/subcategories\/rename/);
assert.match(source, /\/assets-astral\/skill-tags\/subcategories\/delete/);
assert.match(source, /\/assets-astral\/skill-tags\/batch-create/);
assert.match(source, /\/assets-astral\/skill-tags\/batch-delete/);
assert.match(source, /\/assets-astral\/skill-tags\/batch-move/);
assert.match(source, /\/assets-astral\/skill-tags\/update/);
assert.match(source, /\/assets-astral\/skill-tags\/delete/);
assert.match(source, /\/assets-astral\/skill-tags\/reorder/);
assert.doesNotMatch(source, /\/assets-astral\/skill-tags\/text\//);
assert.doesNotMatch(source, /"Edit Tag Text"|"Import Text Tags"/);
assert.doesNotMatch(source, /textImport|inspiration-tags\.txt/);
assert.match(
  source,
  /this\.skillTagState = \{\s*categories: \[\],\s*subcategories: \[\],\s*tags: \[\],\s*\};/,
);
assert.match(source, /this\.activeSkillTagSubcategoryId = "";/);
assert.match(source, /this\.collapsedSkillTagCategoryIds = new Set\(\);/);
assert.match(source, /this\.batchSelectedSkillTagIds = new Set\(\);/);
assert.match(source, /const subcategories = Array\.isArray\(payload\?\.subcategories\)/);
assert.match(
  source,
  /this\.skillTagState = \{ categories, subcategories, tags \};/,
);
assert.match(source, /astral-am-skill-tag-tree-toggle/);
assert.match(source, /astral-am-skill-tag-subcategory-add/);
assert.match(source, /astral-am-skill-tag-subcategory-list/);
assert.match(source, /astral-am-skill-tag-subcategory-row/);
assert.match(source, /label: "New Subcategory"/);
assert.match(source, /label: "Bulk Add Tags"/);
assert.doesNotMatch(source, /label: "New Sub-tag"/);
assert.match(source, /createSkillTagsBatch\(/);
assert.match(source, /multiline: true/);
assert.match(source, /\[\\r\\n,，;；\]\+/);
assert.match(source, /astral-am-skill-tag-batch-checkbox/);
assert.match(source, /astral-am-skill-tag-batch-bar/);
assert.match(source, /toggleSkillTagBatchSelection\(/);
assert.match(source, /selectAllVisibleSkillTags\(\)/);
assert.doesNotMatch(source, /invertVisibleSkillTagSelection\(\)/);
assert.match(source, /clearSkillTagBatchSelection\(\)/);
assert.match(source, /deleteSkillTagsBatch\(\)/);
assert.match(source, /moveSkillTagsBatch\(\)/);
assert.doesNotMatch(
  source,
  /const visibleTagIds = new Set\(visibleTags\.map\(\(tag\) => tag\.id\)\);[\s\S]*?this\.batchSelectedSkillTagIds = new Set\(/,
);
assert.match(source, /"Select All Results"/);
assert.doesNotMatch(source, /"Invert Current Results"/);
assert.match(source, /"Clear Selection"/);
assert.match(source, /"Batch Delete"/);
assert.match(source, /"Move Category"/);
assert.match(source, /showAstralSelect,/);
assert.match(source, /await showAstralSelect\(\{/);
assert.match(css, /\.astral-am-skill-tag-batch-checkbox\s*\{/);
assert.match(css, /\.astral-am-skill-tag-card\.is-batch-selected\s*\{/);
assert.match(css, /\.astral-am-skill-tag-batch-bar\s*\{/);
assert.match(
  source,
  /Tags are prompt-inspiration assets\. Use \+ beside a category or subcategory to add tags in bulk/,
);
assert.doesNotMatch(source, /do not participate in Skill categorization/);
assert.doesNotMatch(source, /skillTagNewCategoryButton/);
assert.doesNotMatch(source, /skillTagNewTagButton/);
assert.doesNotMatch(source, /skillTagRefreshButton/);
assert.match(
  source,
  /replaceChildrenPreservingScroll\(\s*this\.skillTagCategoryList,\s*categoryRows,\s*"data-category-id",\s*\);/,
);
assert.match(source, /this\.activeSkillTagSubcategoryId = "__unclassified__";/);
assert.match(source, /this\.createField\("Subcategory", subcategory\)/);
assert.match(source, /const syncSubcategoryOptions = \(preferredId = ""\) => \{/);
assert.match(
  source,
  /category\.addEventListener\("change", \(\) =>\s*syncSubcategoryOptions\(""\),?\s*\);/,
);
assert.match(source, /subcategoryId: subcategory\.value/);
assert.match(
  source,
  /the tags themselves are not deleted/,
);
assert.match(
  source,
  /kind === "subcategories" &&\s*this\.skillTagDrag\.parentCategoryId !== parentCategoryId/,
);
assert.match(source, /showSkillTagContextMenu\(event, \[/);
assert.match(source, /\/assets-astral\/prompt-inspiration\/generate/);
assert.match(
  source,
  /this\.inspirationModeInput = createElement\(\s*"select",\s*"astral-am-select",?\s*\)/,
);
assert.match(
  source,
  /\["api", "API Text-only Mode"\],\s*\["local", "Local Mode"\]/,
);
assert.match(
  source,
  /language: this\.inspirationLanguageInput\.value,\s*mode,/,
);
assert.match(source, /updateInspirationModeUi\(\)/);
assert.doesNotMatch(source, /inspirationOpenApiButton/);
assert.match(source, /selectedInspirationTagIds/);
assert.match(source, /randomizeInspirationTags\(\)/);
assert.match(source, /generateInspirationPrompt\(\)/);
assert.match(source, /sendInspirationResultToChat\(\)/);
assert.match(source, /const tagLibrary = createElement\("section", "astral-am-tag-library"\)/);
assert.match(
  source,
  /tagBrowserLayout\.append\(tagLibrary, this\.inspirationSelectionPanel\)/,
);
assert.doesNotMatch(source, /\/assets-astral\/skill-tags\/assign/);
assert.doesNotMatch(source, /skillMatchesTags\(skill\)/);
assert.doesNotMatch(source, /buildSkillTagAssignmentEditor\(skill\)/);
assert.doesNotMatch(source, /activeSkillTagFilters/);
assert.match(source, /"API Configuration"/);
assert.doesNotMatch(source, /"API and Chat Parameters"/);
assert.match(source, /this\.apiConfigPane = this\.buildApiConfigPane\(\)/);
assert.match(source, /buildApiConfigPane\(\) \{/);
assert.match(source, /this\.apiConfigContent = settings/);
assert.match(source, /this\.localLlmConfigPane = this\.buildLocalLlmConfigPane\(\)/);
assert.match(
  source,
  /this\.apiConfigScroll\.append\(\s*this\.apiConfigContent,\s*this\.localLlmConfigPane,?\s*\)/,
);
assert.match(source, /openApiConfigSection\("local"\)/);
assert.match(source, /this\.apiConfigScroll\.scrollTo\(\{/);
assert.match(
  source,
  /function openAstralApiConfig\(section = "api"\)[\s\S]*?manager\.promptBrowser\.openApiConfigSection/,
);
assert.match(
  source,
  /window\.openAssetsAstralApiConfig = \(section = "api"\) =>/,
);
assert.doesNotMatch(source, /mode === "localLlmConfig"/);
assert.match(source, /const CHAT_MODE_DEFINITIONS = \[[\s\S]*?LOCAL_CHAT_MODE_DEFINITION/);
assert.match(source, /label: "Local Mode"/);
assert.match(source, /label: "English"[\s\S]*?label: "Simplified Chinese"/);
assert.match(source, /\/assets-astral\/local-llm\/config/);
assert.match(source, /\/assets-astral\/local-llm\/models/);
assert.match(source, /\/assets-astral\/local-llm\/chat/);
assert.match(source, /astral-am-chat-config-hint/);
assert.doesNotMatch(source, /API, model, and chat parameters have moved to a separate configuration page/);
assert.match(source, /this\.activeTaskId = "text"/);
assert.match(source, /this\.chatModeButtons = new Map\(\)/);
assert.match(source, /this\.chatCurrentModelName = createElement\("strong", "", "Not configured"\)/);
assert.match(source, /this\.chatModeButtons\.set\(task\.id, modeButton\)/);
assert.match(source, /this\.selectChatTask\(task\.id\)/);
assert.match(
  source,
  /configToolbar\.append\(modeButtons, configButtons\)/,
);
assert.match(
  source,
  /configButtons\.append\(\s*this\.openApiConfigButton,\s*this\.openLocalLlmConfigButton,?\s*\)/,
);
assert.match(source, /this\.currentChatTaskModel\(activeTask\.id\)/);
assert.match(source, /binding\.model \|\| provider\?\.model/);
assert.match(source, /astral-am-api-provider-tabs/);
assert.match(source, /astral-am-api-provider-tab/);
assert.match(source, /button\.draggable = true/);
assert.match(source, /reorderApiProviders\(sourceId, targetId, placeAfter\)/);
assert.match(source, /addEventListener\("dragstart"/);
assert.match(source, /"API task order saved\."/);
assert.match(source, /mode === "apiConfig"/);
assert.match(css, /\.astral-am-api-config-stack\s*\{/);
assert.match(
  css,
  /\.astral-am-api-config-stack > \.astral-am-api-config-panel\s*\{[\s\S]*?overflow:\s*visible;/,
);
assert.match(
  css,
  /\.astral-am-local-llm-pane\s*\{[\s\S]*?flex-direction:\s*column;[\s\S]*?border-top:/,
);
assert.match(
  css,
  /\.astral-am-local-llm-model-toolbar > \.astral-am-button\s*\{[\s\S]*?white-space:\s*nowrap;/,
);
assert.match(source, /"Media Management"/);
assert.match(source, /"Model Management"/);
assert.match(source, /"LoRA Management"/);
assert.doesNotMatch(source, /Force refresh selected|refreshSelected/);
assert.match(
  source,
  /async querySelectedSources\(\) \{[\s\S]*?\.filter\(Boolean\),\s*false,?\s*\);/,
);
assert.match(source, /"Duplicate Model Cleanup"/);
assert.match(source, /"Fill Missing Models"/);
assert.match(
  source,
  /modeTabs\.append\(\s*this\.missingModeButton,\s*this\.loraModeButton,\s*this\.duplicateModeButton,?\s*\)/,
);
assert.doesNotMatch(source, /modeTabs\.append\([\s\S]*?fileModeButton/);
assert.doesNotMatch(source, /buildFilePane|loadFiles\(true\)|models\/tree\?/);
assert.match(source, /"Quick Open User Folders"/);
assert.match(source, /for \(const root of \[[\s\S]*?"models"[\s\S]*?"custom_nodes"[\s\S]*?"input"[\s\S]*?"output"[\s\S]*?"workflows"[\s\S]*?\]\)/);
assert.match(source, /button\.dataset\.pathLabel = root/);
assert.match(css, /\.astral-am-directory-prompt\s*\{/);
assert.match(css, /\.astral-am-header-button\s*\{[\s\S]*?min-height:\s*38px;[\s\S]*?font:\s*700 13px/);
assert.match(css, /\.astral-am-directory-label::before\s*\{[\s\S]*?content:\s*attr\(data-path-label\)/);
assert.match(source, /"Comfy\.RefreshNodeDefinitions"/);
assert.match(
  source,
  /button\.title = `Show the \$\{root\} folder in system file manager now`/,
);
const openDirectoryBody =
  source.match(
    /  async openDirectory\(root\) \{([\s\S]*?)\n  \}\n\n  async refreshComfyRegistries/,
  )?.[1] || "";
assert.match(openDirectoryBody, /\/assets-astral\/workspace\/open/);
assert.doesNotMatch(
  openDirectoryBody,
  /showTab|\.navigate|\.setMode|\.load\(/,
);
assert.match(source, /\/assets-astral\/workspace\/entries/);
assert.match(source, /\/assets-astral\/workspace\/open/);
assert.match(source, /\/assets-astral\/models\/open/);
assert.match(source, /\/assets-astral\/assets\?/);
assert.match(source, /\/assets-astral\/assets\/detail\?/);
assert.match(source, /\/assets-astral\/assets\/tree\?/);
assert.match(source, /\/assets-astral\/assets\/open/);
assert.match(source, /\/assets-astral\/assets\/rename/);
assert.doesNotMatch(source, /\/assets-astral\/assets\/move/);
assert.match(source, /\/assets-astral\/assets\/recycle/);
assert.match(source, /reloadPreservingLoadedCount\(loadedCount, true\)/);
assert.doesNotMatch(source, /"Open input"/);
assert.doesNotMatch(source, /"Open output"/);
assert.doesNotMatch(source, /"Open current folder"/);
assert.match(source, /exact:\s*1/);
assert.match(source, /toolbar\.append\(root, kind, search, refresh\)/);
assert.match(source, /toolbar\.append\(root\.element, kind\.element, search, refresh\)/);
assert.doesNotMatch(source, /toolbar\.append\(search, kind, root, refresh\)/);
assert.doesNotMatch(
  source,
  /toolbar\.append\(search, kind\.element, root\.element, refresh\)/,
);
assert.match(source, /"Batch Prefix Rename"/);
assert.match(
  source,
  /fileActions\.append\(\s*selectAll,\s*invertSelection,\s*clearSelection,\s*renameSelected,\s*renamePrefix,\s*addToChat,\s*deleteSelected,?\s*\)/,
);
assert.match(
  source,
  /const locationHeader = createElement\("div", "astral-am-model-header"\);\s*locationHeader\.append\(location, fileActions\);/,
);
assert.match(source, /content\.append\(summary, status, grid\);/);
assert.match(source, /content\.append\(summary, status, list\);/);
assert.match(source, /section\.append\(toolbar, locationHeader, browser\);/);
assert.doesNotMatch(source, /Civitai exact lookup by local file SHA256/);
assert.doesNotMatch(source, /"Move Selected"/);
assert.match(source, /"Delete Selected"/);
assert.match(source, /assetSelectionKey/);
assert.match(source, /"Select All"/);
assert.match(source, /"Invert"/);
assert.match(source, /selectAllItems\(\)/);
assert.match(source, /invertSelection\(\)/);
assert.doesNotMatch(source, /"Select Page"/);
assert.match(source, /Open \$\{treeLocation\} in system file manager/);
assert.doesNotMatch(source, /Show in system file manager/);
assert.doesNotMatch(source, /↑ Up one level/);
assert.doesNotMatch(source, /astral-am-parent-path/);
assert.match(
  source,
  /const treeLabel\s*=\s*treePath && currentParts\.length\s*\?\s*currentParts\[currentParts\.length - 1\]\s*:\s*root\.toUpperCase\(\)/,
);
assert.match(
  source,
  /const treeLocation = treePath \? `\$\{root\}\/\$\{treePath\}` : root/,
);
assert.match(source, /\/assets-astral\/loras\/sources/);
assert.match(source, /\/assets-astral\/loras\/sources\/cached/);
assert.match(source, /\/assets-astral\/loras\/tree\?/);
assert.match(source, /\/assets-astral\/loras\/directories/);
assert.match(source, /\/assets-astral\/loras\/open/);
assert.match(source, /\/assets-astral\/loras\/move/);
assert.match(source, /\/assets-astral\/loras\/recycle/);
assert.match(source, /"Move to Folder"/);
assert.match(source, /"Add to Canvas"/);
assert.match(source, /const MAX_LORA_CANVAS_BATCH = 10;/);
assert.match(
  source,
  /const wanted = allWanted\.slice\(0, MAX_LORA_CANVAS_BATCH\);/,
);
assert.match(
  source,
  /const skippedCount = allWanted\.length - wanted\.length;/,
);
assert.match(
  source,
  /Add to Canvas \(first \$\{MAX_LORA_CANVAS_BATCH\}\/\$\{count\}\)/,
);
assert.match(source, /LiteGraph\.createNode\("LoraLoader"\)/);
assert.match(
  source,
  /const value = item\.nativeFile \|\| item\.file \|\| item\.relativePath;/,
);
assert.match(source, /function pathBasename\(value, fallback = "LoRA"\)/);
assert.match(source, /const rootLabel = pathBasename\(currentRootPath\)/);
assert.doesNotMatch(source, /`LoRA \$\{Number\(currentRoot\.index\) \+ 1\}`/);
assert.doesNotMatch(source, /`LoRA \$\{rootIndex \+ 1\}`/);
const loraListRequests = [
  ...source.matchAll(
    /\/assets-astral\/loras\?\$\{queryString\(\{([\s\S]*?)\}\)\}`/g,
  ),
].map((match) => match[1]);
assert.equal(loraListRequests.length, 2);
for (const request of loraListRequests) {
  assert.match(request, /path: this\.currentPath/);
  assert.doesNotMatch(request, /exact\s*:/);
}
assert.match(
  source,
  /async fetchSelectionScope\(\)[\s\S]*?\/assets-astral\/loras\?[\s\S]*?path: this\.currentPath,[\s\S]*?limit:\s*500,/,
);
assert.match(
  source,
  /async fetchSelectionScope\(\)[\s\S]*?\/assets-astral\/assets\?[\s\S]*?exact:\s*1,[\s\S]*?limit:\s*500,/,
);
assert.match(source, /this\.selectionPool = new Map\(/);
assert.match(source, /including files not yet loaded/);
assert.match(source, /\/assets-astral\/models\/categories/);
assert.match(source, /\/assets-astral\/models\/duplicates/);
assert.match(source, /\/assets-astral\/models\/duplicates\/status/);
assert.match(source, /\/assets-astral\/models\/duplicates\/cancel/);
assert.match(source, /\/assets-astral\/models\/missing\/resolve/);
assert.match(
  source,
  /modeTabs\.append\(\s*this\.missingModeButton,\s*this\.loraModeButton,\s*this\.duplicateModeButton,/,
);
assert.match(source, /collectMissingModelReferences\(\)/);
assert.match(source, /MISSING_MODEL_FILE_PATTERN/);
assert.match(source, /isModelComboWidget\(widget\)/);
assert.match(source, /workflowHashRecordForModel\(node, widget, value\)/);
assert.match(source, /inferMissingModelCategories\(node, widget, value\)/);
assert.match(source, /"Scan Current Workflow for Missing Models"/);
assert.match(source, /document\.createTextNode\("Auto-fill after scan"\)/);
assert.match(source, /autoFillDeterminedMissingModels\(entries\)/);
assert.doesNotMatch(source, /Refresh model list and scan|Fill all reliable items/);
assert.doesNotMatch(source, /fillAllReliableMissingModels/);
assert.match(source, /When SHA256 is available, match by content only/);
assert.match(source, /never replace a different model by name/);
assert.match(source, /Multiple same-name matches and hash conflicts still require confirmation/);
assert.match(source, /Filling only changes the current workflow/);
assert.match(
  source,
  /autoFillableMissingModelEntries\(entries = \[\]\)[\s\S]*?entry\.result\?\.state === "match"[\s\S]*?entry\.result\?\.state === "candidate"[\s\S]*?entry\.candidateTargets\.length === 1/,
);
assert.doesNotMatch(source, /graph\.extra\.anomalous_hashes\s*=/);
assert.match(source, /monitorDuplicateTask/);
assert.match(source, /resumeDuplicateScan/);
assert.match(source, /scanPollGeneration/);
assert.match(source, /"Cancel Scan"/);
assert.match(source, /\/assets-astral\/models\/recycle/);
assert.doesNotMatch(source, /window\.confirm\s*\(/);
assert.doesNotMatch(source, /window\.(?:prompt|alert)\s*\(/);
assert.match(source, /showAstralConfirm,/);
assert.match(source, /showAstralPrompt,/);
assert.match(source, /showAstralAlert,/);
assert.match(source, /await showAstralConfirm\(\{/);
assert.match(dialogSource, /createElement\(\s*"div",\s*`astral-am-dialog/);
assert.doesNotMatch(dialogSource, /createElement\(\s*"dialog"/);
assert.doesNotMatch(dialogSource, /dialog\.(?:show|close)\s*\(/);
assert.match(source, /Move the following model to the Windows Recycle Bin/);
assert.match(dialogSource, /export function showAstralConfirm\(/);
assert.match(dialogSource, /export function showAstralPrompt\(/);
assert.match(dialogSource, /export function showAstralSelect\(/);
assert.match(dialogSource, /export function showAstralAlert\(/);
assert.match(dialogCss, /\.astral-am-dialog-select\s*\{/);
assert.match(
  dialogCss,
  /\.astral-am-dialog\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*50000;/,
);
const recycleModelBody =
  source.match(
    /  async recycleModel\(item\) \{([\s\S]*?)\n  \}\n\n  removeDuplicateResultItem/,
  )?.[1] || "";
assert.match(recycleModelBody, /removeDuplicateResultItem\(item\)/);
assert.doesNotMatch(recycleModelBody, /scanDuplicates\(/);
assert.match(
  source,
  /removeDuplicateResultItem\(item\) \{[\s\S]*?this\.renderDuplicates\(this\.duplicateResult\)/,
);
const applyMissingModelTargetBody =
  source.match(
    /  applyMissingModelTarget\(entry, target\) \{([\s\S]*?)\n  \}\n\n  async fillMissingModelEntry/,
  )?.[1] || "";
assert.match(applyMissingModelTargetBody, /getNodeById\(entry\.node\?\.id\)/);
assert.match(applyMissingModelTargetBody, /liveNode !== entry\.node/);
assert.match(applyMissingModelTargetBody, /entry\.widget\.value !== entry\.value/);
assert.match(applyMissingModelTargetBody, /entry\.widget\.value = option/);
assert.match(
  applyMissingModelTargetBody,
  /liveNode\.widgets_values\[widgetIndex\] = option/,
);
assert.match(applyMissingModelTargetBody, /liveNode\.onWidgetChanged/);
assert.match(
  source,
  /reliableMissingModelEntries\(\) \{[\s\S]*?entry\.result\?\.state === "match"[\s\S]*?Boolean\(entry\.selectedTarget\)/,
);
assert.match(source, /mode === "missing"/);
assert.match(source, /this\.missingModelPane/);
assert.match(source, /THUMBNAIL_PREFERENCE/);
assert.match(source, /"Show thumbnails"/);
assert.match(source, /\/assets-astral\/thumbnails\/proxy\?/);
assert.match(source, /row\.classList\.toggle\("has-thumbnail", Boolean\(thumbnail\)\)/);
assert.match(source, /row\.append\(thumbnail\);[\s\S]*?row\.append\(content\);/);
assert.match(source, /batch|Query Selected/);
assert.match(source, /navigator\.clipboard\.write/);
assert.match(source, /copyText\(asset\.absolutePath\)/);
assert.doesNotMatch(
  source,
  /const copyPath = createElement\("button", "astral-am-card-action", "Copy Path"\)/,
);
assert.match(
  source,
  /const copyMedia = createElement\(\s*"button",\s*"astral-am-card-action",\s*item\.kind === "video" \? "Copy Video" : "Copy Image",?\s*\)/,
);
assert.match(
  source,
  /const insertNode = createElement\("button", "astral-am-card-action", "Add to Canvas"\)/,
);
assert.match(
  source,
  /const addToChat = createElement\("button", "astral-am-card-action", "Add to Chat"\)/,
);
assert.match(
  source,
  /actions\.append\(copyMedia\);[\s\S]*?actions\.append\(insertNode, addToChat\);/, 
);
assert.match(source, /async openAssetPicker\(\) \{\s*this\.root\.openChatAssetSelection\(this\);/);
assert.match(
  source,
  /openChatAssetSelection\(promptBrowser = this\.promptBrowser\) \{\s*this\.open\("assets"\);\s*this\.assetBrowser\.beginChatSelection\(promptBrowser\);/,
);
assert.match(source, /beginChatSelection\(promptBrowser\)/);
assert.match(source, /async addChatAttachments\(items\)/);
assert.match(source, /const keys = new Set\(nextAttachments\.map/);
assert.match(source, /const MAX_CHAT_ATTACHMENTS = 30;/);
assert.match(
  source,
  /this\.chatComposerAttachmentLimit = MAX_CHAT_ATTACHMENTS;/,
);
assert.match(source, /const retainedItems = \[\];/);
assert.match(source, /nextAttachments\.length >= limit/);
assert.match(source, /This conversation has reached the limit of \$\{limit\} assets/);
assert.match(source, /count > chatAttachmentLimit/);
assert.match(source, /Add to Chat \(first \$\{chatAttachmentLimit\}\/\$\{count\}\)/);
assert.match(source, /attachments: this\.pendingAttachments\.slice\(/);
assert.doesNotMatch(
  source,
  /const (?:locate|rename) = createElement\("button", "astral-am-card-action"/,
);
assert.match(source, /"Load Embedded Workflow"/);
assert.match(
  source,
  /const insertNode = createElement\("button", "astral-am-button is-primary", "Add to Canvas"\)/,
);
assert.doesNotMatch(source, /Insert official loader node/);
assert.match(source, /asset\.kind === "video"[\s\S]*?"LoadVideo"[\s\S]*?LoadAudio[\s\S]*?"LoadImage"/);
assert.match(source, /function isPhysicalModelCategory\(category\)/);
assert.match(source, /category\.source === "models"/);
assert.match(source, /setAttribute\("translate", "no"\)/);
assert.match(source, /mode === "duplicates"[\s\S]*?this\.loadCategories\(\)/);
assert.doesNotMatch(source, /Add input node|Add output node|Sync output nodes/);
assert.doesNotMatch(
  source,
  /conversationTitle|conversationMeta|renameActiveConversation|placeChatNode|syncChatOutputNodes/,
);
assert.match(source, /button\.title = "Click to switch conversations; double-click to rename\."/);
assert.match(
  source,
  /button\.addEventListener\("click",[\s\S]*?this\.selectConversation\(conversation\.id\)/,
);
assert.match(
  source,
  /button\.addEventListener\("dblclick",[\s\S]*?this\.renameConversation\(conversation\.id\)/,
);
assert.match(source, /this\.conversationLoadSequence = 0/);
assert.match(
  source,
  /requestId !== this\.conversationLoadSequence[\s\S]*?this\.activeConversation = conversation/,
);
assert.match(source, /persistConversationSettings/);
assert.match(source, /function isImageAttachment\(attachment\)/);
assert.match(source, /function attachmentMentionMap\(attachments\)/);
assert.match(source, /function ensureAttachmentMentions\(attachments\)/);
assert.match(source, /replaceChatInputRange\(/);
assert.doesNotMatch(
  source,
  /chatMentionContextAtCaret|chatMentionOptionsForContext|setChatMentionActiveIndex|renderChatMentionOptions|updateChatMentionSuggestions|hideChatMentionSuggestions|handleChatMentionKeydown|acceptChatMentionOption/,
);
assert.doesNotMatch(source, /chatMentionMenu|aria-autocomplete|astral-am-chat-mention/);
assert.match(
  source,
  /Enter a message\. Click an asset chip to insert names such as image1 or video1\./,
);
assert.match(source, /insertChatAttachmentName\(mention\)/);
assert.match(
  source,
  /const insertion = `\$\{leading\}\$\{normalized\}\$\{trailing \|\| " "\}`;/,
);
assert.doesNotMatch(source, /`[^`\n]*@\$\{normalized\}/);
assert.match(
  source,
  /createAttachmentChip\(\s*attachment,\s*onRemove = null,\s*mention = "",\s*onActivate = null,?\s*\)/,
);
assert.match(source, /thumbnail\.src = assetMediaUrl\(attachment, true\)/);
assert.match(source, /thumbnail\.addEventListener\("error"/);
assert.match(source, /chip\.append\(thumbnail\)/);
assert.match(
  source,
  /chips\.append\(this\.createAttachmentChip\(attachment, null, mention\)\)/,
);
assert.match(
  source,
  /const attachmentMentions = attachmentMentionMap\(\s*this\.pendingAttachments,?\s*\)/,
);
assert.match(
  source,
  /mention,\s*\(\) => this\.insertChatAttachmentName\(mention\),/,
);
assert.match(source, /const API_TASK_DEFINITIONS = \[/);
assert.match(source, /id: "text"[\s\S]*?id: "image"[\s\S]*?id: "multimodal"/);
assert.match(source, /label: "Text-only Mode"[\s\S]*?label: "Image Mode"[\s\S]*?label: "Multimodal Mode"/);
assert.match(source, /"Add API"/);
assert.match(source, /"Duplicate API"/);
assert.match(source, /"Delete API"/);
assert.match(source, /\/assets-astral\/chat\/models/);
assert.match(source, /"Fetch Models"/);
assert.match(source, /this\.taskBindingControls\[task\.id\]/);
assert.match(source, /this\.taskBindings\[task\.id\]\.model = fallbackProvider\?\.model \|\| ""/);
assert.match(source, /for \(const legacyId of task\.legacyWriteIds \|\| \[\]\)/);
assert.match(source, /currentModel === previousDefaultModel/);
const localLlmDefaults =
  source.match(
    /const DEFAULT_LOCAL_LLM_CONFIG = Object\.freeze\(\{([\s\S]*?)\}\);/,
  )?.[1] || "";
assert.match(localLlmDefaults, /visionModelPath: ""/);
assert.doesNotMatch(localLlmDefaults, /systemPrompt/);
assert.match(source, /this\.localLlmVisionModelSelect = createElement\(/);
assert.match(source, /Select the local LLM vision projection model \(mmproj\)/);
assert.match(source, /numberField\("nBatch", "Batch size n_batch"/);
assert.match(source, /numberField\("nUbatch", "Micro-batch n_ubatch"/);
assert.match(source, /numberField\("maxImageEdge", "Maximum image edge"/);
assert.match(source, /numberField\("imageJpegQuality", "JPEG quality"/);
assert.match(source, /choiceField\("kvCacheTypeK", "KV Cache K"/);
assert.match(source, /choiceField\("reasoningEffort", "Qwen3\.8 reasoning effort"/);
assert.match(source, /toggleField\(\s*"enableThinking"/);
assert.match(
  source,
  /payload = translationEnabled\s*\?[\s\S]*?useLocal\s*\?\s*\{[\s\S]*?attachments: attachmentSnapshot/,
);
assert.doesNotMatch(source, /translateButton|optimizeButton|invertButton/);
assert.doesNotMatch(source, /translationPanel|translationOutput/);
assert.doesNotMatch(source, /translateInput\(|runPromptTransform\(/);
assert.doesNotMatch(source, /"One-click Translate"|"Prompt Optimization"|"Prompt Inversion"/);
assert.match(source, /\/assets-astral\/chat\/translate/);
const sendChatBody =
  source.match(
    /  async sendChat\(\) \{([\s\S]*?)\n  \}\n\n  async deleteActiveConversation/,
  )?.[1] || "";
assert.match(sendChatBody, /task: activeTask\.id/);
assert.match(sendChatBody, /attachments: attachmentSnapshot/);
assert.match(
  sendChatBody,
  /translationEnabled[\s\S]*?useLocal[\s\S]*?\/assets-astral\/chat\/translate/,
);
assert.match(
  sendChatBody,
  /text: message,[\s\S]*?targetLanguage: targetLanguage\.value,[\s\S]*?sourceLanguage: "auto"/,
);
assert.match(sendChatBody, /new AbortController\(\)/);
assert.match(sendChatBody, /requestId,/);
assert.match(sendChatBody, /signal: this\.chatAbortController\.signal/);
assert.match(
  source,
  /composerActions\.append\(\s*this\.chatStatus,\s*this\.translationControls,\s*this\.sendButton,?\s*\)/,
);
assert.match(source, /\/assets-astral\/chat\/cancel/);
assert.match(
  source,
  /this\.chatGenerating\s*\?\s*this\.chatStopping\s*\?\s*"Stopping\.\.\."\s*:\s*"Stop"\s*:\s*"Send"/,
);
assert.match(
  source,
  /message\.role === "user" \? "Sent" : "Received"/,
);
assert.match(source, /renderChatMessageImages\(/);
assert.doesNotMatch(source, /"Retract and edit"/);
assert.doesNotMatch(source, /\/assets-astral\/chat\/retract/);
assert.match(source, /This cannot be undone\./);
assert.match(source, /\/assets-astral\/chat\/messages\/delete/);
assert.match(source, /"Copy this message"/);
assert.match(source, /"Delete this message \(cannot be undone\)"/);
assert.doesNotMatch(source, /restoreChatDraft\(request, false\)/);
assert.match(
  source,
  /this\.translationCheckbox = createElement\("input"\)/,
);
assert.match(
  source,
  /this\.translationTargetLanguage = "en"/,
);
assert.match(
  source,
  /this\.systemPromptButton = createElement\(\s*"button",\s*"astral-am-button is-small",\s*"Load System Prompt",?\s*\)/,
);
assert.match(
  source,
  /this\.skillButton = createElement\(\s*"button",\s*"astral-am-button is-small",\s*"Load Skill",?\s*\)/,
);
assert.match(
  source,
  /this\.attachmentButton = createElement\(\s*"button",\s*"astral-am-button is-small",\s*"Attach Assets",?\s*\)/,
);
assert.match(
  source,
  /this\.chatControls\.append\(\s*this\.systemPromptButton,\s*this\.skillButton,\s*this\.attachmentButton,\s*this\.chatSelectionTray,?\s*\)/,
);
assert.match(source, /`Attach Assets \(\$\{this\.pendingAttachments\.length\}\)`/);
assert.match(source, /"Load Skill \(1\)"/);
assert.match(source, /"Load System Prompt \(1\)"/);
assert.match(
  source,
  /const loadToChat = createElement\(\s*"button",\s*"astral-am-button is-small",\s*loaded \? "Current Session Prompt" : "Load to Conversation",?\s*\)/,
);
assert.match(source, /void this\.addSystemPromptToChat\(template\)/);
assert.doesNotMatch(
  source,
  /"Copy Template"|duplicateTemplate|\/assets-astral\/prompt-templates\/duplicate/,
);
assert.match(
  source,
  /systemPromptTemplate: this\.pendingSystemPromptTemplate/,
);
assert.match(
  source,
  /openSystemPromptPicker\(\) \{\s*this\.root\.openChatSystemPromptSelection\(this\);\s*\}/,
);
assert.match(
  source,
  /openChatSystemPromptSelection\(\s*promptBrowser = this\.promptBrowser,\s*category = "all",?\s*\) \{\s*this\.open\("prompts"\);\s*promptBrowser\.setMode\("templates"\);/,
);
assert.match(
  source,
  /openSkillPicker\(\) \{\s*this\.root\.openChatSkillSelection\(this\);\s*\}/,
);
assert.match(
  source,
  /openChatSkillSelection\(promptBrowser = this\.promptBrowser\) \{\s*this\.open\("prompts"\);\s*promptBrowser\.setMode\("skills"\);\s*void promptBrowser\.loadSkills\(\);/,
);
assert.match(
  source,
  /button\.textContent = joined\s*\?\s*"Current Session Skill"\s*:\s*hasCurrentContext\s*\?\s*"Switch to this Skill"\s*:\s*"Add to Conversation"/,
);
assert.match(source, /async addSkillToChat\(skillId\)/);
assert.match(source, /this\.pendingSkillIds = \[skill\.id\]/);
assert.doesNotMatch(source, /this\.pendingSkillIds = \[\.\.\.this\.pendingSkillIds/);
assert.match(source, /button\.textContent = joined[\s\S]*?"Switch to this Skill"/);
assert.match(
  source,
  /if \(this\.pendingSystemPromptTemplate && this\.pendingSkillIds\.length\) \{\s*this\.pendingSkillIds = \[\];/,
);
assert.match(
  source,
  /renderChatSelection\(\) \{[\s\S]*?if \(this\.pendingSystemPromptTemplate\)[\s\S]*?for \(const skillId of this\.pendingSkillIds\.slice\(0, 1\)\)[\s\S]*?for \(const attachment of this\.pendingAttachments\)/,
);
assert.match(
  source,
  /async addSkillToChat\(skillId\)[\s\S]*?const previousSystemPrompt = this\.pendingSystemPromptTemplate;[\s\S]*?this\.pendingSystemPromptTemplate = null;[\s\S]*?this\.pendingSkillIds = \[skill\.id\]/,
);
assert.match(
  source,
  /async addSystemPromptToChat\(template\)[\s\S]*?const previousSkillId = this\.pendingSkillIds\[0\] \|\| "";[\s\S]*?this\.pendingSkillIds = \[\];[\s\S]*?this\.pendingSystemPromptTemplate = \{/,
);
assert.match(source, /to Skill "\$\{skill\.name\}"/);
assert.match(
  source,
  /to system prompt "\$\{this\.pendingSystemPromptTemplate\.title\}"/,
);
assert.match(
  source,
  /chip\.addEventListener\("pointerenter"[\s\S]*?scheduleSkillPreview\(skill, chip\)/,
);
assert.match(
  source,
  /chip\.addEventListener\("pointerenter", \(\) => \{\s*this\.scheduleSystemPromptPreview\(\s*this\.pendingSystemPromptTemplate,\s*chip,?\s*\);\s*\}\);/,
);
assert.match(
  source,
  /chip\.addEventListener\("pointerleave", \(\) => \{\s*this\.hideSkillPreview\(chip\);\s*\}\);/,
);
assert.match(
  source,
  /chip\.addEventListener\("focusin", \(\) => \{\s*this\.scheduleSystemPromptPreview\(\s*this\.pendingSystemPromptTemplate,\s*chip,?\s*\);\s*\}\);/,
);
assert.match(
  source,
  /chip\.addEventListener\("focusout", \(event\) => \{\s*if \(!chip\.contains\(event\.relatedTarget\)\) \{\s*this\.hideSkillPreview\(chip\);/,
);
assert.match(
  source,
  /scheduleSystemPromptPreview\(template, anchor\) \{[\s\S]*?skillPreviewExcerpt\(template\.content\)[\s\S]*?"System Prompt · Hover to Preview"/,
);
assert.match(source, /aria-label",\s*`Loaded system prompt:/);
assert.doesNotMatch(source, /card\.addEventListener\("pointerenter"/);
assert.match(source, /this\.mode !== "chat"/);
assert.match(source, /skillPreviewExcerpt\(detail\.content\)/);
assert.match(source, /loadSkillContent\(skillId\)/);
assert.match(source, /\/assets-astral\/skills\/content\?\$\{queryString/);
assert.doesNotMatch(source, /"Copy ID"/);
assert.match(
  source,
  /const openDirectory = createElement\(\s*"button",\s*"astral-am-button is-small",\s*"Open folder",?\s*\)/,
);
assert.match(
  source,
  /openDirectory\.title = "Open this Skill's folder in the system file manager and select it\."/,
);
assert.match(
  source,
  /openDirectory\.addEventListener\(\s*"click",\s*\(\) => void this\.openSkillDirectory\(skill\),?\s*\)/,
);
assert.match(
  source,
  /actions\.append\(preview, openDirectory, addToChat\)/,
);
assert.doesNotMatch(source, /manageTags/);
assert.match(source, /async openSkillDirectory\(skill\) \{/);
assert.match(source, /\/assets-astral\/skills\/open/);
assert.match(source, /body: JSON\.stringify\(\{ id: skill\.id \}\)/);
assert.match(source, /result\?\.revealMode === "selected"/);
assert.match(source, /did not confirm automatic selection/);
assert.match(source, /ComfyUI custom_nodes/);
assert.match(source, /ComfyUI custom_nodes and input/);
assert.match(source, /Scanning custom_nodes and input\.\.\./);
assert.match(source, /payload\?\.roots/);
assert.match(source, /input Skills use the input\/\.\.\. namespace/);
assert.match(
  source,
  /this\.skillSearch = createElement\("input", "astral-am-search"\)/,
);
assert.match(source, /this\.skillSearch\.type = "search"/);
assert.match(
  source,
  /this\.skillSearch\.placeholder = "Search Skill name, ID, description, or source"/,
);
assert.match(source, /toolbar\.append\(this\.skillSearch, this\.skillRefreshButton\)/);
assert.match(
  source,
  /this\.skillSearch\.addEventListener\("input", \(\) => this\.renderSkills\(\)\)/,
);
assert.match(source, /const matchingSkills = this\.skills\.filter/);
assert.match(source, /this\.skillMatchesSearch\(skill, query\)/);
assert.match(
  source,
  /skillMatchesSearch\(skill, query\) \{[\s\S]*?skill\?\.name,[\s\S]*?skill\?\.label,[\s\S]*?skill\?\.id,[\s\S]*?skill\?\.description,[\s\S]*?skill\?\.source,[\s\S]*?skill\?\.fileName,[\s\S]*?skill\?\.relativeDirectory,[\s\S]*?skill\.references/,
);
assert.match(source, /tokens\.every\(\(token\) => haystack\.includes\(token\)\)/);
assert.match(
  source,
  /`Found \$\{matchingSkills\.length\} \/ \$\{this\.skills\.length\} Skills`/,
);
assert.match(source, /No Skills match "\$\{query\}"/);
assert.match(source, /`Source: \$\{skill\.source\}`/);
assert.doesNotMatch(source, /Scan node package skills directory/);
assert.match(source, /asset\.root === "output" \? `\$\{asset\.path\} \[output\]`/);
assert.match(source, /canvasElement\?\.getBoundingClientRect/);
assert.match(source, /canvas\.convertEventToCanvasOffset\(\{/);
assert.match(source, /loader\.pos = \[\s*Number\(graphPosition\[0\]\) - nodeWidth \/ 2/);
assert.match(source, /Name candidate/);
assert.match(source, /not confirmed by file hash/);
assert.doesNotMatch(source, /verify the model file SHA256/);
assert.match(source, /appendAggregateModelInfo/);
assert.match(source, /Trigger word source: /);
assert.match(source, /No reliable recommendation found/);
assert.match(
  source,
  /this\.selectedItems\(\)\s*\.map\(\(item\) => item\.file\)/,
);
assert.match(source, /async querySelectedSources\(\)/);
assert.match(source, /async restoreCachedSources\(items\)/);
assert.match(source, /await this\.restoreCachedSources\(page\)/);
assert.match(source, /result\?\.thumbnailLocalUrl/);
assert.match(source, /startsWith\("\/assets-astral\/loras\/thumbnail\?"\)/);
assert.match(css, /\.astral-am-grid\s*\{/);
assert.match(css, /\.astral-am-api-config-panel\s*\{/);
assert.match(css, /\.astral-am-api-provider-tabs\s*\{/);
assert.match(css, /\.astral-am-api-provider-tab\.is-active\s*\{/);
assert.match(css, /\.astral-am-api-provider-tab\.is-dragging\s*\{/);
assert.match(css, /\.astral-am-api-provider-tab\.is-drop-before::before/);
assert.match(css, /\.astral-am-skill-hover-preview\s*\{/);
assert.match(css, /\.astral-am-skill-hover-preview\s*\{[\s\S]*?pointer-events:\s*none;/);
assert.match(css, /\.astral-am-skill-preview-body\s*\{/);
assert.match(css, /\.astral-am-skill-search-empty\s*\{/);
assert.match(css, /\.astral-am-skill-tag-workspace\s*\{/);
assert.match(css, /\.astral-am-skill-tag-context-menu\s*\{[\s\S]*?position:\s*fixed;/);
assert.match(css, /\.astral-am-skill-tag-category-row\s*\{/);
assert.match(css, /\.astral-am-skill-tag-tree-toggle,/);
assert.match(css, /\.astral-am-skill-tag-subcategory-add\s*\{/);
assert.match(css, /\.astral-am-skill-tag-subcategory-list\s*\{/);
assert.match(css, /\.astral-am-skill-tag-subcategory-row\s*\{/);
assert.match(
  css,
  /\.astral-am-skill-tag-category\.astral-am-skill-tag-subcategory\.is-unclassified\s*\{/,
);
assert.match(css, /\.astral-am-chip\.astral-am-chip-subcategory\s*\{/);
assert.match(css, /\.astral-am-skill-tag-editor-grid\s*\{/);
assert.match(
  css,
  /\.astral-am-skill-tag-editor-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\([\s\S]*?auto-fit,[\s\S]*?minmax\(min\(135px,\s*100%\),\s*1fr\)/,
);
assert.match(
  css,
  /\.astral-am-tag-browser-layout\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(330px,\s*370px\);/,
);
assert.match(
  css,
  /\.astral-am-skill-tag-list\s*\{[\s\S]*?min-height:\s*240px;[\s\S]*?overflow:\s*auto;/,
);
assert.match(css, /\.astral-am-inspiration-panel\s*\{/);
assert.match(css, /\.astral-am-inspiration-controls\s*\{/);
assert.match(css, /\.astral-am-inspiration-result-actions\s*\{/);
assert.match(css, /\.astral-am-skill-tag-card\.is-selected\s*\{/);
assert.doesNotMatch(css, /\.astral-am-skill-tag-assignment-choice:has\(input:checked\)/);
assert.match(css, /\.astral-am-chip-thumbnail\s*\{[\s\S]*?width:\s*24px;[\s\S]*?object-fit:\s*cover;/);
assert.match(css, /\.astral-am-chip\.is-mentionable\s*\{/);
assert.doesNotMatch(css, /\.astral-am-chat-input-shell|\.astral-am-chat-mention/);
assert.doesNotMatch(css, /\.astral-am-load-more/);
assert.match(
  css,
  /\.astral-am-backdrop\s*\{[\s\S]*?pointer-events:\s*none;[\s\S]*?background:\s*transparent;/,
);
assert.match(
  css,
  /\.astral-am-window\s*\{[\s\S]*?pointer-events:\s*auto;/,
);
assert.match(source, /startWindowDrag\(event\)/);
assert.match(source, /translate3d\(\$\{this\.windowOffset\.x\}px/);
assert.doesNotMatch(source, /setAttribute\("aria-modal", "true"\)/);
assert.doesNotMatch(source, /this\.temperatureInput|this\.maxTokensInput|this\.maxRoundsInput/);
assert.doesNotMatch(source, /const advancedSettings = createElement/);
assert.match(source, /const DEFAULT_API_RUNTIME_SETTINGS = Object\.freeze\(\{/);
assert.match(source, /temperature: 0\.7,[\s\S]*?maxTokens: 2048,[\s\S]*?maxRounds: 12,/);
assert.match(source, /topP: 0\.95,[\s\S]*?frequencyPenalty: 0\.0,/);
assert.match(source, /seed: null,[\s\S]*?responseFormat: "default",/);
assert.match(source, /runtimeNumberField\(\s*"temperature",/);
assert.match(source, /runtimeNumberField\(\s*"topP",/);
assert.match(source, /runtimeNumberField\(\s*"seed",/);
assert.match(source, /runtimeTextField\(\s*"stop",/);
assert.match(source, /runtimeTextField\(\s*"systemPrompt",/);
assert.match(source, /collectApiRuntimeSettings\(\)/);
assert.match(source, /LOCAL_LLM_PARAMETER_HINTS = Object\.freeze\(\{/);
assert.match(source, /createField\(labelText, input, extraClass = "", hint = ""\)/);
assert.match(source, /label\.title = hint;[\s\S]*?input\.title = hint;/);
assert.match(css, /\.astral-am-api-runtime-grid\s*\{/);
assert.match(css, /\.astral-am-field\.has-help > span:first-child\s*\{/);
assert.match(css, /\.astral-am-chat-config-hint\s*\{/);
assert.match(css, /\.astral-am-chat-config-toolbar\s*\{/);
assert.match(css, /\.astral-am-chat-mode-buttons\s*\{/);
assert.match(css, /\.astral-am-chat-mode-button\.is-active\s*\{/);
assert.match(css, /\.astral-am-chat-current-model\s*\{/);
assert.match(css, /\.astral-am-local-llm-grid\s*\{/);
assert.match(css, /\.astral-am-chat-translation-toggle\s*\{/);
assert.match(
  css,
  /\.astral-am-chat-translation-toggle\.is-active[\s\S]*?border-color:/,
);
assert.match(css, /\.astral-am-chat-message-time\s*\{/);
assert.match(css, /\.astral-am-chat-message-images\s*\{/);
assert.doesNotMatch(css, /\.astral-am-chat-message-action\.is-retract\s*\{/);
assert.doesNotMatch(
  css,
  /\.astral-am-chat-header|\.astral-am-chat-heading|\.astral-am-translation-actions/,
);
assert.match(
  source,
  /const heading = createElement\("div", "astral-am-skill-dialog-heading"\)/,
);
assert.match(css, /\.astral-am-skill-dialog-heading\s*\{/);
assert.match(
  css,
  /\.astral-am-assets-pane \.astral-am-model-content\s*\{[\s\S]*?overflow:\s*hidden;/,
);
assert.match(
  css,
  /\.astral-am-assets-pane \.astral-am-model-content > \.astral-am-grid\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*auto;/,
);
assert.match(
  css,
  /\.astral-am-assets-pane \.astral-am-model-content > \.astral-am-grid\s*\{[\s\S]*?grid-auto-rows:\s*max-content;[\s\S]*?align-items:\s*start;/,
);
assert.match(
  css,
  /\.astral-am-model-header\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?justify-content:\s*space-between;/,
);
assert.match(
  css,
  /\.astral-am-model-header \.astral-am-file-actions\s*\{[\s\S]*?justify-content:\s*flex-end;[\s\S]*?margin-left:\s*auto;/,
);
assert.match(
  css,
  /\.astral-am-assets-pane \.astral-am-card\s*\{[\s\S]*?align-self:\s*start;[\s\S]*?height:\s*auto;[\s\S]*?padding:\s*0 0 42px;/,
);
assert.match(
  css,
  /\.astral-am-assets-pane \.astral-am-card-actions\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*0;[\s\S]*?height:\s*42px;/,
);
assert.doesNotMatch(css, /\.astral-am-parent-path\s*\{/);
assert.match(css, /\.astral-am-viewer::backdrop/);
assert.match(
  css,
  /\.astral-am-viewer::backdrop\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?backdrop-filter:\s*none;/,
);
assert.match(css, /\.astral-am-lora-row\.has-thumbnail\s*\{/);
assert.match(css, /\.astral-am-duplicate-progress\s*\{/);
assert.match(css, /\.astral-am-duplicate-current-file\s*\{/);
assert.match(css, /\.astral-am-missing-list\s*\{/);
assert.match(css, /\.astral-am-missing-row\.is-match\s*\{/);
assert.match(css, /\.astral-am-missing-row\.is-conflict\s*\{/);
assert.match(css, /\.astral-am-missing-candidate-dropdown\s*\{/);
assert.match(css, /\.astral-am-lora-thumbnail\s*\{[\s\S]*?height:\s*100%;/);
assert.match(css, /\.astral-am-header-actions\s*\{/);
assert.match(css, /\.astral-am-workspace-list\s*\{/);
assert.match(css, /@media \(max-width: 900px\)/);
assert.match(
  css,
  /@media \(max-width: 900px\)[\s\S]*?\.astral-am-skill-tag-workspace\s*\{[\s\S]*?grid-template-columns:\s*1fr;/,
);
assert.match(
  css,
  /@media \(max-width: 900px\)[\s\S]*?\.astral-am-skill-tag-list\s*\{[\s\S]*?height:\s*clamp\(480px,\s*62vh,\s*760px\);[\s\S]*?min-height:\s*480px;[\s\S]*?overflow:\s*auto;/,
);
assert.match(
  css,
  /\.astral-am-skill-tag-list\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(190px,\s*1fr\)\);/,
);
assert.match(
  css,
  /@media \(max-width: 560px\)[\s\S]*?\.astral-am-inspiration-controls\s*\{[\s\S]*?grid-template-columns:\s*1fr;/,
);
assert.match(
  css,
  /\.astral-am-tree-children\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/,
);

const scrollHelpersSource = source.slice(
  source.indexOf("function captureScrollState"),
  source.indexOf("function formatBytes"),
);
const scrollHelpersContext = {};
vm.createContext(scrollHelpersContext);
vm.runInContext(
  `${scrollHelpersSource}
globalThis.scrollHelpers = {
  captureScrollState,
  restoreScrollState,
  restoreScrollStateAfterLayout,
  updateStatusPreservingScroll,
  appendChildrenPreservingScroll,
};`,
  scrollHelpersContext,
);
const {
  captureScrollState,
  restoreScrollState,
  restoreScrollStateAfterLayout,
  updateStatusPreservingScroll,
  appendChildrenPreservingScroll,
} =
  scrollHelpersContext.scrollHelpers;

function scrollTestElement(top, anchors, containerTop = 100) {
  let currentAnchors = anchors;
  let currentTop = containerTop;
  return {
    scrollTop: top,
    scrollLeft: 18,
    getBoundingClientRect() {
      return { top: currentTop };
    },
    querySelectorAll() {
      return currentAnchors;
    },
    setAnchors(nextAnchors) {
      currentAnchors = nextAnchors;
    },
    setContainerTop(nextTop) {
      currentTop = nextTop;
    },
  };
}

function scrollTestAnchor(value, top, bottom) {
  return {
    getAttribute() {
      return value;
    },
    getBoundingClientRect() {
      return { top, bottom };
    },
  };
}

function reactiveScrollTestElement({
  top = 480,
  containerTop = 100,
  anchorContentTop = 494,
} = {}) {
  let currentTop = top;
  let currentContainerTop = containerTop;
  let currentAnchorContentTop = anchorContentTop;
  const anchor = {
    getAttribute() {
      return "lora-b";
    },
    getBoundingClientRect() {
      const renderedTop =
        currentContainerTop + currentAnchorContentTop - currentTop;
      return { top: renderedTop, bottom: renderedTop + 66 };
    },
  };
  return {
    scrollLeft: 18,
    get scrollTop() {
      return currentTop;
    },
    set scrollTop(value) {
      currentTop = Math.max(0, Number(value) || 0);
    },
    getBoundingClientRect() {
      return { top: currentContainerTop };
    },
    querySelectorAll() {
      return [anchor];
    },
    append(children) {
      this.lastAppended = children;
    },
    setContainerTop(value) {
      currentContainerTop = value;
    },
    setAnchorContentTop(value) {
      currentAnchorContentTop = value;
    },
    resetScrollTop(value = 0) {
      currentTop = value;
    },
  };
}

const samePositionElement = scrollTestElement(480, []);
const samePositionState = captureScrollState(
  samePositionElement,
  "data-lora-key",
);
restoreScrollState(samePositionElement, samePositionState);
assert.equal(samePositionElement.scrollTop, 480);
assert.equal(samePositionElement.scrollLeft, 18);

const anchoredElement = scrollTestElement(480, [
  scrollTestAnchor("lora-a", 50, 80),
  scrollTestAnchor("lora-b", 114, 180),
]);
const anchoredState = captureScrollState(anchoredElement, "data-lora-key");
assert.equal(anchoredState.anchorValue, "lora-b");
assert.equal(anchoredState.anchorViewportTop, 114);
anchoredElement.setAnchors([
  scrollTestAnchor("lora-a", 90, 120),
  scrollTestAnchor("lora-b", 144, 210),
]);
restoreScrollState(anchoredElement, anchoredState);
assert.equal(anchoredElement.scrollTop, 510);

const partiallyVisibleElement = scrollTestElement(480, [
  scrollTestAnchor("partial-row", 72, 140),
  scrollTestAnchor("fully-visible-row", 156, 220),
]);
const partiallyVisibleState = captureScrollState(
  partiallyVisibleElement,
  "data-lora-key",
);
assert.equal(
  partiallyVisibleState.anchorValue,
  "partial-row",
  "The scroll anchor should keep the row crossing the viewport top fixed",
);
partiallyVisibleElement.setAnchors([
  scrollTestAnchor("partial-row", 72, 140),
  scrollTestAnchor("fully-visible-row", 188, 252),
]);
restoreScrollState(partiallyVisibleElement, partiallyVisibleState);
assert.equal(
  partiallyVisibleElement.scrollTop,
  480,
  "A taller neighboring row must not move a partially visible anchor",
);

const repeatedAnchorElement = reactiveScrollTestElement();
const repeatedAnchorState = captureScrollState(
  repeatedAnchorElement,
  "data-lora-key",
);
assert.equal(repeatedAnchorState.anchorViewportTop, 114);
repeatedAnchorElement.setContainerTop(145);
restoreScrollState(repeatedAnchorElement, repeatedAnchorState);
assert.equal(repeatedAnchorElement.scrollTop, 525);
restoreScrollState(repeatedAnchorElement, repeatedAnchorState);
assert.equal(
  repeatedAnchorElement.scrollTop,
  525,
  "Repeated restoration must not reapply the same anchor correction",
);

const rerenderedAnchorElement = reactiveScrollTestElement();
const rerenderedAnchorState = captureScrollState(
  rerenderedAnchorElement,
  "data-lora-key",
);
rerenderedAnchorElement.resetScrollTop(0);
rerenderedAnchorElement.setAnchorContentTop(494);
restoreScrollState(rerenderedAnchorElement, rerenderedAnchorState);
assert.equal(
  rerenderedAnchorElement.scrollTop,
  480,
  "A rerendered list should return the anchored row to its screen position",
);

const shiftedContainerElement = scrollTestElement(480, [
  scrollTestAnchor("lora-b", 114, 180),
]);
const shiftedContainerState = captureScrollState(
  shiftedContainerElement,
  "data-lora-key",
);
shiftedContainerElement.setContainerTop(145);
shiftedContainerElement.setAnchors([
  scrollTestAnchor("lora-b", 159, 225),
]);
restoreScrollState(shiftedContainerElement, shiftedContainerState);
assert.equal(shiftedContainerElement.scrollTop, 525);

const removedAnchorElement = scrollTestElement(480, [
  scrollTestAnchor("lora-a", 110, 150),
]);
const removedAnchorState = captureScrollState(
  removedAnchorElement,
  "data-lora-key",
);
removedAnchorElement.setAnchors([]);
restoreScrollState(removedAnchorElement, removedAnchorState);
assert.equal(removedAnchorElement.scrollTop, 480);

const layoutRepairElement = reactiveScrollTestElement();
const layoutRepairState = captureScrollState(
  layoutRepairElement,
  "data-lora-key",
);
layoutRepairElement.resetScrollTop(720);
restoreScrollStateAfterLayout(layoutRepairElement, layoutRepairState);
assert.equal(layoutRepairElement.scrollTop, 480);

const statusElement = {};
const statusScrollElement = scrollTestElement(480, [
  scrollTestAnchor("lora-b", 114, 180),
]);
updateStatusPreservingScroll(
  statusElement,
  "Refreshing sources...",
  "loading",
  statusScrollElement,
  "data-lora-key",
);
assert.equal(statusElement.textContent, "Refreshing sources...");
assert.equal(statusElement.title, "Refreshing sources...");
assert.equal(statusElement.hidden, false);
assert.equal(statusScrollElement.scrollTop, 480);

const appendElement = reactiveScrollTestElement();
const appendState = captureScrollState(appendElement, "data-lora-key");
appendElement.resetScrollTop(0);
const appendedFragment = { kind: "fragment" };
appendChildrenPreservingScroll(
  appendElement,
  appendedFragment,
  "data-lora-key",
  appendState,
);
assert.equal(appendElement.lastAppended, appendedFragment);
assert.equal(appendElement.scrollTop, 480);

assert.match(
  source,
  /async load\(reset, preserveScroll = false\) \{[\s\S]*?!reset \|\| preserveScroll[\s\S]*?captureScrollState\(this\.list, "data-lora-key"\)[\s\S]*?if \(!scrollState\) this\.list\.replaceChildren\(\);/,
);
assert.match(
  source,
  /renderList\(scrollState = null\) \{[\s\S]*?replaceChildrenPreservingScroll\(\s*this\.list,\s*fragment,\s*"data-lora-key",\s*scrollState,\s*\);/,
);
assert.match(
  source,
  /updateRowsPreservingScroll\(files, scrollState = null\) \{[\s\S]*?row\.replaceWith\(this\.createRow\(item\)\);[\s\S]*?restoreScrollStateAfterLayout\(this\.list, state\);/,
  "A LoRA source refresh must update only the affected rows",
);
assert.match(
  source,
  /async queryFiles\(files, refresh\) \{[\s\S]*?const scrollState = captureScrollState\(this\.list, "data-lora-key"\);[\s\S]*?this\.updateRowsPreservingScroll\(wanted, scrollState\);[\s\S]*?this\.updateRowsPreservingScroll\([\s\S]*?finally \{[\s\S]*?this\.updateRowsPreservingScroll\(wanted, scrollState\);/,
  "A LoRA source refresh must use one stable scroll anchor across every async render",
);
const mediaLoadBody =
  source.match(
    /  async load\(reset, preserveScroll = false\) \{([\s\S]*?)\n  \}\n\n  async loadTree\(\)/,
  )?.[1] || "";
assert.match(
  mediaLoadBody,
  /!reset \|\| preserveScroll[\s\S]*?captureScrollState\(this\.grid, "data-asset-key"\)/,
  "Media pagination must capture the visible card before requesting another page",
);
assert.match(
  mediaLoadBody,
  /appendChildrenPreservingScroll\(\s*this\.grid,\s*fragment,\s*"data-asset-key",\s*scrollState,\s*\);/,
  "Media pagination must append cards without rebuilding the loaded grid",
);
const loraLoadBody = [
  ...source.matchAll(
    /  async load\(reset, preserveScroll = false\) \{([\s\S]*?)\n  \}\n\n  async \w+/g,
  ),
]
  .map((match) => match[1])
  .find((body) => body.includes('"data-lora-key"')) || "";
assert.match(
  loraLoadBody,
  /!reset \|\| preserveScroll[\s\S]*?captureScrollState\(this\.list, "data-lora-key"\)/,
  "LoRA pagination must capture the visible row before requesting another page",
);
assert.match(
  loraLoadBody,
  /appendChildrenPreservingScroll\(\s*this\.list,\s*fragment,\s*"data-lora-key",\s*scrollState,\s*\);/,
  "LoRA pagination must append rows without rebuilding the loaded list",
);
assert.doesNotMatch(
  loraLoadBody,
  /this\.renderList\(\);/,
  "Loading more LoRAs must not rebuild already loaded rows",
);
assert.match(
  source,
  /function replaceChildrenPreservingScroll\(\s*element,\s*children = null,\s*anchorAttribute = "",\s*preservedState = null,\s*\) \{[\s\S]*?preservedState \|\| captureScrollState\(element, anchorAttribute\);/,
  "List rendering must accept the stable scroll anchor captured by an async operation",
);
assert.match(
  source,
  /setStatus\(message, kind = ""\) \{\s*updateStatusPreservingScroll\(\s*this\.status,\s*message,\s*kind,\s*this\.list,\s*"data-lora-key",\s*\);/,
);
assert.match(
  source,
  /function restoreScrollStateAfterLayout\(element, state\)[\s\S]*?__astralPendingScrollState[\s\S]*?window\.cancelAnimationFrame\(element\.__astralScrollRestoreFrame\)[\s\S]*?const latestState =\s*element\.__astralPendingScrollState \|\| pendingState;[\s\S]*?restoreScrollState\(element, latestState\);/,
);
assert.match(
  css,
  /\.astral-am-lora-browser-list,[\s\S]*?overflow-anchor:\s*none;[\s\S]*?scrollbar-gutter:\s*stable;/,
);
assert.match(
  css,
  /\.astral-am-status\s*\{[\s\S]*?box-sizing:\s*border-box;[\s\S]*?height:\s*37px;[\s\S]*?overflow:\s*hidden;[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/,
  "The status row must keep a fixed height so loading and result messages cannot resize the list",
);
assert.match(
  css,
  /\.astral-am-status\[hidden\]\s*\{[\s\S]*?display:\s*none;/,
  "Hidden status text must collapse instead of leaving a blank row",
);
assert.match(
  css,
  /\.astral-am-duplicate-groups\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?overflow:\s*auto;/,
);
assert.match(
  source,
  /setDuplicateStatus\(message, kind = ""\) \{[\s\S]*?this\.duplicateGroups,\s*"data-duplicate-sha",\s*\);/,
);
assert.equal(
  (
    source.match(
      /reloadPreservingLoadedCount\(this\.items\.length, true\)/g,
    ) || []
  ).length,
  2,
);
assert.match(source, /this\.loadTemplates\(true, true\)/);
assert.match(source, /this\.loadSkills\(true, true\)/);
assert.match(
  source,
  /refresh\.addEventListener\("click", \(\) => void this\.load\(true, true\)\)/,
  "The legacy media prompt refresh must preserve its scroll anchor",
);
assert.match(
  source,
  /refresh\.addEventListener\("click", \(\) => void this\.load\(true\)\)/,
);
assert.match(
  source,
  /async load\(reset, preserveScroll = false\) \{[\s\S]*?captureScrollState\(this\.list, "data-prompt-key"\)[\s\S]*?replaceChildrenPreservingScroll\(\s*this\.list,\s*fragment,\s*"data-prompt-key",\s*scrollState,\s*\);/,
  "The legacy media prompt browser must replace cards without losing scroll",
);
assert.match(
  source,
  /DEFAULT_ASSET_MANAGER_SHORTCUT[\s\S]*?from "\.\/astral_shortcuts\.js";/,
  "The asset manager must import the dedicated shortcut helpers",
);
assert.match(
  shortcutSource,
  /code:\s*"KeyM",\s*ctrl:\s*true,\s*alt:\s*true,/,
  "Ctrl + Alt + M must remain the recommended default",
);
assert.match(
  source,
  /this\.shortcutButtonLabel = createElement\(\s*"span",\s*"astral-am-shortcut-button-label",\s*"Shortcut",?\s*\);/,
);
assert.doesNotMatch(
  source,
  /this\.shortcutButtonValue|astral-am-shortcut-button-value/,
  "The shortcut button must show only its label",
);
assert.match(
  source,
  /headerActions\.prepend\(this\.shortcutButton\);[\s\S]*?headerActions\.append\(this\.refreshButton\);/,
);
assert.match(
  source,
  /function handleAssetManagerShortcut\(event\) \{[\s\S]*?matchesShortcut\(event, getAssetManagerShortcut\(\)\)[\s\S]*?document\.querySelector\("\[data-assets-astral-dialog='true'\]"\)\) return;[\s\S]*?const panelIsOpen = Boolean\(manager\?\.isOpen\(\)\);[\s\S]*?!panelIsOpen && isTextEntryTarget\(event\.target\)[\s\S]*?if \(panelIsOpen\) \{[\s\S]*?manager\.close\(\);[\s\S]*?openAssetManager\(manager\?\.activeTab \|\| "prompts"\);/,
  "The global shortcut must toggle the panel and preserve text-entry protection while closed",
);
assert.match(
  source,
  /document\.addEventListener\("keydown", handleAssetManagerShortcut, true\);/,
  "The shortcut must be captured before ComfyUI handles the same key",
);
assert.match(
  source,
  /setup\(\) \{[\s\S]*?installAssetManagerShortcut\(\);[\s\S]*?installAstralMenuButton\(\);/,
  "The shortcut must work before the manager is opened for the first time",
);
assert.match(
  source,
  /shortcutFromEvent: shortcutFromKeyboardEvent,[\s\S]*?validateShortcut: validateAssetManagerShortcut,[\s\S]*?formatShortcut,/,
);
assert.match(
  source,
  /if \(!saveAssetManagerShortcut\(nextShortcut\)\) \{[\s\S]*?showAstralAlert\(\{[\s\S]*?title: "Unable to Save Shortcut"/,
);
assert.match(
  css,
  /\.astral-am-shortcut-button\s*\{[\s\S]*?padding-inline:\s*12px;[\s\S]*?white-space:\s*nowrap;/,
);
assert.match(
  dialogSource,
  /export function showAstralShortcutRecorder\(/,
);
assert.match(
  dialogSource,
  /astral_dialogs\.css\?v=20261114-shortcut-1/,
);
assert.match(
  dialogCss,
  /\.astral-am-shortcut-recorder\s*\{[\s\S]*?min-height:\s*76px;[\s\S]*?place-content:\s*center;/,
);

console.log("Asset manager frontend checks passed.");
