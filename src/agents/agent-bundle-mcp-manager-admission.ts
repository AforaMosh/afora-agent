type PendingCreateTracker = {
  run: <T>(sessionId: string, work: () => Promise<T>) => Promise<T>;
  hasPending: (sessionId: string) => boolean;
  totalPending: () => number;
};

export function createPendingCreateTracker(params: {
  onSessionDrained: (sessionId: string) => void;
}): PendingCreateTracker {
  const countsBySessionId = new Map<string, number>();
  return {
    async run<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
      countsBySessionId.set(sessionId, (countsBySessionId.get(sessionId) ?? 0) + 1);
      try {
        return await work();
      } finally {
        const remaining = (countsBySessionId.get(sessionId) ?? 1) - 1;
        if (remaining > 0) {
          countsBySessionId.set(sessionId, remaining);
        } else {
          countsBySessionId.delete(sessionId);
          params.onSessionDrained(sessionId);
        }
      }
    },
    hasPending: (sessionId) => (countsBySessionId.get(sessionId) ?? 0) > 0,
    totalPending: () =>
      Array.from(countsBySessionId.values()).reduce((total, count) => total + count, 0),
  };
}
