import { describe, expect, it } from "vitest";
import { resolveIncognitoAforaAgentSqlitePath } from "../state/afora-agent-db.js";
import { appendIncognitoSystemPrompt } from "./incognito-system-prompt.js";

describe("incognito system prompt", () => {
  it("appends the incognito instruction after existing per-session context", () => {
    expect(
      appendIncognitoSystemPrompt({
        agentId: "main",
        extraSystemPrompt: "Existing context.",
        storePath: resolveIncognitoAforaAgentSqlitePath({ agentId: "main" }),
      }),
    ).toBe(
      "Existing context.\n\nThis chat is incognito; do not store its conversation content in memory files or long-term notes.",
    );
  });
});
