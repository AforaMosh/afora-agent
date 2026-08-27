import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import type { AforaConfig } from "../../../config/types.afora.js";
import "./stale-auth-order.js";

type TestApi = {
  repairStaleConfiguredAuthOrders(params: {
    cfg: AforaConfig;
    stores: readonly AuthProfileStore[];
    activeStores?: readonly AuthProfileStore[];
    runtimeProfileIds?: ReadonlySet<string>;
  }): { config: AforaConfig; changes: string[] };
};

function getTestApi(): TestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("afora.staleAuthOrderTestApi")
  ] as TestApi;
}

export const repairStaleConfiguredAuthOrders: TestApi["repairStaleConfiguredAuthOrders"] = (
  params,
) => getTestApi().repairStaleConfiguredAuthOrders(params);
