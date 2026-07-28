import Foundation

/// Bounds replacement handoff retries because each attempt launches the full app and validates the entire bundle.
/// An unbounded loop adds load that prolongs startup; terminal give-up keeps the old app running instead.
struct ReplacementHandoffRetryPolicy: Equatable, Sendable {
    enum Decision: Equatable, Sendable {
        case retry(after: Duration)
        case giveUp
    }

    static let maximumAttempts = 5
    static let initialRetryDelay: Duration = .seconds(2)
    static let maximumRetryDelay: Duration = .seconds(30)
    static let backoffMultiplier = 2

    // Give-up is keyed on the replacement's code-directory hash, not on a bare
    // counter: abandoning one broken build must never lock the app out of a later
    // fixed one, which arrives as a different hash and so earns a fresh budget.
    private var replacement: Data?
    private var failureCount = 0

    func allowsAttempt(for replacement: Data) -> Bool {
        self.replacement != replacement || self.failureCount < Self.maximumAttempts
    }

    mutating func recordFailure(for replacement: Data) -> Decision {
        if self.replacement != replacement {
            self.replacement = replacement
            self.failureCount = 0
        }
        guard self.failureCount < Self.maximumAttempts else { return .giveUp }

        self.failureCount += 1
        guard self.failureCount < Self.maximumAttempts else { return .giveUp }

        var delaySeconds = Int(Self.initialRetryDelay.components.seconds)
        for _ in 1..<self.failureCount {
            delaySeconds = min(
                delaySeconds * Self.backoffMultiplier,
                Int(Self.maximumRetryDelay.components.seconds))
        }
        return .retry(after: .seconds(delaySeconds))
    }
}
