import Foundation

public enum AforaDeviceCommand: String, Codable, Sendable {
    case status = "device.status"
    case info = "device.info"
}

public enum AforaBatteryState: String, Codable, Sendable {
    case unknown
    case unplugged
    case charging
    case full
}

public enum AforaThermalState: String, Codable, Sendable {
    case nominal
    case fair
    case serious
    case critical
}

public enum AforaNetworkPathStatus: String, Codable, Sendable {
    case satisfied
    case unsatisfied
    case requiresConnection
}

public enum AforaNetworkInterfaceType: String, Codable, Sendable {
    case wifi
    case cellular
    case wired
    case other
}

public struct AforaBatteryStatusPayload: Codable, Sendable, Equatable {
    public var level: Double?
    public var state: AforaBatteryState
    public var lowPowerModeEnabled: Bool

    public init(level: Double?, state: AforaBatteryState, lowPowerModeEnabled: Bool) {
        self.level = level
        self.state = state
        self.lowPowerModeEnabled = lowPowerModeEnabled
    }
}

public struct AforaThermalStatusPayload: Codable, Sendable, Equatable {
    public var state: AforaThermalState

    public init(state: AforaThermalState) {
        self.state = state
    }
}

public struct AforaStorageStatusPayload: Codable, Sendable, Equatable {
    public var totalBytes: Int64
    public var freeBytes: Int64
    public var usedBytes: Int64

    public init(totalBytes: Int64, freeBytes: Int64, usedBytes: Int64) {
        self.totalBytes = totalBytes
        self.freeBytes = freeBytes
        self.usedBytes = usedBytes
    }
}

public struct AforaNetworkStatusPayload: Codable, Sendable, Equatable {
    public var status: AforaNetworkPathStatus
    public var isExpensive: Bool
    public var isConstrained: Bool
    public var interfaces: [AforaNetworkInterfaceType]

    public init(
        status: AforaNetworkPathStatus,
        isExpensive: Bool,
        isConstrained: Bool,
        interfaces: [AforaNetworkInterfaceType])
    {
        self.status = status
        self.isExpensive = isExpensive
        self.isConstrained = isConstrained
        self.interfaces = interfaces
    }
}

public struct AforaDeviceStatusPayload: Codable, Sendable, Equatable {
    public var battery: AforaBatteryStatusPayload
    public var thermal: AforaThermalStatusPayload
    public var storage: AforaStorageStatusPayload
    public var network: AforaNetworkStatusPayload
    public var uptimeSeconds: Double

    public init(
        battery: AforaBatteryStatusPayload,
        thermal: AforaThermalStatusPayload,
        storage: AforaStorageStatusPayload,
        network: AforaNetworkStatusPayload,
        uptimeSeconds: Double)
    {
        self.battery = battery
        self.thermal = thermal
        self.storage = storage
        self.network = network
        self.uptimeSeconds = uptimeSeconds
    }
}

public struct AforaDeviceInfoPayload: Codable, Sendable, Equatable {
    public var deviceName: String
    public var modelIdentifier: String
    public var systemName: String
    public var systemVersion: String
    public var appVersion: String
    public var appBuild: String
    public var locale: String

    public init(
        deviceName: String,
        modelIdentifier: String,
        systemName: String,
        systemVersion: String,
        appVersion: String,
        appBuild: String,
        locale: String)
    {
        self.deviceName = deviceName
        self.modelIdentifier = modelIdentifier
        self.systemName = systemName
        self.systemVersion = systemVersion
        self.appVersion = appVersion
        self.appBuild = appBuild
        self.locale = locale
    }
}
