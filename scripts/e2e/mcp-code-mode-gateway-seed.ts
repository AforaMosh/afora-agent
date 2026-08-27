// Mcp Code Mode Gateway Seed script supports Afora repository automation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyDockerOpenAiProviderConfig, type AforaConfig } from "./docker-openai-seed.ts";
import { writeProbeMcpServer } from "./lib/mcp-code-mode-probe-server.ts";

async function main() {
  const stateDir = process.env.AFORA_STATE_DIR?.trim() || path.join(os.homedir(), ".afora");
  const configPath =
    process.env.AFORA_CONFIG_PATH?.trim() || path.join(stateDir, "afora.json");
  const workspaceDir = path.join(stateDir, "workspace");
  const serverPath = path.join(stateDir, "mcp-code-mode-fixture", "fixture-server.mjs");
  const apiKey =
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.AFORA_MCP_CODE_MODE_OPENAI_API_KEY?.trim() ||
    "sk-docker-smoke-test";

  const cfg = applyDockerOpenAiProviderConfig(
    {
      gateway: {
        controlUi: {
          enabled: false,
        },
        http: {
          endpoints: {
            responses: {
              enabled: true,
            },
          },
        },
      },
      agents: {
        defaults: {
          heartbeat: {
            every: "0m",
          },
        },
      },
      memory: {
        search: {
          enabled: false,
        },
      },
      plugins: {
        slots: {
          memory: "none",
        },
      },
      tools: {
        profile: "coding",
        alsoAllow: ["bundle-mcp"],
        codeMode: {
          enabled: true,
          timeoutMs: 20_000,
          maxPendingToolCalls: 16,
        },
      },
      mcp: {
        servers: {
          fixture: {
            command: "node",
            args: [serverPath],
            cwd: path.dirname(serverPath),
            connectionTimeoutMs: 30_000,
          },
        },
      },
    } satisfies AforaConfig,
    apiKey,
  );

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await writeProbeMcpServer(serverPath);
  await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      stateDir,
      configPath,
      workspaceDir,
      serverPath,
    })}\n`,
  );
}

await main();
