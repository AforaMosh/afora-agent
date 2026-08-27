import Foundation
import SwabbleKit
import Testing
@testable import Afora

struct VoiceWakeRuntimeTests {
    @Test func `cancelled runtime delay does not continue`() async {
        let task = Task {
            await VoiceWakeRuntimeTaskSupport.wait(nanoseconds: 60_000_000_000)
        }

        await Task.yield()
        task.cancel()

        #expect(await task.value == false)
    }

    @Test func `trims after trigger keeps post speech`() {
        let triggers = ["claude", "afora"]
        let text = "hey Claude how are you"
        #expect(VoiceWakeRuntime._testTrimmedAfterTrigger(text, triggers: triggers) == "how are you")
    }

    @Test func `trims after trigger returns original when no trigger`() {
        let triggers = ["claude"]
        let text = "good morning friend"
        #expect(VoiceWakeRuntime._testTrimmedAfterTrigger(text, triggers: triggers) == text)
    }

    @Test func `trims after first matching trigger`() {
        let triggers = ["buddy", "claude"]
        let text = "hello buddy this is after trigger claude also here"
        #expect(VoiceWakeRuntime
            ._testTrimmedAfterTrigger(text, triggers: triggers) == "this is after trigger claude also here")
    }

    @Test func `has content after trigger false when only trigger`() {
        let triggers = ["afora"]
        let text = "hey afora"
        #expect(!VoiceWakeRuntime._testHasContentAfterTrigger(text, triggers: triggers))
    }

    @Test func `has content after trigger true when speech continues`() {
        let triggers = ["claude"]
        let text = "claude write a note"
        #expect(VoiceWakeRuntime._testHasContentAfterTrigger(text, triggers: triggers))
    }

    @Test func `trigger only allows filler before trigger`() {
        let triggers = ["afora"]
        let text = "uh afora"
        #expect(VoiceWakeRuntime._testIsTriggerOnly(text, triggers: triggers))
    }

    @Test func `trigger only rejects trailing wake word mentions in ordinary speech`() {
        let triggers = ["afora"]
        let text = "tell me about afora"
        #expect(!VoiceWakeRuntime._testIsTriggerOnly(text, triggers: triggers))
    }

    @Test func `matched trigger finds trigger not at transcript start`() {
        let triggers = ["afora"]
        let text = "uh afora"
        #expect(VoiceWakeRuntime._testMatchedTriggerWord(text, triggers: triggers) == "afora")
    }

    @Test func `matched trigger rejects larger word suffix matches`() {
        let triggers = ["computer"]
        let text = "uh computers"
        #expect(VoiceWakeRuntime._testMatchedTriggerWord(text, triggers: triggers) == nil)
    }

    @Test func `matched trigger prefers most specific overlapping phrase`() {
        let triggers = ["afora", "hey afora"]
        let text = "hey afora"
        #expect(VoiceWakeRuntime._testMatchedTriggerWord(text, triggers: triggers) == "hey afora")
    }

    @Test func `matched trigger handles width insensitive forms without whitespace tokens`() {
        let triggers = ["afora"]
        let text = "ＯｐｅｎＣｌａｗ"
        #expect(VoiceWakeRuntime._testMatchedTriggerWord(text, triggers: triggers) == "afora")
    }

    @Test func `matched trigger handles chinese forms without whitespace tokens`() {
        let triggers = ["小爪"]
        let text = "嘿小爪"
        #expect(VoiceWakeRuntime._testMatchedTriggerWord(text, triggers: triggers) == "小爪")
    }

    @Test func `text only fallback populates matched trigger`() {
        let transcript = "hey afora do thing"
        let config = WakeWordGateConfig(triggers: ["afora"], minCommandLength: 1)
        let match = VoiceWakeRecognitionDebugSupport.textOnlyFallbackMatch(
            transcript: transcript,
            triggers: ["afora"],
            config: config,
            trimWake: VoiceWakeRuntime._testTrimmedAfterTrigger)
        #expect(match?.trigger == "afora")
    }

    @Test func `text only fallback keeps the first trigger phrase when later words match another trigger`() {
        let transcript = "afora tell me about computer vision"
        let config = WakeWordGateConfig(triggers: ["afora", "computer"], minCommandLength: 1)
        let match = VoiceWakeRecognitionDebugSupport.textOnlyFallbackMatch(
            transcript: transcript,
            triggers: ["afora", "computer"],
            config: config,
            trimWake: VoiceWakeRuntime._testTrimmedAfterTrigger)
        #expect(match?.trigger == "afora")
    }

    @Test func `text only fallback rejects filler prefixed larger word suffix matches`() {
        let transcript = "uh computers"
        let config = WakeWordGateConfig(triggers: ["computer"], minCommandLength: 1)
        let match = VoiceWakeRecognitionDebugSupport.textOnlyFallbackMatch(
            transcript: transcript,
            triggers: ["computer"],
            config: config,
            trimWake: VoiceWakeRuntime._testTrimmedAfterTrigger)
        #expect(match == nil)
    }

    @Test func `trims after chinese trigger keeps post speech`() {
        let triggers = ["小爪", "afora"]
        let text = "嘿 小爪 帮我打开设置"
        #expect(VoiceWakeRuntime._testTrimmedAfterTrigger(text, triggers: triggers) == "帮我打开设置")
    }

    @Test func `trims after trigger handles width insensitive forms`() {
        let triggers = ["afora"]
        let text = "ＯｐｅｎＣｌａｗ 请帮我"
        #expect(VoiceWakeRuntime._testTrimmedAfterTrigger(text, triggers: triggers) == "请帮我")
    }

    @Test func `gate requires gap between trigger and command`() {
        let transcript = "hey afora do thing"
        let segments = makeWakeWordSegments(
            transcript: transcript,
            words: [
                ("hey", 0.0, 0.1),
                ("afora", 0.2, 0.1),
                ("do", 0.35, 0.1),
                ("thing", 0.5, 0.1),
            ])
        let config = WakeWordGateConfig(triggers: ["afora"], minPostTriggerGap: 0.3)
        #expect(WakeWordGate.match(transcript: transcript, segments: segments, config: config) == nil)
    }

    @Test func `gate accepts gap and extracts command`() {
        let transcript = "hey afora do thing"
        let segments = makeWakeWordSegments(
            transcript: transcript,
            words: [
                ("hey", 0.0, 0.1),
                ("afora", 0.2, 0.1),
                ("do", 0.9, 0.1),
                ("thing", 1.1, 0.1),
            ])
        let config = WakeWordGateConfig(triggers: ["afora"], minPostTriggerGap: 0.3)
        #expect(WakeWordGate.match(transcript: transcript, segments: segments, config: config)?.command == "do thing")
    }

    @Test func `gate command text handles foreign string ranges`() {
        let transcript = "hey afora do thing"
        let other = "do thing"
        let foreignRange = other.range(of: "do")
        let segments = [
            WakeWordSegment(text: "hey", start: 0.0, duration: 0.1, range: transcript.range(of: "hey")),
            WakeWordSegment(text: "afora", start: 0.2, duration: 0.1, range: transcript.range(of: "afora")),
            WakeWordSegment(text: "do", start: 0.9, duration: 0.1, range: foreignRange),
            WakeWordSegment(text: "thing", start: 1.1, duration: 0.1, range: nil),
        ]

        #expect(
            WakeWordGate.commandText(
                transcript: transcript,
                segments: segments,
                triggerEndTime: 0.3) == "do thing")
    }
}
