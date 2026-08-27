import AforaKit
import SwiftUI
import UIKit

extension GatewayConnectionProblem.PresentationText {
    var localizedString: String {
        switch self {
        case let .localized(key):
            String(localized: String.LocalizationValue(key))
        case let .localizedFormat(format, arguments):
            String(
                format: String(localized: String.LocalizationValue(format)),
                locale: .current,
                arguments: arguments.map { $0 as CVarArg })
        case let .verbatim(value):
            value
        }
    }
}

extension GatewayConnectionProblem {
    var localizedTitle: String {
        self.titlePresentation.localizedString
    }

    var localizedMessage: String {
        self.messagePresentation.localizedString
    }

    var localizedActionLabel: String? {
        self.actionLabelPresentation?.localizedString
    }

    var localizedStatusText: String {
        switch self.kind {
        case .pairingRequired, .pairingRoleUpgradeRequired, .pairingScopeUpgradeRequired,
             .pairingMetadataUpgradeRequired, .protocolMismatch:
            guard let requestId else { return self.localizedTitle }
            return String(
                format: String(localized: "%@ (request ID: %@)"),
                self.localizedTitle,
                requestId)
        default:
            return self.localizedTitle
        }
    }
}

struct GatewayProblemBanner: View {
    let problem: GatewayConnectionProblem
    var primaryActionTitle: String?
    var onPrimaryAction: (() -> Void)?
    var onShowDetails: (() -> Void)?

    var body: some View {
        AforaNoticeBanner(
            icon: self.iconName,
            title: .verbatim(self.problem.localizedTitle),
            message: .verbatim(self.problem.localizedMessage),
            ownerLabel: .localized(self.ownerLabel),
            tint: self.tint,
            detail: self.problem.requestId.map(AforaNoticeDetail.requestID),
            primaryActionTitle: self.primaryActionTitle.map(AforaTextValue.verbatim),
            onPrimaryAction: self.onPrimaryAction,
            secondaryActionTitle: "Details",
            onSecondaryAction: self.onShowDetails)
    }

    private var iconName: String {
        switch self.problem.kind {
        case .pairingRequired,
             .pairingRoleUpgradeRequired,
             .pairingScopeUpgradeRequired,
             .pairingMetadataUpgradeRequired:
            "person.crop.circle.badge.clock"
        case .timeout, .connectionRefused, .reachabilityFailed, .websocketCancelled:
            "wifi.exclamationmark"
        case .deviceIdentityRequired,
             .deviceSignatureExpired,
             .deviceNonceRequired,
             .deviceNonceMismatch,
             .deviceSignatureInvalid,
             .devicePublicKeyInvalid,
             .deviceIdMismatch:
            "lock.shield"
        default:
            "exclamationmark.triangle.fill"
        }
    }

    private var tint: Color {
        switch self.problem.kind {
        case .pairingRequired,
             .pairingRoleUpgradeRequired,
             .pairingScopeUpgradeRequired,
             .pairingMetadataUpgradeRequired:
            AforaBrand.warn
        case .timeout, .connectionRefused, .reachabilityFailed, .websocketCancelled:
            AforaBrand.warn
        default:
            AforaBrand.danger
        }
    }

    private var ownerLabel: String {
        switch self.problem.owner {
        case .gateway:
            "Fix on gateway"
        case .iphone:
            "Fix on this device"
        case .both:
            "Check both"
        case .network:
            "Check network"
        case .unknown:
            "Needs attention"
        }
    }
}

struct GatewayProblemDetailsSheet: View {
    @Environment(\.dismiss) private var dismiss

    let problem: GatewayConnectionProblem
    var primaryActionTitle: String?
    var onPrimaryAction: (() -> Void)?

    @State private var copyFeedback: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(verbatim: self.problem.localizedTitle)
                            .font(AforaType.title3)
                        Text(verbatim: self.problem.localizedMessage)
                            .font(AforaType.body)
                            .foregroundStyle(.secondary)
                        Text(LocalizedStringKey(self.ownerSummary))
                            .font(AforaType.footnoteSemiBold)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4)
                }

                if let requestId = self.problem.requestId {
                    Section {
                        Text(verbatim: requestId)
                            .font(AforaType.mono)
                            .textSelection(.enabled)
                        Button {
                            UIPasteboard.general.string = requestId
                            self.copyFeedback = "Copied request ID"
                        } label: {
                            Text("Copy request ID")
                                .font(AforaType.subheadSemiBold)
                        }
                        .font(AforaType.subheadSemiBold)
                    } header: {
                        Text("Request")
                            .font(AforaType.captionSemiBold)
                    }
                }

                if let actionCommand = self.problem.actionCommand {
                    Section {
                        Text(verbatim: actionCommand)
                            .font(AforaType.mono)
                            .textSelection(.enabled)
                        Button {
                            UIPasteboard.general.string = actionCommand
                            self.copyFeedback = "Copied command"
                        } label: {
                            Text("Copy command")
                                .font(AforaType.subheadSemiBold)
                        }
                        .font(AforaType.subheadSemiBold)
                    } header: {
                        Text("Gateway command")
                            .font(AforaType.captionSemiBold)
                    }
                }

                if let docsURL = self.problem.docsURL {
                    Section {
                        Link(destination: docsURL) {
                            Label("Open docs", systemImage: "book")
                                .font(AforaType.subheadSemiBold)
                        }
                        .font(AforaType.subheadSemiBold)
                        Text(verbatim: docsURL.absoluteString)
                            .font(AforaType.footnote)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    } header: {
                        Text("Help")
                            .font(AforaType.captionSemiBold)
                    }
                }

                if let technicalDetails = self.problem.technicalDetails {
                    Section {
                        Text(verbatim: technicalDetails)
                            .font(AforaType.monoFootnote)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    } header: {
                        Text("Technical details")
                            .font(AforaType.captionSemiBold)
                    }
                }

                if let copyFeedback {
                    Section {
                        Text(verbatim: copyFeedback)
                            .font(AforaType.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Connection problem")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("Connection problem")
                        .font(AforaType.headline)
                }
                ToolbarItem(placement: .topBarLeading) {
                    if let primaryActionTitle, let onPrimaryAction {
                        Button {
                            self.dismiss()
                            onPrimaryAction()
                        } label: {
                            Text(verbatim: primaryActionTitle)
                                .font(AforaType.subheadSemiBold)
                        }
                        .font(AforaType.subheadSemiBold)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        self.dismiss()
                    } label: {
                        Text("Done")
                            .font(AforaType.subheadSemiBold)
                    }
                    .font(AforaType.subheadSemiBold)
                }
            }
        }
    }

    private var ownerSummary: String {
        switch self.problem.owner {
        case .gateway:
            "Primary fix: gateway"
        case .iphone:
            "Primary fix: this device"
        case .both:
            "Primary fix: check both this device and the gateway"
        case .network:
            "Primary fix: network or remote access"
        case .unknown:
            "Primary fix: review details and retry"
        }
    }
}
