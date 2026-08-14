import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import "../../../styles/config.css";
import { createDreamingViewState, renderDreaming } from "./view.ts";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");
let host: HTMLDivElement | undefined;

afterEach(() => {
  host?.remove();
  host = undefined;
});

describe.skipIf(!hasBrowserLayout)("dream diary browser layout", () => {
  it("keeps the Memory hero fixed when a subview changes scrollbar state", async () => {
    host = document.createElement("div");
    host.className = "shell shell--settings";
    host.innerHTML = `
      <main class="content" style="box-sizing: border-box; width: 1152px; height: 600px; overflow-y: auto">
        <section class="memory-page">
          <section class="content-header content-header--page hub-page-header">
            <div class="hub-page-header__title">Memory</div>
            <div class="hub-page-header__tabs">Overview Memories Dreams Settings</div>
            <div class="hub-page-header__actions">Agent</div>
          </section>
          <div class="memory-page__panel" style="height: 200px"></div>
        </section>
      </main>
    `;
    document.body.append(host);

    const content = expectDefined(host.querySelector<HTMLElement>(".content"), "content");
    const header = expectDefined(
      host.querySelector<HTMLElement>(".hub-page-header"),
      "Memory header",
    );
    const tabs = expectDefined(
      host.querySelector<HTMLElement>(".hub-page-header__tabs"),
      "Memory tabs",
    );
    const before = {
      clientWidth: content.clientWidth,
      header: header.getBoundingClientRect(),
      tabs: tabs.getBoundingClientRect(),
    };

    const panel = expectDefined(
      host.querySelector<HTMLElement>(".memory-page__panel"),
      "Memory panel",
    );
    panel.style.height = "1200px";
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const after = {
      clientWidth: content.clientWidth,
      header: header.getBoundingClientRect(),
      tabs: tabs.getBoundingClientRect(),
    };
    expect(getComputedStyle(content).scrollbarGutter).toBe("stable");
    expect(after.clientWidth).toBe(before.clientWidth);
    expect(after.header.left).toBe(before.header.left);
    expect(after.header.right).toBe(before.header.right);
    expect(after.tabs.left).toBe(before.tabs.left);
    expect(after.tabs.top).toBe(before.tabs.top);
  });

  it("keeps diary dates visible and clickable while a long entry scrolls", async () => {
    host = document.createElement("div");
    host.style.height = "420px";
    host.style.width = "760px";
    host.style.overflow = "hidden";
    document.body.append(host);

    const viewState = createDreamingViewState();
    viewState.activeSubTab = "diary";
    viewState.activeDiarySubTab = "dreams";
    const props: Parameters<typeof renderDreaming>[0] = {
      access: {
        canOpenConfig: true,
        canBackfillDiary: true,
        canDedupeDreamDiary: true,
        canResetDiary: true,
        canResetGroundedShortTerm: true,
        canRepairDreamingArtifacts: true,
      },
      viewState,
      active: true,
      selectedAgentId: "main",
      shortTermCount: 0,
      promotedCount: 0,
      shortTermEntries: [],
      promotedEntries: [],
      dreamingOf: null,
      nextCycle: null,
      timezone: null,
      statusError: null,
      modeSaving: false,
      dreamDiaryLoading: false,
      dreamDiaryActionLoading: false,
      dreamDiaryActionMessage: null,
      dreamDiaryActionArchivePath: null,
      dreamDiaryError: null,
      dreamDiaryContent: [
        "# Dream Diary",
        "---",
        "*January 1, 2026*",
        "The earlier diary entry remains available.",
        "---",
        "*January 2, 2026*",
        ...Array.from(
          { length: 24 },
          (_, index) => `Long diary paragraph ${index + 1}: ${"a visible memory ".repeat(8)}`,
        ),
      ].join("\n\n"),
      memoryWikiEnabled: false,
      wikiImportInsightsLoading: false,
      wikiImportInsightsError: null,
      wikiImportInsights: null,
      wikiOverviewLoading: false,
      wikiOverviewError: null,
      wikiOverview: null,
      onRefreshDiary: () => {},
      onRefreshImports: () => {},
      onRefreshWikiOverview: () => {},
      onOpenConfig: () => {},
      onOpenWikiPage: async () => null,
      onBackfillDiary: () => {},
      onCopyDreamingArchivePath: () => {},
      onDedupeDreamDiary: () => {},
      onResetDiary: () => {},
      onResetGroundedShortTerm: () => {},
      onRepairDreamingArtifacts: () => {},
      onViewStateChange: () => render(renderDreaming(props), host!),
    };
    render(renderDreaming(props), host);

    const diary = host.querySelector<HTMLElement>(".dreams-diary");
    const navigation = host.querySelector<HTMLElement>(".dreams-diary__daychips");
    expect(diary).not.toBeNull();
    expect(navigation).not.toBeNull();
    expect(getComputedStyle(diary!).overflowY).toBe("auto");
    expect(getComputedStyle(navigation!.parentElement!).position).toBe("sticky");
    expect(diary!.scrollHeight).toBeGreaterThan(diary!.clientHeight);

    diary!.scrollTop = 500;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

    const olderDate = expectDefined(
      navigation!.querySelectorAll<HTMLButtonElement>(".dreams-diary__day-chip")[1],
      "older diary date button",
    );
    expect(diary!.scrollTop).toBeGreaterThan(100);
    expect(olderDate.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      diary!.getBoundingClientRect().top,
    );
    expect(olderDate.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      diary!.getBoundingClientRect().bottom,
    );

    olderDate.click();
    expect(viewState.diaryPage).toBe(1);
    expect(host.querySelector(".dreams-diary__date")?.textContent).toBe("January 1, 2026");
  });
});
