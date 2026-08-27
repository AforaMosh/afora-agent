import { describe, expect, it } from "vitest";
import {
  findAforaAgentDatabaseMediaMigrationRequiredError,
  AforaAgentDatabaseMediaMigrationRequiredError,
} from "./afora-agent-db-migration-required.js";

describe("agent database media migration error classification", () => {
  it("recognizes a rehydrated exact migration error through its cause chain", () => {
    const original = new AforaAgentDatabaseMediaMigrationRequiredError(
      "/tmp/afora-agent.sqlite",
      14,
    );
    const rehydrated = new Error("startup failed", {
      cause: new Error(original.message),
    });

    expect(findAforaAgentDatabaseMediaMigrationRequiredError(rehydrated)).toMatchObject({
      pathname: "/tmp/afora-agent.sqlite",
      schemaVersion: 14,
    });
  });

  it("does not classify similar operator guidance as the migration error", () => {
    expect(
      findAforaAgentDatabaseMediaMigrationRequiredError(
        new Error("Afora agent database is outdated; run afora doctor --fix to migrate it."),
      ),
    ).toBeUndefined();
  });
});
