// Text format tests cover command-facing shortening helpers.
import { describe, expect, it } from "vitest";
import { shortenText } from "./text-format.js";

describe("shortenText", () => {
  it("returns original text when it fits", () => {
    expect(shortenText("afora", 16)).toBe("afora");
  });

  it("truncates and appends ellipsis when over limit", () => {
    expect(shortenText("afora-status-output", 10)).toBe("afora-…");
  });

  it("returns an empty string for non-positive limits", () => {
    expect(shortenText("afora", 0)).toBe("");
    expect(shortenText("afora", -1)).toBe("");
  });

  it("counts multi-byte characters correctly", () => {
    expect(shortenText("hello🙂world", 7)).toBe("hello🙂…");
  });
});
