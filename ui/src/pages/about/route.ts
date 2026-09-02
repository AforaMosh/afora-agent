import { definePage } from "@afora/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("about"),
  component: () =>
    import("./about-page.ts").then(() => ({
      header: true,
      render: () => html`<afora-about-page></afora-about-page>`,
    })),
});
