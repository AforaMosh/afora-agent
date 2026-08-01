import { lazyCompile } from "./protocol-validator.js";
// Focused validators for versioned audit and execution-identity request contracts.
import type { AuditRunInspectParams, ExecutionIdentityContextV1 } from "./schema/audit-run.js";
import {
  AuditRunInspectParamsSchema,
  ExecutionIdentityContextV1Schema,
} from "./schema/audit-run.js";

export const validateAuditRunInspectParams = lazyCompile<AuditRunInspectParams>(
  AuditRunInspectParamsSchema,
  (data) => {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return undefined;
    }
    const record = data as Record<string, unknown>;
    const hasRunId = typeof record.runId === "string";
    const hasExecutionId = typeof record.executionId === "string";
    if (hasRunId === hasExecutionId) {
      return {
        keyword: "oneOf",
        instancePath: "",
        message: "must select exactly one of runId or executionId",
      };
    }
    if (
      hasExecutionId &&
      (record.executionCursor !== undefined || record.executionLimit !== undefined)
    ) {
      return {
        keyword: "not",
        instancePath: "",
        message: "execution pagination is only valid with runId discovery",
      };
    }
    return undefined;
  },
);
export const validateExecutionIdentityContextV1 = lazyCompile<ExecutionIdentityContextV1>(
  ExecutionIdentityContextV1Schema,
);
