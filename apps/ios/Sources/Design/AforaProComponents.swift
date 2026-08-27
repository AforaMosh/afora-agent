import AforaChatUI
import SwiftUI

enum AforaProMetric {
    static let pagePadding: CGFloat = 16
    static let cardRadius: CGFloat = 16
    static let controlRadius: CGFloat = 12
    static let compactControlSize: CGFloat = 36
    static let bottomScrollInset: CGFloat = 96
}

enum AforaSpacing {
    static let space1: CGFloat = 4
    static let space2: CGFloat = 8
    static let space3: CGFloat = 12
    static let space4: CGFloat = 16
    static let space6: CGFloat = 24
}

enum AforaRadius {
    static let xs: CGFloat = 8
    static let sm: CGFloat = 10
    static let md: CGFloat = 12
}

enum AforaTextValue: ExpressibleByStringLiteral {
    case localized(LocalizedStringKey)
    case verbatim(String)

    init(stringLiteral value: String) {
        self = .localized(LocalizedStringKey(value))
    }

    static func localized(_ value: String) -> Self {
        .localized(LocalizedStringKey(value))
    }

    var text: Text {
        switch self {
        case let .localized(key):
            Text(key)
        case let .verbatim(value):
            Text(verbatim: value)
        }
    }
}

struct AforaProBackground: View {
    var body: some View {
        Color(uiColor: .systemGroupedBackground)
            .ignoresSafeArea()
    }
}

struct ProSectionHeader: View {
    let title: AforaTextValue
    var actionTitle: AforaTextValue?
    var action: (() -> Void)?
    var uppercase = true

    var body: some View {
        HStack {
            self.title.text
                .font(AforaType.footnoteMedium)
                .foregroundStyle(.secondary)
                .textCase(self.uppercase ? .uppercase : nil)
            Spacer()
            if let actionTitle {
                if let action {
                    Button(action: action) {
                        actionTitle.text
                            .font(AforaType.footnoteMedium)
                    }
                    .foregroundStyle(AforaBrand.accent)
                } else {
                    actionTitle.text
                        .font(AforaType.footnoteMedium)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, AforaProMetric.pagePadding)
    }
}

struct ProCard<Content: View>: View {
    var tint: Color?
    var isProminent: Bool = false
    var padding: CGFloat = 12
    var radius: CGFloat = AforaProMetric.cardRadius
    @ViewBuilder var content: Content

    var body: some View {
        self.content
            .padding(self.padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .proPanelSurface(
                tint: self.tint,
                radius: self.radius,
                isProminent: self.isProminent)
    }
}

private struct ProPanelBackground: View {
    @Environment(\.colorScheme) private var colorScheme
    let radius: CGFloat
    let tint: Color?
    let isProminent: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        shape
            .fill(self.fill)
            .overlay {
                shape.strokeBorder(self.borderStyle, lineWidth: 1)
            }
    }

    private var fill: AnyShapeStyle {
        let color = self.isProminent ? UIColor.systemBackground : UIColor.secondarySystemGroupedBackground
        return AnyShapeStyle(Color(uiColor: color))
    }

    private var borderStyle: AnyShapeStyle {
        if let tint {
            return AnyShapeStyle(tint.opacity(self.isProminent ? 0.18 : 0.10))
        }
        return AnyShapeStyle(Color(uiColor: .separator).opacity(self.colorScheme == .dark ? 0.22 : 0.12))
    }
}

private struct ProInsetSurfaceModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    let tint: Color
    let radius: CGFloat

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content.background {
            shape
                .fill(Color(uiColor: .tertiarySystemGroupedBackground))
                .overlay {
                    shape.strokeBorder(
                        self.tint.opacity(self.colorScheme == .dark ? 0.18 : 0.10),
                        lineWidth: 1)
                }
        }
    }
}

