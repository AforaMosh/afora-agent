import { lazyCompile } from "./protocol-validator.js";
// Focused validators for versioned audit and execution-identity request contracts.
import type { AuditRunInspectParams, ExecutionIdentityContextV1 } from "./schema/audit-run.js";
import {
  AuditRunInspectParamsSchema,
  ExecutionIdentityContextV1Schema,
} from "./schema/audit-run.js";

export const validateAuditRunInspectParams = lazyCompile<AuditRunInspectParams>(
  AuditRunInspectParamsSchema,
);
export const validateExecutionIdentityContextV1 = lazyCompile<ExecutionIdentityContextV1>(
  ExecutionIdentityContextV1Schema,
);
