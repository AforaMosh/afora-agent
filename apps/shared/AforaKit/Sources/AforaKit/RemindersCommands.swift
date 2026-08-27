import Foundation

public enum AforaRemindersCommand: String, Codable, Sendable {
    case list = "reminders.list"
    case add = "reminders.add"
}

public enum AforaReminderStatusFilter: String, Codable, Sendable {
    case incomplete
    case completed
    case all
}

public struct AforaRemindersListParams: Codable, Sendable, Equatable {
    public var status: AforaReminderStatusFilter?
    public var limit: Int?

    public init(status: AforaReminderStatusFilter? = nil, limit: Int? = nil) {
        self.status = status
        self.limit = limit
    }
}

public struct AforaRemindersAddParams: Codable, Sendable, Equatable {
    public var title: String
    public var dueISO: String?
    public var notes: String?
    public var listId: String?
    public var listName: String?

    public init(
        title: String,
        dueISO: String? = nil,
        notes: String? = nil,
        listId: String? = nil,
        listName: String? = nil)
    {
        self.title = title
        self.dueISO = dueISO
        self.notes = notes
        self.listId = listId
        self.listName = listName
    }
}

public struct AforaReminderPayload: Codable, Sendable, Equatable {
    public var identifier: String
    public var title: String
    public var dueISO: String?
    public var completed: Bool
    public var listName: String?

    public init(
        identifier: String,
        title: String,
        dueISO: String? = nil,
        completed: Bool,
        listName: String? = nil)
    {
        self.identifier = identifier
        self.title = title
        self.dueISO = dueISO
        self.completed = completed
        self.listName = listName
    }
}

public struct AforaRemindersListPayload: Codable, Sendable, Equatable {
    public var reminders: [AforaReminderPayload]

    public init(reminders: [AforaReminderPayload]) {
        self.reminders = reminders
    }
}

public struct AforaRemindersAddPayload: Codable, Sendable, Equatable {
    public var reminder: AforaReminderPayload

    public init(reminder: AforaReminderPayload) {
        self.reminder = reminder
    }
}
