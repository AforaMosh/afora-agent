import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { hashWorkerCredential } from "./credential.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";

const BOOTSTRAP_RECEIPT = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.7.1",
  protocolFeatures: ["workspace-sync-v1", "model-proxy-v1"],
};

describe("worker environment node enrollment store", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerEnvironmentStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-node-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerEnvironmentStore({ database, now: () => 1_000 });
    store.createIntent({
      environmentId: "worker-enrollment",
      providerId: "fake-provider",
      profileId: "test-profile",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision:worker-enrollment",
    });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("binds setup completion to the exact environment identity across restart", () => {
    const pending = store.ensureNodeEnrollment("worker-enrollment");
    const setupId = expectDefined(pending.nodeSetupId, "worker node enrollment setup id");
    expect(setupId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(pending.nodeDeviceId).toBeNull();
    expect(store.ensureNodeEnrollment("worker-enrollment").nodeSetupId).toBe(setupId);

    database.db
      .prepare(
        `INSERT INTO device_pair_setup_completions (
          setup_id, device_id, access, completed_at_ms, delivery_state, retain_until_ms
        ) VALUES (?, ?, 'node', ?, 'confirmed', ?)`,
      )
      .run(setupId, "cloud-device-1", 10, 20);

    expect(store.get("worker-enrollment")).toMatchObject({
      nodeSetupId: setupId,
      nodeDeviceId: "cloud-device-1",
    });
  });

  it("persists a credential-bound node receipt without SSH metadata", () => {
    store.transition({
      environmentId: "worker-enrollment",
      from: "requested",
      to: "provisioning",
    });
    const ready = store.transition({
      environmentId: "worker-enrollment",
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: "device-lease-1",
        nodeDeviceId: "device-1",
        sshEndpoint: null,
        sharedHost: true,
        bootstrapReceipt: { ...BOOTSTRAP_RECEIPT, installKind: "bundle" },
        credential: {
          credentialHash: hashWorkerCredential("worker-credential-fixture"),
          sessionId: null,
          rpcSetVersion: 1,
          expiresAtMs: 11_000,
        },
      },
    });

    expect(ready).toMatchObject({
      state: "ready",
      leaseId: "device-lease-1",
      nodeDeviceId: "device-1",
      sshEndpoint: null,
      bootstrapReceipt: {
        ...BOOTSTRAP_RECEIPT,
        protocolFeatures: ["model-proxy-v1", "workspace-sync-v1"],
        installKind: "bundle",
      },
      sharedHost: true,
      ownerEpoch: 1,
    });
    expect(
      database.db
        .prepare(
          "SELECT node_device_id, ssh_host, ssh_host_key FROM worker_environments WHERE environment_id = ?",
        )
        .get("worker-enrollment"),
    ).toEqual({ node_device_id: "device-1", ssh_host: null, ssh_host_key: null });
  });
});
