import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";
import { DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS } from "./streaming.js";

describe("progress draft visibility", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports delayed visibility only after the channel accepts the render", async () => {
    vi.useFakeTimers();
    const onVisible = vi.fn();
    const update = vi.fn(async () => true);
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });
    progress.registerVisibilityListener(onVisible);

    expect(await progress.pushToolProgress("🛠️ Exec")).toBe(false);
    expect(onVisible).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS);

    expect(update).toHaveBeenCalledOnce();
    expect(onVisible).toHaveBeenCalledOnce();
  });

  it("does not report or dedupe failed and no-op delayed renders", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onVisible = vi.fn();
    const update = vi
      .fn<() => Promise<boolean | void>>()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("send failed"))
      .mockResolvedValueOnce(true);
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });
    progress.registerVisibilityListener(onVisible);

    await progress.pushToolProgress("🛠️ Exec");
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS);
    expect(onVisible).not.toHaveBeenCalled();
    await expect(progress.pushToolProgress("🛠️ Exec")).rejects.toThrow("send failed");
    expect(onVisible).not.toHaveBeenCalled();
    await progress.pushToolProgress("🛠️ Exec");

    expect(onVisible).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("preserves synchronous void as a visible legacy render", async () => {
    vi.useFakeTimers();
    const onVisible = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      update: () => undefined,
    });
    progress.registerVisibilityListener(onVisible);

    expect(await progress.pushToolProgress("🛠️ Exec")).toBe(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS);
    expect(onVisible).toHaveBeenCalledOnce();
  });

  it("requires async renderers to confirm visibility explicitly", async () => {
    vi.useFakeTimers();
    const onVisible = vi.fn();
    const update = vi
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(async () => undefined as unknown as boolean)
      .mockResolvedValueOnce(true);
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });
    progress.registerVisibilityListener(onVisible);

    expect(await progress.pushToolProgress("🛠️ Exec")).toBe(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS);
    expect(onVisible).not.toHaveBeenCalled();
    expect(await progress.pushToolProgress("🛠️ Exec")).toBe(true);
    expect(onVisible).toHaveBeenCalledOnce();
  });
});
