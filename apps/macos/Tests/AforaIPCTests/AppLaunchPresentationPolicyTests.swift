import AppKit
import CryptoKit
import Testing
@testable import Afora

struct AppLaunchRuntimePlanTests {
    @Test func `elevation rename is exclusive and source preserving on conflict`() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("afora-elevation-rename-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        let source = root.appendingPathComponent("source", isDirectory: true)
        let destination = root.appendingPathComponent("destination", isDirectory: true)
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: false)
        var applicationConstructed = false
        let moved = try #require(AforaProcessEntrypoint.run(
            arguments: ["Afora", ElevationExclusiveRename.argument, source.path, destination.path],
            launchApplication: { applicationConstructed = true }))
        #expect(moved == 0)
        #expect(!applicationConstructed)
        #expect(!FileManager.default.fileExists(atPath: source.path))
        #expect(FileManager.default.fileExists(atPath: destination.path))

        let conflictingSource = root.appendingPathComponent("conflicting-source", isDirectory: true)
        try FileManager.default.createDirectory(at: conflictingSource, withIntermediateDirectories: false)
        let rejected = try #require(AforaProcessEntrypoint.run(
            arguments: ["Afora", ElevationExclusiveRename.argument, conflictingSource.path, destination.path],
            launchApplication: { applicationConstructed = true }))
        #expect(rejected != 0)
        #expect(!applicationConstructed)
        #expect(FileManager.default.fileExists(atPath: conflictingSource.path))
        #expect(FileManager.default.fileExists(atPath: destination.path))
    }

    @Test func `elevation filesystem sync is native and rejects symlinks`() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("afora-elevation-sync-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let receipt = root.appendingPathComponent("receipt.json")
        try Data("{}\n".utf8).write(to: receipt)
        var applicationConstructed = false
        let fileStatus = try #require(AforaProcessEntrypoint.run(
            arguments: ["Afora", ElevationFilesystemSync.fileArgument, receipt.path],
            launchApplication: { applicationConstructed = true }))
        #expect(fileStatus == 0)
        let directoryStatus = try #require(AforaProcessEntrypoint.run(
            arguments: ["Afora", ElevationFilesystemSync.directoryArgument, root.path],
            launchApplication: { applicationConstructed = true }))
        #expect(directoryStatus == 0)
        let nested = root.appendingPathComponent("nested", isDirectory: true)
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: false)
        try Data("payload\n".utf8).write(to: nested.appendingPathComponent("payload.txt"))
        let treeStatus = try #require(AforaProcessEntrypoint.run(
            arguments: ["Afora", ElevationFilesystemSync.treeArgument, root.path],
            launchApplication: { applicationConstructed = true }))
        #expect(treeStatus == 0)
        let unreadable = root.appendingPathComponent("unreadable", isDirectory: true)
        try FileManager.default.createDirectory(at: unreadable, withIntermediateDirectories: false)
        try Data("hidden\n".utf8).write(to: unreadable.appendingPathComponent("hidden.txt"))
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: unreadable.path)
        let incompleteTreeStatus = try #require(AforaProcessEntrypoint.run(
            arguments: ["Afora", ElevationFilesystemSync.treeArgument, root.path],
            launchApplication: { applicationConstructed = true }))
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: unreadable.path)
        #expect(incompleteTreeStatus != 0)
        let symlink = root.appendingPathComponent("receipt-link.json")
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: receipt)
        let symlinkStatus = try #require(AforaProcessEntrypoint.run(
            arguments: ["Afora", ElevationFilesystemSync.fileArgument, symlink.path],
            launchApplication: { applicationConstructed = true }))
        #expect(symlinkStatus != 0)
        #expect(!applicationConstructed)
    }

    @Test func `normal launches allow automatic presentation`() {
        let policy = AppLaunchRuntimePlan(arguments: ["Afora"])

        #expect(policy.mode == .interactive)
        #expect(!policy.attachOnly)
        #expect(policy.allowsAutomaticPresentation)
        #expect(policy.allowsGatewayUIKeychainAccess)
        #expect(policy.allowsUpdater)
        #expect(policy.allowsDockIcon)
        #expect(policy.allowsInteractiveServices)
        #expect(policy.shouldAutoOpenChat(arguments: ["Afora", "--chat"]))
        #expect(policy.shouldAutoOpenDashboard(arguments: ["Afora", "--dashboard"]))
    }

    @Test func `background-only wins over automatic presentation flags`() {
        let arguments = ["Afora", "--attach-only", "--background-only", "--chat", "--dashboard"]
        let policy = AppLaunchRuntimePlan(arguments: arguments)

        #expect(policy.mode == .background)
        #expect(policy.attachOnly)
        #expect(!policy.allowsAutomaticPresentation)
        #expect(!policy.allowsGatewayUIKeychainAccess)
        #expect(policy.allowsUpdater)
        #expect(policy.allowsDockIcon)
        #expect(policy.allowsInteractiveServices)
        #expect(!policy.shouldAutoOpenChat(arguments: arguments))
        #expect(!policy.shouldAutoOpenDashboard(arguments: arguments))
    }

    @Test func `elevation host owns the complete unattended startup plan`() {
        let arguments = ["Afora", "--elevation-host", "--chat", "--dashboard"]
        let policy = AppLaunchRuntimePlan(arguments: arguments)

        #expect(policy.mode == .elevationHost)
        #expect(policy.attachOnly)
        #expect(policy.isElevationHost)
        #expect(!policy.allowsAutomaticPresentation)
        #expect(!policy.allowsGatewayUIKeychainAccess)
        #expect(!policy.allowsUpdater)
        #expect(!policy.allowsDockIcon)
        #expect(!policy.allowsInteractiveServices)
        #expect(!policy.shouldAutoOpenChat(arguments: arguments))
        #expect(!policy.shouldAutoOpenDashboard(arguments: arguments))
        #expect(DockIconManager.activationPolicy(
            launchPlan: policy,
            userWantsDockHidden: false,
            hasVisibleWindows: true) == .accessory)
    }

    @Test func `attach-only does not change presentation behavior`() {
        let arguments = ["Afora", "--attach-only", "--dashboard"]
        let policy = AppLaunchRuntimePlan(arguments: arguments)

        #expect(policy.mode == .interactive)
        #expect(policy.attachOnly)
        #expect(policy.allowsAutomaticPresentation)
        #expect(policy.allowsGatewayUIKeychainAccess)
        #expect(policy.shouldAutoOpenDashboard(arguments: arguments))
    }

    @Test func `background launch never calls the prompt bearing activation key loader`() {
        var loadCount = 0
        let key = GatewayConnection.activationBindingKey(
            launchPolicy: AppLaunchRuntimePlan(arguments: ["Afora", "--background-only"]),
            loadOrCreate: {
                loadCount += 1
                return SymmetricKey(size: .bits256)
            })

        #expect(key == nil)
        #expect(loadCount == 0)
    }

    @Test func `interactive launch retains the activation binding key`() {
        var loadCount = 0
        let key = GatewayConnection.activationBindingKey(
            launchPolicy: AppLaunchRuntimePlan(arguments: ["Afora"]),
            loadOrCreate: {
                loadCount += 1
                return SymmetricKey(size: .bits256)
            })

        #expect(key != nil)
        #expect(loadCount == 1)
    }
}
