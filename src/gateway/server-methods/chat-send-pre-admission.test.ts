import { describe, expect, it } from "vitest";
import type { AforaConfig } from "../../config/types.afora.js";
import { resolveChatSendStopOwnerScope } from "./chat-send-stop-owner-scope.js";

describe("chat send stop ownership", () => {
  it("keeps the selected filter separate from the compatibility run fallback", () => {
    const cfg: AforaConfig = {
      session: { scope: "global", store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    expect(
      resolveChatSendStopOwnerScope({
        cfg,
        selectedAgentId: "research",
        sessionKey: "global",
      }),
    ).toEqual({ agentId: "research", defaultAgentId: "ops" });
  });
});
