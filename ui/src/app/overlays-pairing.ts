// Startup-safe pairing overlay facade. Every sibling modal already keeps its
// implementation off the startup graph, and the wizard plus its endpoint probe
// are the largest of them, so this file holds only the shape the app shell
// reads on every render and defers the rest until the dialog is opened.
import type {
  PairingConfigWriter,
  PairingWizardActions,
  PairingWizardDeps,
  PairingWizardSnapshot,
} from "../lib/pairing/wizard.ts";
import type { ApplicationGateway } from "./gateway.ts";
import type { createPairingOverlayRuntime } from "./overlays-pairing.runtime.ts";

type PairingOverlayRuntime = ReturnType<typeof createPairingOverlayRuntime>;
type PairingOverlayConnection = Parameters<PairingOverlayRuntime["syncConnection"]>[0];

export const EMPTY_PAIRING_WIZARD_SNAPSHOT: PairingWizardSnapshot = {
  open: false,
  access: "full",
  step: { kind: "inspecting" },
  notice: null,
};

export function createOverlayPairing(params: {
  gateway: ApplicationGateway;
  config?: PairingConfigWriter;
  probe?: PairingWizardDeps["probe"];
  isDisposed: () => boolean;
  publish: () => void;
}) {
  let runtime: PairingOverlayRuntime | null = null;
  let loading: Promise<PairingOverlayRuntime | null> | null = null;
  // Replayed into the runtime on creation: the app keeps syncing connection
  // state while the dialog has never been opened, and the wizard has to adopt
  // the current one rather than whatever it saw first.
  let connection: PairingOverlayConnection | null = null;

  const load = async (): Promise<PairingOverlayRuntime | null> => {
    if (runtime) {
      return runtime;
    }
    loading ??= import("./overlays-pairing.runtime.ts").then((module) => {
      if (params.isDisposed()) {
        return null;
      }
      runtime ??= module.createPairingOverlayRuntime(params);
      if (connection) {
        runtime.syncConnection(connection);
      }
      return runtime;
    });
    try {
      return await loading;
    } finally {
      loading = null;
    }
  };

  const actions: PairingWizardActions = {
    // Every action below is reachable only from the opened dialog, so the
    // runtime already exists; the guard keeps a late event from constructing it.
    setAccess: (access) => runtime?.actions.setAccess(access),
    chooseRoute: async (route) => await runtime?.actions.chooseRoute(route),
    setPublicUrl: (value) => runtime?.actions.setPublicUrl(value),
    submitPublicUrl: async () => await runtime?.actions.submitPublicUrl(),
    confirmLan: async () => await runtime?.actions.confirmLan(),
    back: async () => await runtime?.actions.back(),
  };

  return {
    actions,
    get snapshot(): PairingWizardSnapshot {
      return runtime?.snapshot ?? EMPTY_PAIRING_WIZARD_SNAPSHOT;
    },
    get pendingCount(): number {
      return runtime?.pendingCount ?? 0;
    },
    invalidatePending(options: { clear?: boolean } = {}) {
      runtime?.invalidatePending(options);
    },
    async refreshPending() {
      await runtime?.refreshPending();
    },
    close() {
      runtime?.close();
    },
    async open() {
      await (await load())?.open();
    },
    syncConnection(next: PairingOverlayConnection) {
      connection = next;
      runtime?.syncConnection(next);
    },
  };
}
