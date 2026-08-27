import SwiftUI

struct IPadSidebarScreenChrome<Content: View>: View {
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    let title: String
    let subtitle: String
    let headerSidebarAction: AforaSidebarHeaderAction?
    let usesNativeNavigationChrome: Bool
    let gatewayAction: (() -> Void)?
    @ViewBuilder var content: Content

    init(
        title: String,
        subtitle: String,
        headerSidebarAction: AforaSidebarHeaderAction? = nil,
        usesNativeNavigationChrome: Bool = false,
        gatewayAction: (() -> Void)? = nil,
        @ViewBuilder content: () -> Content)
    {
        self.title = title
        self.subtitle = subtitle
        self.headerSidebarAction = headerSidebarAction
        self.usesNativeNavigationChrome = usesNativeNavigationChrome
        self.gatewayAction = gatewayAction
        self.content = content()
    }

    var body: some View {
        ZStack {
            AforaProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: self.isCompactHeight ? 10 : 16) {
                    if !self.usesNativeNavigationChrome {
                        AforaAdaptiveHeaderRow(
                            title: .localized(self.title),
                            subtitle: .localized(self.subtitle),
                            titleFont: self.isCompactHeight ? AforaType.headline : AforaType.title2SemiBold,
                            subtitleLineLimit: self.isCompactHeight ? 1 : 2)
                        {
                            if let headerSidebarAction {
                                AforaSidebarHeaderLeadingSlot(action: headerSidebarAction)
                            }
                        } accessory: {
                            self.gatewayPill
                        }
                        .padding(.horizontal, AforaProMetric.pagePadding)
                    }
                    self.content
                }
                .padding(.vertical, self.isCompactHeight ? 10 : 18)
                .font(AforaType.body)
            }
            .safeAreaPadding(.bottom, self.bottomScrollInset)
        }
        .navigationTitle(self.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(self.usesNativeNavigationChrome ? .visible : .hidden, for: .navigationBar)
        .toolbar {
            if self.usesNativeNavigationChrome, let gatewayAction {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: gatewayAction) {
                        Image(systemName: "antenna.radiowaves.left.and.right")
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

    private var isCompactHeight: Bool {
        self.verticalSizeClass == .compact
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

    private var bottomScrollInset: CGFloat {
        self.isCompactHeight ? 150 : AforaProMetric.bottomScrollInset
    }
}
