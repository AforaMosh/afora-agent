import type { AgentRunTerminalOutcome } from "./agent-run-terminal-outcome.types.js";

function completedBeforeOrAtTimeout(params: {
  completed: AgentRunTerminalOutcome;
  timeout: AgentRunTerminalOutcome;
}): boolean {
  return (
    params.completed.reason === "completed" &&
    typeof params.completed.endedAt === "number" &&
    typeof params.timeout.endedAt === "number" &&
    params.completed.endedAt <= params.timeout.endedAt
  );
}

function completedBeforeOrAt(params: {
  completed: AgentRunTerminalOutcome;
  incoming: AgentRunTerminalOutcome;
}): boolean {
  return (
    params.completed.reason === "completed" &&
    typeof params.completed.endedAt === "number" &&
    typeof params.incoming.endedAt === "number" &&
    params.completed.endedAt <= params.incoming.endedAt
  );
}

/** Merges observations without overwriting a proven completion, cancellation, or hard timeout. */
export function mergeAgentRunTerminalOutcome(
  current: AgentRunTerminalOutcome | undefined,
  incoming: AgentRunTerminalOutcome,
): AgentRunTerminalOutcome {
  if (!current) {
    return incoming;
  }
  if (current.reason === "superseded" || current.reason === "cancelled") {
    // Timestamps, not callback ordering, decide whether an earlier provider timeout won.
    if (
      incoming.reason === "hard_timeout" &&
      typeof incoming.endedAt === "number" &&
      typeof current.endedAt === "number" &&
      incoming.endedAt <= current.endedAt
    ) {
      return incoming;
    }
    return current.reason === "superseded" || incoming.reason !== "superseded" ? current : incoming;
  }
  // A hard timeout owns the run unless an earlier completion or cancellation is proven.
  if (current.reason === "hard_timeout") {
    if (
      (incoming.reason === "superseded" || incoming.reason === "cancelled") &&
      typeof incoming.endedAt === "number" &&
      typeof current.endedAt === "number" &&
      incoming.endedAt < current.endedAt
    ) {
      return incoming;
    }
    return completedBeforeOrAtTimeout({ completed: incoming, timeout: current })
      ? incoming
      : current;
  }
  if (current.reason === "completed" && incoming.reason !== "completed") {
    // A proven completion outranks every later observation for the same run:
    // teardown cancellations, aborts, supersessions, teardown failures, and
    // soft timeouts that land after the run's own successful end must not
    // reclassify the finished run. A kill or failure of live work has no
    // earlier completion, so it is untouched here. A hard timeout keeps its
    // own timestamp rule below.
    if (incoming.reason === "hard_timeout") {
      return completedBeforeOrAtTimeout({ completed: current, timeout: incoming })
        ? current
        : incoming;
    }
    return completedBeforeOrAt({ completed: current, incoming }) ? current : incoming;
  }
  if (incoming.reason === "superseded" || incoming.reason === "cancelled") {
    return incoming;
  }
  if (incoming.reason === "hard_timeout") {
    return completedBeforeOrAtTimeout({ completed: current, timeout: incoming })
      ? current
      : incoming;
  }
  return incoming;
}
