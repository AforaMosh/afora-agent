import { html, nothing } from "lit";
import { icon, icons } from "../../components/icons.ts";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import "../../components/web-awesome.ts";
import { t } from "../../i18n/index.ts";
import { formatTimeMs } from "../../lib/format.ts";
import type { ModelProviderCard } from "./data.ts";
import type { ModelProvidersViewProps } from "./view.ts";

type ProfileMessage = {
  kind: "success" | "error";
  text: string;
  warning?: string;
};

function profileLabel(profile: ModelProviderCard["profiles"][number]): string {
  return profile.displayName || profile.email || profile.profileId;
}

function orderedProfiles(card: ModelProviderCard) {
  const explicit = new Map(card.profileOrder.map((profileId, index) => [profileId, index]));
  return card.profiles.toSorted((left, right) => {
    const leftIndex = explicit.get(left.profileId) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = explicit.get(right.profileId) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex || left.profileId.localeCompare(right.profileId);
  });
}

function profileCooldown(profile: ModelProviderCard["profiles"][number]) {
  const until = Math.max(
    profile.cooldownUntil ?? 0,
    profile.disabledUntil ?? 0,
    profile.blockedUntil ?? 0,
  );
  return {
    until,
    reason: profile.cooldownReason || profile.disabledReason || profile.blockedReason,
  };
}

function renderProfileStatus(profile: ModelProviderCard["profiles"][number]) {
  const cooldown = profileCooldown(profile);
  if (cooldown.until > Date.now()) {
    return renderSettingsStatus({
      kind: "warn",
      label: t("modelProviders.profiles.cooldown", {
        time: formatTimeMs(cooldown.until - Date.now()),
        reason: cooldown.reason ?? t("modelProviders.profiles.unavailable"),
      }),
    });
  }
  const status =
    profile.status === "ok" || profile.status === "static"
      ? { kind: "ok" as const, label: t("modelProviders.status.ready") }
      : profile.status === "expiring"
        ? { kind: "warn" as const, label: t("modelProviders.status.expiring") }
        : profile.status === "expired"
          ? { kind: "danger" as const, label: t("modelProviders.status.expired") }
          : { kind: "muted" as const, label: t("modelProviders.status.missing") };
  return renderSettingsStatus(status);
}

function renderProfileMessage(message: ProfileMessage | undefined) {
  if (!message) {
    return nothing;
  }
  return html`
    <div class="callout ${message.kind}" role=${message.kind === "error" ? "alert" : "status"}>
      ${message.text}
    </div>
    ${message.warning
      ? html`<div class="callout warning" role="status">${message.warning}</div>`
      : nothing}
  `;
}

