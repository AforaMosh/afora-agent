// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "AforaMLXTTSProtocol",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "AforaMLXTTSProtocol", targets: ["AforaMLXTTSProtocol"]),
    ],
    targets: [
        .target(name: "AforaMLXTTSProtocol"),
        .testTarget(
            name: "AforaMLXTTSProtocolTests",
            dependencies: ["AforaMLXTTSProtocol"]),
    ])
