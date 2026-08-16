import { describe, expect, it, vi } from "vitest";
import { SidebarCustomizerController } from "./app-sidebar-customizer-controller.ts";
import {
  buildSidebarCustomizerEntries,
  buildSidebarCustomizerSections,
  mergeSidebarCustomizerEntries,
  sidebarCustomizerValuesEqual,
} from "./app-sidebar-customizer.ts";
import type { SidebarVisibleSections } from "./app-sidebar-session-navigation-logic.ts";

describe("sidebar customizer model", () => {
  it("restores customizable entries without replacing other current entries", () => {
    expect(
      mergeSidebarCustomizerEntries(
        ["fixed:current", "route:tasks"],
        ["route:cron", "route:plugins"],
        ["route:cron", "route:plugins", "route:tasks"],
      ),
    ).toEqual(["fixed:current", "route:cron", "route:plugins"]);
  });

  it("returns to pristine when the current values match the baseline", () => {
    const baseline = {
      sidebarEntries: ["route:cron", "route:plugins"],
      hiddenCatalogIds: ["claude"],
      groups: ["Research"],
      sectionOrder: ["work", "ungrouped"],
    };

    expect(
      sidebarCustomizerValuesEqual(
        {
          sidebarEntries: [...baseline.sidebarEntries],
          hiddenCatalogIds: [...baseline.hiddenCatalogIds],
          groups: [...baseline.groups],
          sectionOrder: [...baseline.sectionOrder],
        },
        baseline,
      ),
    ).toBe(true);
    expect(
      sidebarCustomizerValuesEqual(
        { ...baseline, sidebarEntries: [...baseline.sidebarEntries, "route:tasks"] },
        baseline,
      ),
    ).toBe(false);
  });

  it("keeps Home fixed and orders visible pages before hidden pages", () => {
    const items = buildSidebarCustomizerEntries({
      canonical: ["route:tasks", "route:cron"],
      enabledRouteIds: ["cron", "tasks", "plugins"],
      workboards: [],
    });

    expect(items.map((item) => item.id)).toEqual([
      "fixed:home",
      "route:tasks",
      "route:cron",
      "route:plugins",
    ]);
    expect(items[0]).toMatchObject({ reorderable: false, toggleable: false, visible: true });
    expect(items.map((item) => item.visible)).toEqual([true, true, true, false]);
  });

  it("keeps pinned sessions in their canonical page positions with a remove action", () => {
    const items = buildSidebarCustomizerEntries({
      canonical: ["route:tasks", "session:agent:main:taxes", "route:cron"],
      enabledRouteIds: ["cron", "tasks", "plugins"],
      pinnedSessions: new Map([
        ["agent:main:taxes", { key: "agent:main:taxes", label: "Tax filing research" }],
      ]),
      workboards: [],
    });

    expect(items.map((item) => item.id)).toEqual([
      "fixed:home",
      "route:tasks",
      "session:agent:main:taxes",
      "route:cron",
      "route:plugins",
    ]);
    expect(items[2]).toMatchObject({
      label: "Tax filing research",
      sessionKey: "agent:main:taxes",
      visible: true,
    });
    expect(items[2]?.icon).toBeDefined();
  });

  it("keeps WorkBoard choices out when the route is unavailable", () => {
    const items = buildSidebarCustomizerEntries({
      canonical: ["workboard:ops", "route:tasks"],
      enabledRouteIds: ["tasks"],
      workboards: [{ id: "ops", name: "Operations" }],
    });

    expect(items.some((item) => item.id === "workboard:ops")).toBe(false);
  });

  it("only exposes visibility for catalogs with an existing persistence owner", () => {
    const sections = [
      {
        id: "ungrouped",
        rows: [],
        totalRowCount: 0,
        visibleRowCount: 0,
        visibleLimit: 25,
        collapsedVisibleRowCount: 0,
      },
      {
        id: "work",
        work: true,
        rows: [],
        totalRowCount: 0,
        visibleRowCount: 0,
        visibleLimit: 25,
        collapsedVisibleRowCount: 0,
      },
      {
        id: "catalog:claude",
        rows: [],
        totalRowCount: 0,
        visibleRowCount: 0,
        visibleLimit: 25,
        collapsedVisibleRowCount: 0,
      },
    ] as SidebarVisibleSections["sections"];

    const items = buildSidebarCustomizerSections({
      sections,
      catalogLabels: new Map([["claude", "Claude Code"]]),
      hiddenCatalogIds: new Set(["claude"]),
    });

    expect(
      items.map(({ id, label, reorderable, toggleable, visible }) => ({
        id,
        label,
        reorderable,
        toggleable,
        visible,
      })),
    ).toEqual([
      { id: "ungrouped", label: "Sessions", reorderable: true, toggleable: false, visible: true },
      { id: "work", label: "Coding", reorderable: true, toggleable: false, visible: true },
      {
        id: "catalog:claude",
        label: "Claude Code",
        reorderable: true,
        toggleable: true,
        visible: false,
      },
    ]);
  });
});

