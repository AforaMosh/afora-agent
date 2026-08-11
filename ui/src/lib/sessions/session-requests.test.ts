import { ErrorCodes, GatewayErrorDetailCodes } from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { SessionRequestClient } from "./session-capability.ts";
import { requestSessionPatch } from "./session-requests.ts";

function rotationRefusal(currentSessionId?: string) {
  return new GatewayRequestError({
    code: ErrorCodes.INVALID_REQUEST,
    message: "Session agent:main:a changed before patch. Retry.",
    details: {
      code: GatewayErrorDetailCodes.SESSION_CHANGED,
      ...(currentSessionId ? { currentSessionId } : {}),
    },
  });
}

function clientRefusingOnce(error: unknown) {
  const request = vi.fn(async (_method: string, _params: unknown) => {
    if (request.mock.calls.length === 1) {
      throw error;
    }
    return { key: "agent:main:a" };
  });
  return { client: { request } as unknown as SessionRequestClient, request };
}

describe("requestSessionPatch identity re-aim", () => {
  it("re-aims a presentation patch at the surviving session, once", async () => {
    const { client, request } = clientRefusingOnce(rotationRefusal("sess-after-rotation"));

    await expect(
      requestSessionPatch(client, "agent:main:a", {
        category: "Client work",
        expectedSessionId: "sess-before-rotation",
      }),
    ).resolves.toMatchObject({ key: "agent:main:a" });

    // The operator picked the row and the row survived the rotation, so the same
    // intent is carried to the session the Gateway named — with no second read.
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      category: "Client work",
      expectedSessionId: "sess-after-rotation",
    });
  });

  it("does not re-aim a lifecycle patch", async () => {
    const rejection = rotationRefusal("sess-after-rotation");
    const { client, request } = clientRefusingOnce(rejection);

    await expect(
      requestSessionPatch(client, "agent:main:a", {
        archived: true,
        expectedSessionId: "sess-before-rotation",
      }),
    ).rejects.toBe(rejection);

    // Archiving guards its own generation; re-aiming it would apply a lifecycle
    // decision to a session the operator never saw in that state.
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not re-aim when no session survives", async () => {
    const rejection = rotationRefusal();
    const { client, request } = clientRefusingOnce(rejection);

    await expect(
      requestSessionPatch(client, "agent:main:a", {
        category: "Client work",
        expectedSessionId: "sess-before-rotation",
      }),
    ).rejects.toBe(rejection);

    // Nothing to re-aim at: patching the key again would create a new session
    // rather than move the one the operator meant.
    expect(request).toHaveBeenCalledOnce();
  });

  it("re-raises an unrelated refusal untouched", async () => {
    const rejection = new GatewayRequestError({
      code: ErrorCodes.INVALID_REQUEST,
      message: "label already in use",
    });
    const { client, request } = clientRefusingOnce(rejection);

    await expect(
      requestSessionPatch(client, "agent:main:a", {
        label: "Taken",
        expectedSessionId: "sess-before-rotation",
      }),
    ).rejects.toBe(rejection);
    expect(request).toHaveBeenCalledOnce();
  });
});
