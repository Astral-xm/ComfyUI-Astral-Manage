import {
  registerLocalizationRoot,
  unregisterLocalizationRoot,
} from "./astral_i18n.js";

const DIALOG_STYLE_SELECTOR = "link[data-assets-astral-dialog-styles]";
const DIALOG_STYLE_URL = new URL(
  "./astral_dialogs.css?v=20261114-shortcut-1",
  import.meta.url,
).href;

let activeDialog = null;
let dialogSerial = 0;

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function ensureDialogStyles() {
  if (document.querySelector(DIALOG_STYLE_SELECTOR)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = DIALOG_STYLE_URL;
  link.dataset.assetsAstralDialogStyles = "true";
  document.head.append(link);
}

function createDialogFrame({
  title,
  message = "",
  className = "",
  tone = "info",
  role = "dialog",
}) {
  ensureDialogStyles();
  const serial = ++dialogSerial;
  const dialog = createElement(
    "div",
    `astral-am-dialog${className ? ` ${className}` : ""}`,
  );
  const shell = createElement("div", "astral-am-dialog-shell");
  const heading = createElement("div", "astral-am-dialog-heading");
  const icon = createElement(
    "span",
    `astral-am-dialog-icon is-${tone}`,
    tone === "danger" ? "!" : tone === "warning" ? "!" : "i",
  );
  const titleElement = createElement("h2", "astral-am-dialog-title", title);
  const messageElement = createElement(
    "p",
    "astral-am-dialog-message",
    message,
  );
  const titleId = `astral-am-dialog-title-${serial}`;
  const messageId = `astral-am-dialog-message-${serial}`;

  dialog.setAttribute("role", role);
  dialog.setAttribute("data-assets-astral-dialog", "true");
  dialog.setAttribute("aria-labelledby", titleId);
  dialog.tabIndex = -1;
  if (message) dialog.setAttribute("aria-describedby", messageId);
  titleElement.id = titleId;
  messageElement.id = messageId;
  icon.setAttribute("aria-hidden", "true");
  heading.append(icon, titleElement);
  shell.append(heading);
  if (message) shell.append(messageElement);
  dialog.append(shell);

  return { dialog, shell };
}

function mountDialog(dialog, defaultResult, resolve, focusTarget) {
  let settled = false;
  const handleOutsidePointer = (event) => {
    if (dialog.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    finish(defaultResult);
  };
  const handleKeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finish(defaultResult);
    }
  };
  const finish = (result) => {
    if (settled) return;
    settled = true;
    if (activeDialog === dialog) activeDialog = null;
    document.removeEventListener("pointerdown", handleOutsidePointer, true);
    document.removeEventListener("keydown", handleKeydown, true);
    unregisterLocalizationRoot(dialog);
    dialog.remove();
    resolve(result);
  };

  document.body.append(dialog);
  registerLocalizationRoot(dialog);
  activeDialog = dialog;
  document.addEventListener("pointerdown", handleOutsidePointer, true);
  document.addEventListener("keydown", handleKeydown, true);
  focusTarget?.focus?.();
  return finish;
}

function createButton(label, className = "") {
  const button = createElement(
    "button",
    `astral-am-dialog-button${className ? ` ${className}` : ""}`,
    label,
  );
  button.type = "button";
  return button;
}

export function showAstralConfirm({
  title = "Confirm Action",
  message = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
} = {}) {
  if (activeDialog) {
    activeDialog.focus();
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const { dialog, shell } = createDialogFrame({
      title,
      message,
      className: "is-confirm",
      tone,
      role: "alertdialog",
    });
    const actions = createElement("div", "astral-am-dialog-actions");
    const cancelButton = createButton(cancelLabel);
    const confirmButton = createButton(
      confirmLabel,
      `is-primary${tone === "danger" ? " is-danger" : ""}`,
    );
    actions.append(cancelButton, confirmButton);
    shell.append(actions);
    const finish = mountDialog(dialog, false, resolve, cancelButton);
    cancelButton.addEventListener("click", () => finish(false));
    confirmButton.addEventListener("click", () => finish(true));
  });
}

