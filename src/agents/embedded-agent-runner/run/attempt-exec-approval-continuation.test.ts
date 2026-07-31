import { describe, expect, it, vi } from "vitest";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import { prepareExecApprovalContinuationForAttempt } from "./attempt-exec-approval-continuation.js";

function buildPrompt() {
  const prefix = "resume approved exec\n";
  const result = `Exec finished (code 1)\n[stdout]\n${"a".repeat(50_000)}\n[stderr]\n${"b".repeat(50_000)}`;
  const suffix = "\ncontinue the task";
  return {
    prompt: `${prefix}${result}${suffix}`,
    range: { start: prefix.length, end: prefix.length + result.length },
    prefix,
    suffix,
  };
}

describe("prepareExecApprovalContinuationForAttempt", () => {
  it("uses the resolved attempt context to size only the completion span", () => {
    const fixture = buildPrompt();
    const replaceTextBeforePersistence = vi.fn();

    const result = prepareExecApprovalContinuationForAttempt({
      prompt: fixture.prompt,
      transcriptPrompt: fixture.prompt,
      promptRange: fixture.range,
      contextTokenBudget: 128_000,
      modelContextWindow: 200_000,
      userTurnTranscriptRecorder: {
        replaceTextBeforePersistence,
      } as unknown as UserTurnTranscriptRecorder,
    });

    expect(result.prompt.startsWith(fixture.prefix)).toBe(true);
    expect(result.prompt.endsWith(fixture.suffix)).toBe(true);
    expect(result.prompt.length).toBeLessThanOrEqual(
      fixture.prefix.length + 32_000 + fixture.suffix.length,
    );
    expect(result.prompt).toMatch(/tail resumes in stderr/);
    expect(result.transcriptPrompt).toBe(result.prompt);
    expect(replaceTextBeforePersistence).toHaveBeenCalledWith(result.prompt);
  });

  it("raises the allowance for an XL resolved context", () => {
    const fixture = buildPrompt();

    const result = prepareExecApprovalContinuationForAttempt({
      prompt: fixture.prompt,
      promptRange: fixture.range,
      modelContextWindow: 200_000,
    });

    expect(result.prompt.length).toBeGreaterThan(fixture.prefix.length + 32_000);
    expect(result.prompt.length).toBeLessThanOrEqual(
      fixture.prefix.length + 64_000 + fixture.suffix.length,
    );
  });

  it("uses distinct runtime and transcript spans after prompt decoration", () => {
    const fixture = buildPrompt();
    const retryPrefix = "[Retry after the previous model attempt failed]\n\n";
    const runtimePrompt = `${retryPrefix}${fixture.prompt}`;

    const result = prepareExecApprovalContinuationForAttempt({
      prompt: runtimePrompt,
      transcriptPrompt: fixture.prompt,
      promptRange: {
        start: retryPrefix.length + fixture.range.start,
        end: retryPrefix.length + fixture.range.end,
      },
      transcriptPromptRange: fixture.range,
      contextTokenBudget: 128_000,
    });

    expect(result.prompt.startsWith(`${retryPrefix}${fixture.prefix}`)).toBe(true);
    expect(result.prompt.endsWith(fixture.suffix)).toBe(true);
    expect(result.transcriptPrompt?.startsWith(fixture.prefix)).toBe(true);
    expect(result.transcriptPrompt?.endsWith(fixture.suffix)).toBe(true);
    expect(result.prompt.length).toBe(retryPrefix.length + result.transcriptPrompt!.length);
    expect(result.prompt).toMatch(/UTF-16 code units omitted from approved exec output/);
  });

  it("leaves ordinary prompts and transcript ownership untouched", () => {
    const replaceTextBeforePersistence = vi.fn();

    const result = prepareExecApprovalContinuationForAttempt({
      prompt: "ordinary turn",
      transcriptPrompt: "ordinary transcript",
      modelContextWindow: 200_000,
      userTurnTranscriptRecorder: {
        replaceTextBeforePersistence,
      } as unknown as UserTurnTranscriptRecorder,
    });

    expect(result).toEqual({
      prompt: "ordinary turn",
      transcriptPrompt: "ordinary transcript",
    });
    expect(replaceTextBeforePersistence).not.toHaveBeenCalled();
  });
});
