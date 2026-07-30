import { afterAll, beforeAll, describe } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/index.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { approveDevicePairing, requestDevicePairing } from "../infra/device-pairing.js";
import { approveNodePairing, listNodePairing } from "../infra/node-pairing.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientName,
} from "../utils/message-channel.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { startServerWithClient } from "./test-helpers.js";

export async function findPairedNode(nodeId: string, baseDir?: string) {
  const pairing = await listNodePairing(baseDir);
  return pairing.paired.find((node) => node.nodeId === nodeId) ?? null;
}

export function requireApprovedPairing(
  result: Awaited<ReturnType<typeof approveNodePairing>>,
): Exclude<typeof result, null | { status: "forbidden"; missingScope: string }> {
  if (!result || "status" in result) {
    throw new Error(`Expected approved node pairing, got ${JSON.stringify(result)}`);
  }
  return result;
}

export async function connectNodeClient(params: {
  port: number;
  deviceIdentity: DeviceIdentity;
  commands: string[];
  clientName?: GatewayClientName;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  caps?: string[];
  onHelloOk?: (hello: HelloOk) => void;
}) {
  return await connectGatewayClient({
    url: `ws://127.0.0.1:${params.port}`,
    token: "secret",
    role: "node",
    clientName: params.clientName ?? GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: params.displayName ?? "node-command-pin",
    clientVersion: "1.0.0",
    platform: params.platform ?? "macos",
    deviceFamily: params.deviceFamily ?? "Mac",
    mode: GATEWAY_CLIENT_MODES.NODE,
    scopes: [],
    caps: params.caps,
    commands: params.commands,
    deviceIdentity: params.deviceIdentity,
    onHelloOk: params.onHelloOk,
    timeoutMessage: "timeout waiting for paired node to connect",
  });
}

export function createNodePairingTestState(prefix: string) {
  const tempDirs = createSuiteTempRootTracker({ prefix });

  return {
    setup: async () => await tempDirs.setup(),
    cleanup: async () => await tempDirs.cleanup(),
    makeStateDir: async () => await tempDirs.make("case"),
    seedNodeDevice: async (nodeId: string, baseDir?: string) => {
      const request = await requestDevicePairing(
        { deviceId: nodeId, publicKey: `pk-${nodeId}`, role: "node", roles: ["node"], scopes: [] },
        baseDir,
      );
      await approveDevicePairing(request.request.requestId, { callerScopes: [] }, baseDir);
    },
  };
}

export function describeWithGatewayServer(
  name: string,
  defineTests: (getStarted: () => Awaited<ReturnType<typeof startServerWithClient>>) => void,
): void {
  describe(name, () => {
    let started: Awaited<ReturnType<typeof startServerWithClient>> | undefined;

    beforeAll(async () => {
      started = await startServerWithClient("secret");
    });

    afterAll(async () => {
      started?.ws.close();
      await started?.server.close();
      started?.envSnapshot.restore();
    });

    defineTests(() => {
      if (!started) {
        throw new Error("gateway test server was not started");
      }
      return started;
    });
  });
}
