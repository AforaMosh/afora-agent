// Owns prepared-model-runtime publication readiness for a long-lived embedded TUI host.
import { refreshPreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.js";
import type { AforaConfig } from "../config/types.afora.js";

export class EmbeddedPreparedModelRuntimeHost {
  private ready: Promise<void> = Promise.resolve();

  publish(config: AforaConfig): void {
    // The runtime layer synchronously stales the prior generation and coalesces queued requests.
    // Invoke it immediately so overlapping config writes retain those latest-wins semantics.
    this.ready = refreshPreparedModelRuntimeSnapshots(config, { catalogMode: "static" });
  }

  async waitUntilReady(): Promise<void> {
    for (;;) {
      const ready = this.ready;
      await ready;
      if (ready === this.ready) {
        return;
      }
    }
  }
}
