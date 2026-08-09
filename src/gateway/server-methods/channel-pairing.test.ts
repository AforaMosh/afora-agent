import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  bootstrapOwner: vi.fn(),
  createMemoryBinding: vi.fn(),
  dismiss: vi.fn(),
  ensureGatewayProfileMemoryPrincipalInTransaction: vi.fn(),
  ensureMemoryIdentitySchema: vi.fn(),
  hasOwners: vi.fn(),
  listPlugins: vi.fn(),
  listRequests: vi.fn(),
  notify: vi.fn(),
  resolveUserProfileId: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listPlugins,
}));
vi.mock("../../channels/plugins/pairing.js", () => ({
  notifyPairingApproved: mocks.notify,
}));
vi.mock("../../commands/doctor-command-owner.js", () => ({
  hasConfiguredCommandOwners: mocks.hasOwners,
}));
vi.mock("../../pairing/command-owner.js", () => ({
  bootstrapCommandOwnerFromPairing: mocks.bootstrapOwner,
}));
vi.mock("../../pairing/pairing-store.js", () => ({
  approveChannelPairingRequest: mocks.approve,
  CHANNEL_PAIRING_PENDING_MAX: 3,
  CHANNEL_PAIRING_PENDING_TTL_MS: 3_600_000,
  dismissChannelPairingRequest: mocks.dismiss,
  listChannelPairingRequests: mocks.listRequests,
  resolveChannelPairingRequestId: vi.fn(() => "opaque-request-id"),
}));
vi.mock("../../state/memory-identity.js", () => ({
  ensureMemoryIdentitySchema: mocks.ensureMemoryIdentitySchema,
  memoryIdentityLifecycle: {
    createMemoryIdentityBindingFromApprovedChannelPairing: mocks.createMemoryBinding,
    ensureGatewayProfileMemoryPrincipalInTransaction:
      mocks.ensureGatewayProfileMemoryPrincipalInTransaction,
  },
}));
vi.mock("../../state/user-profiles.js", () => ({
  resolveUserProfileId: mocks.resolveUserProfileId,
}));
vi.mock("../runtime-plugin-config.js", () => ({
  resolveGatewayPluginConfig: ({ config }: { config: unknown }) => config,
}));

import { channelPairingHandlers } from "./channel-pairing.js";

const notifyApproval = vi.fn(async () => undefined);
const pairingPlugin = {
  id: "whatsapp",
  meta: { label: "WhatsApp" },
  pairing: { idLabel: "Phone number", notifyApproval },
  config: {
    listAccountIds: () => ["personal", "public", "unconfigured"],
    resolveAccount: (_cfg: unknown, accountId: string) => ({
      configured: accountId !== "unconfigured",
      dmPolicy: accountId === "public" ? "open" : "pairing",
      name: accountId === "personal" ? "Personal" : accountId,
    }),
    isConfigured: (account: { configured: boolean }) => account.configured,
    describeAccount: (account: { name: string }) => ({
      accountId: account.name,
      name: account.name,
    }),
  },
  security: {
    resolveDmPolicy: ({ account }: { account: { dmPolicy: string } }) => ({
      policy: account.dmPolicy,
      allowFromPath: "channels.whatsapp.allowFrom",
      approveHint: "approve",
    }),
  },
};

function createContext() {
  return {
    getRuntimeConfig: () => ({}),
    logGateway: { warn: vi.fn() },
  };
}

async function invoke(
  method: keyof typeof channelPairingHandlers,
  params: Record<string, unknown>,
  options: { client?: unknown } = {},
) {
  const respond = vi.fn();
  const handler = expectDefined(channelPairingHandlers[method], `${method} test invariant`);
  await handler({
    params,
    respond,
    context: createContext(),
    ...(options.client ? { client: options.client } : {}),
  } as unknown as Parameters<typeof handler>[0]);
  return respond;
}

