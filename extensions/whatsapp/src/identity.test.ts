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

  it.each(["123:4:5@lid", "123:4:5@hosted.lid", "123:4:5@s.whatsapp.net", "123:4:5@hosted"])(
    "keeps malformed multi-device JID %j non-comparable",
    (jid) => {
      expect(resolveComparableIdentity({ jid })).toEqual({
        jid,
        lid: null,
        e164: null,
      });
    },
  );

  it.each([
    ["123:4@s.whatsapp.net", { jid: "123@s.whatsapp.net", lid: null, e164: "+123" }],
    ["123:4@hosted", { jid: "123@hosted", lid: null, e164: "+123" }],
    ["123:4@lid", { jid: null, lid: "123@lid", e164: null }],
    ["123:4@hosted.lid", { jid: null, lid: "123@hosted.lid", e164: null }],
  ])("canonicalizes exactly one device segment in %j", (jid, expected) => {
    expect(resolveComparableIdentity({ jid })).toEqual(expected);
  });
});
