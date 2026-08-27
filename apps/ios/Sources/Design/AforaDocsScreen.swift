import SwiftUI

struct AforaDocsScreen: View {
    private let docsURL = URL(string: "https://docs.afora.ai")!
    private let gatewayURL = URL(string: "https://docs.afora.ai/gateway")!
    private let pairingURL = URL(string: "https://docs.afora.ai/channels/pairing")!
    let headerSidebarAction: AforaSidebarHeaderAction?
    let usesNativeNavigationChrome: Bool
    let gatewayAction: (() -> Void)?

    init(
        headerSidebarAction: AforaSidebarHeaderAction? = nil,
        usesNativeNavigationChrome: Bool = false,
        gatewayAction: (() -> Void)? = nil)
    {
        self.headerSidebarAction = headerSidebarAction
        self.usesNativeNavigationChrome = usesNativeNavigationChrome
        self.gatewayAction = gatewayAction
    }

    var body: some View {
        ZStack {
            AforaProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if !self.usesNativeNavigationChrome {
                        self.headerCard
                    }
                    self.linkCard
                }
                .padding(.vertical, 18)
                .font(AforaType.body)
            }
        }
        .navigationTitle("Docs")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(self.usesNativeNavigationChrome ? .visible : .hidden, for: .navigationBar)
        .toolbar {
            if self.usesNativeNavigationChrome, let gatewayAction {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: gatewayAction) {
                        Image(systemName: "antenna.radiowaves.left.and.right")
                            .font(AforaType.subheadSemiBold)
                    }
                    .accessibilityLabel("Gateway settings")
                }
            }
            if self.usesNativeNavigationChrome, let headerSidebarAction {
                AforaSidebarToolbarItem(
                    action: headerSidebarAction,
                    placement: .topBarLeading)
            }
        }
    }

    private var headerCard: some View {
        ProCard(radius: AforaProMetric.cardRadius) {
            AforaAdaptiveHeaderRow(
                title: "Docs",
                subtitle: "Gateway setup, pairing, channels, and mobile node reference.",
                titleFont: AforaType.headline,
                subtitleFont: AforaType.caption)
            {
                HStack(spacing: 10) {
                    if let headerSidebarAction {
                        AforaSidebarHeaderLeadingSlot(action: headerSidebarAction)
                    }
                    ProIconBadge(systemName: "book", color: AforaBrand.accent)
                }
            } accessory: {
                self.gatewayPill
            }
        }
        .padding(.horizontal, AforaProMetric.pagePadding)
    }

    @ViewBuilder
    private var gatewayPill: some View {
        if let gatewayAction {
            Button(action: gatewayAction) {
                AforaGatewayCompactPill()
            }
            .buttonBorderShape(.capsule)
            .aforaGlassButton()
            .accessibilityHint("Opens Settings / Gateway")
        } else {
            AforaGatewayCompactPill()
        }
    }

    private var linkCard: some View {
        ProCard(padding: 0, radius: AforaProMetric.cardRadius) {
            VStack(spacing: 0) {
                self.docsLinkRow(
                    title: "Docs Home",
                    detail: "Browse the current Afora reference.",
                    icon: "book",
                    url: self.docsURL)
                Divider().padding(.leading, 58)
                self.docsLinkRow(
                    title: "Gateway",
                    detail: "Connection, auth, and diagnostics.",
                    icon: "network",
                    url: self.gatewayURL)
                Divider().padding(.leading, 58)
                self.docsLinkRow(
                    title: "Pairing",
                    detail: "Mobile setup codes, QR, and node approval.",
                    icon: "qrcode",
                    url: self.pairingURL)
            }
        }
        .padding(.horizontal, AforaProMetric.pagePadding)
    }

    private func docsLinkRow(title: String, detail: String, icon: String, url: URL) -> some View {
        Link(destination: url) {
            HStack(spacing: 12) {
                ProIconBadge(systemName: icon, color: AforaBrand.accent)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(AforaType.subheadSemiBold)
                    Text(detail)
                        .font(AforaType.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "arrow.up.right")
                    .font(AforaType.captionBold)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
