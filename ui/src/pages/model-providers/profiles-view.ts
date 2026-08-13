import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { icon, icons } from "../../components/icons.ts";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import "../../components/web-awesome.ts";
import { t } from "../../i18n/index.ts";
import { formatTimeMs } from "../../lib/format.ts";
import type { ModelProviderCard } from "./data.ts";
import type { ModelProvidersViewProps } from "./view.ts";

type ProviderProfile = ModelProviderCard["profiles"][number];

type ProfileMessage = {
  kind: "success" | "error";
  text: string;
  warning?: string;
};

type ProfileDropPosition = "before" | "after";

const PROFILE_DRAG_MIME = "application/x-openclaw-provider-profile";
const PROFILE_DRAGGING_CLASS = "model-providers__profile--dragging";
const PROFILE_DROP_BEFORE_CLASS = "model-providers__profile--drop-before";
const PROFILE_DROP_AFTER_CLASS = "model-providers__profile--drop-after";

function profileLabel(profile: ProviderProfile): string {
  return profile.displayName || profile.email || profile.profileId;
}

function profileIdentity(profile: ProviderProfile): string {
  return profile.email || profile.displayName || profile.profileId;
}

function profileMeta(profile: ProviderProfile): string {
  const parts: string[] = [];
  if (profile.email && profile.displayName) {
    parts.push(profile.displayName);
  } else if (profileIdentity(profile) !== profile.profileId) {
    parts.push(profile.profileId);
  }
  if (profile.lastUsedAt) {
    parts.push(
      t("modelProviders.profiles.lastUsed", {
        time: formatTimeMs(Date.now() - profile.lastUsedAt),
      }),
    );
  }
  return parts.join(" · ");
}

function profileInitials(profile: ProviderProfile): string {
  const localPart = profileIdentity(profile).split("@")[0] ?? "";
  const words = localPart.split(/[^a-z0-9]+/iu).filter(Boolean);
  const initials =
    words.length > 1
      ? `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}`
      : (words[0]?.slice(0, 2) ?? "");
  return initials.toLocaleUpperCase() || "?";
}

function orderedProfiles(card: ModelProviderCard) {
  const explicit = new Map(card.profileOrder.map((profileId, index) => [profileId, index]));
  return card.profiles.toSorted((left, right) => {
    const leftIndex = explicit.get(left.profileId) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = explicit.get(right.profileId) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex || left.profileId.localeCompare(right.profileId);
  });
}

function profileCooldown(profile: ProviderProfile) {
  return Math.max(
    profile.cooldownUntil ?? 0,
    profile.disabledUntil ?? 0,
    profile.blockedUntil ?? 0,
  );
}

