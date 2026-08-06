import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import { cleanupTalkConnection } from "../../talk-session-registry.js";
import type { GatewayWsClient } from "../ws-types.js";
import { createGatewayAuthenticatedRequestDispatcher } from "./authenticated-request-dispatch.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";

const deferredRuntime = vi.hoisted(() => {
  let markImportStarted!: () => void;
  const importStarted = new Promise<void>((resolve) => {
    markImportStarted = resolve;
  });
  let releaseImport!: () => void;
  const importGate = new Promise<void>((resolve) => {
    releaseImport = resolve;
  });
  return {
    handleGatewayRequest: vi.fn(),
    importStarted,
    markImportStarted,
    importGate,
    releaseImport,
  };
});

vi.mock("./authenticated-request-dispatch.server-methods.runtime.js", async () => {
  deferredRuntime.markImportStarted();
  await deferredRuntime.importGate;
  return { handleGatewayRequest: deferredRuntime.handleGatewayRequest };
});

const connectionIds = ["talk-browser", "talk-realtime-relay", "talk-transcription-relay"];

function createHarness(connId: string) {
  const send = vi.fn();
  const client = {
    socket: new EventEmitter() as unknown as WebSocket,
    connId,
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        version: "dev",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.UI,
      },
      role: "operator",
      scopes: ["operator.admin"],
    },
  } as GatewayWsClient;
  const dispatcher = createGatewayAuthenticatedRequestDispatcher({
    handler: {
      connId,
      extraHandlers: {},
      buildRequestContext: () => ({}) as never,
      send,
      close: vi.fn(),
      isClosed: () => false,
      setCloseCause: vi.fn(),
      logGateway: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as GatewayWsMessageHandlerParams,
    isWebchatConnect: () => false,
  });
  return { client, dispatcher, send };
}

afterEach(async () => {
  deferredRuntime.releaseImport();
  await Promise.all(
    connectionIds.map((connId) => cleanupTalkConnection(connId, { warn: vi.fn() })),
  );
});

describe("authenticated Talk request admission", () => {
  it("drains browser, realtime relay, and transcription startup before lazy import resumes", async () => {
    const requests = [
      {
        connId: connectionIds[0]!,
        method: "talk.client.create",
        params: { mode: "realtime", transport: "webrtc" },
      },
      {
        connId: connectionIds[1]!,
        method: "talk.session.create",
        params: { mode: "realtime", transport: "gateway-relay" },
      },
      {
        connId: connectionIds[2]!,
        method: "talk.session.create",
        params: { mode: "transcription", transport: "gateway-relay" },
      },
    ].map((request) => ({ request, ...createHarness(request.connId) }));

    for (const { request, dispatcher, client } of requests) {
      await dispatcher.dispatch(
        {
          type: "req",
          id: request.connId,
          method: request.method,
          params: request.params,
        },
        client,
      );
    }
    await deferredRuntime.importStarted;

    const settled = requests.map(() => false);
    const drains = requests.map(({ request }, index) =>
      cleanupTalkConnection(request.connId, { warn: vi.fn() }).then(() => {
        settled[index] = true;
      }),
    );
    await Promise.resolve();
    expect(settled).toEqual([false, false, false]);
    expect(deferredRuntime.handleGatewayRequest).not.toHaveBeenCalled();

    deferredRuntime.releaseImport();
    await Promise.all(drains);

    expect(deferredRuntime.handleGatewayRequest).not.toHaveBeenCalled();
    for (const { send } of requests) {
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({
            code: ErrorCodes.UNAVAILABLE,
            message: expect.stringContaining("Talk connection closed before request startup"),
          }),
        }),
      );
    }
  });
});