private struct AforaGlassButtonModifier: ViewModifier {
    let prominent: Bool
    let tint: Color?

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            if self.prominent {
                content
                    .font(AforaType.subheadSemiBold)
                    .buttonStyle(.glassProminent)
                    .tint(self.tint ?? AforaBrand.accent)
            } else {
                content
                    .font(AforaType.subheadSemiBold)
                    .buttonStyle(.glass)
                    .tint(self.tint)
            }
        } else if self.prominent {
            content
                .font(AforaType.subheadSemiBold)
                .buttonStyle(.borderedProminent)
                .tint(self.tint ?? AforaBrand.accent)
        } else {
            content
                .font(AforaType.subheadSemiBold)
                .buttonStyle(.bordered)
                .tint(self.tint)
        }
    }
}

private struct AforaGlassSurfaceModifier: ViewModifier {
    let radius: CGFloat

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular, in: .rect(cornerRadius: self.radius))
        } else {
            content.background(
                .regularMaterial,
                in: RoundedRectangle(cornerRadius: self.radius, style: .continuous))
        }
    }
}

extension View {
    func proPanelSurface(
        tint: Color? = nil,
        radius: CGFloat = AforaProMetric.cardRadius,
        isProminent: Bool = false) -> some View
    {
        modifier(ProPanelSurfaceModifier(
            tint: tint,
            radius: radius,
            isProminent: isProminent))
    }

    func proInsetSurface(tint: Color, radius: CGFloat) -> some View {
        modifier(ProInsetSurfaceModifier(tint: tint, radius: radius))
    }

    func aforaGlassButton(prominent: Bool = false, tint: Color? = nil) -> some View {
        modifier(AforaGlassButtonModifier(prominent: prominent, tint: tint))
    }

    func aforaGlassSurface(radius: CGFloat = AforaProMetric.controlRadius) -> some View {
        modifier(AforaGlassSurfaceModifier(radius: radius))
    }
}

private struct ProPanelSurfaceModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    let tint: Color?
    let radius: CGFloat
    let isProminent: Bool

    func body(content: Content) -> some View {
        content
            .background {
                ProPanelBackground(
                    radius: self.radius,
                    tint: self.tint,
                    isProminent: self.isProminent)
            }
            .shadow(
                color: self.isProminent
                    ? (self.colorScheme == .dark ? .black.opacity(0.14) : .black.opacity(0.045))
                    : .clear,
                radius: self.isProminent ? 5 : 0,
                y: self.isProminent ? 2 : 0)
    }
}

struct ProIconBadge: View {
    let systemName: String
    let color: Color

    var body: some View {
        Image(systemName: self.systemName)
            .font(AforaType.captionSemiBold)
            .foregroundStyle(self.color)
            .frame(width: 30, height: 30)
            .background {
                RoundedRectangle(cornerRadius: AforaRadius.xs, style: .continuous)
                    .fill(self.color.opacity(0.12))
            }
    }
}

struct AforaSidebarHeaderAction {
    let systemName: String
    let accessibilityLabel: AforaTextValue
    let accessibilityIdentifier: String?
    let action: () -> Void

    init(
        systemName: String,
        accessibilityLabel: AforaTextValue,
        accessibilityIdentifier: String? = nil,
        action: @escaping () -> Void)
    {
        self.systemName = systemName
        self.accessibilityLabel = accessibilityLabel
        self.accessibilityIdentifier = accessibilityIdentifier
        self.action = action
    }
}

struct AforaSidebarControlButton: View {
    let headerAction: AforaSidebarHeaderAction

    init(action: AforaSidebarHeaderAction) {
        self.headerAction = action
    }

    var body: some View {
        if #available(iOS 26.0, *) {
            self.identified(self.button.buttonStyle(.plain))
        } else {
            self.identified(self.button.aforaGlassButton(tint: AforaBrand.accent))
        }
    }

    private var button: some View {
        Button(action: self.headerAction.action) {
            self.icon
        }
        .buttonBorderShape(.circle)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
        .accessibilityLabel(self.headerAction.accessibilityLabel.text)
    }

    @ViewBuilder
    private var icon: some View {
        let icon = Image(systemName: self.headerAction.systemName)
            .font(AforaType.subheadSemiBold)
            .frame(
                width: AforaProMetric.compactControlSize,
                height: AforaProMetric.compactControlSize)
        if #available(iOS 26.0, *) {
            icon
                .foregroundStyle(AforaBrand.accent)
                .glassEffect(
                    .regular.interactive(),
                    in: Circle())
        } else {
            icon
        }
    }

    @ViewBuilder
    private func identified(_ button: some View) -> some View {
        if let accessibilityIdentifier = headerAction.accessibilityIdentifier {
            button.accessibilityIdentifier(accessibilityIdentifier)
        } else {
            button
        }
    }
}

