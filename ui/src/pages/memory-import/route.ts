import { definePage } from "@afora/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("memory-import"),
  component: () =>
    import("./memory-import-page.ts").then(() => ({
      header: true,
      render: () => html`<afora-memory-import-page></afora-memory-import-page>`,
    })),
});
