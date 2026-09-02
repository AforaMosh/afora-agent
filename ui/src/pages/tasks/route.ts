import { definePage } from "@afora/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("tasks"),
  component: () =>
    import("./tasks-page.ts").then(() => ({
      header: true,
      render: () => html`<afora-tasks-page></afora-tasks-page>`,
    })),
});
