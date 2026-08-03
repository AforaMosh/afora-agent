// Verifies canonical configured open-inbound policy discovery for all audit consumers.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listConfiguredOpenInboundPolicyPaths } from "./audit-open-inbound.js";

describe("configured open inbound policy paths", () => {
  it("resolves account, legacy DM, precedence, and nested channel scopes", () => {
    const cfg = {
      channels: {
        discord: {
          dmPolicy: "allowlist",
          dm: { policy: "open" },
          accounts: {
            work: { groupPolicy: "open", dm: { policy: "open" } },
          },
        },
        telegram: {
          groupPolicy: "allowlist",
          groups: { "-10042": { groupPolicy: "open" } },
          direct: { alice: { dmPolicy: "open" } },
        },
      },
    } as unknown as OpenClawConfig;

    expect(listConfiguredOpenInboundPolicyPaths(cfg)).toEqual([
      "channels.discord.accounts.work.dm.policy",
      "channels.discord.accounts.work.groupPolicy",
      "channels.telegram.direct.alice.dmPolicy",
      "channels.telegram.groups.-10042.groupPolicy",
    ]);
  });
});
