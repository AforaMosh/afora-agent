import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixQaE2eeScenarioClient } from "../substrate/e2ee-client.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

const sharedScenarioMocks = vi.hoisted(() => ({
  createMatrixQaE2eeScenarioClient: vi.fn(),
}));

vi.mock("../substrate/e2ee-client.js", () => ({
  createMatrixQaE2eeScenarioClient: sharedScenarioMocks.createMatrixQaE2eeScenarioClient,
  runMatrixQaE2eeBootstrap: vi.fn(),
}));

import {
  createMatrixQaE2eeDriverClient,
  withMatrixQaE2eeDriverAndObserver,
} from "./scenario-runtime-e2ee-shared.js";

function createContext(): MatrixQaScenarioContext {
  return {
    baseUrl: "https://matrix-qa.test",
    driverAccessToken: "driver-token",
    driverDeviceId: "DRIVER",
    driverPassword: "driver-password",
    driverUserId: "@driver:matrix-qa.test",
    observedEvents: [],
    observerAccessToken: "observer-token",
    observerDeviceId: "OBSERVER",
    observerPassword: "observer-password",
    observerUserId: "@observer:matrix-qa.test",
    outputDir: "/tmp/matrix-qa-output",
    sutAccessToken: "sut-token",
    sutUserId: "@sut:matrix-qa.test",
    syncState: {},
    timeoutMs: 30_000,
    topology: { rooms: [] },
  } as unknown as MatrixQaScenarioContext;
}

function createClient() {
  const stop = vi.fn(async () => undefined);
  return {
    client: { stop } as unknown as MatrixQaE2eeScenarioClient,
    stop,
  };
}

beforeEach(() => {
  sharedScenarioMocks.createMatrixQaE2eeScenarioClient.mockReset();
});

describe("Matrix E2EE scenario readiness scope", () => {
  it("does not require room readiness for a control-plane driver", async () => {
    const { client } = createClient();
    sharedScenarioMocks.createMatrixQaE2eeScenarioClient.mockResolvedValue(client);

    await createMatrixQaE2eeDriverClient(createContext(), "matrix-e2ee-bootstrap-success");

    expect(sharedScenarioMocks.createMatrixQaE2eeScenarioClient).toHaveBeenCalledOnce();
    expect(
      sharedScenarioMocks.createMatrixQaE2eeScenarioClient.mock.calls[0]?.[0],
    ).not.toHaveProperty("readyRoomIds");
  });

  it("requires the explicit message room for both driver and observer", async () => {
    const driver = createClient();
    const observer = createClient();
    sharedScenarioMocks.createMatrixQaE2eeScenarioClient
      .mockResolvedValueOnce(driver.client)
      .mockResolvedValueOnce(observer.client);
    const roomId = "!message:matrix-qa.test";

    await expect(
      withMatrixQaE2eeDriverAndObserver(
        createContext(),
        "matrix-e2ee-basic-reply",
        async (clients) => clients,
        { readyRoomIds: [roomId] },
      ),
    ).resolves.toEqual({ driver: driver.client, observer: observer.client });

    expect(sharedScenarioMocks.createMatrixQaE2eeScenarioClient).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ actorId: "driver", readyRoomIds: [roomId] }),
    );
    expect(sharedScenarioMocks.createMatrixQaE2eeScenarioClient).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ actorId: "observer", readyRoomIds: [roomId] }),
    );
    expect(observer.stop).toHaveBeenCalledTimes(1);
    expect(driver.stop).toHaveBeenCalledTimes(1);
  });

  it("stops the driver when observer construction fails", async () => {
    const driver = createClient();
    sharedScenarioMocks.createMatrixQaE2eeScenarioClient
      .mockResolvedValueOnce(driver.client)
      .mockRejectedValueOnce(new Error("observer setup failed"));
    const run = vi.fn();

    await expect(
      withMatrixQaE2eeDriverAndObserver(createContext(), "matrix-e2ee-basic-reply", run, {
        readyRoomIds: ["!message:matrix-qa.test"],
      }),
    ).rejects.toThrow("observer setup failed");

    expect(run).not.toHaveBeenCalled();
    expect(driver.stop).toHaveBeenCalledTimes(1);
  });
});
