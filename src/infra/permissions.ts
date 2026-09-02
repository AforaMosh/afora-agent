// Exposes cross-platform permission inspection helpers with fs-safe defaults.
import "./fs-safe-defaults.js";

// Permission inspection facades expose fs-safe POSIX and Windows ACL helpers
// after applying Afora's fs-safe defaults.
export {
  formatPermissionDetail,
  formatPermissionRemediation,
  inspectPathPermissions,
  safeStat,
  type PermissionCheck,
  type PermissionCheckOptions,
} from "@afora/fs-safe/permissions";
export {
  createIcaclsResetCommand,
  formatIcaclsResetCommand,
  type PermissionExec as ExecFn,
} from "@afora/fs-safe/advanced";
