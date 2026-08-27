// Declares extension points for agent session type augmentation.
export type AforaAgentSessionSkillSourceAugmentation = never;

declare module "afora-agent/plugin-sdk/agent-sessions" {
  interface Skill {
    // Afora relies on the source identifier returned by skill loaders.
    source: string;
  }
}
