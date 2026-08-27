// Googlechat tests cover secret contract plugin behavior.
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from "afora-agent/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";

describe("googlechat secret contract", () => {
  it("resolves account serviceAccount SecretRefs for enabled accounts", async () => {
    const sourceConfig = {
      channels: {
        googlechat: {
          enabled: true,
          accounts: {
            work: {
              enabled: true,
              serviceAccount: {
                source: "env",
                provider: "default",
                id: "GOOGLECHAT_SERVICE_ACCOUNT",
              },
            },
          },
        },
      },
    } satisfies AforaConfig;
    const resolvedConfig: AforaConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: {
        GOOGLECHAT_SERVICE_ACCOUNT: '{"client_email":"bot@example.com"}',
      },
    });

    collectRuntimeConfigAssignments({
      config: resolvedConfig,
      defaults: undefined,
      context,
    });

    expect(context.assignments).toMatchObject([
      {
        ownerKind: "account",
        ownerId: "googlechat:work",
        requiredForGateway: false,
        disposition: "isolate",
      },
    ]);

    const resolved = await resolveSecretRefValues(
      context.assignments.map((assignment) => assignment.ref),
      {
        config: sourceConfig,
        env: context.env,
        cache: context.cache,
      },
    );
    applyResolvedAssignments({
      assignments: context.assignments,
      resolved,
    });

    const workAccount = resolvedConfig.channels?.googlechat?.accounts?.work;
    expect(workAccount?.serviceAccount).toBe('{"client_email":"bot@example.com"}');
    expect(context.warnings).toStrictEqual([]);
  });
});
