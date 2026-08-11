/**
 * Telegram inline button utilities for model selection.
 *
 * Callback data patterns (max 64 bytes for Telegram):
 * - mdl_prov              - show providers list
 * - mdl_list_{prov}_{pg}  - show models for provider (page N, 1-indexed)
 * - mdl_sel_{provider/id} - select model (standard)
 * - mdl_sel/{model}       - select model (shipped compact callback)
 * - mdl1~p:{sha256}:{pg}  - show models for an opaque provider ref
 * - mdl1~m:{sha256}       - select an opaque provider/model ref
 * - mdl_back              - back to providers list
 */
import { createHash } from "node:crypto";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { fitsTelegramCallbackData } from "./approval-callback-data.js";

export type ButtonRow = Array<{ text: string; callback_data: string }>;

export type ParsedModelCallback =
  | { type: "providers" }
  | { type: "list"; provider: string; page: number }
  | { type: "list-ref"; digest: string; page: number }
  | { type: "select"; provider?: string; model: string }
  | { type: "select-ref"; digest: string }
  | { type: "back" };

export type ProviderInfo = {
  id: string;
  count: number;
};

export type ResolveModelSelectionResult =
  | { kind: "resolved"; provider: string; model: string }
  | { kind: "ambiguous"; model: string; matchingProviders: string[] };

type ResolveModelListCallbackResult =
  | { kind: "resolved"; provider: string; page: number }
  | { kind: "ambiguous"; matchingProviders: string[] };

export type ModelsKeyboardParams = {
  provider: string;
  models: readonly string[];
  currentModel?: string;
  currentPage: number;
  totalPages: number;
  pageSize?: number;
  /** Optional map from provider/model to display name. When provided, the
   *  display name is shown on the button instead of the raw model ID. */
  modelNames?: ReadonlyMap<string, string>;
};

const MODELS_PAGE_SIZE = 8;
const MODEL_BUTTON_LABEL_MAX_LENGTH = 38;
const LEGACY_PROVIDER_PATTERN = /^[a-z0-9_.-]+$/i;
const CALLBACK_PREFIX = {
  providers: "mdl_prov",
  back: "mdl_back",
  list: "mdl_list_",
  selectStandard: "mdl_sel_",
  selectCompact: "mdl_sel/",
  opaqueModel: "mdl1~m:",
  opaqueProvider: "mdl1~p:",
} as const;

function hashOpaqueCallback(domain: "model" | "provider", values: readonly string[]): string {
  const hash = createHash("sha256").update(`openclaw.telegram.${domain}-callback.v1`, "utf8");
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("base64url");
}

function hashModelSelection(provider: string, model: string): string {
  return hashOpaqueCallback("model", [provider, model]);
}

function hashProvider(provider: string): string {
  return hashOpaqueCallback("provider", [provider]);
}

function parseBase36PositiveInteger(value: string): number | undefined {
  if (!/^[0-9a-z]+$/.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 36);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed.toString(36) === value
    ? parsed
    : undefined;
}

/**
 * Parse a model callback_data string into a structured object.
 * Returns null if the data doesn't match a known pattern.
 */
export function parseModelCallbackData(data: string): ParsedModelCallback | null {
  const trimmed = data.trim();

  const opaqueModelMatch = trimmed.match(/^mdl1~m:([A-Za-z0-9_-]{43})$/);
  if (opaqueModelMatch?.[1]) {
    return { type: "select-ref", digest: opaqueModelMatch[1] };
  }

  const opaqueProviderMatch = trimmed.match(/^mdl1~p:([A-Za-z0-9_-]{43}):([0-9a-z]+)$/);
  if (opaqueProviderMatch?.[1] && opaqueProviderMatch[2]) {
    const page = parseBase36PositiveInteger(opaqueProviderMatch[2]);
    if (page !== undefined) {
      return { type: "list-ref", digest: opaqueProviderMatch[1], page };
    }
  }

  if (!trimmed.startsWith("mdl_")) {
    return null;
  }

  if (trimmed === CALLBACK_PREFIX.providers || trimmed === CALLBACK_PREFIX.back) {
    return { type: trimmed === CALLBACK_PREFIX.providers ? "providers" : "back" };
  }

  // mdl_list_{provider}_{page}
  const listMatch = trimmed.match(/^mdl_list_([a-z0-9_.-]+)_(\d+)$/i);
  if (listMatch) {
    const [, provider, pageStr] = listMatch;
    const page = parseStrictPositiveInteger(pageStr);
    if (provider && page !== undefined) {
      return { type: "list", provider, page };
    }
  }

  // mdl_sel/{model} (compact fallback)
  const compactSelMatch = trimmed.match(/^mdl_sel\/(.+)$/);
  if (compactSelMatch) {
    const modelRef = compactSelMatch[1];
    if (modelRef) {
      return {
        type: "select",
        model: modelRef,
      };
    }
  }

  // mdl_sel_{provider/model}
  const selMatch = trimmed.match(/^mdl_sel_(.+)$/);
  if (selMatch) {
    const modelRef = selMatch[1];
    if (modelRef) {
      const slashIndex = modelRef.indexOf("/");
      if (slashIndex > 0 && slashIndex < modelRef.length - 1) {
        return {
          type: "select",
          provider: modelRef.slice(0, slashIndex),
          model: modelRef.slice(slashIndex + 1),
        };
      }
    }
  }

  return null;
}

