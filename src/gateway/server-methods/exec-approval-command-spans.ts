type ExecApprovalCommandSpan = {
  startIndex: number;
  endIndex: number;
};

export function normalizeCommandSpans(
  spans: ExecApprovalCommandSpan[] | undefined,
  commandLength: number,
): ExecApprovalCommandSpan[] | undefined {
  if (!spans) {
    return undefined;
  }
  const candidates = spans
    .filter(
      (span) =>
        Number.isSafeInteger(span.startIndex) &&
        Number.isSafeInteger(span.endIndex) &&
        span.startIndex >= 0 &&
        span.endIndex > span.startIndex &&
        span.endIndex <= commandLength,
    )
    .toSorted((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
  const accepted: ExecApprovalCommandSpan[] = [];
  let cursor = 0;
  for (const span of candidates) {
    if (span.startIndex < cursor) {
      continue;
    }
    accepted.push({ startIndex: span.startIndex, endIndex: span.endIndex });
    cursor = span.endIndex;
  }
  return accepted.length > 0 ? accepted : undefined;
}
