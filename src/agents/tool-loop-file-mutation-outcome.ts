const FILE_MUTATION_TOOLS = new Set(["apply_patch", "edit", "write"]);

export function isFileMutationTool(toolName: string): boolean {
  return FILE_MUTATION_TOOLS.has(toolName);
}

export function isFileMutationNoProgressOutcome(
  toolName: string,
  details: Record<string, unknown>,
): boolean {
  // Display text includes paths and formatting details; the structured flag is
  // the stable contract shared by built-in file mutation tools.
  return isFileMutationTool(toolName) && details.changed === false;
}
