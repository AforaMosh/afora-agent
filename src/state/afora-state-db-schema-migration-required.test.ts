import { describe, expect, it } from "vitest";
import {
  findAforaStateDatabaseSchemaMigrationRequiredError,
  AforaStateDatabaseSchemaMigrationRequiredError,
} from "./afora-state-db-schema-migration-required.js";

describe("state database schema migration error classification", () => {
  it("recognizes a rehydrated exact migration error through its cause chain", () => {
    const original = new AforaStateDatabaseSchemaMigrationRequiredError(
      "agent-databases-composite-primary-key",
      "/tmp/afora.sqlite",
    );
    const rehydrated = new Error("startup failed", {
      cause: new Error(original.message),
    });

    expect(findAforaStateDatabaseSchemaMigrationRequiredError(rehydrated)).toMatchObject({
      kind: "agent-databases-composite-primary-key",
      pathname: "/tmp/afora.sqlite",
    });
  });

  it("recognizes an exact instance of the typed error", () => {
    const original = new AforaStateDatabaseSchemaMigrationRequiredError(
      "audit-events-v2",
      "/tmp/afora.sqlite",
    );

    expect(findAforaStateDatabaseSchemaMigrationRequiredError(original)).toBe(original);
  });

  it("does not classify similar operator guidance as the migration error", () => {
    expect(
      findAforaStateDatabaseSchemaMigrationRequiredError(
        new Error(
          "Afora state database /tmp/afora.sqlite is stale; run afora doctor --fix.",
        ),
      ),
    ).toBeUndefined();
  });

  it("does not classify the agent DB media migration error", () => {
    // Ensure the state-DB classifier does not accidentally match agent-DB messages.
    expect(
      findAforaStateDatabaseSchemaMigrationRequiredError(
        new Error(
          "Afora agent database /tmp/afora-agent.sqlite uses schema version 5; run afora doctor --fix to migrate persisted media before using it.",
        ),
      ),
    ).toBeUndefined();
  });
});
