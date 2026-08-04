import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
private final class RealtimeStopAudioCapture: RealtimeTalkAudioCapturing {
    let suppressesInputDuringOutput = false

    func start(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void) throws
    {}

    func stop() {}
}

@MainActor
private final class RealtimeStopPCMPlayer: PCMStreamingAudioPlaying {
    func play(
        stream: AsyncThrowingStream<Data, Error>,
        sampleRate: Double) async -> StreamingPlaybackResult
    {
        do {
            for try await _ in stream {}
        } catch {}
        return StreamingPlaybackResult(finished: true, interruptedAt: nil)
    }

    func stop() -> Double? {
        nil
    }
}

private struct RealtimeStopRequest: Sendable {
    let method: String
    let params: [String: AnyCodable]?
}

private actor RealtimeStopRequestLog {
    private var requests: [RealtimeStopRequest] = []

    func record(method: String, params: [String: AnyCodable]?) {
        self.requests.append(RealtimeStopRequest(method: method, params: params))
    }

    func snapshot() -> [RealtimeStopRequest] {
        self.requests
    }

    func clear() {
        self.requests.removeAll()
    }
}

@MainActor
private final class RealtimeStopSpeakingProbe {
    private(set) var isSpeaking = false

    func update(_ isSpeaking: Bool) {
        self.isSpeaking = isSpeaking
    }
}

private func realtimeStopEvent(type: String, includeOutputIdentity: Bool = false) -> EventFrame {
    var payload: [String: Any] = [
        "relaySessionId": "relay-1",
        "type": type,
    ]
    if type == "audio" {
        payload["audioBase64"] = Data([0x01]).base64EncodedString()
    }
    if includeOutputIdentity {
        payload["outputGeneration"] = 7
        payload["talkEvent"] = ["turnId": "turn-7"]
    }
    return EventFrame(
        type: "event",
        event: "talk.event",
        payload: AnyCodable(payload),
        seq: nil,
        stateversion: nil)
}

private struct RealtimeStopFixture {
    let session: RealtimeTalkRelaySession
    let events: AsyncStream<EventFrame>.Continuation
    let speaking: RealtimeStopSpeakingProbe
}

@MainActor
private func makeRealtimeStopSession(
    requests: RealtimeStopRequestLog) throws -> RealtimeStopFixture
{
    let (events, eventContinuation) = AsyncStream<EventFrame>.makeStream()
    let result = TalkSessionCreateResult(
        sessionid: "talk-session",
        mode: AnyCodable("realtime"),
        transport: AnyCodable("gateway-relay"),
        brain: AnyCodable("agent-consult"),
        relaysessionid: "relay-1")
    let resultData = try JSONEncoder().encode(result)
    let speaking = RealtimeStopSpeakingProbe()
    let session = RealtimeTalkRelaySession(
        transport: RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in events },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return method == "talk.session.create"
                    ? resultData
                    : Data("{\"ok\":true}".utf8)
            },
            supportsOutputGeneration: { true }),
        options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
        audioCapture: RealtimeStopAudioCapture(),
        pcmPlayer: RealtimeStopPCMPlayer(),
        onStatus: { _ in },
        onSpeakingChanged: { speaking.update($0) })
    return RealtimeStopFixture(
        session: session,
        events: eventContinuation,
        speaking: speaking)
}

@MainActor
private func startRealtimeStopSession(
    _ fixture: RealtimeStopFixture,
    requests: RealtimeStopRequestLog) async throws
{
    let start = Task { @MainActor in
        try await fixture.session.start()
    }
    fixture.events.yield(realtimeStopEvent(type: "ready"))
    try await start.value
    await requests.clear()
}

@MainActor
@Suite(.serialized)
struct TalkModeRuntimeRealtimeStopTests {
    @Test func `idle realtime stop updates local phase without provider cancellation`() async throws {
        let requests = RealtimeStopRequestLog()
        let fixture = try makeRealtimeStopSession(requests: requests)
        try await startRealtimeStopSession(fixture, requests: requests)
        let runtime = TalkModeRuntime()
        await runtime._test_prepareRealtimeStop(session: fixture.session, phase: .speaking)

        await runtime.stopSpeaking(reason: .userTap)
        for _ in 0..<10 {
            await Task.yield()
        }

        #expect(await requests.snapshot().isEmpty)
        #expect(await runtime._test_realtimeStopPhase() == .listening)
        fixture.session.stop()
        fixture.events.finish()
    }

    @Test func `active realtime stop cancels provider output and becomes listening`() async throws {
        let requests = RealtimeStopRequestLog()
        let fixture = try makeRealtimeStopSession(requests: requests)
        try await startRealtimeStopSession(fixture, requests: requests)
        fixture.events.yield(realtimeStopEvent(type: "audio", includeOutputIdentity: true))
        for _ in 0..<10 {
            if fixture.speaking.isSpeaking { break }
            await Task.yield()
        }
        #expect(fixture.speaking.isSpeaking)
        let runtime = TalkModeRuntime()
        await runtime._test_prepareRealtimeStop(session: fixture.session, phase: .speaking)

        await runtime.stopSpeaking(reason: .userTap)
        for _ in 0..<10 {
            let recorded = await requests.snapshot()
            if !recorded.isEmpty { break }
            await Task.yield()
        }

        let request = try #require(await requests.snapshot().first)
        #expect(request.method == "talk.session.cancelOutput")
        #expect(request.params?["reason"]?.stringValue == "user")
        #expect(await runtime._test_realtimeStopPhase() == .listening)
        fixture.session.stop()
        fixture.events.finish()
    }
}
