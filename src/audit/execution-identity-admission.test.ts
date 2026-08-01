import { describe, expect, it, vi } from "vitest";
import {
  configureExecutionIdentityAdmissionSink,
  enqueueExecutionIdentityContextAtAdmission,
  hasExecutionIdentityAdmissionSink,
  parseExecutionIdentityAdmissionEnvelope,
  type ExecutionIdentityAdmissionEnvelope,
  type ExecutionIdentityAdmissionFacts,
} from "./execution-identity-admission.js";

const ADMISSION_MAX_BYTES = 16 * 1024;
const ADMISSION_MAX_ITEMS = 16;

function facts(overrides: Partial<ExecutionIdentityAdmissionFacts> = {}) {
  return {
    runId: "run-1",
    agentId: "main",
    ingress: { kind: "local-cli" as const, boundary: "agent-command.local" },
    runtime: { kind: "embedded" as const },
    ...overrides,
  };
}

function captureEnvelope(
  admissionFacts: ExecutionIdentityAdmissionFacts,
  options: { contextId?: string; now?: number; runtimeInstanceId?: string } = {},
) {
  let captured: ExecutionIdentityAdmissionEnvelope | undefined;
  const clear = configureExecutionIdentityAdmissionSink((envelope) => {
    captured = envelope;
    return true;
  });
  try {
    const result = enqueueExecutionIdentityContextAtAdmission(admissionFacts, {
      ...options,
      enabled: true,
    });
    if (!result || !captured) {
      throw new Error("expected admission envelope");
    }
    return captured;
  } finally {
    clear();
  }
}

describe("execution identity admission envelope", () => {
  it("captures a deterministic, deeply frozen, redacted envelope with fixed identity", () => {
    const envelope = captureEnvelope(
      facts({
        invoker: {
          kind: "local-account",
          rawPrincipalRef: "raw-principal",
          displayLabel: "Operator OPENAI_API_KEY=sk-1234567890abcdef",
        },
        applicableGrants: [
          { rawGrantRef: "z", state: "present" },
          { rawGrantRef: "a", state: "present" },
          { rawGrantRef: "a", state: "present" },
        ],
        assurance: [
          {
            kind: "runtime-binding",
            rawEvidenceRef: "z",
            strength: "boundary-verified",
          },
          {
            kind: "local-process",
            rawEvidenceRef: "a",
            strength: "boundary-verified",
          },
        ],
      }),
      { contextId: "context-1", now: 123, runtimeInstanceId: "runtime-1" },
    );

    expect(envelope).toMatchObject({
      envelopeVersion: 1,
      contextId: "context-1",
      runId: "run-1",
      createdAt: 123,
      runtimeInstanceId: "runtime-1",
      ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
    });
    expect(envelope.applicableGrants).toEqual([
      { rawGrantRef: "a", state: "present" },
      { rawGrantRef: "z", state: "present" },
    ]);
    expect(envelope.invoker?.displayLabel).not.toContain("sk-1234567890abcdef");
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.ingress)).toBe(true);
    expect(Object.isFrozen(envelope.assurance)).toBe(true);
    expect(parseExecutionIdentityAdmissionEnvelope(structuredClone(envelope))).toEqual(envelope);
    expect(Buffer.byteLength(JSON.stringify(envelope), "utf8")).toBeLessThanOrEqual(
      ADMISSION_MAX_BYTES,
    );
  });

  it("rejects invalid owned facts, excess items, and oversized encoded envelopes", () => {
    expect(() =>
      captureEnvelope(facts({ runId: "" }), {
        runtimeInstanceId: "runtime-1",
      }),
    ).toThrow("expected admission envelope");
    expect(() =>
      captureEnvelope(
        facts({
          applicableGrants: Array.from({ length: ADMISSION_MAX_ITEMS + 1 }, (_, index) => ({
            rawGrantRef: `grant-${String(index)}`,
            state: "present" as const,
          })),
        }),
        { runtimeInstanceId: "runtime-1" },
      ),
    ).toThrow("expected admission envelope");
    expect(() =>
      captureEnvelope(
        facts({
          ingress: {
            kind: "local-cli",
            boundary: "agent-command.local",
            rawSourceRef: "a".repeat(4_096),
          },
          invoker: {
            kind: "local-account",
            rawPrincipalRef: "b".repeat(4_096),
          },
          applicableGrants: [
            { rawGrantRef: "c".repeat(4_096), state: "present" },
            { rawGrantRef: "d".repeat(4_096), state: "present" },
          ],
        }),
        { runtimeInstanceId: "e".repeat(4_096) },
      ),
    ).toThrow("expected admission envelope");
  });

  it("keeps sink replacement ownership and makes unavailable paths nonblocking", () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const clearFirst = configureExecutionIdentityAdmissionSink(first);
    const clearSecond = configureExecutionIdentityAdmissionSink(second);
    clearFirst();
    expect(hasExecutionIdentityAdmissionSink()).toBe(true);
    expect(
      enqueueExecutionIdentityContextAtAdmission(facts(), {
        enabled: true,
        contextId: "context-queued",
        now: 1,
        runtimeInstanceId: "runtime-1",
      }),
    ).toEqual({ contextId: "context-queued", accepted: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    clearSecond();
    expect(hasExecutionIdentityAdmissionSink()).toBe(false);
    expect(() =>
      enqueueExecutionIdentityContextAtAdmission(
        facts({ ingress: { kind: "local-cli", boundary: "x", rawSourceRef: "raw-secret" } }),
        { enabled: true },
      ),
    ).not.toThrow();
    expect(enqueueExecutionIdentityContextAtAdmission(facts(), { enabled: false })).toBeUndefined();
  });
});
