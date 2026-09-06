/**
 * The session routing header, under both of its spellings (afora-compat).
 *
 * A turn is pinned to one on-disk agent session by `x-afora-session-key`. The debrand renamed
 * that header from `x-openclaw-session-key`, and three senders on the host still speak the old
 * name: the console's turn runner, /api/build, and the goal watchdog in the tenant's own
 * workspace. Two of those are copies a tenant already has on disk, so they cannot all be
 * updated in the same breath as the gateway.
 *
 * The failure is silent and total. An unrecognised header is not rejected, it is ignored, so
 * the turn is routed to a brand new session: the tenant asks a follow-up question and the
 * agent has never heard of the conversation. Nothing throws, nothing is logged, and the
 * gateway reports a healthy turn.
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { readRequestedSessionKeyHeader, resolveGatewayRequestContext } from "./http-utils.js";

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

const CANONICAL = "x-afora-session-key";
const LEGACY = "x-openclaw-session-key"; // afora-compat: the name the host senders still use

describe("readRequestedSessionKeyHeader", () => {
  it("reads the canonical header", () => {
    expect(readRequestedSessionKeyHeader(createReq({ [CANONICAL]: "jarvis" }))).toBe("jarvis");
  });

  it("reads the pre-rename header a caller that predates the debrand still sends", () => {
    expect(readRequestedSessionKeyHeader(createReq({ [LEGACY]: "jarvis" }))).toBe("jarvis");
  });

  it("prefers the canonical header when a sender emits both", () => {
    const req = createReq({ [CANONICAL]: "afora-key", [LEGACY]: "legacy-key" });
    expect(readRequestedSessionKeyHeader(req)).toBe("afora-key");
  });

  it("treats a blank canonical header as absent so it cannot mask the legacy one", () => {
    // A proxy that inserts every known header, filling the unknown ones in empty, would
    // otherwise silently unpin every turn from a sender that is spelling it the old way.
    const req = createReq({ [CANONICAL]: "   ", [LEGACY]: "jarvis" });
    expect(readRequestedSessionKeyHeader(req)).toBe("jarvis");
  });

  it("trims either spelling, and reports nothing when neither is sent", () => {
    expect(readRequestedSessionKeyHeader(createReq({ [LEGACY]: "  jarvis  " }))).toBe("jarvis");
    expect(readRequestedSessionKeyHeader(createReq({}))).toBeUndefined();
    expect(readRequestedSessionKeyHeader(createReq({ [LEGACY]: "  " }))).toBeUndefined();
  });
});

describe("resolveGatewayRequestContext routes on either spelling", () => {
  const context = (headers: Record<string, string>) =>
    resolveGatewayRequestContext({
      req: createReq(headers),
      model: "afora",
      sessionPrefix: "openai",
      defaultMessageChannel: "webchat",
    });

  it("pins the turn to the tenant's session when the header carries the current name", () => {
    expect(context({ [CANONICAL]: "jarvis" }).sessionKey).toBe("jarvis");
  });

  it("pins the same turn to the same session when the header carries the old name", () => {
    expect(context({ [LEGACY]: "jarvis" }).sessionKey).toBe("jarvis");
  });

  it("still opens a fresh session when no routing header is sent at all", () => {
    // The point of the two cases above: this is what a dropped header looks like, and it is
    // indistinguishable from a healthy first turn from the outside.
    const sessionKey = context({}).sessionKey;
    expect(sessionKey).not.toBe("jarvis");
    expect(sessionKey).toContain("openai:");
  });
});
