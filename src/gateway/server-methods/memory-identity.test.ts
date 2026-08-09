import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateMemoryIdentityBindingRevokeResult } from "../../../packages/gateway-protocol/src/index.js";
import { memoryIdentityHandlers } from "./memory-identity.js";

const mocks = vi.hoisted(() => ({
  resolveUserProfileId: vi.fn(),
  revokeMemoryIdentityBinding: vi.fn(),
}));

vi.mock("../../state/memory-identity.js", () => ({
  memoryIdentityLifecycle: {
    revokeMemoryIdentityBinding: mocks.revokeMemoryIdentityBinding,
  },
}));
vi.mock("../../state/user-profiles.js", () => ({
  resolveUserProfileId: mocks.resolveUserProfileId,
}));

async function invoke(params: object, client?: object) {
  const respond = vi.fn();
  await expectDefined(
    memoryIdentityHandlers["memory.identityBinding.revoke"],
    "memory.identityBinding.revoke test invariant",
  )({ params, client, respond } as never);
  return respond;
}

function adminClient(profileId = "admin-profile") {
  return {
    connect: { scopes: ["operator.admin"] },
    authenticatedUserProfile: {
      profileId,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

describe("memory identity gateway methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveUserProfileId.mockReturnValue("admin-profile-current");
    mocks.revokeMemoryIdentityBinding.mockReturnValue(true);
  });

  it("requires operator.admin before it can revoke a durable binding", async () => {
    const respond = await invoke(
      { bindingId: "binding-1" },
      {
        connect: { scopes: ["operator.write"] },
        authenticatedUserProfile: adminClient().authenticatedUserProfile,
      },
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "FORBIDDEN",
        message: "memory.identityBinding.revoke requires gateway scope: operator.admin",
      }),
    );
    expect(mocks.revokeMemoryIdentityBinding).not.toHaveBeenCalled();
  });

  it("requires a durable authenticated Gateway profile for revocation attribution", async () => {
    const respond = await invoke(
      { bindingId: "binding-1" },
      { connect: { scopes: ["operator.admin"] } },
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "FORBIDDEN",
        message: "memory.identityBinding.revoke requires an authenticated Gateway profile",
      }),
    );
    expect(mocks.revokeMemoryIdentityBinding).not.toHaveBeenCalled();
  });

  it("records the canonical admin profile and normalized optional reason", async () => {
    const respond = await invoke(
      { bindingId: " binding-1 ", reason: "  operator requested revocation  " },
      adminClient("merged-admin-profile"),
    );

    expect(mocks.resolveUserProfileId).toHaveBeenCalledWith("merged-admin-profile");
    expect(mocks.revokeMemoryIdentityBinding).toHaveBeenCalledWith({
      bindingId: "binding-1",
      revokedBy: "admin-profile-current",
      reason: "operator requested revocation",
    });
    expect(respond).toHaveBeenCalledWith(true, { bindingId: "binding-1", revoked: true });
    expect(validateMemoryIdentityBindingRevokeResult(respond.mock.calls[0]?.[1])).toBe(true);
  });

  it("reports an idempotent no-op without overwriting prior revocation evidence", async () => {
    mocks.revokeMemoryIdentityBinding.mockReturnValue(false);

    const respond = await invoke({ bindingId: "binding-1", reason: "   " }, adminClient());

    expect(mocks.revokeMemoryIdentityBinding).toHaveBeenCalledWith({
      bindingId: "binding-1",
      revokedBy: "admin-profile-current",
    });
    expect(respond).toHaveBeenCalledWith(true, { bindingId: "binding-1", revoked: false });
  });

  it("fails closed when the connect-time profile no longer resolves", async () => {
    mocks.resolveUserProfileId.mockReturnValue(undefined);

    const respond = await invoke({ bindingId: "binding-1" }, adminClient());

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: "authenticated Gateway profile is unavailable",
      }),
    );
    expect(mocks.revokeMemoryIdentityBinding).not.toHaveBeenCalled();
  });
});
