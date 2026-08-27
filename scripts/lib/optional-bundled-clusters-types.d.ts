// Optional Bundled Clusters Types.D script supports Afora repository automation.
export const optionalBundledClusterSet: Set<string>;
export function shouldBuildBundledCluster(
  cluster: string,
  env?: NodeJS.ProcessEnv,
  options?: { packageJson?: unknown },
): boolean;
