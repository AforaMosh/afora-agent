/**
 * OAuth credential management for AI providers.
 *
 * This module handles login, token refresh, and credential storage
 * for OAuth-based providers:
 * - Anthropic (Claude Pro/Max)
 * - provider plugins through their runtime auth hooks
 */

// Anthropic
// OpenAI Codex (ChatGPT OAuth)

export * from "./types.js";

// ============================================================================
// Built-in providers and instance-owned registries
// ============================================================================

import { anthropicOAuthProvider } from "./anthropic.js";
import { openaiCodexOAuthProvider } from "./openai-chatgpt.js";
import type {
  OAuthCredentials,
  OAuthProviderId,
  OAuthProviderInterface,
  OAuthRefreshContext,
} from "./types.js";

const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [
  anthropicOAuthProvider,
  openaiCodexOAuthProvider,
];

type OAuthApiKeyResult = { newCredentials: OAuthCredentials; apiKey: string } | null;
type PreparedOAuthApiKey = (
  credentials: OAuthCredentials,
  context?: OAuthRefreshContext,
) => Promise<OAuthApiKeyResult>;

async function resolveOAuthApiKey(
  provider: OAuthProviderInterface,
  credentials: OAuthCredentials,
  refresh: OAuthProviderInterface["refreshToken"],
  context?: OAuthRefreshContext,
): Promise<OAuthApiKeyResult> {
  let creds = credentials;
  if (Date.now() >= creds.expires) {
    try {
      creds = await refresh(creds, context);
    } catch (error) {
      throw new Error(`Failed to refresh OAuth token for ${provider.id}`, { cause: error });
    }
  }

  return { newCredentials: creds, apiKey: provider.getApiKey(creds) };
}

function prepareOAuthApiKeyForProvider(provider: OAuthProviderInterface): PreparedOAuthApiKey {
  const refresh = provider.prepareRefreshToken?.() ?? provider.refreshToken.bind(provider);
  return (credentials: OAuthCredentials, context?: OAuthRefreshContext) =>
    resolveOAuthApiKey(provider, credentials, refresh, context);
}

/** Mutable OAuth provider registrations owned by one auth/session runtime. */
export class OAuthProviderRegistry {
  private providers = new Map<string, OAuthProviderInterface>();

  constructor() {
    this.reset();
  }

  get(id: OAuthProviderId): OAuthProviderInterface | undefined {
    return this.providers.get(id);
  }

  register(provider: OAuthProviderInterface): void {
    this.providers.set(provider.id, provider);
  }

  reset(): void {
    this.providers.clear();
    for (const provider of BUILT_IN_OAUTH_PROVIDERS) {
      this.providers.set(provider.id, provider);
    }
  }

  getAll(): OAuthProviderInterface[] {
    return Array.from(this.providers.values());
  }

  async getApiKey(
    providerId: OAuthProviderId,
    credentials: Record<string, OAuthCredentials>,
  ): Promise<OAuthApiKeyResult> {
    const resolveApiKey = this.prepareApiKey(providerId);
    if (!resolveApiKey) {
      throw new Error(`Unknown OAuth provider: ${providerId}`);
    }
    const credential = credentials[providerId];
    return credential ? resolveApiKey(credential) : null;
  }

  prepareApiKey(providerId: OAuthProviderId): PreparedOAuthApiKey | null {
    const provider = this.get(providerId);
    return provider ? prepareOAuthApiKeyForProvider(provider) : null;
  }
}

/**
 * Get a built-in OAuth provider by ID.
 */
function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
  return BUILT_IN_OAUTH_PROVIDERS.find((provider) => provider.id === id);
}

/**
 * Get all built-in OAuth providers.
 */
export function getOAuthProviders(): OAuthProviderInterface[] {
  return [...BUILT_IN_OAUTH_PROVIDERS];
}

// ============================================================================
// High-level built-in provider API
// ============================================================================

/**
 * Get API key for a provider from OAuth credentials.
 * Automatically refreshes expired tokens.
 *
 * @returns API key string and updated credentials, or null if no credentials
 * @throws Error if refresh fails
 */
export function prepareOAuthApiKey(providerId: OAuthProviderId): PreparedOAuthApiKey | null {
  const provider = getOAuthProvider(providerId);
  return provider ? prepareOAuthApiKeyForProvider(provider) : null;
}
