import Foundation

public enum AforaSystemCommand: String, Codable, Sendable {
    case run = "system.run"
    case which = "system.which"
    case notify = "system.notify"
    case execApprovalsGet = "system.execApprovals.get"
    case execApprovalsSet = "system.execApprovals.set"
}

public enum AforaFileSystemCommand: String, Codable, Sendable {
    case listDir = "fs.listDir"
}

public enum AforaNotificationPriority: String, Codable, Sendable {
    case passive
    case active
    case timeSensitive
}

public enum AforaNotificationDelivery: String, Codable, Sendable {
    case system
    case overlay
    case auto
}

public struct AforaSystemNotifyParams: Codable, Sendable, Equatable {
    public var title: String
    public var body: String
    public var sound: String?
    public var priority: AforaNotificationPriority?
    public var delivery: AforaNotificationDelivery?

    public init(
        title: String,
        body: String,
        sound: String? = nil,
        priority: AforaNotificationPriority? = nil,
        delivery: AforaNotificationDelivery? = nil)
    {
        self.title = title
        self.body = body
        self.sound = sound
        self.priority = priority
        self.delivery = delivery
    }
}
