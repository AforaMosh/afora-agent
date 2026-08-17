// Active operational conditions live behind one footer bell so the sidebar
// stays quiet while the same canonical items remain available on demand.
import { consume } from "@lit/context";
import { initialState, Task } from "@lit/task";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { CronJob, ModelAuthStatusResult } from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { createInitialCronState, loadCronJobsPage } from "../lib/cron/index.ts";
import { loadModelAuthStatus } from "../lib/model-auth.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { icons } from "./icons.ts";
import { buildSidebarAttentionItems, type SidebarAttentionItem } from "./sidebar-attention-items.ts";
import "./menu-surface.ts";

// Reloads are connection-scoped; a visibility change only refetches after the
// snapshot is older than this, so tab switches stay free of request bursts.
const VISIBILITY_REFRESH_MIN_AGE_MS = 60_000;
// Always-visible windows (the macOS app) never fire visibilitychange, so a
// slow lifecycle-owned interval keeps the chips from going permanently stale.
const IDLE_REFRESH_INTERVAL_MS = 10 * 60_000;

class SidebarAttention extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @state() private cronJobs: CronJob[] = [];
  @state() private modelAuthStatus: ModelAuthStatusResult | null = null;
  @state() private panelOpen = false;
  @state() private panelPosition = { left: 8, bottom: 8 };

  @property({ attribute: false }) activeRouteId?: NavigationRouteId;
  @property({ attribute: false }) onNavigate?: (routeId: NavigationRouteId) => void;
  @property({ attribute: false }) onOpenApprovals?: () => void;

  private loadedClient: GatewayBrowserClient | null = null;
  private loadedGateway: ApplicationContext["gateway"] | null = null;
  private loadedAgentId: string | null = null;
  // Cron events may restart the combined task; retain the committed auth owner so an
  // interrupted agent switch reissues auth instead of displaying the prior agent's alert.
  private modelAuthAgentId: string | null = null;
  private loadedAtMs = 0;
  private idleRefreshTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private panelTrigger: HTMLElement | null = null;

  private readonly loadTask = new Task(this, {
    autoRun: false,
    // Gateway identity matters when a replacement source reuses the same client object.
    args: () =>
      [
        null as ApplicationContext["gateway"] | null,
        null as GatewayBrowserClient | null,
        null as string | null,
        true as boolean,
      ] as const,
    task: async ([gateway, client, agentId, refreshModelAuth], { signal }) => {
      if (!gateway || !client) {
        return initialState;
      }
      const cron = createInitialCronState({ client, connected: true });
      const loads: Promise<unknown>[] = [
        loadCronJobsPage(cron).then(() => {
          if (!signal.aborted) {
            this.cronJobs = cron.cronJobs;
          }
        }),
      ];
      if (refreshModelAuth && agentId) {
        loads.push(
          loadModelAuthStatus(client, {
            agentId,
            signal,
          })
            .catch(() => null)
            .then((modelAuthStatus) => {
              if (!signal.aborted) {
                this.modelAuthStatus = modelAuthStatus;
                this.modelAuthAgentId = agentId;
              }
            }),
        );
      } else if (!agentId) {
        this.modelAuthStatus = null;
        this.modelAuthAgentId = null;
      }
      await Promise.allSettled(loads);
      return true;
    },
    onComplete: () => {
      this.loadedAtMs = Date.now();
    },
  });

  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        this.synchronize(gateway);
        return gateway.subscribe(() => this.synchronize(gateway));
      },
    )
    .watch(
      () => this.context?.agentSelection,
      (selection, notify) => selection.subscribe(notify),
      () => {
        const gateway = this.context?.gateway;
        if (gateway) {
          this.synchronize(gateway);
        }
      },
    )
    .effect(
      () => this.context?.gateway,
      (gateway) =>
        gateway.subscribeEvents((event) => {
          if (this.context?.gateway !== gateway || event.event !== "cron") {
            return;
          }
          // The Automations page refreshes from the same event. Refresh this
          // independent snapshot too so its ambient alert cannot contradict it.
          this.loadedClient = null;
          this.synchronize(gateway, { refreshModelAuth: false });
        }),
    )
    .watch(
      () => this.context?.overlays,
      (overlays, notify) => overlays.subscribe(() => notify()),
    );

  private readonly refreshIfStale = () => {
    if (document.visibilityState !== "visible") {
      return;
    }
    const gateway = this.context?.gateway;
    if (gateway && Date.now() - this.loadedAtMs >= VISIBILITY_REFRESH_MIN_AGE_MS) {
      this.loadedClient = null;
      this.synchronize(gateway);
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.refreshIfStale);
    this.idleRefreshTimer = globalThis.setInterval(this.refreshIfStale, IDLE_REFRESH_INTERVAL_MS);
  }

  override disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.refreshIfStale);
    document.removeEventListener("pointerdown", this.closeOnOutsidePointer, true);
    if (this.idleRefreshTimer !== null) {
      globalThis.clearInterval(this.idleRefreshTimer);
      this.idleRefreshTimer = null;
    }
    this.subscriptions.clear();
    void this.loadTask.run([null, null, null, false]);
    this.loadedClient = null;
    this.loadedGateway = null;
    this.loadedAgentId = null;
    this.modelAuthAgentId = null;
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("activeRouteId") && changed.get("activeRouteId") !== undefined) {
      this.closePanel(false);
    }
    if (this.panelOpen && this.currentItems().length === 0) {
      this.closePanel(false);
    }
  }

  private synchronize(
    gateway: ApplicationContext["gateway"],
    options: { refreshModelAuth?: boolean } = {},
  ) {
    const snapshot = gateway.snapshot;
    if (snapshot.phase !== "connected" || !snapshot.client) {
      void this.loadTask.run([null, null, null, false]);
      this.loadedClient = null;
      this.loadedGateway = null;
      this.loadedAgentId = null;
      this.modelAuthAgentId = null;
      this.cronJobs = [];
      this.modelAuthStatus = null;
      return;
    }
    const agentId = this.context?.agentSelection.state.selectedId ?? null;
    if (
      gateway === this.loadedGateway &&
      snapshot.client === this.loadedClient &&
      agentId === this.loadedAgentId
    ) {
      return;
    }
    this.loadedGateway = gateway;
    this.loadedClient = snapshot.client;
    this.loadedAgentId = agentId;
    void this.loadTask.run([
      gateway,
      snapshot.client,
      agentId,
      options.refreshModelAuth !== false || agentId !== this.modelAuthAgentId,
    ]);
  }

  private currentItems() {
    return buildSidebarAttentionItems({
      cronJobs: this.cronJobs,
      modelAuthStatus: this.modelAuthAgentId === this.loadedAgentId ? this.modelAuthStatus : null,
      modelAuthAgentId: this.modelAuthAgentId,
      approvalQueue: this.context?.overlays.snapshot.approvalQueue ?? [],
      now: Date.now(),
    });
  }

  private readonly closeOnOutsidePointer = (event: PointerEvent) => {
    if (!this.panelOpen || event.composedPath().includes(this)) {
      return;
    }
    this.closePanel(false);
  };

  private openPanel(trigger: HTMLElement) {
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(304, globalThis.innerWidth - 16);
    this.panelTrigger = trigger;
    this.panelPosition = {
      left: Math.max(8, Math.min(rect.right - width, globalThis.innerWidth - width - 8)),
      bottom: Math.max(8, globalThis.innerHeight - rect.top + 6),
    };
    this.panelOpen = true;
    document.addEventListener("pointerdown", this.closeOnOutsidePointer, true);
    void this.updateComplete.then(() => {
      this.querySelector<HTMLElement>(".sidebar-issues-panel [data-autofocus]")?.focus();
    });
  }

  private closePanel(restoreFocus: boolean) {
    if (!this.panelOpen) {
      return;
    }
    const trigger = this.panelTrigger;
    this.panelOpen = false;
    this.panelTrigger = null;
    document.removeEventListener("pointerdown", this.closeOnOutsidePointer, true);
    if (restoreFocus) {
      void this.updateComplete.then(() => trigger?.focus());
    }
  }

  private open(item: SidebarAttentionItem) {
    this.closePanel(false);
    if (item.action.kind === "openApprovals") {
      this.onOpenApprovals?.();
      return;
    }
    this.onNavigate?.(item.action.routeId);
  }

  private readonly handlePanelKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.closePanel(true);
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const rows = Array.from(
      (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("button"),
    );
    const first = rows[0];
    const last = rows.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  private renderItem(item: SidebarAttentionItem, autofocus: boolean) {
    return html`
      <button
        type="button"
        class="sidebar-issues-panel__row sidebar-issues-panel__row--${item.severity}"
        data-autofocus=${autofocus ? "true" : nothing}
        aria-label=${item.detail ? `${item.label}: ${item.detail}` : item.label}
        @click=${() => this.open(item)}
      >
        <span class="sidebar-issues-panel__icon" aria-hidden="true">${icons[item.icon]}</span>
        <span class="sidebar-issues-panel__content">
          <span class="sidebar-issues-panel__entity">${item.label}</span>
          ${item.detail
            ? html`<span class="sidebar-issues-panel__state">${item.detail}</span>`
            : nothing}
        </span>
        <span class="sidebar-issues-panel__chevron" aria-hidden="true"
          >${icons.chevronRight}</span
        >
      </button>
    `;
  }

  override render() {
    if (this.context?.gateway.snapshot.phase !== "connected") {
      return nothing;
    }
    const items = this.currentItems();
    if (items.length === 0) {
      return nothing;
    }
    const count = items.length;
    const label = `${count} ${count === 1 ? "issue" : "issues"}`;
    return html`
      <span class="sr-only" role="status" aria-live="polite">${label}</span>
      <button
        type="button"
        class="sidebar-issues-button"
        aria-expanded=${String(this.panelOpen)}
        aria-haspopup="dialog"
        aria-label=${label}
        @click=${(event: MouseEvent) =>
          this.panelOpen
            ? this.closePanel(true)
            : this.openPanel(event.currentTarget as HTMLElement)}
      >
        <span class="sidebar-issues-button__icon" aria-hidden="true">${icons.bell}</span>
        <span class="sidebar-issues-button__count" aria-hidden="true"
          >${count > 9 ? "9+" : count}</span
        >
      </button>
      ${this.panelOpen
        ? html`<openclaw-menu-surface>
            <section
              class="sidebar-issues-panel"
              role="dialog"
              aria-label="Issues"
              style=${`left:${this.panelPosition.left}px;bottom:${this.panelPosition.bottom}px`}
              @keydown=${this.handlePanelKeydown}
            >
              <header class="sidebar-issues-panel__header">
                <h2 class="sidebar-issues-panel__heading">Issues</h2>
              </header>
              <div class="sidebar-issues-panel__list">
                ${items.map((item, index) => this.renderItem(item, index === 0))}
              </div>
            </section>
          </openclaw-menu-surface>`
        : nothing}
    `;
  }
}

if (!customElements.get("openclaw-sidebar-attention")) {
  customElements.define("openclaw-sidebar-attention", SidebarAttention);
}
