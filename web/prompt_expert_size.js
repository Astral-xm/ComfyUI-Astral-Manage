function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function nextPromptExpertSize({
  content = 0,
  user = null,
  minimumWidth = 420,
  currentWidth = 0,
  force = false,
} = {}) {
  const minWidth = positive(minimumWidth, 420);
  const userWidth = Array.isArray(user) ? positive(user[0], 0) : 0;
  const width = Math.ceil(
    Math.max(minWidth, positive(currentWidth, 0), userWidth),
  );
  const contentHeight = Math.ceil(positive(content, 1));
  const userHeight = Array.isArray(user) ? positive(user[1], 0) : 0;
  // Collapsing a section shrinks the node even below a manual height; otherwise
  // a manual resize stays as the minimum until the next collapse/expand.
  const height = force
    ? contentHeight
    : Math.ceil(Math.max(contentHeight, userHeight));
  return [width, Math.max(1, height)];
}
