// Gateway protocol schemas for durable memory-identity administration.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

const MemoryIdentityBindingIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const MemoryIdentityRevocationReasonSchema = Type.String({ maxLength: 1_024 });

/** Revokes one durable identity binding while retaining its verification evidence. */
export const MemoryIdentityBindingRevokeParamsSchema = closedObject({
  bindingId: MemoryIdentityBindingIdSchema,
  reason: Type.Optional(MemoryIdentityRevocationReasonSchema),
});

export const MemoryIdentityBindingRevokeResultSchema = closedObject({
  bindingId: MemoryIdentityBindingIdSchema,
  revoked: Type.Boolean(),
});

export type MemoryIdentityBindingRevokeParams = Static<
  typeof MemoryIdentityBindingRevokeParamsSchema
>;
export type MemoryIdentityBindingRevokeResult = Static<
  typeof MemoryIdentityBindingRevokeResultSchema
>;