export function renderProfiles(card: ModelProviderCard, props: ModelProvidersViewProps) {
  const profiles = orderedProfiles(card).filter(
    (profile) => profile.type === "oauth" || profile.type === "token",
  );
  if (profiles.length === 0) {
    return nothing;
  }
  const busy = Boolean(props.busy[`profiles:${card.id}`] || props.busy[`logout:${card.id}`]);
  const mutationDisabled = !props.canMutate || props.configBusy;
  const message = props.messages[`profiles:${card.id}`];
  const primary = profiles[0];
  const coolingDown = profiles.filter(
    (profile) => profileCooldown(profile).until > Date.now(),
  ).length;
  return html`
    <details class="model-providers__profiles">
      <summary class="model-providers__profiles-summary">
        <span class="model-providers__profiles-summary-copy">
          <strong>${t("modelProviders.profiles.title")}</strong>
          <span>
            ${t(
              profiles.length === 1
                ? "modelProviders.profiles.accountOne"
                : "modelProviders.profiles.accounts",
              { count: String(profiles.length) },
            )}
            · ${t("modelProviders.profiles.primary", { account: profileLabel(primary!) })}
          </span>
        </span>
        <span class="model-providers__profiles-summary-actions">
          ${coolingDown > 0
            ? renderSettingsStatus({
                kind: "warn",
                label: t("modelProviders.profiles.coolingDown", {
                  count: String(coolingDown),
                }),
              })
            : nothing}
          <span class="model-providers__profiles-chevron" aria-hidden="true"
            >${icons.chevronDown}</span
          >
        </span>
      </summary>
      <div class="model-providers__profiles-content">
        <div class="model-providers__profiles-heading">
          <span>${t("modelProviders.profiles.subtitle")}</span>
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${mutationDisabled}
            @click=${props.onOpenModelSetup}
          >
            ${t("modelProviders.profiles.addAccount")}
          </button>
        </div>
        ${profiles.map((profile) => {
          const provider = card.profileProviderIds[profile.profileId] ?? card.id;
          const cooldown = profileCooldown(profile);
          const ownerProfiles = orderedProfiles(card).filter(
            (candidate) => (card.profileProviderIds[candidate.profileId] ?? card.id) === provider,
          );
          // Priority is credential-owner scoped even when provider aliases share one card.
          // Using the card-wide order would show a priority the Gateway never persists.
          const visibleOwnerProfiles = ownerProfiles.filter(
            (candidate) => candidate.type === "oauth" || candidate.type === "token",
          );
          const ownerIndex = visibleOwnerProfiles.findIndex(
            (candidate) => candidate.profileId === profile.profileId,
          );
          const canMoveUp = props.profileOrderAvailable && ownerIndex > 0;
          const canMoveDown =
            props.profileOrderAvailable && ownerIndex < visibleOwnerProfiles.length - 1;
          const canClearCooldown =
            props.profileCooldownClearAvailable && cooldown.until > Date.now();
          const canLogout = profile.logoutSupported === true;
          return html`
            <div class="model-providers__profile" data-profile-id=${profile.profileId}>
              <div class="model-providers__profile-priority">${ownerIndex + 1}</div>
              <div class="model-providers__profile-copy">
                <strong>${profileLabel(profile)}</strong>
                ${profile.email && profile.displayName
                  ? html`<span>${profile.email}</span>`
                  : html`<span>${profile.profileId}</span>`}
                <span class="model-providers__profile-meta">
                  ${renderProfileStatus(profile)}
                  ${profile.lastUsedAt
                    ? html`<span>
                        ${t("modelProviders.profiles.lastUsed", {
                          time: formatTimeMs(Date.now() - profile.lastUsedAt),
                        })}
                      </span>`
                    : nothing}
                </span>
              </div>
              ${canMoveUp || canMoveDown || canClearCooldown || canLogout
                ? html`<wa-dropdown
                    class="model-providers__profile-menu"
                    placement="bottom-end"
                    @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
                      const action = event.detail.item.value;
                      if (action === "logout") {
                        props.onLogoutProfile(
                          card.id,
                          provider,
                          profile.profileId,
                          profileLabel(profile),
                        );
                        return;
                      }
                      if (action === "clear-cooldown") {
                        props.onClearProfileCooldown(card.id, provider, profile.profileId);
                        return;
                      }
                      const offset = action === "move-up" ? -1 : action === "move-down" ? 1 : 0;
                      const adjacent = visibleOwnerProfiles[ownerIndex + offset];
                      if (offset === 0 || !adjacent) {
                        return;
                      }
                      const next = ownerProfiles.map((candidate) => candidate.profileId);
                      const currentIndex = next.indexOf(profile.profileId);
                      const adjacentIndex = next.indexOf(adjacent.profileId);
                      [next[currentIndex], next[adjacentIndex]] = [
                        next[adjacentIndex]!,
                        next[currentIndex]!,
                      ];
                      props.onProfileOrderChange(card.id, provider, next);
                    }}
                  >
                    <button
                      slot="trigger"
                      type="button"
                      class="btn btn--sm btn--ghost model-providers__profile-menu-trigger"
                      aria-label=${t("modelProviders.profiles.actions", {
                        account: profileLabel(profile),
                      })}
                      title=${t("modelProviders.profiles.actions", {
                        account: profileLabel(profile),
                      })}
                      ?disabled=${busy || mutationDisabled}
                    >
                      ${icon("moreHorizontal")}
                    </button>
                    ${props.profileOrderAvailable
                      ? html`
                          <wa-dropdown-item value="move-up" ?disabled=${!canMoveUp}>
                            ${t("modelProviders.profiles.moveUp", {
                              account: profileLabel(profile),
                            })}
                          </wa-dropdown-item>
                          <wa-dropdown-item value="move-down" ?disabled=${!canMoveDown}>
                            ${t("modelProviders.profiles.moveDown", {
                              account: profileLabel(profile),
                            })}
                          </wa-dropdown-item>
                        `
                      : nothing}
                    ${canClearCooldown
                      ? html`<wa-dropdown-item value="clear-cooldown">
                          ${t("modelProviders.profiles.clearCooldown")}
                        </wa-dropdown-item>`
                      : nothing}
                    ${canLogout
                      ? html`<wa-dropdown-item value="logout" variant="danger">
                          ${t("modelProviders.logout.action")}
                        </wa-dropdown-item>`
                      : nothing}
                  </wa-dropdown>`
                : nothing}
            </div>
          `;
        })}
        ${renderProfileMessage(message)}
      </div>
    </details>
  `;
}
