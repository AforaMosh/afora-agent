import Foundation

public struct AforaCanvasNavigateParams: Codable, Sendable, Equatable {
    public var url: String

    public init(url: String) {
        self.url = url
    }
}

public struct AforaCanvasPlacement: Codable, Sendable, Equatable {
    public var x: Double?
    public var y: Double?
    public var width: Double?
    public var height: Double?
}

public struct AforaCanvasPresentParams: Codable, Sendable, Equatable {
    public var url: String?
    public var placement: AforaCanvasPlacement?

    public init(url: String? = nil, placement: AforaCanvasPlacement? = nil) {
        self.url = url
        self.placement = placement
    }
}

public struct AforaCanvasEvalParams: Codable, Sendable, Equatable {
    public var javaScript: String

    public init(javaScript: String) {
        self.javaScript = javaScript
    }
}

public enum AforaCanvasSnapshotFormat: String, Codable, Sendable {
    case png
    case jpeg

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        let raw = try c.decode(String.self).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch raw {
        case "png":
            self = .png
        case "jpeg", "jpg":
            self = .jpeg
        default:
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Invalid snapshot format: \(raw)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(self.rawValue)
    }
}

public struct AforaCanvasSnapshotParams: Codable, Sendable, Equatable {
    public var maxWidth: Int?
    public var quality: Double?
    public var format: AforaCanvasSnapshotFormat?
}
