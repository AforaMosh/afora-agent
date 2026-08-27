import { describe, expect, it } from "vitest";
import type { AforaConfig } from "../../config/types.afora.js";
import { resolveRequestedChatAgentId } from "./chat-origin-routing.js";

describe("chat session owner resolution", () => {
  it("uses configured fixed-store ownership for bare keys", () => {
    const cfg: AforaConfig = {
      session: { store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    expect(resolveRequestedChatAgentId({ cfg, requestedSessionKey: "global" })).toEqual({
      ok: true,
      agentId: "ops",
    });
  });

  it("returns the typed selection error for ownerless bare keys", () => {
    const cfg: AforaConfig = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    };

    expect(resolveRequestedChatAgentId({ cfg, requestedSessionKey: "global" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("has no explicit owner") },
    });
  });
});
