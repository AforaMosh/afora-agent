import Foundation

public enum AforaCalendarCommand: String, Codable, Sendable {
    case events = "calendar.events"
    case add = "calendar.add"
}

public typealias AforaCalendarEventsParams = AforaDateRangeLimitParams

public struct AforaCalendarAddParams: Codable, Sendable, Equatable {
    public var title: String
    public var startISO: String
    public var endISO: String
    public var isAllDay: Bool?
    public var location: String?
    public var notes: String?
    public var calendarId: String?
    public var calendarTitle: String?

    public init(
        title: String,
        startISO: String,
        endISO: String,
        isAllDay: Bool? = nil,
        location: String? = nil,
        notes: String? = nil,
        calendarId: String? = nil,
        calendarTitle: String? = nil)
    {
        self.title = title
        self.startISO = startISO
        self.endISO = endISO
        self.isAllDay = isAllDay
        self.location = location
        self.notes = notes
        self.calendarId = calendarId
        self.calendarTitle = calendarTitle
    }
}

public struct AforaCalendarEventPayload: Codable, Sendable, Equatable {
    public var identifier: String
    public var title: String
    public var startISO: String
    public var endISO: String
    public var isAllDay: Bool
    public var location: String?
    public var calendarTitle: String?

    public init(
        identifier: String,
        title: String,
        startISO: String,
        endISO: String,
        isAllDay: Bool,
        location: String? = nil,
        calendarTitle: String? = nil)
    {
        self.identifier = identifier
        self.title = title
        self.startISO = startISO
        self.endISO = endISO
        self.isAllDay = isAllDay
        self.location = location
        self.calendarTitle = calendarTitle
    }
}

public struct AforaCalendarEventsPayload: Codable, Sendable, Equatable {
    public var events: [AforaCalendarEventPayload]

    public init(events: [AforaCalendarEventPayload]) {
        self.events = events
    }
}

public struct AforaCalendarAddPayload: Codable, Sendable, Equatable {
    public var event: AforaCalendarEventPayload

    public init(event: AforaCalendarEventPayload) {
        self.event = event
    }
}
