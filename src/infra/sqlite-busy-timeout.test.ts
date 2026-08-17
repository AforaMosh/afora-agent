import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runWithSqliteBusyTimeout } from "./sqlite-busy-timeout.js";

describe("runWithSqliteBusyTimeout", () => {
  let database: DatabaseSync | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("restores the previous timeout after success and failure", () => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA busy_timeout = 5000");

    expect(
      runWithSqliteBusyTimeout(database, 0, () => database?.prepare("PRAGMA busy_timeout").get()),
    ).toEqual({ timeout: 0 });
    expect(database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });

    expect(() =>
      runWithSqliteBusyTimeout(database!, 25, () => {
        throw new Error("operation failed");
      }),
    ).toThrow("operation failed");
    expect(database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid timeout %s",
    (timeout) => {
      database = new DatabaseSync(":memory:");
      expect(() => runWithSqliteBusyTimeout(database!, timeout, () => undefined)).toThrow(
        "busyTimeoutMs must be a non-negative integer",
      );
    },
  );
});
