// Gateway methods for durable memory-identity administration.
import {
  ErrorCodes,
  errorShape,
  validateMemoryIdentityBindingRevokeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { memoryIdentityLifecycle } from "../../state/memory-identity.js";
import { resolveUserProfileId } from "../../state/user-profiles.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const { revokeMemoryIdentityBinding } = memoryIdentityLifecycle;

/** Admin revocation is deliberately independent from channel ingress allowlists. */
export const memoryIdentityHandlers: GatewayRequestHandlers = {
  "memory.identityBinding.revoke": ({ client, params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateMemoryIdentityBindingRevokeParams,
        "memory.identityBinding.revoke",
        respond,
      )
    ) {
      return;
    }
    if (!client?.connect.scopes?.includes(ADMIN_SCOPE)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          `memory.identityBinding.revoke requires gateway scope: ${ADMIN_SCOPE}`,
        ),
      );
      return;
    }
    const authenticatedProfileId = client.authenticatedUserProfile?.profileId;
    if (!authenticatedProfileId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          "memory.identityBinding.revoke requires an authenticated Gateway profile",
        ),
      );
      return;
    }

    const bindingId = params.bindingId.trim();
    if (!bindingId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "bindingId must not be empty"),
      );
      return;
    }

    let revokedBy: string | undefined;
    try {
      revokedBy = resolveUserProfileId(authenticatedProfileId);
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "authenticated Gateway profile is unavailable"),
      );
      return;
    }
    if (!revokedBy) {
      // The connection's profile can be merged or removed after authentication.
      // Never attribute a durable revocation to an identity that no longer resolves.
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "authenticated Gateway profile is unavailable"),
      );
      return;
    }

    try {
      const revoked = revokeMemoryIdentityBinding({
        bindingId,
        revokedBy,
        ...(params.reason?.trim() ? { reason: params.reason.trim() } : {}),
      });
      respond(true, { bindingId, revoked });
    } catch {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "memory identity binding revocation is temporarily unavailable",
        ),
      );
    }
  },
};
