/** Filesystem policy for agent tools that can touch local paths. */
export type ToolFsPolicy =
  | Readonly<{ kind: "workspace"; workspaceOnly: boolean }>
  | Readonly<{
      kind: "authorized-memory-view";
      workspaceOnly: true;
      viewId: string;
      revision: string;
      virtualRoots: readonly string[];
    }>
  | Readonly<{
      kind: "sandbox-mount-plan";
      workspaceOnly: true;
      viewId: string;
      revision: string;
      mountTargets: readonly string[];
    }>
  | Readonly<{ kind: "memory-unavailable"; workspaceOnly: true }>;
