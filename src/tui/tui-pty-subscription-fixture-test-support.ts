// Keeps bounded session-subscription failure injection outside the shared PTY fixture.
export const TUI_PTY_SESSION_SUBSCRIPTION_FIXTURE_SCRIPT = `
  private sessionSubscriptionAttempts = 0;
  private preRestoreOverlayEmitted = false;

  async subscribeSessionEvents() {
    record("subscribeSessionEvents");
    const configuredFailures = Number(process.env.OPENCLAW_TUI_PTY_SUBSCRIBE_FAILURES ?? 0);
    if (this.sessionSubscriptionAttempts++ < configuredFailures) {
      record("subscribeSessionFailure");
      throw new Error("fixture session subscription unavailable");
    }
    if (!this.preRestoreOverlayEmitted && preRestoreOverlay) {
      this.preRestoreOverlayEmitted = true;
      if (preRestoreOverlay === "plugin-approval") {
        pendingPluginApproval = {
          id: "plugin:pre-restore",
          request: {
            title: "Default session approval",
            description: "This prompt must close when remembered-session restore changes identity.",
            pluginId: "workspace-skills",
            severity: "warning",
            toolName: "skill_workshop",
            allowedDecisions: ["allow-once", "deny"],
            sessionKey: "agent:main:main",
          },
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 120_000,
        };
        this.onEvent?.({
          event: "plugin.approval.requested",
          payload: pendingPluginApproval,
        });
      } else if (preRestoreOverlay === "task-suggestion") {
        pendingTaskSuggestion = {
          id: "task_pre_restore",
          title: "Default session task",
          prompt: "This prompt must close when remembered-session restore changes identity.",
          tldr: "It belongs to the abandoned default session.",
          cwd: "/repo/project",
          sessionKey: "agent:main:main",
          agentId: "main",
          createdAt: Date.now(),
        };
        this.onEvent?.({
          event: "task.suggestion",
          payload: { action: "created", suggestion: pendingTaskSuggestion },
        });
      }
    }
    return { subscribed: true };
  }
`;
