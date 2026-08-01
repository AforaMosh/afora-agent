import { describe, expect, it } from "vitest";
import {
  captureRuntimeAuthProfileStorePublicationToken,
  isRuntimeAuthProfileStorePublicationTokenCurrent,
} from "./runtime-publication-order.js";

describe("runtime auth publication order", () => {
  it("keeps a pending main token current when an unrelated owner is evicted", () => {
    for (let index = 0; index < 255; index += 1) {
      captureRuntimeAuthProfileStorePublicationToken(`/tmp/openclaw-auth-owner-${index}`, {
        advanceOwner: true,
      });
    }
    const mainToken = captureRuntimeAuthProfileStorePublicationToken(undefined, {
      advanceOwner: true,
    });

    captureRuntimeAuthProfileStorePublicationToken("/tmp/openclaw-auth-owner-overflow", {
      advanceOwner: true,
    });

    expect(isRuntimeAuthProfileStorePublicationTokenCurrent(mainToken)).toBe(true);
  });
});
