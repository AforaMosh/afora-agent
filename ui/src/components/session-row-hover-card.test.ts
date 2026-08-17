/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import {
  renderCatalogSessionInformationCard,
  renderSessionInformationCard,
} from "./session-row-hover-card.ts";

let container: HTMLDivElement;

beforeEach(async () => {
  await i18n.setLocale("en");
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => container.remove());

function session(overrides: Partial<SidebarRecentSession> = {}): SidebarRecentSession {
  return {
    key: "agent:main:one",
    label: "One",
    href: "/chat",
    active: false,
    visuallyActive: false,
    hasActiveRun: false,
    modelSelectionLocked: false,
    pinned: false,
    unread: false,
    attention: { kind: "none" },
    cloudWorkerStopAction: null,
    hasAutomation: false,
    childSessionKeys: [],
    children: [],
    isChild: false,
    loadingChildren: false,
    containsActiveDescendant: false,
    runningChildCount: 0,
    failedChildCount: 0,
    ...overrides,
  };
}

function rowText(): string[] {
  return [...container.querySelectorAll(".session-hover-card__row")].map((row) =>
    (row.textContent ?? "").replace(/\s+/gu, " ").trim(),
  );
}

describe("session information card", () => {
  it("shows the complete title, project, branch, creator, and participants", () => {
    render(
      renderSessionInformationCard({
        session: session({
          createdActor: { type: "human", id: "ada", label: "Ada" },
          updatedAt: Date.now() - 3_600_000,
        }),
        title: "Reconcile the workspace conflict",
        subtitle: "openclaw ⎇ feature/sidebar · macbook",
        presencePayload: {
          presence: [
            {
              instanceId: "self",
              user: { id: "ada", name: "Ada" },
              watchedSessions: ["agent:main:one"],
            },
            {
              instanceId: "peer",
              user: { id: "grace", name: "Grace" },
              watchedSessions: ["agent:main:one"],
            },
          ],
        },
        selfInstanceId: "self",
      }),
      container,
    );

    expect(container.querySelector(".session-hover-card__title")?.textContent).toBe(
      "Reconcile the workspace conflict",
    );
    expect(rowText()).toEqual([
      "Created by Ada",
      "Project openclaw",
      "Branch feature/sidebar",
      "People Grace",
    ]);
  });

  it("uses catalog facts without inventing unavailable context", () => {
    render(
      renderCatalogSessionInformationCard({
        title: "Refactor sidebar",
        age: "3d",
        cwd: "/work/openclaw",
        branch: "main",
      }),
      container,
    );

    expect(rowText()).toEqual(["Project /work/openclaw", "Branch main"]);
  });
});
