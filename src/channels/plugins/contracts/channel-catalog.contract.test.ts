// Channel catalog contract tests cover bundled and registry-backed channel catalog invariants.
import whatsappPackageJson from "../../../../extensions/whatsapp/package.json" with { type: "json" };
import { isPrereleaseSemverVersion } from "../../../infra/npm-registry-spec.js";
import {
  describeBundledMetadataOnlyChannelCatalogContract,
  describeChannelCatalogEntryContract,
  describeOfficialFallbackChannelCatalogContract,
} from "./test-helpers/channel-catalog-contract.js";

describeChannelCatalogEntryContract({
  channelId: "msteams",
  npmSpec: "@openclaw/msteams",
  alias: "teams",
});

const whatsappMeta = {
  id: "whatsapp",
  label: "WhatsApp",
  selectionLabel: "WhatsApp (QR link)",
  detailLabel: "WhatsApp Web",
  docsPath: "/channels/whatsapp",
  blurb: "works with your own number; recommend a separate phone + eSIM.",
};

const whatsappOfficialFallbackNpmSpec =
  whatsappPackageJson.openclaw.install.npmSpec ?? whatsappPackageJson.name;
const expectedWhatsappOfficialFallbackNpmSpec = isPrereleaseSemverVersion(
  whatsappPackageJson.version,
)
  ? `${whatsappOfficialFallbackNpmSpec}@${whatsappPackageJson.version}`
  : whatsappOfficialFallbackNpmSpec;

describeBundledMetadataOnlyChannelCatalogContract({
  pluginId: "whatsapp",
  packageName: "@openclaw/whatsapp",
  npmSpec: "@openclaw/whatsapp",
  meta: whatsappMeta,
  defaultChoice: "npm",
});

describeOfficialFallbackChannelCatalogContract({
  channelId: "whatsapp",
  npmSpec: expectedWhatsappOfficialFallbackNpmSpec,
  meta: whatsappMeta,
  packageName: "@openclaw/whatsapp",
  pluginId: "whatsapp",
  externalNpmSpec: "@vendor/whatsapp-fork",
  externalLabel: "WhatsApp Fork",
});

describeChannelCatalogEntryContract({
  channelId: "wecom",
  npmSpec: "@wecom/wecom-openclaw-plugin@2026.5.7",
  alias: "wework",
});

describeChannelCatalogEntryContract({
  channelId: "yuanbao",
  npmSpec: "openclaw-plugin-yuanbao@2.15.0",
  alias: "yb",
});

describeChannelCatalogEntryContract({
  channelId: "openclaw-zaloclawbot",
  npmSpec: "@zalo-platforms/openclaw-zaloclawbot@0.1.4",
  alias: "zaloclawbot",
});
