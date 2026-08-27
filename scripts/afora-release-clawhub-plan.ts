#!/usr/bin/env -S node --import tsx
// Afora release ClawHub plan CLI emits release workflow routing as JSON.

import { pathToFileURL } from "node:url";
import {
  buildAforaReleaseClawHubPlan,
  parseAforaReleaseClawHubPlanArgs,
} from "./lib/afora-release-clawhub-plan.ts";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseAforaReleaseClawHubPlanArgs(process.argv.slice(2));
  const plan = await buildAforaReleaseClawHubPlan(args);
  console.log(JSON.stringify(plan, null, 2));
}
