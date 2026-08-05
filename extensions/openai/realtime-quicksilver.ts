// GPT-Live (OpenAI "quicksilver") uses browser or Gateway-owned WebRTC when
// the host owns delegation, and the Platform-key Frameless Bidi WebSocket elsewhere.

const OPENAI_GPT_LIVE_MODEL_PREFIX = "gpt-live";

const OPENAI_GPT_LIVE_MODEL = "gpt-live-1-boulder-alpha";
const OPENAI_GPT_LIVE_MODELS = [OPENAI_GPT_LIVE_MODEL] as const;

export function isOpenAIGptLiveModel(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  const normalized = model.trim().toLowerCase();
  return (
    normalized === OPENAI_GPT_LIVE_MODEL_PREFIX ||
    normalized.startsWith(`${OPENAI_GPT_LIVE_MODEL_PREFIX}-`)
  );
}

export function isSupportedOpenAIGptLiveModel(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  const normalized = model.trim().toLowerCase();
  return OPENAI_GPT_LIVE_MODELS.includes(normalized as (typeof OPENAI_GPT_LIVE_MODELS)[number]);
}

export function getUnsupportedOpenAIGptLiveModelMessage(
  model: string | undefined,
): string | undefined {
  if (!isOpenAIGptLiveModel(model) || isSupportedOpenAIGptLiveModel(model)) {
    return undefined;
  }
  return "This experimental realtime model is not supported by this OpenClaw build.";
}

export function assertSupportedOpenAIGptLiveModel(model: string | undefined): void {
  const message = getUnsupportedOpenAIGptLiveModelMessage(model);
  if (message) {
    throw new Error(message);
  }
}
