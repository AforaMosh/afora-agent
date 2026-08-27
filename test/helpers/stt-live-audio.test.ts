// STT live audio tests validate live speech-to-text audio fixtures.
import {
  expectAforaLiveTranscriptMarker,
  normalizeTranscriptForMatch,
  AFORA_LIVE_TRANSCRIPT_MARKER_RE,
} from "afora-agent/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";

describe("normalizeTranscriptForMatch", () => {
  it("normalizes punctuation and common Afora live transcription variants", () => {
    expect(normalizeTranscriptForMatch("Afora integration OK")).toBe("aforaintegrationok");
    expect(normalizeTranscriptForMatch("Testing OpenFlaw realtime transcription")).toMatch(
      /open(?:claw|flaw)/,
    );
    expect(normalizeTranscriptForMatch("OpenCore xAI realtime transcription")).toMatch(
      AFORA_LIVE_TRANSCRIPT_MARKER_RE,
    );
    expect(normalizeTranscriptForMatch("OpenCL xAI realtime transcription")).toMatch(
      AFORA_LIVE_TRANSCRIPT_MARKER_RE,
    );
    expectAforaLiveTranscriptMarker("OpenClar integration OK");
  });
});
