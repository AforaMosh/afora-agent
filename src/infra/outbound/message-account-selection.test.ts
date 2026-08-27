import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { AforaConfig } from "../../config/types.afora.js";
import { validateExplicitMessageAccountSelection } from "./message-account-selection.js";

describe("validateExplicitMessageAccountSelection", () => {
  const cfg = {} as AforaConfig;
  const plugin = {
    id: "feishu",
    config: {
      listAccountIds: () => ["default"],
      defaultAccountId: () => "ops",
      resolveAccount: (_cfg: AforaConfig, accountId?: string | null) => ({
        accountId,
        enabled: true,
      }),
    },
  } as unknown as ChannelPlugin;

  it("accepts the plugin-resolved default when it is intentionally unlisted", () => {
    expect(
      validateExplicitMessageAccountSelection({
        cfg,
        channel: "feishu",
        accountId: "OPS",
        plugin,
      }),
    ).toBe("ops");
  });

  it("still rejects a non-default unlisted account", () => {
    expect(() =>
      validateExplicitMessageAccountSelection({
        cfg,
        channel: "feishu",
        accountId: "missing",
        plugin,
      }),
    ).toThrow('Unknown account "missing"');
  });
});