export function buildModelSelectionCallbackData(params: {
  provider: string;
  model: string;
}): string {
  const fullCallbackData = `${CALLBACK_PREFIX.selectStandard}${params.provider}/${params.model}`;
  const parsed = parseModelCallbackData(fullCallbackData);
  if (
    LEGACY_PROVIDER_PATTERN.test(params.provider) &&
    fitsTelegramCallbackData(fullCallbackData) &&
    parsed?.type === "select" &&
    parsed.provider === params.provider &&
    parsed.model === params.model
  ) {
    return fullCallbackData;
  }
  return `${CALLBACK_PREFIX.opaqueModel}${hashModelSelection(params.provider, params.model)}`;
}

function buildProviderListCallbackData(params: { provider: string; page: number }): string {
  const fullCallbackData = `${CALLBACK_PREFIX.list}${params.provider}_${params.page}`;
  const parsed = parseModelCallbackData(fullCallbackData);
  if (
    LEGACY_PROVIDER_PATTERN.test(params.provider) &&
    fitsTelegramCallbackData(fullCallbackData) &&
    parsed?.type === "list" &&
    parsed.provider === params.provider &&
    parsed.page === params.page
  ) {
    return fullCallbackData;
  }
  return `${CALLBACK_PREFIX.opaqueProvider}${hashProvider(params.provider)}:${params.page.toString(36)}`;
}

export function resolveModelSelection(params: {
  callback: Extract<ParsedModelCallback, { type: "select" | "select-ref" }>;
  providers: readonly string[];
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
}): ResolveModelSelectionResult {
  const callback = params.callback;
  if (callback.type === "select-ref") {
    const matches: Array<{ provider: string; model: string }> = [];
    for (const provider of params.providers) {
      for (const model of params.byProvider.get(provider) ?? []) {
        if (hashModelSelection(provider, model) === callback.digest) {
          matches.push({ provider, model });
        }
      }
    }
    if (matches.length === 1) {
      return { kind: "resolved", ...expectDefined(matches.at(0), "single matching model") };
    }
    return {
      kind: "ambiguous",
      model: callback.digest,
      matchingProviders: matches.map((match) => match.provider),
    };
  }
  if (callback.provider) {
    return {
      kind: "resolved",
      provider: callback.provider,
      model: callback.model,
    };
  }
  const matchingProviders = params.providers.filter((id) =>
    params.byProvider.get(id)?.has(callback.model),
  );
  if (matchingProviders.length === 1) {
    return {
      kind: "resolved",
      provider: expectDefined(matchingProviders.at(0), "single matching model provider"),
      model: callback.model,
    };
  }
  return {
    kind: "ambiguous",
    model: callback.model,
    matchingProviders,
  };
}

export function resolveModelListCallback(params: {
  callback: Extract<ParsedModelCallback, { type: "list" | "list-ref" }>;
  providers: readonly string[];
}): ResolveModelListCallbackResult {
  const callback = params.callback;
  if (callback.type === "list") {
    return {
      kind: "resolved",
      provider: callback.provider,
      page: callback.page,
    };
  }
  const matchingProviders = params.providers.filter(
    (provider) => hashProvider(provider) === callback.digest,
  );
  return matchingProviders.length === 1
    ? {
        kind: "resolved",
        provider: expectDefined(matchingProviders.at(0), "single matching provider"),
        page: callback.page,
      }
    : { kind: "ambiguous", matchingProviders };
}