function createAuthenticatedClient(params: { profileId?: string; scopes: string[] }) {
  return {
    connect: { scopes: params.scopes },
    ...(params.profileId
      ? {
          authenticatedUserProfile: {
            profileId: params.profileId,
            displayName: null,
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPlugins.mockReturnValue([pairingPlugin]);
  mocks.hasOwners.mockReturnValue(false);
  mocks.listRequests.mockResolvedValue([]);
  mocks.bootstrapOwner.mockResolvedValue({ ownerEntry: "whatsapp:+1555", status: "configured" });
  mocks.resolveUserProfileId.mockReset();
  mocks.resolveUserProfileId.mockImplementation((profileId: string) => profileId);
  mocks.ensureMemoryIdentitySchema.mockReset();
  mocks.ensureGatewayProfileMemoryPrincipalInTransaction.mockReset();
  mocks.ensureGatewayProfileMemoryPrincipalInTransaction.mockReturnValue({
    principalId: "memory-principal",
  });
  mocks.createMemoryBinding.mockReset();
  mocks.createMemoryBinding.mockReturnValue({ bindingId: "memory-binding-id" });
});

describe("channel DM pairing gateway handlers", () => {
  it("lists only pairing-policy accounts without exposing the human code", async () => {
    mocks.listRequests.mockResolvedValue([
      {
        id: "+15551234567",
        code: "SECRET12",
        createdAt: "2026-07-20T10:00:00.000Z",
        lastSeenAt: "2026-07-20T10:05:00.000Z",
        meta: { accountId: "personal", name: "Alice" },
      },
    ]);

    const respond = await invoke("channels.pairing.list", {});

    expect(mocks.listRequests).toHaveBeenCalledTimes(1);
    expect(mocks.listRequests).toHaveBeenCalledWith("whatsapp", process.env, "personal");
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        accounts: [
          {
            channel: "whatsapp",
            channelLabel: "WhatsApp",
            accountId: "personal",
            accountLabel: "Personal",
            notifySupported: true,
          },
        ],
        requests: [
          {
            requestId: "opaque-request-id",
            channel: "whatsapp",
            channelLabel: "WhatsApp",
            accountId: "personal",
            accountLabel: "Personal",
            senderId: "+15551234567",
            senderLabel: "Phone number",
            metadata: { name: "Alice" },
            createdAt: "2026-07-20T10:00:00.000Z",
            lastSeenAt: "2026-07-20T10:05:00.000Z",
            expiresAt: "2026-07-20T11:00:00.000Z",
            notifySupported: true,
          },
        ],
        commandOwnerConfigured: false,
        limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
      },
      undefined,
    );
    expect(JSON.stringify(respond.mock.calls)).not.toContain("SECRET12");
  });

  it("approves access even when the optional notification fails", async () => {
    mocks.approve.mockResolvedValue({
      id: "+15551234567",
      entry: {
        id: "+15551234567",
        code: "SECRET12",
        createdAt: "2026-07-20T10:00:00.000Z",
        lastSeenAt: "2026-07-20T10:00:00.000Z",
        meta: { accountId: "personal" },
      },
    });
    mocks.notify.mockRejectedValue(new Error("offline"));

    const respond = await invoke("channels.pairing.approve", {
      channel: "whatsapp",
      accountId: "personal",
      requestId: "opaque-request-id",
      notify: true,
      bootstrapCommandOwner: true,
    });

    expect(mocks.approve).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "personal",
      requestId: "opaque-request-id",
      pairingAdapter: pairingPlugin.pairing,
    });
    expect(mocks.bootstrapOwner).toHaveBeenCalledWith({
      channel: "whatsapp",
      id: "+15551234567",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        requestId: "opaque-request-id",
        senderId: "+15551234567",
        notification: "failed",
        commandOwnerBootstrap: "configured",
        memoryBinding: "not-requested",
      },
      undefined,
    );
  });

  it("reports command-owner setup failure without rolling back DM approval", async () => {
    mocks.approve.mockResolvedValue({
      id: "+15551234567",
      entry: {
        id: "+15551234567",
        code: "SECRET12",
        createdAt: "2026-07-20T10:00:00.000Z",
        lastSeenAt: "2026-07-20T10:00:00.000Z",
      },
    });
    mocks.bootstrapOwner.mockRejectedValue(new Error("config write failed"));

    const respond = await invoke("channels.pairing.approve", {
      channel: "whatsapp",
      accountId: "personal",
      requestId: "opaque-request-id",
      bootstrapCommandOwner: true,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        requestId: "opaque-request-id",
        senderId: "+15551234567",
        notification: "not-requested",
        commandOwnerBootstrap: "unavailable",
        memoryBinding: "not-requested",
      },
      undefined,
    );
  });

  it("requires an admin-scoped authenticated creator before linking private memory", async () => {
    const params = {
      channel: "whatsapp",
      accountId: "personal",
      requestId: "opaque-request-id",
      linkMemoryProfileId: "target-profile",
    };

    const missingAdmin = await invoke("channels.pairing.approve", params, {
      client: createAuthenticatedClient({
        profileId: "creator-profile",
        scopes: ["operator.pairing"],
      }),
    });
    expect(missingAdmin).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "linkMemoryProfileId requires gateway scope: operator.admin",
      }),
    );
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(mocks.ensureGatewayProfileMemoryPrincipalInTransaction).not.toHaveBeenCalled();

    const missingCreator = await invoke("channels.pairing.approve", params, {
      client: createAuthenticatedClient({ scopes: ["operator.pairing", "operator.admin"] }),
    });
    expect(missingCreator).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "linkMemoryProfileId requires an authenticated Gateway profile",
      }),
    );
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(mocks.ensureGatewayProfileMemoryPrincipalInTransaction).not.toHaveBeenCalled();
  });

  it("binds the transaction-consumed pairing identity and returns the created binding", async () => {
    const transactionDatabase = { transaction: "pairing-approval" };
    const approval = Object.freeze({ consumed: "pairing-approval" });
    mocks.resolveUserProfileId.mockImplementation((profileId: string) =>
      profileId === "target-profile" ? "target-profile-current" : "creator-profile-current",
    );
    mocks.ensureGatewayProfileMemoryPrincipalInTransaction.mockReturnValue({
      principalId: "target-memory-principal",
    });
    mocks.createMemoryBinding.mockReturnValue({ bindingId: "memory-binding-created" });
    mocks.approve.mockImplementationOnce(
      async (params: {
        onApproved?: (approval: { database: unknown; approval: unknown }) => void;
      }) => {
        params.onApproved?.({
          database: transactionDatabase,
          approval,
        });
        return {
          id: "+15559876543",
          entry: {
            id: "+15559876543",
            code: "SECRET12",
            createdAt: "2026-07-20T10:00:00.000Z",
            lastSeenAt: "2026-07-20T10:00:00.000Z",
          },
        };
      },
    );

    const respond = await invoke(
      "channels.pairing.approve",
      {
        channel: "whatsapp",
        accountId: "personal",
        requestId: "caller-request-id",
        linkMemoryProfileId: "target-profile",
      },
      {
        client: createAuthenticatedClient({
          profileId: "creator-profile",
          scopes: ["operator.pairing", "operator.admin"],
        }),
      },
    );

    expect(mocks.ensureMemoryIdentitySchema).toHaveBeenCalledTimes(1);
    expect(mocks.ensureGatewayProfileMemoryPrincipalInTransaction).toHaveBeenCalledWith({
      database: transactionDatabase,
      profileId: "target-profile",
    });
    expect(mocks.createMemoryBinding).toHaveBeenCalledWith({
      database: transactionDatabase,
      approval,
      principalId: "target-memory-principal",
      creatorProfileId: "creator-profile",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        requestId: "caller-request-id",
        senderId: "+15559876543",
        notification: "not-requested",
        commandOwnerBootstrap: "not-requested",
        memoryBinding: "created",
        memoryBindingId: "memory-binding-created",
      },
      undefined,
    );
  });

  it("does not create a memory principal when the pairing request was already consumed", async () => {
    mocks.approve.mockResolvedValueOnce(null);

    const respond = await invoke(
      "channels.pairing.approve",
      {
        channel: "whatsapp",
        accountId: "personal",
        requestId: "caller-request-id",
        linkMemoryProfileId: "target-profile",
      },
      {
        client: createAuthenticatedClient({
          profileId: "creator-profile",
          scopes: ["operator.pairing", "operator.admin"],
        }),
      },
    );

    expect(mocks.ensureMemoryIdentitySchema).toHaveBeenCalledTimes(1);
    expect(mocks.ensureGatewayProfileMemoryPrincipalInTransaction).not.toHaveBeenCalled();
    expect(mocks.createMemoryBinding).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "pending DM access request no longer exists" }),
    );
  });

  it("returns the pairing failure path when the atomic memory-binding callback fails", async () => {
    const transactionDatabase = { transaction: "pairing-approval" };
    const approval = Object.freeze({ consumed: "pairing-approval" });
    mocks.createMemoryBinding.mockImplementationOnce(() => {
      throw new Error("memory binding write failed");
    });
    mocks.approve.mockImplementationOnce(
      async (params: {
        onApproved?: (approval: { database: unknown; approval: unknown }) => void;
      }) => {
        params.onApproved?.({
          database: transactionDatabase,
          approval,
        });
        return null;
      },
    );

    const respond = await invoke(
      "channels.pairing.approve",
      {
        channel: "whatsapp",
        accountId: "personal",
        requestId: "caller-request-id",
        linkMemoryProfileId: "target-profile",
      },
      {
        client: createAuthenticatedClient({
          profileId: "creator-profile",
          scopes: ["operator.pairing", "operator.admin"],
        }),
      },
    );

    expect(mocks.createMemoryBinding).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("memory binding write failed") }),
    );
  });

  it("dismisses a request without approving the sender", async () => {
    mocks.dismiss.mockResolvedValue({
      id: "+15551234567",
      entry: {
        id: "+15551234567",
        code: "SECRET12",
        createdAt: "2026-07-20T10:00:00.000Z",
        lastSeenAt: "2026-07-20T10:00:00.000Z",
      },
    });

    const respond = await invoke("channels.pairing.dismiss", {
      channel: "whatsapp",
      accountId: "personal",
      requestId: "opaque-request-id",
    });

    expect(mocks.dismiss).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "personal",
      requestId: "opaque-request-id",
    });
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      { requestId: "opaque-request-id", senderId: "+15551234567" },
      undefined,
    );
  });
});
