import { expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGateway,
  createSessions,
  mountSidebar,
  type TestSessionMenu,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

it("shows a catalog-owned OpenClaw session only in its catalog section", async () => {
  const gateway = createGateway({} as GatewayBrowserClient);
  const backingSessionKey = "agent:main:claude-bound";
  const { sidebar } = await mountSidebar(
    gateway,
    createSessions("main", ["agent:main:main", backingSessionKey]),
    "panel",
    {
      defaultId: "main",
      mainKey: "agent:main:main",
      scope: "global",
      agents: [
        { id: "main", name: "Main" },
        { id: "research", name: "Research" },
      ],
    },
  );
  sidebar.connected = true;
  sidebar.sessionData.sessionCatalogs = [
    {
      id: "claude",
      label: "Claude Code",
      capabilities: { continueSession: true, archive: false },
      hosts: [
        {
          hostId: "gateway:local",
          label: "Local Claude",
          kind: "gateway",
          connected: true,
          sessions: [
            {
              threadId: "claude-thread",
              name: "Claude session",
              cwd: "/work/openclaw",
              source: "worktree",
              status: "stored",
              pullRequest: { numbers: [107302], state: "draft" },
              archived: false,
              sessionKey: backingSessionKey,
              canContinue: true,
              canArchive: false,
            },
          ],
        },
      ],
    },
  ];
  const backingRows = (sidebar.sessionData.sessionsResult?.sessions ?? []).map((row) =>
    row.key === backingSessionKey
      ? Object.assign({}, row, {
          unread: true,
          worktree: {
            id: "wt-adopted",
            branch: "feature/live-context",
            repoRoot: "/work/openclaw",
          },
        })
      : row,
  );
  sidebar.sessionData.sessionsResult = {
    ...sidebar.sessionData.sessionsResult!,
    sessions: backingRows,
  };
  sidebar.sessionData.sessionRowsByAgent = { main: backingRows };
  sidebar.sessionData.requestSessionDataUpdate();
  await sidebar.updateComplete;

  expect(
    sidebar.querySelectorAll(
      `.sidebar-agent-section__body [data-session-key="${backingSessionKey}"]`,
    ),
  ).toHaveLength(0);
  expect(
    sidebar.querySelectorAll(
      `[data-session-section="catalog:claude"] [data-session-key="${backingSessionKey}"]`,
    ),
  ).toHaveLength(1);
  expect(sidebar.querySelectorAll(`[data-session-key="${backingSessionKey}"]`)).toHaveLength(1);
  const catalogSection = sidebar.querySelector('[data-session-section="catalog:claude"]');
  const linkedRow = catalogSection?.querySelector<HTMLElement>(
    `[data-session-key="${backingSessionKey}"]`,
  );
  expect(linkedRow?.getAttribute("draggable")).toBe("true");
  const pullRequestBadge = linkedRow?.querySelector(".session-row-badge--pull-request");
  expect(pullRequestBadge?.hasAttribute("title")).toBe(false);
  expect(
    (pullRequestBadge?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)
      ?.content,
  ).toBe("#107302 · Draft");
  expect(linkedRow?.querySelector('[data-sidebar-session-pin="true"]')).not.toBeNull();
  expect(linkedRow?.querySelector('[data-session-menu="true"]')).not.toBeNull();
  expect(linkedRow?.querySelector(".sidebar-recent-session__subtitle-text")?.textContent).toBe(
    "feature/live-context",
  );
  expect(linkedRow?.querySelector(".session-row-worktree-glyph")).not.toBeNull();
  linkedRow?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await sidebar.updateComplete;
  const linkedMenu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
  await linkedMenu?.updateComplete;
  expect(linkedMenu?.querySelector('[data-shortcut="a"]')).not.toBeNull();
  expect(linkedMenu?.querySelector('[data-shortcut="d"]')).not.toBeNull();
  expect(
    catalogSection?.querySelector(
      `[data-session-key="${backingSessionKey}"] .session-state-dot--unread`,
    ),
  ).not.toBeNull();
  expect(
    catalogSection?.querySelector('.sidebar-recent-sessions__head [data-section-status="unread"]'),
  ).not.toBeNull();

  const runningRows = backingRows.map((row) =>
    row.key === backingSessionKey
      ? Object.assign({}, row, { unread: false, hasActiveRun: true })
      : row,
  );
  sidebar.sessionData.sessionsResult = {
    ...sidebar.sessionData.sessionsResult,
    sessions: runningRows,
  };
  sidebar.sessionData.sessionRowsByAgent = { main: runningRows };
  sidebar.sessionData.requestSessionDataUpdate();
  await sidebar.updateComplete;

  const runningCatalogSection = sidebar.querySelector('[data-session-section="catalog:claude"]');
  expect(
    runningCatalogSection?.querySelector(
      `[data-session-key="${backingSessionKey}"].session-row-host--running .session-run-spinner`,
    ),
  ).not.toBeNull();
  expect(
    runningCatalogSection?.querySelector(".sidebar-recent-sessions__head .session-run-spinner"),
  ).not.toBeNull();
});
