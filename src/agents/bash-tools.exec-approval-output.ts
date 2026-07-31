/**
 * Output formatting for approved async exec continuations.
 *
 * This is deliberately NOT the compact background-notification formatter
 * (`normalizeNotifyOutput` + `DEFAULT_NOTIFY_TAIL_CHARS`, exec-runtime.ts). A
 * notification is one chat line; a continuation is the model's only view of a
 * command it already approved, so newlines, indentation and trailing
 * whitespace are preserved verbatim and the budget is the model-facing one.
 */
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

/** One named output stream supplied by an exec host. */
export type ExecApprovalOutputStream = {
  label: string;
  value?: string | null;
};

/**
 * Hard cap for continuation output, mirroring
 * `DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS` (tool-result-limits.ts): the floor every
 * exec tool result is truncated to when the model context window is unknown.
 * The host builds this text before the resuming agent's model is resolved, and
 * the text re-enters as a user follow-up that bypasses the tool-result guard,
 * so it needs its own bound. Head-weighted because command output front-loads
 * the failure and back-loads the summary.
 */
const MAX_UTF16_UNITS = 16_000;
const HEAD_SHARE = 0.75;

function buildOmissionMarker(params: {
  omitted: number;
  headUnits: number;
  tailUnits: number;
}): string {
  return (
    `[... ${params.omitted} UTF-16 code units omitted from approved exec output; ` +
    `showing first ${params.headUnits} and last ${params.tailUnits} ...]`
  );
}

// Widest marker the cut can produce, so headers, marker and both newlines are
// budgeted inside MAX_UTF16_UNITS instead of pushing the result over it.
const MARKER_RESERVE_UNITS =
  buildOmissionMarker({
    omitted: MAX_UTF16_UNITS,
    headUnits: MAX_UTF16_UNITS,
    tailUnits: MAX_UTF16_UNITS,
  }).length + 2;
const CONTENT_BUDGET_UNITS = MAX_UTF16_UNITS - MARKER_RESERVE_UNITS;
const HEAD_BUDGET_UNITS = Math.floor(CONTENT_BUDGET_UNITS * HEAD_SHARE);
const TAIL_BUDGET_UNITS = CONTENT_BUDGET_UNITS - HEAD_BUDGET_UNITS;

/** Continuation output budget, exported so tests assert against one source. */
export const EXEC_APPROVAL_CONTINUATION_OUTPUT_LIMITS = {
  maxUtf16Units: MAX_UTF16_UNITS,
  headUtf16Units: HEAD_BUDGET_UNITS,
  tailUtf16Units: TAIL_BUDGET_UNITS,
} as const;

type HeaderRange = { start: number; end: number };
type StreamRange = { label: string; contentStart: number; end: number };

type RenderedExecOutput = {
  text: string;
  headerRanges: HeaderRange[];
  streamRanges: StreamRange[];
};

function renderExecOutputStreams(streams: ExecApprovalOutputStream[]): RenderedExecOutput {
  const present = streams.filter(
    (stream): stream is { label: string; value: string } =>
      typeof stream.value === "string" && /\S/.test(stream.value),
  );
  if (present.length === 0) {
    return { text: "", headerRanges: [], streamRanges: [] };
  }
  // A lone stream is emitted verbatim: the gateway supplies one already
  // interleaved aggregate, and a header there would imply a split that the
  // payload does not actually carry.
  const [only] = present;
  if (present.length === 1 && only) {
    return { text: only.value, headerRanges: [], streamRanges: [] };
  }

  let text = "";
  const headerRanges: HeaderRange[] = [];
  const streamRanges: StreamRange[] = [];
  for (const stream of present) {
    if (text) {
      text += "\n";
    }
    const header = `[${stream.label}]\n`;
    const headerStart = text.length;
    text += header;
    headerRanges.push({ start: headerStart, end: text.length });
    const contentStart = text.length;
    text += stream.value;
    streamRanges.push({ label: stream.label, contentStart, end: text.length });
  }
  return { text, headerRanges, streamRanges };
}

/**
 * Pushes a cut off the interior of a generated header so a partial `[stde`
 * never reaches the model. Both directions shrink what is retained, which keeps
 * the budget arithmetic below valid.
 */
function moveCutOutsideHeader(
  cut: number,
  headerRanges: HeaderRange[],
  direction: "head" | "tail",
): number {
  const containing = headerRanges.find((range) => range.start < cut && cut < range.end);
  if (!containing) {
    return cut;
  }
  return direction === "head" ? containing.start : containing.end;
}

/** Re-emits the tail stream's header when the omitted middle swallowed it. */
function resolveRetainedTailLabel(params: {
  tailStart: number;
  headEnd: number;
  streamRanges: StreamRange[];
}): string {
  const tailStream = params.streamRanges.find(
    (range) => range.contentStart <= params.tailStart && params.tailStart < range.end,
  );
  if (!tailStream || params.headEnd >= tailStream.contentStart) {
    return "";
  }
  return `[${tailStream.label}]\n`;
}

/**
 * Renders approved exec output for the agent continuation, preserving exact
 * bytes under the cap and reporting an exact omitted-unit count above it.
 */
export function formatExecApprovalContinuationOutput(streams: ExecApprovalOutputStream[]): string {
  const rendered = renderExecOutputStreams(streams);
  if (rendered.text.length <= MAX_UTF16_UNITS) {
    return rendered.text;
  }

  let headEnd = moveCutOutsideHeader(HEAD_BUDGET_UNITS, rendered.headerRanges, "head");
  const tailStart = moveCutOutsideHeader(
    rendered.text.length - TAIL_BUDGET_UNITS,
    rendered.headerRanges,
    "tail",
  );
  const tailLabel = resolveRetainedTailLabel({
    tailStart,
    headEnd,
    streamRanges: rendered.streamRanges,
  });
  if (tailLabel) {
    // The re-added header is paid for out of the head so the total stays capped.
    headEnd = moveCutOutsideHeader(headEnd - tailLabel.length, rendered.headerRanges, "head");
  }

  const head = sliceUtf16Safe(rendered.text, 0, headEnd);
  const tail = sliceUtf16Safe(rendered.text, tailStart);
  const omitted = rendered.text.length - head.length - tail.length - tailLabel.length;
  const marker = buildOmissionMarker({
    omitted,
    headUnits: head.length,
    tailUnits: tail.length,
  });
  return `${head}\n${marker}\n${tailLabel}${tail}`;
}
