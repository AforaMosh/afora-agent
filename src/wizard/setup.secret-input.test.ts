// Secret input tests cover provider credential prompt normalization.
import { describe, expect, it } from "vitest";
import type { AforaConfig } from "../config/config.js";
import { resolveSetupSecretInputString } from "./setup.secret-input.js";

function makeConfig(): AforaConfig {
  return {
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
  } as AforaConfig;
}

describe("resolveSetupSecretInputString", () => {
  it("resolves env-template SecretInput strings", async () => {
    const resolved = await resolveSetupSecretInputString({
      config: makeConfig(),
      value: "${AFORA_GATEWAY_PASSWORD}",
      path: "gateway.auth.password",
      env: {
        AFORA_GATEWAY_PASSWORD: "gateway-secret", // pragma: allowlist secret
      },
    });

    expect(resolved).toBe("gateway-secret");
  });

  it("returns plaintext strings when value is not a SecretRef", async () => {
    const resolved = await resolveSetupSecretInputString({
      config: makeConfig(),
      value: "plain-text",
      path: "gateway.auth.password",
    });

    expect(resolved).toBe("plain-text");
  });

  it("throws with path context when env-template SecretRef cannot resolve", async () => {
    await expect(
      resolveSetupSecretInputString({
        config: makeConfig(),
        value: "${AFORA_GATEWAY_PASSWORD}",
        path: "gateway.auth.password",
        env: {},
      }),
    ).rejects.toThrow(
      'gateway.auth.password: failed to resolve SecretRef "env:default:AFORA_GATEWAY_PASSWORD"',
    );
  });
});
