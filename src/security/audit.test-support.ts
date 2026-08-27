import type { AforaConfig } from "../config/config.js";
import { runSecurityAuditCore } from "./audit.js";
import type { SecurityAuditFinding } from "./audit.types.js";

type AuditOverrides = Omit<Parameters<typeof runSecurityAuditCore>[0], "config">;

export async function collectSecurityAuditFindings(
  config: AforaConfig,
  overrides: AuditOverrides = {},
): Promise<SecurityAuditFinding[]> {
  const report = await runSecurityAuditCore({
    config,
    sourceConfig: config,
    includeFilesystem: false,
    includeChannelSecurity: false,
    loadPluginSecurityCollectors: false,
    ...overrides,
  });
  return report.findings;
}
