import { describe, expect, it } from "vitest";
import {
  createAforaTestState as createAforaTestStateDirect,
  withAforaTestState as withAforaTestStateDirect,
} from "../test-utils/afora-test-state.js";
import { createAforaTestState, withAforaTestState } from "./test-state.js";

describe("test-state SDK seam", () => {
  it("re-exports the canonical isolated state lifecycle", () => {
    expect(createAforaTestState).toBe(createAforaTestStateDirect);
    expect(withAforaTestState).toBe(withAforaTestStateDirect);
  });
});
