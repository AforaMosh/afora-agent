import { definePage } from "@afora/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("cron"),
  component: () =>
    import("./cron-page.ts").then(() => ({
      header: true,
      render: () => html`<afora-cron-page></afora-cron-page>`,
    })),
});
