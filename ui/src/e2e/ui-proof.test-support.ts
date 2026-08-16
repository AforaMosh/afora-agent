import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";

export const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

export async function captureUnionUiProof(params: {
  page: Page;
  artifactDir: string;
  fileName: string;
  locators: readonly Locator[];
  margin?: number;
  animations?: "allow" | "disabled";
  clampToViewport?: boolean;
  empty?: "error" | "full-page";
  requireAllLocators?: boolean;
  settleLocators?: boolean;
}): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }

  const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const locator of params.locators) {
    if (params.settleLocators) {
      await locator.waitFor({ state: "visible" });
      await locator.evaluate(async (element) => {
        const running = element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === "running");
        await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
      });
    }
    const box = await locator.boundingBox();
    if (box) {
      boxes.push(box);
    } else if (params.requireAllLocators) {
      throw new Error(`Cannot capture ${params.fileName}: a proof surface has no bounding box`);
    }
  }

  const fullPage = boxes.length === 0 && params.empty === "full-page";
  if (boxes.length === 0 && !fullPage) {
    throw new Error(`Cannot capture ${params.fileName}: no proof surface is visible`);
  }

  let clip: { x: number; y: number; width: number; height: number } | undefined;
  if (!fullPage) {
    const margin = params.margin ?? 12;
    const rawLeft = Math.min(...boxes.map((box) => box.x)) - margin;
    const rawTop = Math.min(...boxes.map((box) => box.y)) - margin;
    const rawRight = Math.max(...boxes.map((box) => box.x + box.width)) + margin;
    const rawBottom = Math.max(...boxes.map((box) => box.y + box.height)) + margin;
    const viewport = params.clampToViewport ? params.page.viewportSize() : null;
    if (params.clampToViewport && !viewport) {
      throw new Error(`Cannot capture ${params.fileName}: viewport is unavailable`);
    }
    const x = Math.max(0, rawLeft);
    const y = Math.max(0, rawTop);
    const right = viewport ? Math.min(viewport.width, rawRight) : rawRight;
    const bottom = viewport ? Math.min(viewport.height, rawBottom) : rawBottom;
    clip = { x, y, width: right - x, height: bottom - y };
  }

  await mkdir(params.artifactDir, { recursive: true });
  await params.page.screenshot({
    animations: params.animations ?? "disabled",
    clip,
    fullPage,
    path: path.join(params.artifactDir, params.fileName),
  });
}