function isCurrentModelSelection(params: {
  currentModel?: string;
  provider: string;
  model: string;
}): boolean {
  const currentModel = params.currentModel?.trim();
  if (!currentModel) {
    return false;
  }
  return currentModel.includes("/")
    ? currentModel === `${params.provider}/${params.model}`
    : currentModel === params.model;
}

/**
 * Build provider selection keyboard with 2 providers per row.
 */
export function buildProviderKeyboard(providers: ProviderInfo[]): ButtonRow[] {
  if (providers.length === 0) {
    return [];
  }

  const rows: ButtonRow[] = [];
  let currentRow: ButtonRow = [];

  for (const provider of providers) {
    const button = {
      text: `${provider.id} (${provider.count})`,
      callback_data: buildProviderListCallbackData({ provider: provider.id, page: 1 }),
    };

    currentRow.push(button);

    if (currentRow.length === 2) {
      rows.push(currentRow);
      currentRow = [];
    }
  }

  // Push any remaining button
  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Build model list keyboard with pagination and back button.
 */
export function buildModelsKeyboard(params: ModelsKeyboardParams): ButtonRow[] {
  const { provider, models, currentModel, currentPage, totalPages, modelNames } = params;
  const pageSize = params.pageSize ?? MODELS_PAGE_SIZE;

  if (models.length === 0) {
    return [[{ text: "<< Back", callback_data: CALLBACK_PREFIX.back }]];
  }

  const rows: ButtonRow[] = [];

  // Calculate page slice
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, models.length);
  const pageModels = models.slice(startIndex, endIndex);

  for (const model of pageModels) {
    const callbackData = buildModelSelectionCallbackData({ provider, model });
    const isCurrentModel = isCurrentModelSelection({ currentModel, provider, model });
    const fallbackLabel = model.includes("/") ? `${provider}/${model}` : model;
    const displayLabel = modelNames?.get(`${provider}/${model}`) ?? fallbackLabel;
    const displayText = truncateModelLabel(displayLabel, MODEL_BUTTON_LABEL_MAX_LENGTH);
    const text = isCurrentModel ? `${displayText} ✓` : displayText;

    rows.push([
      {
        text,
        callback_data: callbackData,
      },
    ]);
  }

  // Pagination row
  if (totalPages > 1) {
    const paginationRow: ButtonRow = [];

    if (currentPage > 1) {
      paginationRow.push({
        text: "◀ Prev",
        callback_data: buildProviderListCallbackData({ provider, page: currentPage - 1 }),
      });
    }

    paginationRow.push({
      text: `${currentPage}/${totalPages}`,
      callback_data: buildProviderListCallbackData({ provider, page: currentPage }), // noop
    });

    if (currentPage < totalPages) {
      paginationRow.push({
        text: "Next ▶",
        callback_data: buildProviderListCallbackData({ provider, page: currentPage + 1 }),
      });
    }

    rows.push(paginationRow);
  }

  // Back button
  rows.push([{ text: "<< Back", callback_data: CALLBACK_PREFIX.back }]);

  return rows;
}

/**
 * Build "Browse providers" button for /model summary.
 */
export function buildBrowseProvidersButton(): ButtonRow[] {
  return [[{ text: "Browse providers", callback_data: CALLBACK_PREFIX.providers }]];
}

/**
 * Truncate a model label for display, preserving its end if too long.
 */
function truncateModelLabel(modelLabel: string, maxLen: number): string {
  if (modelLabel.length <= maxLen) {
    return modelLabel;
  }
  return `…${sliceUtf16Safe(modelLabel, -(maxLen - 1))}`;
}

/**
 * Get page size for model list pagination.
 */
export function getModelsPageSize(): number {
  return MODELS_PAGE_SIZE;
}

/**
 * Calculate total pages for a model list.
 */
export function calculateTotalPages(totalModels: number, pageSize?: number): number {
  const size = pageSize ?? MODELS_PAGE_SIZE;
  return size > 0 ? Math.ceil(totalModels / size) : 1;
}
