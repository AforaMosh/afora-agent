// Shared harness for spawn command tests and mocked agent process state.
import type { AforaConfig } from "../../config/types.afora.js";
import type { MsgContext } from "../templating.js";
import { buildCommandTestParams as buildBaseCommandTestParams } from "./commands.test-harness.js";

export function buildCommandTestParams(
  commandBody: string,
  cfg: AforaConfig,
  ctxOverrides?: Partial<MsgContext>,
) {
  return buildBaseCommandTestParams(commandBody, cfg, ctxOverrides);
}
