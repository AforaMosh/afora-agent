import type { AforaConfig } from "afora-agent/plugin-sdk/memory-core-host-engine-foundation";

export function isolateMemoryManagerTestConfig(cfg: AforaConfig): AforaConfig {
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      enabled: cfg.plugins?.enabled ?? false,
    },
  };
}
