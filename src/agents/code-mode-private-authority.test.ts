import { describe, expect, it } from "vitest";
import { CodeModePrivateAuthority } from "./code-mode-private-authority.js";

const build = {
  conversationRef: "conv_0123456789abcdef0123456789abcdef",
  channel: "discord",
  accountId: "default",
  kind: "direct",
  target: "build-bot",
} as const;
const deploy = {
  conversationRef: "conv_11111111111111111111111111111111",
  channel: "discord",
  accountId: "default",
  kind: "direct",
  target: "deploy-bot",
} as const;

function deliverList(
  authority: CodeModePrivateAuthority,
  conversations: unknown[],
  complete = true,
): void {
  authority.beginBridgeFrontier([
    {
      id: "list-1",
      conversationListIntent: true,
      conversationListEligible: true,
    },
  ]);
  authority.deliverBridgeSettlements([
    {
      id: "list-1",
      conversationListResult: { conversations, complete },
    },
  ]);
}

describe("CodeModePrivateAuthority", () => {
  it("preserves direct-tool parity before list selection starts", () => {
    const authority = new CodeModePrivateAuthority();
    expect(authority.consumeConversation(build.conversationRef)).toBe(true);
    expect(authority.consumeConversation(deploy.conversationRef)).toBe(true);
  });

  it("returns the unique canonical address and consumes it once", () => {
    const authority = new CodeModePrivateAuthority();
    deliverList(authority, [build, deploy]);

    expect(authority.consumeConversation(build.conversationRef)).toEqual(build);
    expect(authority.consumeConversation(build.conversationRef)).toBe(false);
  });

  it("allows any unique address in the complete owner snapshot", () => {
    const authority = new CodeModePrivateAuthority();
    deliverList(authority, [build, deploy]);

    // The snapshot proves canonical target provenance, not natural-language intent.
    expect(authority.consumeConversation(deploy.conversationRef)).toEqual(deploy);
  });

  it("rejects duplicate normalized addresses and consumes the lease", () => {
    const authority = new CodeModePrivateAuthority();
    deliverList(authority, [
      build,
      {
        ...build,
        conversationRef: "conv_22222222222222222222222222222222",
      },
    ]);

    expect(authority.consumeConversation(build.conversationRef)).toBe(false);
    expect(authority.consumeConversation(build.conversationRef)).toBe(false);
  });

  it("rejects unlisted refs, incomplete snapshots, and oversized snapshots", () => {
    const unlisted = new CodeModePrivateAuthority();
    deliverList(unlisted, [build]);
    expect(unlisted.consumeConversation(deploy.conversationRef)).toBe(false);
    expect(unlisted.consumeConversation(build.conversationRef)).toBe(false);

    const incomplete = new CodeModePrivateAuthority();
    deliverList(incomplete, [build], false);
    expect(incomplete.consumeConversation(build.conversationRef)).toBe(false);

    const oversized = new CodeModePrivateAuthority();
    deliverList(
      oversized,
      Array.from({ length: 101 }, (_, index) => ({
        ...build,
        conversationRef: `conv_${index.toString(16).padStart(32, "0")}`,
      })),
    );
    expect(oversized.consumeConversation(build.conversationRef)).toBe(false);
  });

  it("revokes prior selection when another or parallel list starts", () => {
    const later = new CodeModePrivateAuthority();
    deliverList(later, [build]);
    later.beginBridgeFrontier([
      {
        id: "list-2",
        conversationListIntent: true,
        conversationListEligible: true,
      },
    ]);
    expect(later.consumeConversation(build.conversationRef)).toBe(false);

    const parallel = new CodeModePrivateAuthority();
    parallel.beginBridgeFrontier([
      {
        id: "list-a",
        conversationListIntent: true,
        conversationListEligible: true,
      },
      {
        id: "list-b",
        conversationListIntent: true,
        conversationListEligible: true,
      },
    ]);
    parallel.deliverBridgeSettlements([
      {
        id: "list-a",
        conversationListResult: { conversations: [build], complete: true },
      },
      {
        id: "list-b",
        conversationListResult: { conversations: [build], complete: true },
      },
    ]);
    expect(parallel.consumeConversation(build.conversationRef)).toBe(false);
  });

  it("keeps private state out of serialization and rejects after revocation", () => {
    const authority = new CodeModePrivateAuthority();
    deliverList(authority, [build]);
    expect(JSON.stringify(authority)).toBe("{}");
    authority.revoke();
    expect(authority.consumeConversation(build.conversationRef)).toBe(false);
  });
});
