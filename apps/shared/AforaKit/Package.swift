// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "AforaKit",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
        .watchOS(.v11),
    ],
    products: [
        .library(name: "AforaProtocol", targets: ["AforaProtocol"]),
        .library(name: "AforaNativeState", targets: ["AforaNativeState"]),
        .library(name: "AforaKit", targets: ["AforaKit"]),
        .library(name: "AforaChatUI", targets: ["AforaChatUI"]),
    ],
    traits: [
        .trait(name: "Talk", description: "ElevenLabs cloud TTS / talk support"),
        .default(enabledTraits: ["Talk"]),
    ],
    dependencies: [
        .package(url: "https://github.com/steipete/ElevenLabsKit", exact: "0.1.1"),
        .package(url: "https://github.com/groue/GRDB.swift.git", exact: "7.11.1"),
        .package(url: "https://github.com/mgriebling/SwiftMath", exact: "1.7.3"),
        .package(url: "https://github.com/swiftlang/swift-markdown", exact: "0.8.0"),
    ],
    targets: [
        .target(
            name: "AforaProtocol",
            path: "Sources/AforaProtocol",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "AforaNativeState",
            path: "Sources/AforaNativeState",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "AforaKit",
            dependencies: [
                "AforaNativeState",
                "AforaProtocol",
                .product(
                    name: "ElevenLabsKit",
                    package: "ElevenLabsKit",
                    condition: .when(platforms: [.iOS, .macOS], traits: ["Talk"])),
            ],
            path: "Sources/AforaKit",
            resources: [
                .process("Resources"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "AforaChatUI",
            dependencies: [
                "AforaKit",
                "AforaProtocol",
                .product(name: "GRDB", package: "GRDB.swift"),
                .product(name: "Markdown", package: "swift-markdown"),
                .product(name: "SwiftMath", package: "SwiftMath"),
            ],
            path: "Sources/AforaChatUI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "AforaKitTests",
            dependencies: [
                "AforaKit",
                "AforaChatUI",
                "AforaProtocol",
                .product(name: "GRDB", package: "GRDB.swift"),
            ],
            path: "Tests/AforaKitTests",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
        .testTarget(
            name: "AforaNativeStateTests",
            dependencies: ["AforaNativeState"],
            path: "Tests/AforaNativeStateTests",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
