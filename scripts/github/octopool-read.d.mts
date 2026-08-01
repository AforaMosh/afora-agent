export function createOctopoolReadClient(options: {
  url: string;
  pool: string;
  token: string;
  fetchImpl?: typeof fetch;
}): {
  supports(path: string): boolean;
  get(
    path: string,
    options?: { routeHint?: { pr_head_sha: string }; signal?: AbortSignal },
  ): Promise<unknown>;
};
export function createOctopoolReadClientFromEnv(
  environment?: NodeJS.ProcessEnv,
  options?: { fetchImpl?: typeof fetch },
): ReturnType<typeof createOctopoolReadClient> | null;
