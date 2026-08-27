import { MeetingPlatformAdapter } from "afora-agent/plugin-sdk/meeting-runtime";

export function teamsMeetingStatusCallSource(): string {
  return MeetingPlatformAdapter.createStatusCallSource({
    platform: {
      audioOutputElementIdPrefix: "afora-teams-audio-output-",
      displayName: "Teams",
      globals: {
        audioOutputs: "__aforaTeamsAudioOutputs",
        captions: "__aforaTeamsCaptions",
        meeting: "__aforaTeamsMeeting",
      },
      manualActionReasonPrefix: "teams",
    },
    captionEnableSource: `if (!captionsFinalized && canMutateSession && inCall && !captionsEnabledNow) {
      let captionButton = first(selectors.captions);
      if (!captionButton) {
        first(selectors.moreActions)?.click?.();
        await waitForUi();
        captionButton = first(selectors.captions);
      }
      if (captionButton) {
        const captionLabel = label(captionButton);
        const alreadyEnabled = captionButton.getAttribute?.("aria-checked") === "true" ||
          /hide live captions|turn off captions/i.test(captionLabel) ||
          Boolean(firstRaw(selectors.captionsOff));
        if (!alreadyEnabled) {
          captionButton.click();
          await waitForUi();
        }
        const currentLabel = label(captionButton);
        captionsEnabledNow = captionButton.getAttribute?.("aria-checked") === "true" ||
          /hide live captions|turn off captions/i.test(currentLabel) ||
          Boolean(firstRaw(selectors.captionRenderer)) ||
          Boolean(firstRaw(selectors.captionsOff));
        if (captionsEnabledNow && !alreadyEnabled) {
          notes.push("Enabled Teams live captions for transcript capture.");
        }
      }
    }`,
  });
}
