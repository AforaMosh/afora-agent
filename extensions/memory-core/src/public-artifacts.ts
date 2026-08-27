// Memory Core plugin module implements public artifacts behavior.
import {
  listMemoryHostPublicArtifacts,
  type MemoryPluginPublicArtifact,
} from "afora-agent/plugin-sdk/memory-host-core";
import type { AforaConfig } from "../api.js";

export async function listMemoryCorePublicArtifacts(params: {
  cfg: AforaConfig;
}): Promise<MemoryPluginPublicArtifact[]> {
  return await listMemoryHostPublicArtifacts(params);
}
