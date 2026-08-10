// Channel entry resolution tests preserve canonical-id and alias collision semantics.
import { describe, expect, it } from "vitest";
import { resolveChannelTarget } from "./channel-entry-resolution.js";

const entries = [
  { id: "feishu", meta: { aliases: ["lark", "telegram", "shared"] } },
  { id: "telegram", meta: { aliases: ["tg", "shared"] } },
] as const;

describe("resolveChannelTarget", () => {
  it("normalizes canonical ids and aliases", () => {
    expect(resolveChannelTarget({ raw: " TELEGRAM ", entries })?.id).toBe("telegram");
    expect(resolveChannelTarget({ raw: "Lark", entries })?.id).toBe("feishu");
  });

  it("prefers canonical ids over earlier aliases", () => {
    expect(resolveChannelTarget({ raw: "telegram", entries })?.id).toBe("telegram");
  });

  it("keeps discovery order for duplicate aliases", () => {
    expect(resolveChannelTarget({ raw: "shared", entries })?.id).toBe("feishu");
  });

  it("rejects blank and unknown targets", () => {
    expect(resolveChannelTarget({ raw: " ", entries })).toBeUndefined();
    expect(resolveChannelTarget({ raw: "unknown", entries })).toBeUndefined();
  });

  it("keeps an exact catalog id authoritative over a registered alias", () => {
    expect(resolveChannelTarget({ raw: "telegram", entries, registeredId: "feishu" })).toEqual({
      id: "telegram",
      entry: entries[1],
    });
  });

  it("keeps the active registry authoritative for aliases", () => {
    expect(resolveChannelTarget({ raw: "shared", entries, registeredId: "telegram" })).toEqual({
      id: "telegram",
      entry: entries[1],
    });
    expect(resolveChannelTarget({ raw: "lark", entries })).toEqual({
      id: "feishu",
      entry: entries[0],
    });
  });
});