function renderProfileStatus(profile: ProviderProfile) {
  const cooldown = profileCooldown(profile);
  if (cooldown > Date.now()) {
    return renderSettingsStatus({
      kind: "warn",
      label: t("modelProviders.profiles.cooldown", {
        time: formatTimeMs(cooldown - Date.now()),
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

function reorderedOwnerProfileIds(
  ownerProfiles: ProviderProfile[],
  visibleOwnerProfiles: ProviderProfile[],
  draggedId: string,
  targetId: string,
  position: ProfileDropPosition,
): string[] | null {
  const visibleIds = visibleOwnerProfiles.map((profile) => profile.profileId);
  if (draggedId === targetId || !visibleIds.includes(draggedId) || !visibleIds.includes(targetId)) {
    return null;
  }
  const nextVisible = visibleIds.filter((profileId) => profileId !== draggedId);
  const targetIndex = nextVisible.indexOf(targetId);
  nextVisible.splice(targetIndex + (position === "after" ? 1 : 0), 0, draggedId);
  if (nextVisible.every((profileId, index) => profileId === visibleIds[index])) {
    return null;
  }

  const visibleIdSet = new Set(visibleIds);
  let nextVisibleIndex = 0;
  // Non-visible credentials keep their exact slots; the Gateway order applies
  // to the whole owner while this roster intentionally exposes OAuth/token rows.
  return ownerProfiles.map((profile) =>
    visibleIdSet.has(profile.profileId)
      ? (nextVisible[nextVisibleIndex++] ?? profile.profileId)
      : profile.profileId,
  );
}

function profileListFor(event: Event): HTMLElement | null {
  const row = event.currentTarget;
  return row instanceof HTMLElement ? row.closest(".model-providers__profile-list") : null;
}

function clearProfileDragState(list: HTMLElement | null): void {
  list
    ?.querySelectorAll<HTMLElement>(".model-providers__profile")
    .forEach((row) =>
      row.classList.remove(
        PROFILE_DRAGGING_CLASS,
        PROFILE_DROP_BEFORE_CLASS,
        PROFILE_DROP_AFTER_CLASS,
      ),
    );
}

function profileDropPosition(event: DragEvent, row: HTMLElement): ProfileDropPosition {
  const rect = row.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function setProfileDropTarget(event: DragEvent, position: ProfileDropPosition): void {
  const row = event.currentTarget;
  if (!(row instanceof HTMLElement)) {
    return;
  }
  const list = profileListFor(event);
  list
    ?.querySelectorAll<HTMLElement>(`.${PROFILE_DROP_BEFORE_CLASS}, .${PROFILE_DROP_AFTER_CLASS}`)
    .forEach((candidate) => {
      if (candidate !== row) {
        candidate.classList.remove(PROFILE_DROP_BEFORE_CLASS, PROFILE_DROP_AFTER_CLASS);
      }
    });
  row.classList.toggle(PROFILE_DROP_BEFORE_CLASS, position === "before");
  row.classList.toggle(PROFILE_DROP_AFTER_CLASS, position === "after");
}

export function renderProfiles(card: ModelProviderCard, props: ModelProvidersViewProps) {
  const allOrderedProfiles = orderedProfiles(card);
  const profiles = allOrderedProfiles.filter(
    (profile) => profile.type === "oauth" || profile.type === "token",
  );
  if (profiles.length === 0) {
    return nothing;
  }
  const busy = Boolean(props.busy[`profiles:${card.id}`] || props.busy[`logout:${card.id}`]);
  const mutationDisabled = !props.canMutate || props.configBusy;
  const message = props.messages[`profiles:${card.id}`];
  const reorderOffered =
    props.profileOrderAvailable &&
    profiles.some((profile, index) => {
      const provider = card.profileProviderIds[profile.profileId] ?? card.id;
      return profiles.some(
        (candidate, candidateIndex) =>
          candidateIndex !== index &&
          (card.profileProviderIds[candidate.profileId] ?? card.id) === provider,
      );
    });

  return html`
    <section
      class="model-providers__profiles${reorderOffered
        ? " model-providers__profiles--reorderable"
        : ""}"
      aria-label=${t("modelProviders.profiles.title")}
      aria-busy=${busy ? "true" : "false"}
    >
      <div class="model-providers__profiles-heading">
        <span class="model-providers__profiles-heading-copy">
          <strong>${t("modelProviders.profiles.title")}</strong>
          <span>
            ${t(
              profiles.length === 1
                ? "modelProviders.profiles.accountOne"
                : "modelProviders.profiles.accounts",
              { count: String(profiles.length) },
            )}
            ·
            ${t(
              reorderOffered
                ? "modelProviders.profiles.reorderHint"
                : "modelProviders.profiles.orderHint",
            )}
          </span>
        </span>
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${mutationDisabled}
          @click=${props.onOpenModelSetup}
        >
          ${t("modelProviders.profiles.addAccount")}
        </button>
      </div>
      <div class="model-providers__profile-list" role="list">
        ${repeat(
          profiles,
          (profile) => profile.profileId,
          (profile) => {
            const provider = card.profileProviderIds[profile.profileId] ?? card.id;
            const cooldown = profileCooldown(profile);
            const ownerProfiles = allOrderedProfiles.filter(
              (candidate) => (card.profileProviderIds[candidate.profileId] ?? card.id) === provider,
            );
            const visibleOwnerProfiles = ownerProfiles.filter(
              (candidate) => candidate.type === "oauth" || candidate.type === "token",
            );
            const ownerIndex = visibleOwnerProfiles.findIndex(
              (candidate) => candidate.profileId === profile.profileId,
            );
            const canMove =
              reorderOffered && visibleOwnerProfiles.length > 1 && !busy && !mutationDisabled;
            const canMoveUp = canMove && ownerIndex > 0;
            const canMoveDown = canMove && ownerIndex < visibleOwnerProfiles.length - 1;
            const canClearCooldown = props.profileCooldownClearAvailable && cooldown > Date.now();
            const canLogout = profile.logoutSupported === true;
            const identity = profileIdentity(profile);
            const orderLabel =
              ownerIndex === 0
                ? t("modelProviders.profiles.primary")
                : t("modelProviders.profiles.priority", { position: String(ownerIndex + 1) });
            const move = (position: ProfileDropPosition, targetId: string) => {
              const next = reorderedOwnerProfileIds(
                ownerProfiles,
                visibleOwnerProfiles,
                profile.profileId,
                targetId,
                position,
              );
              if (next) {
                props.onProfileOrderChange(card.id, provider, next);
              }
            };
            return html`
              <div
                class="model-providers__profile"
                role="listitem"
                data-profile-id=${profile.profileId}
                draggable=${canMove ? "true" : "false"}
                @dragstart=${(event: DragEvent) => {
                  const target = event.target;
                  if (
                    !canMove ||
                    !(target instanceof Element) ||
                    !target.closest(".model-providers__profile-grip") ||
                    !event.dataTransfer
                  ) {
                    event.preventDefault();
                    return;
                  }
                  event.dataTransfer.setData(PROFILE_DRAG_MIME, profile.profileId);
                  event.dataTransfer.effectAllowed = "move";
                  const row = event.currentTarget;
                  if (row instanceof HTMLElement) {
                    event.dataTransfer.setDragImage(row, 24, row.offsetHeight / 2);
                    row.classList.add(PROFILE_DRAGGING_CLASS);
                  }
                }}
                @dragover=${(event: DragEvent) => {
                  if (!canMove || !event.dataTransfer?.types.includes(PROFILE_DRAG_MIME)) {
                    return;
                  }
                  event.preventDefault();
                  if (event.dataTransfer) {
                    event.dataTransfer.dropEffect = "move";
                  }
                  const row = event.currentTarget;
                  if (row instanceof HTMLElement) {
                    setProfileDropTarget(event, profileDropPosition(event, row));
                  }
                }}
                @dragleave=${(event: DragEvent) => {
                  const row = event.currentTarget;
                  if (!(row instanceof HTMLElement)) {
                    return;
                  }
                  const related = event.relatedTarget;
                  if (related instanceof Node && row.contains(related)) {
                    return;
                  }
                  row.classList.remove(PROFILE_DROP_BEFORE_CLASS, PROFILE_DROP_AFTER_CLASS);
                }}
                @drop=${(event: DragEvent) => {
                  const row = event.currentTarget;
                  const draggedId = event.dataTransfer?.getData(PROFILE_DRAG_MIME);
                  if (!(row instanceof HTMLElement) || !draggedId) {
                    return;
                  }
                  const position = row.classList.contains(PROFILE_DROP_AFTER_CLASS)
                    ? "after"
                    : row.classList.contains(PROFILE_DROP_BEFORE_CLASS)
                      ? "before"
                      : profileDropPosition(event, row);
                  clearProfileDragState(profileListFor(event));
                  if (!visibleOwnerProfiles.some((item) => item.profileId === draggedId)) {
                    return;
                  }
                  event.preventDefault();
                  const next = reorderedOwnerProfileIds(
                    ownerProfiles,
                    visibleOwnerProfiles,
                    draggedId,
                    profile.profileId,
                    position,
                  );
                  if (next) {
                    props.onProfileOrderChange(card.id, provider, next);
                  }
                }}
                @dragend=${(event: DragEvent) => clearProfileDragState(profileListFor(event))}
              >
                <button
                  type="button"
                  class="model-providers__profile-grip"
                  draggable=${canMove ? "true" : "false"}
                  ?disabled=${!canMove}
                  aria-label=${t("modelProviders.profiles.reorder", {
                    account: identity,
                    position: String(ownerIndex + 1),
                  })}
                  aria-keyshortcuts=${canMove ? "ArrowUp ArrowDown" : nothing}
                  @keydown=${(event: KeyboardEvent) => {
                    if (!canMove) {
                      return;
                    }
                    const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
                    if (delta === 0) {
                      return;
                    }
                    const adjacent = visibleOwnerProfiles[ownerIndex + delta];
                    if (!adjacent) {
                      return;
                    }
                    event.preventDefault();
                    move(delta < 0 ? "before" : "after", adjacent.profileId);
                  }}
                >
                  ${icons.gripVertical}
                </button>
                <span class="model-providers__profile-avatar" aria-hidden="true"
                  >${profileInitials(profile)}</span
                >
                <span class="model-providers__profile-copy">
                  <strong title=${identity}>${identity}</strong>
                  <span>
                    <span class="model-providers__profile-mobile-order" aria-hidden="true"
                      >${orderLabel} ·</span
                    >
                    ${profileMeta(profile)}
                  </span>
                </span>
                <span class="model-providers__profile-status">${renderProfileStatus(profile)}</span>
                <span
                  class="model-providers__profile-order${ownerIndex === 0
                    ? " model-providers__profile-order--primary"
                    : ""}"
                  aria-hidden="true"
                  >${orderLabel}</span
                >
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
                        move(offset < 0 ? "before" : "after", adjacent.profileId);
                      }}
                    >
                      <button
                        slot="trigger"
                        type="button"
                        class="btn btn--sm btn--ghost model-providers__profile-menu-trigger"
                        aria-label=${t("modelProviders.profiles.actions", { account: identity })}
                        title=${t("modelProviders.profiles.actions", { account: identity })}
                        ?disabled=${busy || mutationDisabled}
                      >
                        ${icon("moreHorizontal")}
                      </button>
                      ${props.profileOrderAvailable
                        ? html`
                            <wa-dropdown-item value="move-up" ?disabled=${!canMoveUp}>
                              ${t("modelProviders.profiles.moveUp", { account: identity })}
                            </wa-dropdown-item>
                            <wa-dropdown-item value="move-down" ?disabled=${!canMoveDown}>
                              ${t("modelProviders.profiles.moveDown", { account: identity })}
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
                  : html`<span class="model-providers__profile-menu-placeholder"></span>`}
              </div>
            `;
          },
        )}
      </div>
      ${renderProfileMessage(message)}
    </section>
  `;
}
