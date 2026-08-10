// Compare-and-swap session patches must reject reset replacements atomically.
import { afterEach, expect, test } from "vitest";
import { ErrorCodes, GatewayErrorDetailCodes } from "../../packages/gateway-protocol/src/index.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { embeddedRunMock, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test.each([
  {
    name: "session id",
    expected: { expectedSessionId: "sess-before-reset" },
  },
  {
    name: "lifecycle revision",
    expected: { expectedLifecycleRevision: "revision-before-reset" },
  },
])("sessions.patch rejects a stale expected $name atomically", async ({ expected }) => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:archive-identity";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("sess-after-reset", {
        lifecycleRevision: "revision-after-reset",
      }),
    },
  });

  const archived = await directSessionReq("sessions.patch", {
    key: sessionKey,
    archived: true,
    ...expected,
  });

  expect(archived).toMatchObject({
    ok: false,
    // Archive guards its own generation, so its refusal deliberately reports no
    // surviving identity: there is nothing here a client may re-aim at.
    error: {
      code: ErrorCodes.INVALID_REQUEST,
      details: { code: GatewayErrorDetailCodes.SESSION_CHANGED },
      message: `Session ${sessionKey} changed before patch. Retry.`,
    },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    sessionId: "sess-after-reset",
    lifecycleRevision: "revision-after-reset",
  });
  expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty("archivedAt");
});

test("sessions.patch rejects a replaced identity before projected active-run protection", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:active-replacement";
  const replacementSessionId = "sess-active-after-reset";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(replacementSessionId, {
        lifecycleRevision: "revision-after-reset",
      }),
    },
  });
  embeddedRunMock.activeIds.add(replacementSessionId);

  const archived = await directSessionReq("sessions.patch", {
    key: sessionKey,
    archived: true,
    expectedSessionId: "sess-before-reset",
  });

  expect(archived).toMatchObject({
    ok: false,
    // Clients must tell a moved target from any other invalid request without
    // matching the public copy, and must tell a rotation from a deletion without
    // a second read, so both facts are part of the contract.
    error: {
      code: ErrorCodes.INVALID_REQUEST,
      details: { code: GatewayErrorDetailCodes.SESSION_CHANGED },
      message: `Session ${sessionKey} changed before patch. Retry.`,
    },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    sessionId: replacementSessionId,
  });
  expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty("archivedAt");
});

test.each([
  {
    name: "session id",
    expected: { expectedSessionId: "sess-before-reset" },
  },
  {
    name: "lifecycle revision",
    expected: { expectedLifecycleRevision: "revision-before-reset" },
  },
])("sessions.patch rejects stale $name for metadata mutations", async ({ expected }) => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:metadata-identity";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("sess-after-reset", {
        lifecycleRevision: "revision-after-reset",
      }),
    },
  });

  const patched = await directSessionReq("sessions.patch", {
    key: sessionKey,
    label: "Stale agent request",
    ...expected,
  });

  expect(patched).toMatchObject({
    ok: false,
    // Archive guards its own generation, so its refusal deliberately reports no
    // surviving identity: there is nothing here a client may re-aim at.
    error: {
      code: ErrorCodes.INVALID_REQUEST,
      details: { code: GatewayErrorDetailCodes.SESSION_CHANGED },
      message: `Session ${sessionKey} changed before patch. Retry.`,
    },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    sessionId: "sess-after-reset",
    lifecycleRevision: "revision-after-reset",
  });
  expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty("label");
});

test("sessions.patch archives the expected session under its lifecycle lock", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:archive-identity";
  const sessionId = "sess-expected-archive";
  const lifecycleRevision = "revision-expected-archive";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, { lifecycleRevision }),
    },
  });

  const archived = await directSessionReq("sessions.patch", {
    key: sessionKey,
    archived: true,
    expectedSessionId: sessionId,
    expectedLifecycleRevision: lifecycleRevision,
  });

  expect(archived.ok).toBe(true);
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    sessionId,
    lifecycleRevision,
    archivedAt: expect.any(Number),
  });
});

test("sessions.patch reports the surviving identity when a presentation patch is refused", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:rotated";
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry("sess-after-rotation") },
  });

  const patched = await directSessionReq("sessions.patch", {
    key: sessionKey,
    category: "Client work",
    expectedSessionId: "sess-before-rotation",
  });

  // Rotation under a live row is routine and invisible (compaction, reset,
  // in-place rewind). Naming the survivor is what lets a client carry the
  // operator's intent across it without a second read to discover the id.
  expect(patched).toMatchObject({
    ok: false,
    error: {
      code: ErrorCodes.INVALID_REQUEST,
      details: {
        code: GatewayErrorDetailCodes.SESSION_CHANGED,
        currentSessionId: "sess-after-rotation",
      },
    },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty("category");
});
