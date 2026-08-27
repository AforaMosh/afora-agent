import "./client-voice-confirmation.js";

type ClientVoiceConfirmationTestApi = {
  resetClientVoiceConfirmationStateForTest(): void;
};

function getTestApi(): ClientVoiceConfirmationTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("afora.clientVoiceConfirmationTestApi")
  ] as ClientVoiceConfirmationTestApi;
}

export function resetClientVoiceConfirmationStateForTest(): void {
  getTestApi().resetClientVoiceConfirmationStateForTest();
}
