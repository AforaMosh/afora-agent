import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  detectAndLoadPromptImages: vi.fn(),
  dispose: vi.fn(async () => {}),
  resolveAttemptWorkspaceSandbox: vi.fn(),
}));

vi.mock("../../../media/media-facts.js", () => ({
  isImageMediaFact: () => true,
  readPersistedMediaFacts: () => undefined,
}));

vi.mock("../../image-sanitization.js", () => ({
  resolveImageSanitizationLimits: () => ({ maxDimensionPx: 4096 }),
}));

vi.mock("./attempt-setup.js", () => ({
  resolveAttemptWorkspaceSandbox: mocks.resolveAttemptWorkspaceSandbox,
}));

vi.mock("./images.js", () => ({
  detectAndLoadPromptImages: mocks.detectAndLoadPromptImages,
}));

const { preparePluginHarnessPromptImages } = await import("./plugin-harness-prompt-images.js");

function workspace() {
  return {
    effectiveFsWorkspaceOnly: true,
    effectiveWorkspace: "/sandbox/workspace",
    resolvedWorkspace: "/host/workspace",
    sandbox: {
      enabled: true,
      workspaceDir: "/sandbox/workspace",
      disposeAuthorizedVirtualProjectionMountPlan: mocks.dispose,
    },
  };
}

describe("plugin harness projection staging lifecycle", () => {
  beforeEach(() => {
    mocks.dispose.mockClear();
    mocks.resolveAttemptWorkspaceSandbox.mockReset();
    mocks.resolveAttemptWorkspaceSandbox.mockResolvedValue(workspace());
    mocks.detectAndLoadPromptImages.mockReset();
    mocks.detectAndLoadPromptImages.mockResolvedValue({
      failedMediaCount: 0,
      imageFactIndexes: [0],
      images: [{ type: "image", data: "safe", mimeType: "image/png" }],
    });
  });

  it("uses the dispatch context to create and dispose an owned plugin-harness workspace", async () => {
    await expect(
      preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: {},
          messageChannel: "telegram",
          runId: "run-1",
          sessionId: "stale-session-id",
          sessionKey: "stale-session-key",
          media: [{ kind: "image" }],
        },
        runtime: {
          model: { input: ["image"] },
          sessionId: "admitted-session-id",
          sessionKey: "admitted-session-key",
          workspaceDir: "/host/workspace",
        },
        pluginHarnessOwnsTransport: true,
      } as never),
    ).resolves.toMatchObject({ images: [{ mimeType: "image/png" }] });

    expect(mocks.resolveAttemptWorkspaceSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        cwd: undefined,
        runId: "run-1",
        sessionId: "admitted-session-id",
        sessionKey: "admitted-session-key",
        workspaceDir: "/host/workspace",
      }),
    );
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("disposes owned plugin-harness staging when image preparation fails", async () => {
    mocks.detectAndLoadPromptImages.mockResolvedValue({
      failedMediaCount: 1,
      imageFactIndexes: [],
      images: [],
    });

    await expect(
      preparePluginHarnessPromptImages({
        runParams: { agentId: "main", config: {}, media: [{ kind: "image" }] },
        runtime: {
          model: { input: ["image"] },
          sessionId: "admitted-session-id",
          sessionKey: "admitted-session-key",
          workspaceDir: "/host/workspace",
        },
        pluginHarnessOwnsTransport: true,
      } as never),
    ).rejects.toThrow(/failed to hydrate 1 structured image attachment/);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
