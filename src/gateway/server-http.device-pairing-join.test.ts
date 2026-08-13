// Real Gateway lifecycle proof for admin mint -> public single-use join exchange.
import { Agent, fetch } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { decodePairingSetupCode } from "../pairing/setup-code.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  connectReq,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type JoinSetupResult = {
  setupCode: string;
  joinUrl: string;
};

let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let adminSocket: WebSocket;
let httpDispatcher: Agent;

beforeAll(async () => {
  testState.gatewayAuth = {
    mode: "token",
    token: "secret",
    rateLimit: {
      maxAttempts: 2,
      windowMs: 60_000,
      lockoutMs: 60_000,
    },
  };
  harness = await createGatewaySuiteHarness();
  httpDispatcher = new Agent({ connections: 1 });
  adminSocket = await harness.openWs();
  const connected = await connectReq(adminSocket, {
    token: "secret",
    scopes: ["operator.admin"],
  });
  if (!connected.ok) {
    throw new Error(`admin test client failed to connect: ${JSON.stringify(connected.error)}`);
  }
});

afterAll(async () => {
  adminSocket?.close();
  await httpDispatcher?.close();
  await harness?.close();
});

async function mintJoinUrl(contextPath = ""): Promise<JoinSetupResult> {
  const response = await rpcReq<JoinSetupResult>(adminSocket, "device.pair.setupCode", {
    bootstrapProfile: "node",
    includeQr: false,
    joinUrl: true,
    publicUrl: `ws://127.0.0.1:${harness.port}${contextPath}`,
  });
  if (!response.ok || !response.payload?.setupCode || !response.payload.joinUrl) {
    throw new Error(`join-code mint failed: ${JSON.stringify(response.error)}`);
  }
  return response.payload;
}

function shortcodeFromUrl(joinUrl: string): string {
  return new URL(joinUrl).pathname.split("/").at(-1) ?? "";
}

async function readJson(response: Awaited<ReturnType<typeof fetch>>): Promise<unknown> {
  return JSON.parse(await response.text()) as unknown;
}

async function fetchJoinUrl(url: string) {
  // Other Gateway suites replace the process-wide Undici dispatcher. Keep this
  // real loopback route bound to its own client so cross-suite mocks cannot claim it.
  return await fetch(url, { dispatcher: httpDispatcher });
}

describe("Gateway device join route", () => {
  it("burns once, expires opaquely, and rate-limits misses on the real HTTP server", async () => {
    const expired = await mintJoinUrl();
    const expiredShortcode = shortcodeFromUrl(expired.joinUrl);
    runOpenClawStateWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "device_pairing_join_codes">>(db)
          .updateTable("device_pairing_join_codes")
          .set({ expires_at_ms: 0 })
          .where("shortcode", "=", expiredShortcode),
      );
    });

    const expiredResponse = await fetchJoinUrl(expired.joinUrl);
    expect(expiredResponse.status).toBe(404);
    const opaqueNotFound = await readJson(expiredResponse);
    expect(opaqueNotFound).toEqual({ error: "not_found" });

    const live = await mintJoinUrl("/public-gateway");
    const shortcode = shortcodeFromUrl(live.joinUrl);
    expect(Buffer.from(shortcode, "base64url").byteLength).toBeGreaterThanOrEqual(16);

    const first = await fetchJoinUrl(live.joinUrl);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("application/json");
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await readJson(first)).toEqual(decodePairingSetupCode(live.setupCode));

    const used = await fetchJoinUrl(live.joinUrl);
    expect(used.status).toBe(404);
    expect(await readJson(used)).toEqual(opaqueNotFound);

    const unknownUrl = `http://127.0.0.1:${harness.port}/j/${"z".repeat(22)}`;
    const unknown = await fetchJoinUrl(unknownUrl);
    expect(unknown.status).toBe(404);
    expect(await readJson(unknown)).toEqual(opaqueNotFound);

    const limited = await fetchJoinUrl(unknownUrl);
    expect(limited.status).toBe(429);
    expect(await readJson(limited)).toEqual({ error: "rate_limited" });
  });
});
