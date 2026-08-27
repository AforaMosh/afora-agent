import Foundation

public enum AforaCameraCommand: String, Codable, Sendable {
    case list = "camera.list"
    case snap = "camera.snap"
    case clip = "camera.clip"
    case ptzStatus = "camera.ptz.status"
    case ptzControl = "camera.ptz.control"
}

public enum AforaCameraPTZOperation: String, Codable, Sendable {
    case set
    case move
    case home
}

public struct AforaCameraPTZAxisValues: Codable, Sendable, Equatable {
    public var panDegrees: Double?
    public var tiltDegrees: Double?
    public var zoomPercent: Double?

    public init(
        panDegrees: Double? = nil,
        tiltDegrees: Double? = nil,
        zoomPercent: Double? = nil)
    {
        self.panDegrees = panDegrees
        self.tiltDegrees = tiltDegrees
        self.zoomPercent = zoomPercent
    }
}

public struct AforaCameraPTZStatusParams: Codable, Sendable, Equatable {
    public var deviceId: String

    public init(deviceId: String) {
        self.deviceId = deviceId
    }
}

public struct AforaCameraPTZControlParams: Codable, Sendable, Equatable {
    public var deviceId: String
    public var operation: AforaCameraPTZOperation
    public var target: AforaCameraPTZAxisValues?
    public var delta: AforaCameraPTZAxisValues?

    public init(
        deviceId: String,
        operation: AforaCameraPTZOperation,
        target: AforaCameraPTZAxisValues? = nil,
        delta: AforaCameraPTZAxisValues? = nil)
    {
        self.deviceId = deviceId
        self.operation = operation
        self.target = target
        self.delta = delta
    }
}

public enum AforaCameraFacing: String, Codable, Sendable {
    case back
    case front
}

public enum AforaCameraImageFormat: String, Codable, Sendable {
    case jpg
    case jpeg
}

public enum AforaCameraVideoFormat: String, Codable, Sendable {
    case mp4
}

public struct AforaCameraSnapParams: Codable, Sendable, Equatable {
    public var facing: AforaCameraFacing?
    public var maxWidth: Int?
    public var quality: Double?
    public var format: AforaCameraImageFormat?
    public var deviceId: String?
    public var delayMs: Int?

    public init(
        facing: AforaCameraFacing? = nil,
        maxWidth: Int? = nil,
        quality: Double? = nil,
        format: AforaCameraImageFormat? = nil,
        deviceId: String? = nil,
        delayMs: Int? = nil)
    {
        self.facing = facing
        self.maxWidth = maxWidth
        self.quality = quality
        self.format = format
        self.deviceId = deviceId
        self.delayMs = delayMs
    }
}

public struct AforaCameraClipParams: Codable, Sendable, Equatable {
    public var facing: AforaCameraFacing?
    public var durationMs: Int?
    public var includeAudio: Bool?
    public var format: AforaCameraVideoFormat?
    public var deviceId: String?

    public init(
        facing: AforaCameraFacing? = nil,
        durationMs: Int? = nil,
        includeAudio: Bool? = nil,
        format: AforaCameraVideoFormat? = nil,
        deviceId: String? = nil)
    {
        self.facing = facing
        self.durationMs = durationMs
        self.includeAudio = includeAudio
        self.format = format
        self.deviceId = deviceId
    }
}
