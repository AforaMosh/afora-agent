import type { AforaPluginApi } from "./plugin-api.types.js";
import type { AforaPluginConfigSchema } from "./plugin-config-schema.types.js";
import type { PluginKind } from "./plugin-kind.types.js";
import type {
  AforaPluginReloadRegistration,
  AforaPluginSecurityAuditCollector,
} from "./plugin-registration.types.js";
import type { AforaPluginNodeHostCommand } from "./types.node-host.js";

/** Module-level plugin definition loaded from a native plugin entry file. */
export type AforaPluginDefinition = {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  /**
   * @deprecated Declare exclusive plugin kind in `afora.plugin.json` via
   * manifest `kind`. Runtime-exported `kind` is kept as a compatibility
   * fallback for older plugins and may require loading plugin runtime on
   * metadata-only command paths.
   */
  kind?: PluginKind | PluginKind[];
  configSchema?: AforaPluginConfigSchema;
  reload?: AforaPluginReloadRegistration;
  nodeHostCommands?: AforaPluginNodeHostCommand[];
  securityAuditCollectors?: AforaPluginSecurityAuditCollector[];
  register?: (api: AforaPluginApi) => void;
};

export type AforaPluginModule = AforaPluginDefinition | ((api: AforaPluginApi) => void);
