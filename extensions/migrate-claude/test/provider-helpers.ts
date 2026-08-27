// Migrate Claude provider module implements model/runtime integration.
import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationProviderContext } from "afora-agent/plugin-sdk/plugin-entry";
import type { AforaConfig } from "afora-agent/plugin-sdk/provider-auth";

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

export async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

export function makeConfigRuntime(
  config: AforaConfig,
  onWrite?: (next: AforaConfig) => void,
): NonNullable<MigrationProviderContext["runtime"]> {
  const commitConfig = (next: AforaConfig) => {
    for (const key of Object.keys(config) as Array<keyof AforaConfig>) {
      delete config[key];
    }
    Object.assign(config, next);
    onWrite?.(next);
  };

  return {
    config: {
      current: () => config,
      mutateConfigFile: async ({
        afterWrite,
        mutate,
      }: {
        afterWrite?: unknown;
        mutate: (draft: AforaConfig, context: unknown) => Promise<unknown> | void;
      }) => {
        const next = structuredClone(config);
        const result = await mutate(next, {
          snapshot: {
            path: "/tmp/afora.json",
            exists: true,
            raw: "{}",
            parsed: {},
            valid: true,
            issues: [],
            warnings: [],
            legacyIssues: [],
            config: next,
            resolved: next,
            runtimeConfig: next,
            sourceConfig: next,
          },
          previousHash: "test",
        });
        commitConfig(next);
        return {
          nextConfig: next,
          afterWrite,
          followUp: { mode: "auto", requiresRestart: false },
          result,
        };
      },
      replaceConfigFile: async ({
        afterWrite,
        nextConfig,
      }: {
        afterWrite?: unknown;
        nextConfig: AforaConfig;
      }) => {
        commitConfig(nextConfig);
        return {
          nextConfig,
          afterWrite,
          followUp: { mode: "auto", requiresRestart: false },
        };
      },
    },
  } as NonNullable<MigrationProviderContext["runtime"]>;
}

export function makeContext(params: {
  source: string;
  stateDir: string;
  workspaceDir: string;
  config?: AforaConfig;
  includeSecrets?: boolean;
  overwrite?: boolean;
  targetAgentId?: string;
  itemKinds?: readonly string[];
  reportDir?: string;
  runtime?: MigrationProviderContext["runtime"];
}): MigrationProviderContext {
  const config =
    params.config ??
    ({
      agents: {
        defaults: {
          workspace: params.workspaceDir,
        },
      },
    } as AforaConfig);
  return {
    config,
    stateDir: params.stateDir,
    source: params.source,
    includeSecrets: params.includeSecrets,
    overwrite: params.overwrite,
    targetAgentId: params.targetAgentId,
    itemKinds: params.itemKinds,
    reportDir: params.reportDir,
    runtime: params.runtime,
    logger,
  };
}
