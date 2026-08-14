// Control UI tests cover the community invite showing protocol in a real browser,
// across two pages of one browser profile. jsdom cannot carry this proof: Web Locks
// do not exist there, so mutual exclusion, lock release and the fail-closed
// behavior of a browser without a lock manager can only be observed here.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI community invite showing E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const STORAGE_KEY = "openclaw:control-ui:community-invite:v1";
const RUNTIME_MODULE = "/src/app/community-invite.runtime.ts";

/** An armed record: qualified once already, upgraded cohort, never shown. */
function armedRecord(): string {
  return JSON.stringify({
    firstQualifiedAtMs: Date.now() - 60 * 60 * 1000,
    qualifiedLoads: 2,
    established: true,
  });
}

suite.define(() => {
  it("lets one page of a browser profile show the card, and never a second", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });

    async function openPage() {
      const page = await context.newPage();
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}`);
      return page;
    }

    try {
      const first = await openPage();
      const second = await openPage();

      // Same origin and same browser profile, so both pages share one localStorage
      // and one Web Locks namespace — exactly the situation two tabs are in.
      await first.evaluate(([key, record]) => localStorage.setItem(key, record), [
        STORAGE_KEY,
        armedRecord(),
      ] as const);
      expect(await second.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).not.toBeNull();

      const claimIn = (page: typeof first | typeof second) =>
        page.evaluate(async (module) => {
          const { claimCommunityInviteShowing } = (await import(
            /* @vite-ignore */ module
          )) as typeof import("../app/community-invite.runtime.ts");
          return claimCommunityInviteShowing();
        }, RUNTIME_MODULE);

      // Both pages race for the same showing.
      const claims = await Promise.all([claimIn(first), claimIn(second)]);
      expect(claims.filter(Boolean)).toHaveLength(1);

      // The winner left a durable tombstone, visible from the other page.
      const stored = await second.evaluate((key) => {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as { shownAtMs?: number }) : null;
      }, STORAGE_KEY);
      expect(stored?.shownAtMs).toBeGreaterThan(0);

      // The lock is released once the claim is decided, so a later attempt is
      // turned away by the tombstone rather than blocked by a held lock. If the
      // lock were still held this would hang instead of resolving false.
      expect(await claimIn(first)).toBe(false);
      expect(await claimIn(second)).toBe(false);

      // A page that dies right after being shown changes nothing: the tombstone was
      // written before the card, so the surviving page still refuses.
      await first.close();
      expect(await claimIn(second)).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("refuses to show when storage or Web Locks cannot carry the tombstone", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });

    try {
      const page = await context.newPage();
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}`);

      const claimWith = (
        fault: "none" | "no-locks" | "throwing-write" | "dropped-write" | "cleared",
      ) =>
        page.evaluate(
          async ([module, key, record, mode]) => {
            localStorage.setItem(key, record);
            const original = Storage.prototype.setItem;
            // `locks` lives on the prototype, so removing it there is what makes
            // `"locks" in navigator` false the way an unsupporting browser does.
            const locksDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "locks");
            if (mode === "no-locks") {
              Reflect.deleteProperty(Navigator.prototype, "locks");
            }
            if (mode === "throwing-write") {
              Storage.prototype.setItem = () => {
                throw new DOMException("quota", "QuotaExceededError");
              };
            }
            if (mode === "dropped-write") {
              Storage.prototype.setItem = () => undefined;
            }
            if (mode === "cleared") {
              localStorage.clear();
            }
            try {
              const { claimCommunityInviteShowing } = (await import(
                /* @vite-ignore */ module
              )) as typeof import("../app/community-invite.runtime.ts");
              const claimed = await claimCommunityInviteShowing();
              Storage.prototype.setItem = original;
              const raw = localStorage.getItem(key);
              return {
                claimed,
                shown: raw ? Boolean((JSON.parse(raw) as { shownAtMs?: number }).shownAtMs) : false,
              };
            } finally {
              Storage.prototype.setItem = original;
              if (locksDescriptor) {
                Object.defineProperty(Navigator.prototype, "locks", locksDescriptor);
              }
              localStorage.clear();
            }
          },
          [RUNTIME_MODULE, STORAGE_KEY, armedRecord(), fault] as const,
        );

      // The control: with everything working, this page does claim the showing.
      expect(await claimWith("none")).toEqual({ claimed: true, shown: true });

      // Every fault answers the same way, because a card with no durable tombstone
      // would come back on the next load — and might already be up in another tab.
      expect(await claimWith("no-locks")).toEqual({ claimed: false, shown: false });
      expect(await claimWith("throwing-write")).toEqual({ claimed: false, shown: false });
      expect(await claimWith("dropped-write")).toEqual({ claimed: false, shown: false });
      expect(await claimWith("cleared")).toEqual({ claimed: false, shown: false });
    } finally {
      await context.close();
    }
  });
});