export function showAstralPrompt({
  title = "Enter Content",
  message = "",
  label = "",
  initialValue = "",
  placeholder = "",
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  multiline = false,
} = {}) {
  if (activeDialog) {
    activeDialog.focus();
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const { dialog, shell } = createDialogFrame({
      title,
      message,
      className: "is-prompt",
      tone: "info",
    });
    const form = createElement("div", "astral-am-dialog-form");
    const labelElement = createElement(
      "label",
      "astral-am-dialog-label",
      label || title,
    );
    const input = createElement(
      multiline ? "textarea" : "input",
      `astral-am-dialog-input${multiline ? " astral-am-dialog-textarea" : ""}`,
    );
    const actions = createElement("div", "astral-am-dialog-actions");
    const cancelButton = createButton(cancelLabel);
    const confirmButton = createButton(confirmLabel, "is-primary");
    const inputId = `astral-am-dialog-input-${dialogSerial}`;

    input.id = inputId;
    if (!multiline) input.type = "text";
    input.value = String(initialValue ?? "");
    input.placeholder = placeholder;
    input.autocomplete = "off";
    if (multiline) {
      input.rows = 7;
      input.spellcheck = false;
    }
    labelElement.htmlFor = inputId;
    form.append(labelElement, input);
    actions.append(cancelButton, confirmButton);
    shell.append(form, actions);

    const finish = mountDialog(dialog, null, resolve, input);
    cancelButton.addEventListener("click", () => finish(null));
    confirmButton.addEventListener("click", () => finish(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      if (multiline && !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      finish(input.value);
    });
    window.setTimeout(() => input.select(), 0);
  });
}

export function showAstralSelect({
  title = "Select Content",
  message = "",
  label = "",
  options = [],
  initialValue = "",
  confirmLabel = "OK",
  cancelLabel = "Cancel",
} = {}) {
  if (activeDialog) {
    activeDialog.focus();
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const { dialog, shell } = createDialogFrame({
      title,
      message,
      className: "is-select",
      tone: "info",
    });
    const form = createElement("div", "astral-am-dialog-form");
    const labelElement = createElement(
      "label",
      "astral-am-dialog-label",
      label || title,
    );
    const select = createElement(
      "select",
      "astral-am-dialog-input astral-am-dialog-select",
    );
    const actions = createElement("div", "astral-am-dialog-actions");
    const cancelButton = createButton(cancelLabel);
    const confirmButton = createButton(confirmLabel, "is-primary");
    const selectId = `astral-am-dialog-select-${dialogSerial}`;

    for (const rawOption of options) {
      const optionData =
        typeof rawOption === "object" && rawOption !== null
          ? rawOption
          : { value: rawOption, label: rawOption };
      const value = String(optionData.value ?? "");
      const option = createElement(
        "option",
        "",
        optionData.label ?? value,
      );
      option.value = value;
      option.disabled = Boolean(optionData.disabled);
      select.append(option);
    }
    if (
      [...select.children].some(
        (option) =>
          option.value === String(initialValue ?? "") && !option.disabled,
      )
    ) {
      select.value = String(initialValue ?? "");
    }

    select.id = selectId;
    labelElement.htmlFor = selectId;
    form.append(labelElement, select);
    actions.append(cancelButton, confirmButton);
    shell.append(form, actions);

    const finish = mountDialog(dialog, null, resolve, select);
    cancelButton.addEventListener("click", () => finish(null));
    confirmButton.addEventListener("click", () => finish(select.value));
    select.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      finish(select.value);
    });
  });
}

