import { definePage } from "@afora/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("connection"),
  component: () =>
    import("./connection-page.ts").then(() => ({
      header: true,
      render: () => html`<afora-connection-page></afora-connection-page>`,
    })),
});
