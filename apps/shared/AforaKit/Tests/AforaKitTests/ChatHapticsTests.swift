import Foundation
import AforaKit
import Testing
@testable import AforaChatUI

private final class HapticRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recordedEvents: [AforaChatHaptics.Event] = []

    var events: [AforaChatHaptics.Event] {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.recordedEvents
    }

    func record(_ event: AforaChatHaptics.Event) {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.recordedEvents.append(event)
    }
}

private final class HapticsTestTransport: @unchecked Sendable, AforaChatTransport {
    private let response: AforaChatSendResponse
    // History rows are built per fetch so fixtures can stamp timestamps at
    // request time; every fetch in the send flow happens after the optimistic
    // user echo exists, which keeps fixture rows ordered after the user turn
    // regardless of how long the test was starved before sending.
    private let historyMessages: @Sendable () -> [AnyCodable]
    private let stream: AsyncStream<AforaChatTransportEvent>
    private let continuation: AsyncStream<AforaChatTransportEvent>.Continuation

    init(status: String, historyMessages: @escaping @Sendable () -> [AnyCodable] = { [] }) {
        self.response = AforaChatSendResponse(runId: "run-1", status: status)
        self.historyMessages = historyMessages
        var continuation: AsyncStream<AforaChatTransportEvent>.Continuation!
        self.stream = AsyncStream { continuation = $0 }
        self.continuation = continuation
    }

    func requestHistory(sessionKey: String) async throws -> AforaChatHistoryPayload {
        AforaChatHistoryPayload(
            sessionKey: sessionKey,
            sessionId: "session-1",
            messages: self.historyMessages(),
            thinkingLevel: "off")
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey _: String,
        attachments _: [AforaChatAttachmentPayload]) async throws -> AforaChatSendResponse
    {
        self.response
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<AforaChatTransportEvent> {
        self.stream
    }

    func emit(_ event: AforaChatTransportEvent) {
        self.continuation.yield(event)
    }
}

private func makeHapticsViewModel(
    status: String,
    historyMessages: @escaping @Sendable () -> [AnyCodable] = { [] }) async -> (
    HapticsTestTransport,
    AforaChatViewModel,
    HapticRecorder)
{
    let transport = HapticsTestTransport(status: status, historyMessages: historyMessages)
    let recorder = HapticRecorder()
    let haptics = AforaChatHaptics(performer: recorder.record)
    let viewModel = await MainActor.run {
        AforaChatViewModel(sessionKey: "main", transport: transport, haptics: haptics)
    }
    return (transport, viewModel, recorder)
}

private func sendHapticsTestMessage(_ viewModel: AforaChatViewModel) async {
    await MainActor.run {
        viewModel.input = "hello"
        viewModel.send()
    }
}

struct ChatHapticsTests {
    @Test func `send acceptance fires message sent exactly once`() async throws {
        let (_, viewModel, recorder) = await makeHapticsViewModel(status: "started")
        await sendHapticsTestMessage(viewModel)
        try await waitUntil("message sent haptic") { recorder.events == [.messageSent] }
        try await Task.sleep(for: .milliseconds(20))
        #expect(recorder.events == [.messageSent])
    }

    @Test func `completion fires once for duplicate terminal events`() async throws {
        let (transport, viewModel, recorder) = await makeHapticsViewModel(status: "started")
        await sendHapticsTestMessage(viewModel)
        try await waitUntil("message accepted") { recorder.events == [.messageSent] }

        let final = AforaChatTransportEvent.chat(AforaChatEventPayload(
            runId: "run-1",
            sessionKey: "main",
            state: "final",
            message: nil,
            errorMessage: nil))
        transport.emit(final)
        transport.emit(final)
        try await waitUntil("completion haptic") {
            recorder.events == [.messageSent, .runCompleted]
        }
        try await Task.sleep(for: .milliseconds(20))
        #expect(recorder.events == [.messageSent, .runCompleted])
    }

    @Test(arguments: ["error", "aborted"])
    func `durable assistant failure fires run failed`(stopReason: String) async throws {
        // The run-failed drain only fires for assistant rows timestamped at or
        // after the optimistic user echo. Stamp the durable failure when history
        // is fetched (always post-send) instead of at test start, where a >1s
        // scheduling stall before send() left the row permanently "older" than
        // the user turn and the wait timed out on loaded CI runners.
        let (_, viewModel, recorder) = await makeHapticsViewModel(status: "started") {
            [AnyCodable([
                "role": "assistant",
                "content": [],
                "timestamp": Date().timeIntervalSince1970 * 1000,
                "stopReason": stopReason,
                "errorMessage": "provider failed",
            ] as [String: Any])]
        }
        await sendHapticsTestMessage(viewModel)
        try await waitUntil("run failed haptic") {
            recorder.events == [.messageSent, .runFailed]
        }
        #expect(recorder.events == [.messageSent, .runFailed])
    }
}