struct AforaSidebarHeaderLeadingSlot: View {
    let action: AforaSidebarHeaderAction

    var body: some View {
        AforaSidebarControlButton(action: self.action)
    }
}

struct AforaSidebarToolbarItem: ToolbarContent {
    let action: AforaSidebarHeaderAction
    let placement: ToolbarItemPlacement

    @ToolbarContentBuilder
    var body: some ToolbarContent {
        if #available(iOS 26.0, *) {
            ToolbarItem(placement: self.placement) {
                AforaSidebarControlButton(action: self.action)
            }
            // The button owns an explicit circular glass shape; suppress the
            // toolbar's shared pill so it cannot stretch the leading control.
            .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: self.placement) {
                AforaSidebarControlButton(action: self.action)
            }
        }
    }
}

struct AforaGlassControlGroup<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: 8) {
                self.content
            }
        } else {
            self.content
        }
    }
}

enum AforaNoticeDetail {
    case accent(String)
    case requestID(String)
}

struct AforaNoticeBanner: View {
    let icon: String
    let title: AforaTextValue
    let message: AforaTextValue
    let ownerLabel: AforaTextValue
    let tint: Color
    var detail: AforaNoticeDetail?
    var primaryActionTitle: AforaTextValue?
    var onPrimaryAction: (() -> Void)?
    var secondaryActionTitle: AforaTextValue?
    var onSecondaryAction: (() -> Void)?

    var body: some View {
        ProCard(tint: self.tint, padding: 14) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    ProIconBadge(systemName: self.icon, color: self.tint)

                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            self.title.text
                                .font(AforaType.subheadSemiBold)
                                .multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                            self.ownerLabel.text
                                .font(AforaType.captionSemiBold)
                                .foregroundStyle(.secondary)
                        }

                        self.message.text
                            .font(AforaType.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)

