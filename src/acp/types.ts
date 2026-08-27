/** ACP protocol helpers and Afora agent identity metadata. */
import { VERSION } from "../version.js";
export { normalizeAcpProvenanceMode } from "@afora/acp-core/types";

/** ACP agent identity advertised during protocol initialization. */
export const ACP_AGENT_INFO = {
  name: "afora-acp",
  title: "Afora ACP Gateway",
  version: VERSION,
};
