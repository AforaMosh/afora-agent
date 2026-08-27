// Shared config names let the build wrapper isolate the large unified DTS graph.
export const TSDOWN_PACKAGE_CONFIG_GROUP = "afora-packages";
export const TSDOWN_UNIFIED_CONFIG_GROUP = "afora-unified";
export const TSDOWN_UNIFIED_DTS_CONFIG_GROUPS = [
  "afora-dts-base",
  "afora-dts-plugin-sdk-1",
  "afora-dts-plugin-sdk-2",
  "afora-dts-extensions-1",
  "afora-dts-extensions-2",
  "afora-dts-extensions-3",
  "afora-dts-extensions-4",
  "afora-dts-extensions-5",
] as const;
