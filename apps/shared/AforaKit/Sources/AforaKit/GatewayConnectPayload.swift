import Foundation
import AforaProtocol

enum GatewayConnectPayload {
    static func makeClient(
        options: GatewayConnectOptions,
        displayName: String,
        platform: String) -> [String: AforaProtocol.AnyCodable]
    {
        var client: [String: AforaProtocol.AnyCodable] = [
            "id": AforaProtocol.AnyCodable(options.clientId),
            "displayName": AforaProtocol.AnyCodable(displayName),
            "version": AforaProtocol.AnyCodable(
                Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"),
            "platform": AforaProtocol.AnyCodable(platform),
            "mode": AforaProtocol.AnyCodable(options.clientMode),
            "instanceId": AforaProtocol.AnyCodable(InstanceIdentity.instanceId),
            "deviceFamily": AforaProtocol.AnyCodable(InstanceIdentity.deviceFamily),
        ]
        if let model = InstanceIdentity.modelIdentifier {
            client["modelIdentifier"] = AforaProtocol.AnyCodable(model)
        }
        return client
    }
}
