import { describe, expect, it } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import type { MemoryConfig } from "./config.js";
import { createEmbeddings } from "./embeddings.js";

const api = { config: {}, runtime: {} } as unknown as OpenClawPluginApi;

describe("memory-lancedb embedding transport", () => {
  it.each(["http://10.0.0.1/v1", "http://169.254.169.254/v1", "http://[fe80::1]/v1"])(
    "blocks private or link-local embedding endpoint %s",
    async (baseUrl) => {
      const embeddings = createEmbeddings(api, {
        embedding: {
          provider: "openai",
          apiKey: "test-key",
          model: "text-embedding-3-small",
          baseUrl,
        },
      } as MemoryConfig);

      await expect(embeddings.embed("sensitive memory")).rejects.toMatchObject({
        name: "SsrFBlockedError",
      });
    },
  );
});
