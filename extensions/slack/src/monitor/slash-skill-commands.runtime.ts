// Slack plugin module implements slash skill commands behavior.
import { listSkillCommandsForAgents as listSkillCommandsForAgentsImpl } from "afora-agent/plugin-sdk/command-auth-native";

type ListSkillCommandsForAgents =
  typeof import("afora-agent/plugin-sdk/command-auth-native").listSkillCommandsForAgents;

export function listSkillCommandsForAgents(
  ...args: Parameters<ListSkillCommandsForAgents>
): ReturnType<ListSkillCommandsForAgents> {
  return listSkillCommandsForAgentsImpl(...args);
}
