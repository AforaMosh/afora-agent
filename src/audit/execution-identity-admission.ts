/** Bounded execution-identity facts captured at authoritative run admission. */
import { randomUUID } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const EXECUTION_IDENTITY_ADMISSION_MAX_BYTES = 16 * 1024;
const EXECUTION_IDENTITY_ADMISSION_MAX_ITEMS = 16;
const RAW_REF_MAX_LENGTH = 4_096;
const PROCESS_RUNTIME_INSTANCE_ID = randomUUID();
const log = createSubsystemLogger("audit/events");

const boundedRef = () => Type.String({ minLength: 1, maxLength: 256 });
const rawRef = () => Type.String({ minLength: 1, maxLength: RAW_REF_MAX_LENGTH });
const evidenceState = () =>
  Type.Union([
    Type.Literal("present"),
    Type.Literal("absent"),
    Type.Literal("unknown"),
    Type.Literal("unsupported"),
  ]);
const closedObject = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const ExecutionIdentityAdmissionEnvelopeSchema = closedObject({
  envelopeVersion: Type.Literal(1),
  contextId: boundedRef(),
  runId: boundedRef(),
  createdAt: Type.Integer({ minimum: 0 }),
  runtimeInstanceId: rawRef(),
  agentId: boundedRef(),
  ingress: closedObject({
    kind: Type.Union([
      Type.Literal("local-cli"),
      Type.Literal("gateway-client"),
      Type.Literal("channel"),
      Type.Literal("api"),
      Type.Literal("schedule"),
      Type.Literal("webhook"),
      Type.Literal("task"),
      Type.Literal("subagent"),
      Type.Literal("acp"),
      Type.Literal("worker"),
      Type.Literal("plugin"),
      Type.Literal("recovery"),
      Type.Literal("system"),
    ]),
    boundary: boundedRef(),
    state: evidenceState(),
    rawSourceRef: Type.Optional(rawRef()),
  }),
  runtime: closedObject({
    kind: Type.Union([
      Type.Literal("gateway"),
      Type.Literal("embedded"),
      Type.Literal("worker"),
      Type.Literal("plugin-harness"),
      Type.Literal("acp"),
    ]),
  }),
  invoker: Type.Optional(
    closedObject({
      kind: Type.Union([
        Type.Literal("person"),
        Type.Literal("agent"),
        Type.Literal("service"),
        Type.Literal("schedule"),
        Type.Literal("webhook"),
        Type.Literal("system"),
        Type.Literal("local-account"),
        Type.Literal("runtime"),
      ]),
      rawPrincipalRef: rawRef(),
      displayLabel: Type.Optional(Type.String({ maxLength: 128 })),
    }),
  ),
  applicableGrants: Type.Array(closedObject({ rawGrantRef: rawRef(), state: evidenceState() }), {
    maxItems: EXECUTION_IDENTITY_ADMISSION_MAX_ITEMS,
  }),
  assurance: Type.Array(
    closedObject({
      kind: Type.Union([
        Type.Literal("durable-profile"),
        Type.Literal("trusted-proxy"),
        Type.Literal("tailscale-whois"),
        Type.Literal("device-proof"),
        Type.Literal("channel-admission"),
        Type.Literal("local-process"),
        Type.Literal("spawn-lineage"),
        Type.Literal("worker-admission"),
        Type.Literal("runtime-binding"),
        Type.Literal("other"),
      ]),
      rawEvidenceRef: rawRef(),
      strength: Type.Union([
        Type.Literal("self-asserted"),
        Type.Literal("boundary-verified"),
        Type.Literal("cryptographic"),
      ]),
    }),
    { maxItems: EXECUTION_IDENTITY_ADMISSION_MAX_ITEMS },
  ),
});

export type ExecutionIdentityAdmissionEnvelope = Static<
  typeof ExecutionIdentityAdmissionEnvelopeSchema
>;
export type ExecutionIdentityAdmissionFacts = Omit<
  ExecutionIdentityAdmissionEnvelope,
  | "envelopeVersion"
  | "contextId"
  | "createdAt"
  | "runtimeInstanceId"
  | "ingress"
  | "applicableGrants"
  | "assurance"
> & {
  ingress: Omit<ExecutionIdentityAdmissionEnvelope["ingress"], "state"> & {
    state?: ExecutionIdentityAdmissionEnvelope["ingress"]["state"];
  };
  applicableGrants?: ExecutionIdentityAdmissionEnvelope["applicableGrants"];
  assurance?: ExecutionIdentityAdmissionEnvelope["assurance"];
};
type ExecutionIdentityAdmissionSink = (envelope: ExecutionIdentityAdmissionEnvelope) => boolean;

let admissionSink: ExecutionIdentityAdmissionSink | undefined;
let admissionFailureWarned = false;

function uniqueSorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()].toSorted((a, b) => {
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function freezeEnvelope<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeEnvelope(nested, seen);
  }
  return Object.freeze(value);
}

function validateEnvelope(value: unknown): asserts value is ExecutionIdentityAdmissionEnvelope {
  if (
    !Value.Check(ExecutionIdentityAdmissionEnvelopeSchema, value) ||
    !Number.isSafeInteger(value.createdAt)
  ) {
    throw new Error("execution identity admission envelope violates its bounded contract");
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > EXECUTION_IDENTITY_ADMISSION_MAX_BYTES) {
    throw new Error("execution identity admission envelope exceeds 16 KiB");
  }
}

function redactDisplayLabel(value: string): string {
  // The shared redactor's secret-prefix pass becomes stable on its second pass.
  // Stabilizing here lets the worker reject any altered structured-clone payload.
  return truncateUtf16Safe(
    redactSensitiveText(redactSensitiveText(value, { mode: "tools" }), { mode: "tools" }),
    128,
  );
}

/** Capture owned admission facts without touching filesystem or database state. */
function captureExecutionIdentityAdmissionEnvelope(
  facts: ExecutionIdentityAdmissionFacts,
  options: { contextId?: string; now?: number; runtimeInstanceId?: string } = {},
): ExecutionIdentityAdmissionEnvelope {
  const runtimeInstanceId = options.runtimeInstanceId ?? PROCESS_RUNTIME_INSTANCE_ID;
  const assurance = facts.assurance ?? [
    {
      kind: "runtime-binding" as const,
      rawEvidenceRef: runtimeInstanceId,
      strength: "boundary-verified" as const,
    },
  ];
  const envelope = {
    envelopeVersion: 1 as const,
    contextId: options.contextId ?? randomUUID(),
    runId: facts.runId,
    createdAt: options.now ?? Date.now(),
    runtimeInstanceId,
    agentId: facts.agentId,
    ingress: { ...facts.ingress, state: facts.ingress.state ?? "present" },
    runtime: { ...facts.runtime },
    ...(facts.invoker
      ? {
          invoker: {
            ...facts.invoker,
            ...(facts.invoker.displayLabel !== undefined
              ? { displayLabel: redactDisplayLabel(facts.invoker.displayLabel) }
              : {}),
          },
        }
      : {}),
    applicableGrants: uniqueSorted(
      facts.applicableGrants ?? [],
      (grant) => `${grant.rawGrantRef}\0${grant.state}`,
    ).map((grant) => ({ rawGrantRef: grant.rawGrantRef, state: grant.state })),
    assurance: uniqueSorted(
      assurance,
      (item) => `${item.kind}\0${item.rawEvidenceRef}\0${item.strength}`,
    ).map((item) => ({
      kind: item.kind,
      rawEvidenceRef: item.rawEvidenceRef,
      strength: item.strength,
    })),
  };
  validateEnvelope(envelope);
  return freezeEnvelope(envelope);
}

/** Revalidate a structured-cloned worker message before any persistence work. */
export function parseExecutionIdentityAdmissionEnvelope(
  value: unknown,
): ExecutionIdentityAdmissionEnvelope {
  validateEnvelope(value);
  const parsed = captureExecutionIdentityAdmissionEnvelope(value, {
    contextId: value.contextId,
    now: value.createdAt,
    runtimeInstanceId: value.runtimeInstanceId,
  });
  if (JSON.stringify(parsed) !== JSON.stringify(value)) {
    throw new Error("execution identity admission envelope is not canonical");
  }
  return parsed;
}

/** Install the current process lifecycle's writer without creating a second queue. */
export function configureExecutionIdentityAdmissionSink(
  sink: ExecutionIdentityAdmissionSink,
): () => void {
  admissionSink = sink;
  return () => {
    if (admissionSink === sink) {
      admissionSink = undefined;
    }
  };
}

export function hasExecutionIdentityAdmissionSink(): boolean {
  return admissionSink !== undefined;
}

/** Capture and enqueue best-effort evidence; no worker readiness or persistence is awaited. */
export function enqueueExecutionIdentityContextAtAdmission(
  facts: ExecutionIdentityAdmissionFacts,
  options: {
    enabled: boolean;
    contextId?: string;
    now?: number;
    runtimeInstanceId?: string;
  },
): { contextId: string; accepted: boolean } | undefined {
  if (!options.enabled) {
    return undefined;
  }
  try {
    const envelope = captureExecutionIdentityAdmissionEnvelope(facts, options);
    if (!admissionSink) {
      throw new Error("audit writer unavailable");
    }
    return { contextId: envelope.contextId, accepted: admissionSink(envelope) };
  } catch {
    if (!admissionFailureWarned) {
      admissionFailureWarned = true;
      log.warn("audit execution identity admission evidence was not queued; continuing without it");
    }
    return undefined;
  }
}
