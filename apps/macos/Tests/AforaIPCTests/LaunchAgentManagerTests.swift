import Foundation
import Testing
@testable import Afora

struct LaunchAgentManagerTests {
    @Test func `active profile performs no login agent reads or writes`() async {
        let profile = AppProfile(environment: ["AFORA_PROFILE": "work"])
        var writes: [String] = []
        LaunchAgentManager._testResetLaunchctlCalls()

        #expect(await !(LaunchAgentManager.status(profile: profile)))
        #expect(await !(LaunchAgentManager.set(
            enabled: true,
            bundlePath: "/Applications/Afora.app",
            profile: profile,
            writePlist: { writes.append($0) })))
        #expect(await !(LaunchAgentManager.set(
            enabled: false,
            bundlePath: "/Applications/Afora.app",
            profile: profile,
            writePlist: { writes.append($0) })))
        #expect(writes.isEmpty)
        #expect(LaunchAgentManager._testLaunchctlCallSnapshot().isEmpty)
    }

    @Test func `enabling an already loaded login job only refreshes its plist`() async {
        var persistedBundlePaths: [String] = []
        let reloaded = await LaunchAgentManager.set(
            enabled: true,
            bundlePath: "/Applications/Afora.app",
            loaded: true,
            writePlist: { persistedBundlePaths.append($0) })

        #expect(reloaded == false)
        #expect(persistedBundlePaths == ["/Applications/Afora.app"])
    }

    @Test func `launch at login plist does not keep app alive after manual quit`() throws {
        let plist = LaunchAgentManager.plistContents(bundlePath: "/Applications/Afora.app")
        let data = try #require(plist.data(using: .utf8))
        let object = try #require(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])

        #expect(object["RunAtLoad"] as? Bool == true)
        #expect(object["KeepAlive"] == nil)

        let args = try #require(object["ProgramArguments"] as? [String])
        #expect(args == ["/Applications/Afora.app/Contents/MacOS/Afora"])
    }

    @MainActor
    @Test func `launch at login plist preserves normalized profile environment once`() async throws {
        try await TestIsolation.withEnvValues([
            "AFORA_CONFIG_PATH": "  /tmp/custom&<afora>\"'.json  ",
            "AFORA_STATE_DIR": "/tmp/afora-state",
        ]) {
            let plist = LaunchAgentManager.plistContents(
                bundlePath: "/Applications/Afora.app",
                preferredPaths: ["/tmp/custom&<bin>", "/usr/bin"])
            let data = try #require(plist.data(using: .utf8))
            let object = try #require(
                PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])

            let environment = try #require(object["EnvironmentVariables"] as? [String: String])
            #expect(environment["AFORA_CONFIG_PATH"] == "/tmp/custom&<afora>\"'.json")
            #expect(environment["AFORA_STATE_DIR"] == "/tmp/afora-state")
            #expect(environment["PATH"]?.contains("/tmp/custom&<bin>") == true)
            #expect(plist.components(separatedBy: "<key>AFORA_CONFIG_PATH</key>").count == 2)
            #expect(plist.components(separatedBy: "<key>AFORA_STATE_DIR</key>").count == 2)
        }
    }

    @MainActor
    @Test func `launch at login plist omits unset and blank profile environment`() async throws {
        try await TestIsolation.withEnvValues([
            "AFORA_CONFIG_PATH": nil,
            "AFORA_STATE_DIR": " \n ",
        ]) {
            let plist = LaunchAgentManager.plistContents(bundlePath: "/Applications/Afora.app")
            let data = try #require(plist.data(using: .utf8))
            let object = try #require(
                PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])

            let environment = try #require(object["EnvironmentVariables"] as? [String: String])
            #expect(environment.keys.sorted() == ["PATH"])
            #expect(!plist.contains("AFORA_CONFIG_PATH"))
            #expect(!plist.contains("AFORA_STATE_DIR"))
        }
    }
}
