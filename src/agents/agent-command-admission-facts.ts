import type { ExecutionIdentityAdmissionFacts } from "../audit/execution-identity-admission.js";

type AgentCommandAdmissionFacts = Readonly<
  Pick<ExecutionIdentityAdmissionFacts, "assurance" | "ingress" | "invoker">
>;

const factsByIngress = new WeakMap<object, AgentCommandAdmissionFacts>();

export function attachAgentCommandAdmissionFacts<TIngress extends object>(
  ingress: TIngress,
  facts: AgentCommandAdmissionFacts,
): void {
  factsByIngress.set(ingress, facts);
}

export function getAgentCommandAdmissionFacts<TIngress extends object>(
  ingress: TIngress,
): AgentCommandAdmissionFacts | undefined {
  return factsByIngress.get(ingress);
}
