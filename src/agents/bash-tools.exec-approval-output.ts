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
import { DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS } from "./tool-result-limits.js";

/** One named output stream supplied by an exec host. */
type ExecApprovalOutputStream = {
  label: string;
  value?: string | null;
};

/**
 * The exec host still needs an absolute transport bound before the resumed
 * attempt resolves its model. Gateway aggregate output and node combined
 * output are capped at 200k units, so 256k preserves every valid payload plus
 * stream headers while bounding malformed or future sources.
 */
const MAX_SOURCE_UTF16_UNITS = 256_000;
const HEAD_SHARE = 0.75;

export type ExecApprovalContinuationPromptRange = {
  start: number;
  end: number;
};

function buildOmissionMarker(params: {
  omitted: number;
  headUnits: number;
  tailUnits: number;
  resumingLabel?: string;
}): string {
  // Naming the stream the tail resumes in keeps label information intact
  // without splicing synthetic header bytes into the retained content, so the
  // three counts below always sum to the exact input length.
  const resuming = params.resumingLabel ? `; tail resumes in ${params.resumingLabel}` : "";
  return (
    `[... ${params.omitted} UTF-16 code units omitted from approved exec output; ` +
    `showing first ${params.headUnits} and last ${params.tailUnits}${resuming} ...]`
  );
}

/**
 * Head/tail budget for one input. The marker reserve is derived from the actual
 * input length rather than from `MAX_UTF16_UNITS`, because the omitted count
 * scales with the input and a fixed five-digit reserve would let a megabyte of
 * output push the result past the hard cap. `omitted` can never exceed the
 * input length, each retained side can never exceed the cap, and no stream
 * label is longer than `longestLabelUnits`, so this is the widest marker the
 * cut can produce for this input.
 */
function resolveCutBudget(
  totalUnits: number,
  longestLabelUnits: number,
  maxUtf16Units: number,
): { head: number; tail: number } {
  const markerReserve =
    buildOmissionMarker({
      omitted: totalUnits,
      headUnits: maxUtf16Units,
      tailUnits: maxUtf16Units,
      resumingLabel: "x".repeat(longestLabelUnits),
    }).length + 2;
  const content = Math.max(0, maxUtf16Units - markerReserve);
  const head = Math.floor(content * HEAD_SHARE);
  return { head, tail: content - head };
}

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

function readRenderedExecOutput(text: string): RenderedExecOutput {
  const headers = Array.from(text.matchAll(/(?:^|\n)\[(stdout|stderr|error)\]\n/g), (match) => {
    const leadingNewlineUnits = match[0].startsWith("\n") ? 1 : 0;
    const start = (match.index ?? 0) + leadingNewlineUnits;
    return {
      label: match[1] ?? "",
      start,
      end: start + match[0].length - leadingNewlineUnits,
    };
  });
  return {
    text,
    headerRanges: headers.map(({ start, end }) => ({ start, end })),
    streamRanges: headers.map((header, index) => ({
      label: header.label,
      contentStart: header.end,
      end: headers[index + 1]?.start ?? text.length,
    })),
  };
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

/**
 * Names the stream the retained tail belongs to when the omitted middle
 * swallowed that stream's header, so no label information is lost.
 */
function resolveResumingStreamLabel(params: {
  tailStart: number;
  headEnd: number;
  streamRanges: StreamRange[];
}): string | undefined {
  const tailStream = params.streamRanges.find(
    (range) => range.contentStart <= params.tailStart && params.tailStart < range.end,
  );
  if (!tailStream || params.headEnd >= tailStream.contentStart) {
    return undefined;
  }
  return tailStream.label;
}

/**
 * Renders approved exec output for the agent continuation, preserving exact
 * bytes under the cap and reporting an exact omitted-unit count above it.
 */
function formatRenderedExecApprovalContinuationOutput(
  rendered: RenderedExecOutput,
  maxUtf16Units: number,
): string {
  const requestedMax = Number.isFinite(maxUtf16Units)
    ? Math.floor(maxUtf16Units)
    : DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS;
  const boundedMax = Math.max(1, Math.min(requestedMax, MAX_SOURCE_UTF16_UNITS));
  if (rendered.text.length <= boundedMax) {
    return rendered.text;
  }

  const longestLabelUnits = rendered.streamRanges.reduce(
    (widest, range) => Math.max(widest, range.label.length),
    0,
  );
  const budget = resolveCutBudget(rendered.text.length, longestLabelUnits, boundedMax);
  const headEnd = moveCutOutsideHeader(budget.head, rendered.headerRanges, "head");
  const tailStart = moveCutOutsideHeader(
    rendered.text.length - budget.tail,
    rendered.headerRanges,
    "tail",
  );

  const head = sliceUtf16Safe(rendered.text, 0, headEnd);
  const tail = sliceUtf16Safe(rendered.text, tailStart);
  const marker = buildOmissionMarker({
    omitted: rendered.text.length - head.length - tail.length,
    headUnits: head.length,
    tailUnits: tail.length,
    resumingLabel: resolveResumingStreamLabel({
      tailStart,
      headEnd,
      streamRanges: rendered.streamRanges,
    }),
  });
  const formatted = `${head}\n${marker}\n${tail}`;
  if (formatted.length <= boundedMax) {
    return formatted;
  }
  return sliceUtf16Safe(
    `[... ${rendered.text.length} UTF-16 code units omitted from approved exec output ...]`,
    0,
    boundedMax,
  );
}

/**
 * Formats the host-owned stream structure without imposing the model-specific
 * cap. The resolved attempt applies that final cap before persistence and
 * provider submission.
 */
export function formatExecApprovalContinuationSourceOutput(
  streams: ExecApprovalOutputStream[],
): string {
  return formatRenderedExecApprovalContinuationOutput(
    renderExecOutputStreams(streams),
    MAX_SOURCE_UTF16_UNITS,
  );
}

/** Applies the resolved attempt's output allowance to the marked prompt span. */
export function resizeExecApprovalContinuationPrompt(params: {
  prompt: string;
  range: ExecApprovalContinuationPromptRange;
  maxOutputUtf16Units: number;
}): string {
  const { prompt, range } = params;
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start ||
    range.end > prompt.length
  ) {
    return prompt;
  }
  const resultText = prompt.slice(range.start, range.end);
  const resized = formatRenderedExecApprovalContinuationOutput(
    readRenderedExecOutput(resultText),
    params.maxOutputUtf16Units,
  );
  return `${prompt.slice(0, range.start)}${resized}${prompt.slice(range.end)}`;
}
