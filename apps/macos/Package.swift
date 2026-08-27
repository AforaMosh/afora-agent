// swift-tools-version: 6.2
// Package manifest for the Afora macOS companion (menu bar app + IPC library).

import PackageDescription

let package = Package(
    name: "Afora",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "AforaIPC", targets: ["AforaIPC"]),
        .library(name: "AforaDiscovery", targets: ["AforaDiscovery"]),
        .executable(name: "Afora", targets: ["Afora"]),
        .executable(name: "afora-mac", targets: ["AforaMacCLI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/sindresorhus/KeyboardShortcuts", exact: "3.0.1"),
        .package(url: "https://github.com/orchetect/MenuBarExtraAccess", exact: "1.3.0"),
        .package(url: "https://github.com/swiftlang/swift-subprocess.git", from: "0.4.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.12.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.9.0"),
        .package(
            url: "https://github.com/afora/Peekaboo.git",
            revision: "a48c462c757acbf320b22a6c9b34852e26bcb763"),
        .package(url: "https://github.com/pointfreeco/swift-concurrency-extras", from: "1.3.1"),
        .package(path: "../shared/AforaKit"),
        .package(path: "../shared/AforaMLXTTSProtocol"),
        .package(path: "../swabble"),
    ],
    targets: [
        .target(
            name: "AforaCameraPTZNative",
            path: "Sources/AforaCameraPTZNative",
            publicHeadersPath: "include",
            linkerSettings: [
                .linkedFramework("CoreFoundation"),
                .linkedFramework("IOKit"),
            ]),
        .target(
            name: "AforaIPC",
            dependencies: [],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "AforaDiscovery",
            dependencies: [
                .product(name: "AforaKit", package: "AforaKit"),
                .product(name: "Subprocess", package: "swift-subprocess"),
            ],
            path: "Sources/AforaDiscovery",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "Afora",
            dependencies: [
                "AforaIPC",
                "AforaDiscovery",
                "AforaCameraPTZNative",
                .product(name: "AforaNativeState", package: "AforaKit"),
                .product(name: "AforaKit", package: "AforaKit"),
                .product(name: "AforaChatUI", package: "AforaKit"),
                .product(name: "AforaMLXTTSProtocol", package: "AforaMLXTTSProtocol"),
                .product(name: "AforaProtocol", package: "AforaKit"),
                .product(name: "SwabbleKit", package: "swabble"),
                .product(name: "MenuBarExtraAccess", package: "MenuBarExtraAccess"),
                .product(name: "Subprocess", package: "swift-subprocess"),
                .product(name: "Logging", package: "swift-log"),
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "PeekabooBridge", package: "Peekaboo"),
                .product(name: "PeekabooAutomationKit", package: "Peekaboo"),
                .product(name: "ConcurrencyExtras", package: "swift-concurrency-extras"),
                .product(name: "KeyboardShortcuts", package: "KeyboardShortcuts"),
            ],
            exclude: [
                "Resources/Info.plist",
                "Resources/Localizable.xcstrings",
            ],
            resources: [
                .copy("Resources/Afora.icns"),
                .copy("Resources/DeviceModels"),
                .copy("Resources/ProviderIcons"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "AforaMacCLI",
            dependencies: [
                "AforaDiscovery",
                .product(name: "AforaKit", package: "AforaKit"),
                .product(name: "AforaProtocol", package: "AforaKit"),
            ],
            path: "Sources/AforaMacCLI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "AforaIPCTests",
            dependencies: [
                "AforaIPC",
                "Afora",
                "AforaMacCLI",
                "AforaDiscovery",
                .product(name: "AforaChatUI", package: "AforaKit"),
                .product(name: "AforaKit", package: "AforaKit"),
                .product(name: "AforaMLXTTSProtocol", package: "AforaMLXTTSProtocol"),
                .product(name: "AforaProtocol", package: "AforaKit"),
                .product(name: "SwabbleKit", package: "swabble"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
