import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("lobsterdex"),
  component: () =>
    import("./lobsterdex-page.ts").then(() => ({
      header: true,
      render: () => html`<afora-lobsterdex-page></afora-lobsterdex-page>`,
    })),
});
