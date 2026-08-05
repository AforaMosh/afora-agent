/** Keeps OpenClaw's image tool only when Codex cannot inspect images itself. */
export function filterCodexVisionTools<T extends { name?: string }>(
  tools: T[],
  params: {
    modelHasVision: boolean;
    hasInboundImages: boolean;
    nativeToolSurfaceEnabled: boolean;
  },
): T[] {
  if (!params.modelHasVision || !(params.hasInboundImages || params.nativeToolSurfaceEnabled)) {
    return tools;
  }
  return tools.filter((tool) => tool.name !== "image");
}