                        self.detailView
                    }
                }

                if self.onPrimaryAction != nil || self.onSecondaryAction != nil {
                    AforaGlassControlGroup {
                        HStack(spacing: 10) {
                            if let primaryActionTitle, let onPrimaryAction {
                                Button(action: onPrimaryAction) {
                                    primaryActionTitle.text
                                        .font(AforaType.captionSemiBold)
                                }
                                .font(AforaType.captionSemiBold)
                                .aforaGlassButton(prominent: true)
                                .controlSize(.small)
                            }
                            if let secondaryActionTitle, let onSecondaryAction {
                                Button(action: onSecondaryAction) {
                                    secondaryActionTitle.text
                                        .font(AforaType.captionSemiBold)
                                }
                                .font(AforaType.captionSemiBold)
                                .aforaGlassButton()
                                .controlSize(.small)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var detailView: some View {
        if let detail {
            switch detail {
            case let .accent(value):
                Text(value)
                    .font(AforaType.captionMedium)
                    .foregroundStyle(self.tint)
                    .fixedSize(horizontal: false, vertical: true)
            case let .requestID(value):
                Text(verbatim: String(
                    format: String(localized: "Request ID: %@"),
                    value))
                    .font(AforaType.monoSmallMedium)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }
}

struct AforaAdaptiveHeaderRow<Leading: View, Accessory: View>: View {
    let title: AforaTextValue
    let subtitle: AforaTextValue?
    var titleFont: Font = AforaType.title3SemiBold
    var subtitleFont: Font = AforaType.subhead
    var subtitleLineLimit: Int? = 2
    @ViewBuilder let leading: Leading
    @ViewBuilder let accessory: Accessory

    init(
        title: AforaTextValue,
        subtitle: AforaTextValue? = nil,
        titleFont: Font = AforaType.title3SemiBold,
        subtitleFont: Font = AforaType.subhead,
        subtitleLineLimit: Int? = 2,
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder accessory: () -> Accessory)
    {
        self.title = title
        self.subtitle = subtitle
        self.titleFont = titleFont
        self.subtitleFont = subtitleFont
        self.subtitleLineLimit = subtitleLineLimit
        self.leading = leading()
        self.accessory = accessory()
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            self.horizontalLayout
            self.stackedLayout
        }
    }

    private var horizontalLayout: some View {
        HStack(alignment: .top, spacing: 12) {
            self.leading

            self.titleBlock
                .layoutPriority(1)

            Spacer(minLength: 8)

            self.accessory
                .fixedSize(horizontal: true, vertical: false)
        }
    }

    private var stackedLayout: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                self.leading

                self.titleBlock
                    .layoutPriority(1)

                Spacer(minLength: 8)
            }

            HStack {
                Spacer(minLength: 0)
                self.accessory
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            self.title.text
                .font(self.titleFont)
                .lineLimit(2)
                .minimumScaleFactor(0.86)
                .fixedSize(horizontal: false, vertical: true)
            if let subtitle {
                subtitle.text
                    .font(self.subtitleFont)
                    .foregroundStyle(.secondary)
                    .lineLimit(self.subtitleLineLimit)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// Shared switch indicator replacing the 3 duplicated capsule toggles.
/// Native Toggle only hits the switch edge on iOS 26; this full-width button approach
/// gives the whole row a tap target.
struct AforaToggleIndicator: View {
    let isOn: Bool

    var body: some View {
        Capsule()
            .fill(self.isOn ? AforaBrand.accent : Color.secondary.opacity(0.35))
            .frame(width: 52, height: 32)
            .overlay(alignment: self.isOn ? .trailing : .leading) {
                Circle()
                    .fill(Color.white)
                    .frame(width: 28, height: 28)
                    .padding(2)
                    .shadow(color: Color.black.opacity(0.14), radius: 1, x: 0, y: 1)
            }
    }
}

enum AforaStatusTone {
    case ok
    case warn
    case danger
    case info
    case accent
    case teal
    case muted

    var color: Color {
        switch self {
        case .ok: AforaBrand.ok
        case .warn: AforaBrand.warn
        case .danger: AforaBrand.danger
        case .info: AforaBrand.info
        case .accent: AforaBrand.accent
        case .teal: AforaBrand.teal
        case .muted: AforaBrand.textSecondary
        }
    }
}

struct AforaStatusBadge: View {
    @Environment(\.colorScheme) private var colorScheme
    let label: AforaTextValue
    let tone: AforaStatusTone

    var body: some View {
        HStack(spacing: AforaSpacing.space1 + 2) {
            Circle()
                .fill(self.tone.color)
                .frame(width: 7, height: 7)
                .shadow(color: self.tone.color.opacity(0.55), radius: 3)
            self.label.text
                .font(AforaType.caption2SemiBold)
                .foregroundStyle(self.tone.color)
        }
        .padding(.horizontal, AforaSpacing.space2)
        .padding(.vertical, 5)
        .background {
            Capsule()
                .fill(self.tone.color.opacity(self.colorScheme == .dark ? 0.14 : 0.10))
        }
    }
}

struct ProValuePill: View {
    @Environment(\.colorScheme) private var colorScheme
    let value: String
    let color: Color

    var body: some View {
        Text(self.value)
            .font(AforaType.footnoteSemiBold)
            .foregroundStyle(self.color)
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background {
                Capsule()
                    .fill(self.color.opacity(self.colorScheme == .dark ? 0.12 : 0.08))
            }
    }
}

struct AforaProMark: View {
    var size: CGFloat = 42
    var shadowRadius: CGFloat = 10
    /// Opt-in tap Easter eggs; leave off when the mark sits inside a control.
    var interactive = false

    var body: some View {
        AforaMascotView(interactive: self.interactive)
            .frame(width: self.size, height: self.size)
            .shadow(color: AforaBrand.accent.opacity(0.18), radius: self.shadowRadius, y: self.shadowRadius / 3)
            .accessibilityLabel("Afora")
    }
}

struct ProProgressBar: View {
    let progress: Double
    var color: Color = AforaBrand.accentHot

    var body: some View {
        GeometryReader { proxy in
            let clamped = max(0, min(self.progress, 1))
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.primary.opacity(0.10))
                Capsule()
                    .fill(self.color)
                    .frame(width: proxy.size.width * clamped)
            }
        }
        .frame(height: 3)
    }
}

struct AforaGatewayCompactPill: View {
    @Environment(NodeAppModel.self) private var appModel

    var body: some View {
        AforaStatusBadge(label: .verbatim(self.title), tone: self.tone)
            .accessibilityLabel(
                String(
                    format: String(localized: "Gateway %@"),
                    self.title))
    }

    private var title: String {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected:
            String(localized: "Online")
        case .connecting:
            String(localized: "Connecting")
        case .error:
            String(localized: "Attention")
        case .disconnected:
            String(localized: "Offline")
        }
    }

    private var tone: AforaStatusTone {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected:
            .ok
        case .connecting:
            .accent
        case .error:
            .warn
        case .disconnected:
            .muted
        }
    }
}

struct ProMetricTile: View {
    @Environment(\.colorScheme) private var colorScheme
    let title: AforaTextValue
    let value: String
    let icon: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: self.icon)
                    .font(AforaType.captionSemiBold)
                    .foregroundStyle(self.color)
                    .frame(width: 24, height: 24)
                    .background(self.color.opacity(self.colorScheme == .dark ? 0.18 : 0.10), in: Circle())
                Spacer(minLength: 4)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(self.value)
                    .font(AforaType.headlineBold)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                self.title.text
                    .font(AforaType.caption2Medium)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .proInsetSurface(tint: self.color, radius: AforaProMetric.controlRadius)
    }
}

