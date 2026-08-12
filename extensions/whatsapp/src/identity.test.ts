// Whatsapp identity tests cover strict provider identity aliases.
import { describe, expect, it } from "vitest";
import { normalizeWhatsAppLidJid, resolveComparableIdentity } from "./identity.js";

describe("normalizeWhatsAppLidJid", () => {
  it.each([
    ["123@lid", "123@lid"],
    ["123:4@LID", "123@lid"],
    ["123:4@HOSTED.LID", "123@hosted.lid"],
    ["  whatsapp:whatsapp:123@hosted.lid  ", "123@hosted.lid"],
  ])("normalizes exact provider LID %j", (value, expected) => {
    expect(normalizeWhatsAppLidJid(value)).toBe(expected);
  });

  it.each([
    "\u0000123@lid",
    "123@lid\u007f",
    "\u00a0123@lid\u00a0",
    "\ufeff123@hosted.lid\ufeff",
    "\u2028123@lid\u2028",
    "telegram:123@lid",
    "123@lid.example",
    "abc@lid",
    "123@g.us",
    "123@newsletter",
  ])("rejects unsafe or foreign provider LID %j", (value) => {
    expect(normalizeWhatsAppLidJid(value)).toBeNull();
  });

  it("keeps unsafe provider aliases out of comparable identity", () => {
    expect(resolveComparableIdentity({ lid: "\u00a0123@lid\u00a0" }).lid).toBeNull();
    expect(resolveComparableIdentity({ lid: "123:4@hosted.lid" }).lid).toBe("123@hosted.lid");
  });
});