export function showAstralShortcutRecorder({
  title = "Customize Panel Shortcut",
  message = "Set the shortcut that opens the Asset Manager. It takes effect immediately and works while the panel is closed.",
  initialShortcut = null,
  defaultShortcut = null,
  shortcutFromEvent = () => null,
  validateShortcut = () => "",
  formatShortcut = (shortcut) => shortcut?.code || "",
  resetLabel = "Restore Default",
  confirmLabel = "Save",
  cancelLabel = "Cancel",
} = {}) {
  if (activeDialog) {
    activeDialog.focus();
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const { dialog, shell } = createDialogFrame({
      title,
      message,
      className: "is-shortcut",
      tone: "info",
    });
    const recorder = createElement(
      "div",
      "astral-am-shortcut-recorder",
    );
    recorder.tabIndex = 0;
    recorder.setAttribute("role", "button");
    recorder.setAttribute("aria-label", "Shortcut capture area");
    const preview = createElement(
      "strong",
      "astral-am-shortcut-preview",
    );
    const hint = createElement(
      "span",
      "astral-am-shortcut-hint",
      "Press the new shortcut combination.",
    );
    const status = createElement("p", "astral-am-shortcut-status");
    status.setAttribute("aria-live", "polite");
    const actions = createElement(
      "div",
      "astral-am-dialog-actions is-split",
    );
    const resetButton = createButton(resetLabel);
    const actionGroup = createElement(
      "div",
      "astral-am-dialog-actions-group",
    );
    const cancelButton = createButton(cancelLabel);
    const confirmButton = createButton(confirmLabel, "is-primary");
    let candidate = initialShortcut || defaultShortcut || null;

    actionGroup.append(cancelButton, confirmButton);
    actions.append(resetButton, actionGroup);
    recorder.append(preview, hint);
    shell.append(recorder, status, actions);

    const formatCandidate = () =>
      candidate ? formatShortcut(candidate) : "";
    const renderCandidate = (instruction = "") => {
      const formatted = formatCandidate();
      const validationError = candidate ? validateShortcut(candidate) : "";
      preview.textContent = formatted || "Waiting for keys...";
      recorder.dataset.empty = formatted ? "false" : "true";
      status.className = `astral-am-shortcut-status${
        validationError ? " is-error" : formatted ? " is-valid" : ""
      }`;
      status.textContent =
        validationError ||
        instruction ||
        "Press \"Save\" to apply the new shortcut.";
      confirmButton.disabled = !candidate || Boolean(validationError);
      resetButton.disabled =
        !defaultShortcut ||
        (candidate !== null &&
          formatCandidate() === formatShortcut(defaultShortcut) &&
          validateShortcut(candidate) === "");
    };

    const finish = mountDialog(dialog, null, resolve, recorder);
    resetButton.addEventListener("click", () => {
      candidate = defaultShortcut;
      renderCandidate("The recommended shortcut was restored. Press Save to apply it.");
      recorder.focus();
    });
    cancelButton.addEventListener("click", () => finish(null));
    confirmButton.addEventListener("click", () => {
      if (!candidate || validateShortcut(candidate)) return;
      finish(candidate);
    });
    recorder.addEventListener("click", () => recorder.focus());
    recorder.addEventListener("keydown", (event) => {
      if (event.key === "Escape") return;
      if (
        event.key === "Tab" &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const captured = shortcutFromEvent(event);
      if (!captured) {
        candidate = null;
        renderCandidate("Now press a letter, number, or function key.");
        return;
      }
      candidate = captured;
      renderCandidate();
    });
    renderCandidate();
  });
}

export function showAstralAlert({
  title = "Notice",
  message = "",
  confirmLabel = "Got it",
  tone = "info",
} = {}) {
  if (activeDialog) {
    activeDialog.focus();
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const { dialog, shell } = createDialogFrame({
      title,
      message,
      className: "is-alert",
      tone,
      role: "alertdialog",
    });
    const actions = createElement("div", "astral-am-dialog-actions");
    const confirmButton = createButton(confirmLabel, "is-primary");
    actions.append(confirmButton);
    shell.append(actions);
    const finish = mountDialog(dialog, false, resolve, confirmButton);
    confirmButton.addEventListener("click", () => finish(true));
  });
}