struct ProMetric: Identifiable {
    let id = UUID()
    let icon: String
    let title: AforaTextValue
    let value: String
    let color: Color
}

struct ProMetricGrid: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let metrics: [ProMetric]

    var body: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible()), count: self.columnCount),
            spacing: 10)
        {
            ForEach(self.metrics) { metric in
                ProMetricTile(
                    title: metric.title,
                    value: metric.value,
                    icon: metric.icon,
                    color: metric.color)
            }
        }
        .padding(.horizontal, AforaProMetric.pagePadding)
    }

    private var columnCount: Int {
        guard self.horizontalSizeClass != .compact else { return 1 }
        return min(max(self.metrics.count, 1), 3)
    }
}

struct ProPanelHeader: View {
    let title: AforaTextValue
    var value: String?
    var actionTitle: AforaTextValue?
    var actionIcon: String?
    var actionAccessibilityLabel: String?
    var isActionDisabled = false
    var action: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            self.title.text
                .font(AforaType.subheadSemiBold)
            if let value {
                Text(value)
                    .font(AforaType.caption2Bold)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            self.actionControl
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }

    @ViewBuilder
    private var actionControl: some View {
        if let action {
            if let actionIcon {
                Button(action: action) {
                    Image(systemName: actionIcon)
                }
                .accessibilityLabel(
                    self.actionAccessibilityLabel.map { Text(LocalizedStringKey($0)) }
                        ?? actionTitle?.text
                        ?? self.title.text)
                .disabled(self.isActionDisabled)
            } else if let actionTitle {
                Button(action: action) {
                    actionTitle.text
                        .font(AforaType.captionSemiBold)
                }
                .disabled(self.isActionDisabled)
            }
        }
    }
}

struct ProStatusRow: View {
    let icon: String
    let title: AforaTextValue
    let detail: AforaTextValue
    let value: String?
    let color: Color
    var actionTitle: AforaTextValue?
    var action: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ProIconBadge(systemName: self.icon, color: self.color)
            VStack(alignment: .leading, spacing: 4) {
                self.title.text
                    .font(AforaType.subheadSemiBold)
                    .lineLimit(1)
                self.detail.text
                    .font(AforaType.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 6) {
                if let value {
                    ProValuePill(value: value, color: self.color)
                }
                if let actionTitle, let action {
                    Button(action: action) {
                        actionTitle.text
                            .font(AforaType.captionSemiBold)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}
