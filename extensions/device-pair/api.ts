// Device Pair API module exposes the plugin public contract.
export {
  approveDevicePairing,
  clearDeviceBootstrapTokens,
  issueDeviceBootstrapToken,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  listDevicePairing,
  revokeDeviceBootstrapToken,
  type DeviceBootstrapProfile,
} from "afora-agent/plugin-sdk/device-bootstrap";
export { definePluginEntry, type AforaPluginApi } from "afora-agent/plugin-sdk/plugin-entry";
export {
  resolveGatewayBindUrl,
  resolveGatewayPort,
  resolveTailnetHostWithRunner,
  resolveTailscaleServeGatewayUrlsWithRunner,
} from "afora-agent/plugin-sdk/core";
export { resolveAdvertisedLanHost } from "afora-agent/plugin-sdk/gateway-runtime";
export {
  resolvePreferredAforaTmpDir,
  runPluginCommandWithTimeout,
} from "afora-agent/plugin-sdk/sandbox";
export { renderQrPngBase64, renderQrPngDataUrl, writeQrPngTempFile } from "./qr-image.js";
