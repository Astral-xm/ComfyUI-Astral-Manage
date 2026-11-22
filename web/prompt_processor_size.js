function finiteDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizedSize(size) {
  if (!Array.isArray(size) || size.length < 2) return null;
  return [
    finiteDimension(size[0]),
    finiteDimension(size[1]),
  ];
}

export function nextPromptProcessorSize({
  current = null,
  restored = null,
  user = null,
  minimum = null,
  minimumWidth = 150,
} = {}) {
  const currentSize = normalizedSize(current);
  const restoredSize = normalizedSize(restored);
  const userSize = normalizedSize(user);
  const minimumSize = normalizedSize(minimum);
  const safeMinimumWidth = Math.max(1, finiteDimension(minimumWidth));

  // A user resize owns the preferred dimensions. Current only fills the gap
  // before the first manual resize, while restored survives workflow loading.
  const preferredWidth =
    userSize?.[0] ||
    currentSize?.[0] ||
    restoredSize?.[0] ||
    safeMinimumWidth;
  const preferredHeight =
    userSize?.[1] ||
    currentSize?.[1] ||
    restoredSize?.[1] ||
    1;

  return [
    Math.ceil(
      Math.max(
        safeMinimumWidth,
        minimumSize?.[0] || 0,
        preferredWidth,
      ),
    ),
    Math.ceil(
      Math.max(
        1,
        minimumSize?.[1] || 0,
        preferredHeight,
      ),
    ),
  ];
}
