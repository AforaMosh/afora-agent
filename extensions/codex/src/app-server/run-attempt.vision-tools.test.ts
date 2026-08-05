// Codex tests cover run attempt.vision tools plugin behavior.
import { describe, expect, it } from "vitest";
import { filterCodexVisionTools } from "./vision-tools.js";

describe("Codex dynamic tool filtering", () => {
  it("drops the image tool when the model already has inbound vision input", () => {
    const toolNames = filterCodexVisionTools(
      [{ name: "image" }, { name: "read" }, { name: "write" }],
      {
        modelHasVision: true,
        hasInboundImages: true,
        nativeToolSurfaceEnabled: false,
      },
    ).map((tool) => tool.name);

    expect(toolNames).toContain("read");
    expect(toolNames).toContain("write");
    expect(toolNames).not.toContain("image");
  });

  it("uses native Codex image viewing even when the turn begins without images", () => {
    const tools = [{ name: "image" }, { name: "message" }];

    expect(
      filterCodexVisionTools(tools, {
        modelHasVision: true,
        hasInboundImages: false,
        nativeToolSurfaceEnabled: true,
      }),
    ).toEqual([{ name: "message" }]);
  });

  it("keeps OpenClaw image analysis when Codex cannot inspect the image itself", () => {
    const tools = [{ name: "image" }, { name: "read" }];

    expect(
      filterCodexVisionTools(tools, {
        modelHasVision: false,
        hasInboundImages: true,
        nativeToolSurfaceEnabled: true,
      }),
    ).toBe(tools);
    expect(
      filterCodexVisionTools(tools, {
        modelHasVision: true,
        hasInboundImages: false,
        nativeToolSurfaceEnabled: false,
      }),
    ).toBe(tools);
  });
});
