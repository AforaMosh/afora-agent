/** ACP protocol helpers and OpenClaw agent identity metadata. */
export { normalizeAcpProvenanceMode } from "@openclaw/acp-core/types";
import { VERSION } from "../version.js";

/** ACP agent identity advertised during protocol initialization. */
export const ACP_AGENT_INFO = {
  name: "openclaw-acp",
  title: "OpenClaw ACP Gateway",
  version: VERSION,
};

/** Agent identity advertised by the process-local ACP runtime. */
export const ACP_LOCAL_AGENT_INFO = {
  name: "openclaw-acp",
  title: "OpenClaw ACP",
  version: VERSION,
};
