/** Tests ACP request metadata parsing for the process-local session runtime. */
import { describe, expect, it } from "vitest";
import { parseSessionMeta } from "./session-mapper.js";

describe("acp session mapper", () => {
  it("parses supported routing aliases", () => {
    expect(
      parseSessionMeta({
        session: "agent:main:work",
        label: "support",
        reset: true,
        requireExistingSession: true,
        prefixCwd: false,
      }),
    ).toEqual({
      sessionKey: "agent:main:work",
      sessionLabel: "support",
      resetSession: true,
      requireExisting: true,
      prefixCwd: false,
    });
  });

  it("ignores non-object metadata", () => {
    expect(parseSessionMeta(undefined)).toEqual({});
    expect(parseSessionMeta("session")).toEqual({});
  });
});
