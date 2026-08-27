// Provider-index types describe install hints, auth choices, and preview catalogs for discoverable providers.
import type { ModelCatalogProvider } from "@afora/model-catalog-core/model-catalog-types";

// Normalized provider-index schema. It describes providers discoverable before
// plugin install, including install hints, auth choices, and preview catalogs.
export type AforaProviderIndexPluginInstall = {
  clawhubSpec?: string;
  npmSpec?: string;
  defaultChoice?: "clawhub" | "npm";
  minHostVersion?: string;
  expectedIntegrity?: string;
};

export type AforaProviderIndexPlugin = {
  id: string;
  package?: string;
  source?: string;
  install?: AforaProviderIndexPluginInstall;
};

export type AforaProviderIndexProviderAuthChoice = {
  method: string;
  choiceId: string;
  choiceLabel: string;
  choiceHint?: string;
  assistantPriority?: number;
  assistantVisibility?: "visible" | "manual-only";
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
  optionKey?: string;
  cliFlag?: string;
  cliOption?: string;
  cliDescription?: string;
  onboardingScopes?: readonly ("text-inference" | "image-generation" | "music-generation")[];
};

export type AforaProviderIndexProvider = {
  id: string;
  name: string;
  plugin: AforaProviderIndexPlugin;
  docs?: string;
  categories?: readonly string[];
  authChoices?: readonly AforaProviderIndexProviderAuthChoice[];
  previewCatalog?: ModelCatalogProvider;
};

export type AforaProviderIndex = {
  version: number;
  providers: Readonly<Record<string, AforaProviderIndexProvider>>;
};
