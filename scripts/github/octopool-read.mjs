// Direct Octopool transport for the guards' compatible GitHub REST reads.
import { readBoundedResponseText } from "../lib/bounded-response.mjs";

const octopoolResponseMaxBytes = 1024 * 1024;
const guardReadRoutes = [
  /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/u,
  /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files$/u,
  /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/u,
  /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/labels$/u,
  /^\/repos\/[^/]+\/[^/]+\/contents\/.+$/u,
  /^\/repos\/[^/]+\/[^/]+\/git\/blobs\/[0-9a-f]+$/iu,
];

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required for Octopool GitHub reads.`);
  }
  return value.trim();
}

function parseGuardReadPath(path) {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.includes("://") ||
    path.includes("\\") ||
    path.includes("#") ||
    /(?:^|\/)\.{1,2}(?:\/|$)/u.test(path) ||
    /%(?:2e|5c)/iu.test(path)
  ) {
    return null;
  }
  const url = new URL(path, "https://api.github.com");
  if (!guardReadRoutes.some((route) => route.test(url.pathname))) {
    return null;
  }
  const query = Object.fromEntries(url.searchParams);
  return {
    path: url.pathname,
    ...(Object.keys(query).length > 0 ? { query } : {}),
  };
}

function relayError(path, status) {
  const error = new Error(`Octopool GET ${path} failed with ${status}.`);
  error.status = status;
  return error;
}

export function createOctopoolReadClient({ url, pool, token, fetchImpl = fetch } = {}) {
  const baseUrl = new URL(required(url, "OCTOPOOL_URL"));
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error("OCTOPOOL_URL must be an https origin.");
  }
  const endpoint = new URL("/v1/github/request", baseUrl);
  const relayPool = required(pool, "OCTOPOOL_POOL");
  const relayToken = required(token, "OCTOPOOL_TOKEN");

  return {
    supports: (path) => parseGuardReadPath(path) !== null,
    async get(path, { routeHint, signal } = {}) {
      const request = parseGuardReadPath(path);
      if (!request) {
        throw new Error(`Octopool does not allow GitHub route: ${path}`);
      }
      if (
        routeHint !== undefined &&
        (!/\/pulls\/\d+\/files$/u.test(request.path) ||
          !/^[a-f0-9]{40}$/iu.test(routeHint.pr_head_sha ?? ""))
      ) {
        throw new Error("Octopool pr_head_sha is valid only for pull-request file reads.");
      }
      const response = await fetchImpl(endpoint, {
        method: "POST",
        signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${relayToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          pool: relayPool,
          method: "GET",
          ...request,
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
          ...(routeHint === undefined ? {} : { route_hint: routeHint }),
        }),
      });
      let envelope;
      try {
        envelope = JSON.parse(
          await readBoundedResponseText(response, "Octopool", octopoolResponseMaxBytes, { signal }),
        );
      } catch {
        if (!response.ok) {
          throw relayError(request.path, response.status);
        }
        throw new Error(`Octopool returned an invalid response for ${request.path}.`);
      }
      if (!envelope || typeof envelope !== "object" || !Number.isInteger(envelope.status)) {
        throw new Error(`Octopool returned an invalid response for ${request.path}.`);
      }
      if (!response.ok || envelope.status < 200 || envelope.status >= 300) {
        throw relayError(request.path, envelope.status);
      }
      if (envelope.body_encoding !== "json") {
        throw new Error(`Octopool returned non-JSON data for ${request.path}.`);
      }
      const relay = envelope.relay ?? {};
      console.info(
        `Octopool GET ${request.path}: status=${envelope.status} route=${relay.route_kind ?? "unknown"} cache=${relay.cache ?? "unknown"}`,
      );
      return envelope.body;
    },
  };
}

export function createOctopoolReadClientFromEnv(environment = process.env, options = {}) {
  const values = [environment.OCTOPOOL_URL, environment.OCTOPOOL_POOL, environment.OCTOPOOL_TOKEN];
  if (values.every((value) => value === undefined)) {
    return null;
  }
  return createOctopoolReadClient({
    url: environment.OCTOPOOL_URL,
    pool: environment.OCTOPOOL_POOL,
    token: environment.OCTOPOOL_TOKEN,
    ...options,
  });
}
