import Foundation

public enum AforaCanvasA2UICommand: String, Codable, Sendable {
    /// Render A2UI content on the device canvas.
    case push = "canvas.a2ui.push"
    /// Legacy alias for `push` when sending JSONL.
    case pushJSONL = "canvas.a2ui.pushJSONL"
    /// Reset the A2UI renderer state.
    case reset = "canvas.a2ui.reset"
}

public struct AforaCanvasA2UIPushParams: Codable, Sendable, Equatable {
    public var messages: [AnyCodable]
}

public struct AforaCanvasA2UIPushJSONLParams: Codable, Sendable, Equatable {
    public var jsonl: String

    public init(jsonl: String) {
        self.jsonl = jsonl
    }
}
