import path from "node:path";
import { setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "./test-helpers.env.js";

const MANUAL_GATEWAY_BACKGROUND_ENV_KEYS = [
  "AFORA_SKIP_BROWSER_CONTROL_SERVER",
  "AFORA_SKIP_GMAIL_WATCHER",
  "AFORA_SKIP_CANVAS_HOST",
  "AFORA_SKIP_CHANNELS",
  "AFORA_SKIP_PROVIDERS",
  "AFORA_SKIP_CRON",
  "AFORA_DISABLE_BUNDLED_PLUGINS",
  "AFORA_BUNDLED_PLUGINS_DIR",
] as const;

export const MANUAL_GATEWAY_ENV_KEYS = [
  ...GATEWAY_STARTUP_MUTATED_ENV_KEYS,
  ...MANUAL_GATEWAY_BACKGROUND_ENV_KEYS,
] as const;

/** Keeps manual RPC suites on the real core Gateway without unrelated startup work. */
export function configureManualGatewayBackgroundEnv(tempHome: string): void {
  setTestEnvValue("AFORA_SKIP_BROWSER_CONTROL_SERVER", "1");
  setTestEnvValue("AFORA_SKIP_GMAIL_WATCHER", "1");
  setTestEnvValue("AFORA_SKIP_CANVAS_HOST", "1");
  setTestEnvValue("AFORA_SKIP_CHANNELS", "1");
  setTestEnvValue("AFORA_SKIP_PROVIDERS", "1");
  setTestEnvValue("AFORA_SKIP_CRON", "1");
  setTestEnvValue("AFORA_DISABLE_BUNDLED_PLUGINS", "1");
  setTestEnvValue("AFORA_BUNDLED_PLUGINS_DIR", path.join(tempHome, "no-plugins"));
}
