import { describe, expectTypeOf, it } from "vitest";
import type { GetReplyOptions } from "./reply-runtime.js";

type ProgressResult = boolean | void;
type ProgressCallback = GetReplyOptions[
  | "onToolResult"
  | "onToolStart"
  | "onItemEvent"
  | "onPlanUpdate"
  | "onApprovalEvent"
  | "onCommandOutput"
  | "onPatchSummary"];

describe("reply runtime public progress contracts", () => {
  it("exports acceptance-aware progress callback results", () => {
    expectTypeOf<Exclude<ProgressCallback, undefined>>().returns.toEqualTypeOf<
      Promise<ProgressResult> | ProgressResult
    >();
    expectTypeOf<Exclude<GetReplyOptions["onPartialReply"], undefined>>().returns.toEqualTypeOf<
      Promise<ProgressResult> | ProgressResult
    >();
    expectTypeOf<Exclude<GetReplyOptions["onReasoningStream"], undefined>>().returns.toEqualTypeOf<
      Promise<ProgressResult> | ProgressResult
    >();
  });

  it("exports the asynchronous visibility listener registration contract", () => {
    expectTypeOf<
      Exclude<GetReplyOptions["registerProgressVisibilityListener"], undefined>
    >().toEqualTypeOf<(listener: () => void) => void>();
  });
});