describe("sidebar customizer transaction", () => {
  it("waits for an in-flight unpin before restoring the snapshot", async () => {
    let resolveUnpin!: () => void;
    const unpin = new Promise<void>((resolve) => {
      resolveUnpin = resolve;
    });
    const session = { key: "agent:main:pinned", label: "Pinned", pinned: true };
    const item = {
      id: "session:agent:main:pinned",
      entry: "session:agent:main:pinned",
      kind: "entry" as const,
      label: "Pinned",
      sessionKey: session.key,
      visible: true,
    };
    const patchSession = vi.fn(async (_session, patch: { pinned?: boolean }) => {
      if (patch.pinned === false) {
        await unpin;
      }
      session.pinned = patch.pinned ?? session.pinned;
      return "completed" as const;
    });
    const sessions = {
      state: { groups: [] },
      groupsLoad: vi.fn(async () => []),
      groupsPut: vi.fn(async () => "completed" as const),
    };
    const element = document.createElement("div");
    const host = Object.assign(element, {
      addController: vi.fn(),
      removeController: vi.fn(),
      hiddenSessionCatalogIds: new Set<string>(),
      onUpdateSidebarEntries: vi.fn(),
      sessionOrganizer: { patchSession },
      sidebarMenus: { dismissTransientMenus: vi.fn() },
      updateComplete: Promise.resolve(true),
      findSidebarSessionByKey: () => session,
      knownSectionOrder: () => [],
      reconciledSidebarZone: () => ({ sidebarEntries: [item.entry] }),
      requestUpdate: vi.fn(),
      sidebarCustomizerContext: () => ({ sessions }),
      sidebarCustomizerEntries: () => [item],
    }) as unknown as ConstructorParameters<typeof SidebarCustomizerController>[0];
    const controller = new SidebarCustomizerController(host);
    controller.open();
    await vi.waitFor(() => expect(controller.isOpen).toBe(true));

    controller.remove(item);
    const discard = controller.discard();

    expect(controller.isOpen).toBe(true);
    resolveUnpin();
    await discard;
    expect(patchSession.mock.calls.map(([, patch]) => patch)).toEqual([
      { pinned: false },
      { pinned: true },
    ]);
    expect(controller.isOpen).toBe(false);
  });

  it("waits for an in-flight section reorder before restoring the snapshot", async () => {
    let resolveReorder!: () => void;
    let sectionOrder = ["work", "ungrouped"];
    const reorder = new Promise<"completed">((resolve) => {
      resolveReorder = () => {
        sectionOrder = ["ungrouped", "work"];
        resolve("completed");
      };
    });
    const sessions = {
      state: { groups: [] },
      groupsLoad: vi.fn(async () => []),
      groupsPut: vi.fn(async () => "completed" as const),
    };
    const element = document.createElement("div");
    const host = Object.assign(element, {
      addController: vi.fn(),
      removeController: vi.fn(),
      hiddenSessionCatalogIds: new Set<string>(),
      onUpdateSidebarEntries: vi.fn(),
      sessionOrganizer: {
        patchSession: vi.fn(),
        reorderSidebarSection: vi.fn(),
      },
      sidebarMenus: { dismissTransientMenus: vi.fn() },
      updateComplete: Promise.resolve(true),
      findSidebarSessionByKey: () => undefined,
      knownSectionOrder: () => sectionOrder,
      reconciledSidebarZone: () => ({ sidebarEntries: [] }),
      requestUpdate: vi.fn(),
      sidebarCustomizerContext: () => ({ sessions }),
      sidebarCustomizerEntries: () => [],
    }) as unknown as ConstructorParameters<typeof SidebarCustomizerController>[0];
    const controller = new SidebarCustomizerController(host);
    controller.open();
    await vi.waitFor(() => expect(controller.isOpen).toBe(true));

    controller.trackSectionMutation(reorder);
    const discard = controller.discard();
    expect(controller.isOpen).toBe(true);

    resolveReorder();
    await discard;
    expect(sessions.groupsPut).toHaveBeenCalledWith([], ["work", "ungrouped"]);
    expect(controller.isOpen).toBe(false);
  });
});
