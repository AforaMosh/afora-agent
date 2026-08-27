import AforaKit
import SwiftUI

/// iOS Settings-style icon: white glyph on a solid rounded-square, sized for a List row.
struct SettingsIcon: View {
    let systemName: String
    let color: Color

    var body: some View {
        Image(systemName: self.systemName)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 28, height: 28)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(self.color))
    }
}

private struct AppearanceSettingsRow: View {
    @Environment(AppAppearanceModel.self) private var appearanceModel

    private var preference: AppAppearancePreference {
        self.appearanceModel.preference
    }

    var body: some View {
        NavigationLink {
            AppearanceSettingsScreen()
        } label: {
            self.rowLabel
        }
        .accessibilityIdentifier("settings-appearance-row")
        .accessibilityLabel("Appearance")
        .accessibilityValue(self.preference.label)
        .accessibilityHint("Choose system, light, or dark appearance")
    }

    private var rowLabel: some View {
        HStack(spacing: 12) {
            ProIconBadge(
                systemName: "circle.lefthalf.filled",
                color: .secondary)

            Text("Appearance")
                .font(AforaType.subheadSemiBold)

            Spacer(minLength: 8)

            Text(self.preference.label)
                .font(AforaType.subhead)
                .foregroundStyle(.secondary)
        }
    }
}

private struct AppearanceSettingsScreen: View {
    @Environment(AppAppearanceModel.self) private var appearanceModel
    @Environment(\.dismiss) private var dismiss
    @AppStorage(RootSidebar.visibleAgentCountKey) private var sidebarVisibleAgentCount: Int = 1

    var body: some View {
        List {
            Section {
                ForEach(AppAppearancePreference.allCases) { preference in
                    Button {
                        self.select(preference)
                    } label: {
                        Label {
                            HStack {
                                Text(preference.label)
                                    .font(AforaType.body)
                                Spacer()
                                if preference == self.appearanceModel.preference {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(AforaBrand.accent)
                                }
                            }
                        } icon: {
                            Image(systemName: preference.systemImage)
                        }
                    }
                    .foregroundStyle(.primary)
                    .accessibilityIdentifier("settings-appearance-\(preference.rawValue)")
                    .accessibilityValue(
                        preference == self.appearanceModel.preference ? "Selected" : "")
                }
            } footer: {
                Text("System follows this device’s appearance setting.")
                    .font(AforaType.footnote)
            }

            Section {
                Stepper(value: self.$sidebarVisibleAgentCount, in: 1...3) {
                    HStack {
                        Text("Sidebar Agents")
                            .font(AforaType.body)
                        Spacer()
                        Text(verbatim: self.sidebarVisibleAgentCount.formatted())
                            .font(AforaType.body)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityIdentifier("settings-appearance-sidebar-agents")
            } footer: {
                Text("How many agents the sidebar lists before the switcher menu.")
                    .font(AforaType.footnote)
            }
        }
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func select(_ preference: AppAppearancePreference) {
        guard preference != self.appearanceModel.preference else { return }
        self.dismiss()
        Task { @MainActor in
            // Changing the root scheme while an iPad split-view destination is active can
            // leave that destination blank. Apply only after the native pop transition.
            try? await Task.sleep(for: .milliseconds(500))
            self.appearanceModel.select(preference)
        }
    }
}

extension SettingsProTab {
    var appearanceRow: some View {
        AppearanceSettingsRow()
    }

    var gatewaySection: some View {
        Section("Gateway") {
            HStack(spacing: 8) {
                NavigationLink(value: SettingsRoute.gateway) {
                    self.gatewayConnectionRow
                }
                if self.gatewayRegistry.entries.count > 1 {
                    self.gatewayQuickSwitchMenu
                }
            }
            SettingsDetailRow("Address", value: .verbatim(self.gatewayAddress))
            SettingsDetailRow("Server", value: .verbatim(self.gatewayServer))
            SettingsDetailRow(
                "Agents",
                value: .verbatim(self.appModel.gatewayAgents.count.formatted()))
            self.gatewayActions
        }
    }

    var gatewayConnectionRow: some View {
        LabeledContent {
            Text(self.gatewayStatusDetail)
                .font(AforaType.subhead)
                .foregroundStyle(self.gatewayStatusColor)
        } label: {
            Text("Connection")
                .font(AforaType.subheadSemiBold)
        }
    }

    @ViewBuilder var settingsListSection: some View {
        Section {
            self.settingsListRow(
                icon: "sparkles.square.filled.on.square",
                iconColor: AforaBrand.accent,
                title: "Afora",
                route: .systemAgent)
                .accessibilityIdentifier("settings-system-agent-row")
            self.settingsListRow(
                icon: "checkmark.shield.fill",
                iconColor: self.pendingApproval == nil ? .green : .orange,
                title: "Approvals",
                route: .approvals,
                badgeValue: self.pendingApproval == nil ? nil : "1")
            self.settingsListRow(
                icon: "person.2.fill",
                iconColor: .blue,
                title: "Permissions",
                route: .permissions)
            self.settingsListRow(
                icon: "point.3.connected.trianglepath.dotted",
                iconColor: .purple,
                title: "Channels",
                route: .channels)
            self.settingsListRow(
                icon: "sparkles",
                iconColor: AforaBrand.accent,
                title: "Skills",
                route: .skills)
            self.settingsListRow(
                icon: "waveform",
                iconColor: .pink,
                title: "Voice & Talk",
                route: .voice)
        }

        Section {
            self.appearanceRow
            self.settingsListRow(
                icon: "stethoscope",
                iconColor: .teal,
                title: "Diagnostics",
                route: .diagnostics)
            self.settingsListRow(
                icon: "hand.raised.fill",
                iconColor: .indigo,
                title: "Privacy",
                route: .privacy)
            self.settingsListRow(
                icon: "applewatch",
                iconColor: .green,
                title: "Apple Watch",
                route: .appleWatch)
            self.settingsListRow(
                icon: "info.circle.fill",
                iconColor: .gray,
                title: "About",
                route: .about)
        } header: {
            Text("Device")
                .font(AforaType.captionSemiBold)
                .foregroundStyle(.secondary)
        }

        Section {
            self.settingsListRow(
                icon: "doc.text",
                iconColor: .gray,
                title: "Licenses",
                route: .licenses)
                .accessibilityIdentifier("settings-licenses-row")
        }
    }

    func settingsListRow(
        icon: String,
        iconColor: Color,
        title: LocalizedStringKey,
        route: SettingsRoute,
        badgeValue: String? = nil) -> some View
    {
        NavigationLink(value: route) {
            Label {
                Text(title)
                    .font(AforaType.subheadSemiBold)
            } icon: {
                SettingsIcon(systemName: icon, color: iconColor)
            }
        }
        .badge(badgeValue.map { Text($0).font(AforaType.captionSemiBold) })
    }

    @ViewBuilder
    func destination(for route: SettingsRoute) -> some View {
        switch route {
        case .systemAgent:
            SettingsSystemAgentChatScreen(model: self.systemAgentChatStore.model(for: self.appModel))
        case .channels:
            SettingsChannelsDestination()
                .navigationTitle(title(for: route))
                .navigationBarTitleDisplayMode(.inline)
        case .skills:
            SettingsSkillsDestination()
                .navigationTitle(title(for: route))
                .navigationBarTitleDisplayMode(.inline)
        default:
            List {
                switch route {
                case .gateway:
                    self.gatewayDestination
                case .systemAgent:
                    EmptyView()
                case .appleWatch:
                    self.appleWatchDestination
                case .approvals:
                    self.approvalsDestination
                case .permissions:
                    self.permissionsDestination
                case .skills:
                    EmptyView()
                case .voice:
                    self.voiceDestination
                case .diagnostics:
                    self.diagnosticsDestination
                case .privacy:
                    self.privacyDestination
                case .notifications:
                    self.notificationsDestination
                case .about:
                    self.aboutDestination
                case .licenses:
                    self.licensesDestination
                case .channels:
                    EmptyView()
                }
            }
            .font(AforaType.body)
            .navigationTitle(title(for: route))
            .navigationBarTitleDisplayMode(.inline)
            .task(id: route) {
                guard route == .appleWatch else { return }
                await self.appModel.refreshWatchMessagingStatus()
            }
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(title(for: route))
                        .font(AforaType.headline)
                        .foregroundStyle(.primary)
                }
                if route == .gateway {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            self.openGatewayQRScanner()
                        } label: {
                            Image(systemName: "qrcode.viewfinder")
                                .font(AforaType.subheadSemiBold)
                        }
                        .disabled(self.connectingGateway != nil)
                        .accessibilityLabel("Scan QR")
                    }
                }
                if let headerSidebarAction {
                    AforaSidebarToolbarItem(
                        action: headerSidebarAction,
                        placement: .topBarLeading)
                }
            }
        }
    }

    /// Ordered by intent: connection state, then pairing (the first-run action),
    /// then facts/preferences; manual entry and credentials are plumbing at the end.
    var gatewayDestination: some View {
        Group {
            self.gatewayStatusCard

            Section {
                Button {
                    Task { await self.reconnectGateway() }
                } label: {
                    Label("Reconnect", systemImage: "arrow.triangle.2.circlepath")
                        .font(AforaType.body)
                }
                .disabled(self.isReconnectingGateway || self.appModel.isAppleReviewDemoModeEnabled)
                Button {
                    Task { await self.runDiagnostics() }
                } label: {
                    Label("Diagnose", systemImage: "cross.case")
                        .font(AforaType.body)
                }
                .disabled(self.isRefreshingGateway)
            }

            self.gatewaySetupCard
            self.pairedGatewaysCard

            self.detailListCard {
                SettingsDetailRow("Address", value: .verbatim(self.gatewayAddress))
                SettingsDetailRow("Server", value: .verbatim(self.gatewayServer))
                SettingsDetailRow(
                    "Discovered",
                    value: .verbatim(self.gatewayController.gateways.count.formatted()))
                SettingsDetailRow(
                    "Default Agent",
                    value: .verbatim(self.appModel.activeAgentName))
                SettingsDetailRow(
                    "Agents",
                    value: .verbatim(self.appModel.gatewayAgents.count.formatted()))
                SettingsDetailRow(
                    "Access",
                    value: .verbatim(
                        self.appModel.isOperatorGatewayConnected
                            ? (self.appModel.hasOperatorAdminScope ? "Full" : "Limited")
                            : "Not available"))
            }

            if self.appModel.isOperatorGatewayConnected,
               !self.appModel.hasOperatorAdminScope
            {
                Section("Upgrade access") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("This phone has limited Gateway access.")
                            .font(AforaType.subheadSemiBold)
                        Text(
                            "Use a secure wss:// or Tailscale Serve Gateway, then scan a full-access setup code from the Control UI or afora qr and reconnect to enable settings and upgrades.") // swiftlint:disable:this line_length
                            .font(AforaType.caption) // Keep the native localization key contiguous.
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Button {
                        self.openGatewayQRScanner()
                    } label: {
                        Label("Scan Full-Access Code", systemImage: "qrcode.viewfinder")
                            .font(AforaType.body)
                    }
                }
            }

            self.agentSelectionCard
            self.deviceIdentityCard
            self.manualGatewayCard
            self.gatewayAdvancedCard
        }
        .font(AforaType.body)
    }

    private var gatewayStatusCard: some View {
        // Hero pairing action honors the same connect lock as the other scanner
        // entry points; an in-flight attempt must not race a second scan.
        let showScanHero = self.gatewayNeedsPairing && self.connectingGateway == nil
        // Unapplied `self.openGatewayQRScanner` in a ternary crashes the Swift 6
        // type checker ("failed to produce diagnostic"); build the optional closure imperatively.
        var scanAction: (() -> Void)?
        if showScanHero {
            scanAction = { self.openGatewayQRScanner() }
        }
        return self.detailStatusCard(
            icon: "antenna.radiowaves.left.and.right",
            title: "Gateway",
            detail: .verbatim(self.gatewayStatusDetail),
            value: .verbatim(self.gatewayStatusValue),
            color: self.gatewayStatusColor,
            actionTitle: showScanHero ? "Scan QR to Pair" : nil,
            actionSystemImage: "qrcode.viewfinder",
            action: scanAction)
    }

    var gatewayQuickSwitchMenu: some View {
        Menu {
            ForEach(self.gatewayRegistry.entries) { entry in
                Button {
                    Task { await self.switchGateway(to: entry) }
                } label: {
                    Label {
                        Text(entry.name)
                            .font(AforaType.body)
                    } icon: {
                        Image(systemName: GatewayStableIdentifier.matches(
                            entry.stableID,
                            self.gatewayRegistry.activeStableID)
                            ? "checkmark.circle.fill"
                            : "circle")
                    }
                }
                .disabled(
                    GatewayStableIdentifier.matches(entry.stableID, self.gatewayRegistry.activeStableID) ||
                        self.connectingGateway != nil)
            }
        } label: {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(AforaType.subheadSemiBold)
                .foregroundStyle(AforaBrand.accent)
        }
        .accessibilityLabel("Switch Gateway")
    }

    var approvalsDestination: some View {
        Group {
            self.detailStatusCard(
                icon: "checkmark.shield.fill",
                title: "Approvals",
                detail: .verbatim(self.notificationsNeedAttention
                    ? String(localized: "Out-of-app approval alerts need notification permission.")
                    : (self.pendingApprovalCount == 0
                        ? String(localized: "No gateway actions are waiting for review.")
                        : String(localized: "Review pending gateway actions."))),
                value: self.notificationsNeedAttention
                    ? .verbatim(String(localized: "Alerts Off"))
                    : (self.pendingApprovalCount == 0
                        ? .verbatim(String(localized: "clear"))
                        : .verbatim(self.approvalWaitingText)),
                color: self.notificationsNeedAttention ? AforaBrand.warn :
                    (self.pendingApprovalCount == 0 ? AforaBrand.ok : AforaBrand.warn))

            if self.notificationsNeedAttention {
                self.approvalNotificationsWarningCard
            }

            self.approvalsReviewCard
        }
    }

    var appleWatchDestination: some View {
        Group {
            let watchStatus = self.appModel.watchMessagingStatus
            self.detailStatusCard(
                icon: "applewatch",
                title: "Apple Watch",
                detail: .verbatim(watchStatus.appInstalled
                    ? String(
                        localized: "Relay remains available; direct mode adds an independent Gateway node.")
                    : String(
                        localized: "Install the Afora watch app before enabling direct mode.")),
                value: .verbatim(
                    watchStatus.reachable
                        ? String(localized: "Reachable")
                        : (watchStatus.appInstalled
                            ? String(localized: "Installed")
                            : String(localized: "Unavailable"))),
                color: watchStatus.appInstalled ? AforaBrand.ok : AforaBrand.warn)

            Section {
                Button {
                    Task { await self.sendDirectWatchSetup() }
                } label: {
                    Label("Enable Direct Gateway Connection", systemImage: "point.3.connected.trianglepath.dotted")
                        .font(AforaType.body)
                }
                .disabled(
                    self.isSendingWatchDirectSetup
                        || !self.appModel.isOperatorGatewayConnected
                        || !self.appModel.hasOperatorAdminScope
                        || !watchStatus.appInstalled)

                if let statusText = self.watchDirectSetupStatusText {
                    Text(statusText)
                        .font(AforaType.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } footer: {
                Text(
                    """
                    The watch receives a one-time pairing code and stores its own device token. \
                    A reachable secure Gateway URL is required away from the iPhone.
                    """)
                    .font(AforaType.footnote)
            }

            Section("Direct node features") {
                SettingsDetailRow("Device", value: "Info and status")
                SettingsDetailRow("Notifications", value: "While app is active")
            }
        }
    }

    var approvalNotificationsWarningCard: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text("Notifications are off")
                    .font(AforaType.subheadSemiBold)
                Text("Enable Notifications to receive approval alerts while Afora is not open.")
                    .font(AforaType.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if self.directRoute == nil {
                Button {
                    self.openNotificationsRouteFromApprovals()
                } label: {
                    Label("Open Notifications", systemImage: "bell.badge")
                        .font(AforaType.body)
                }
            }
        }
    }

    @ViewBuilder
    var approvalsReviewCard: some View {
        if !self.appModel.pendingExecApprovalInboxItems.isEmpty {
            Section("Pending approvals") {
                ForEach(self.appModel.pendingExecApprovalInboxItems) { item in
                    Button {
                        self.appModel.presentPendingExecApprovalFromInbox(item.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.prompt.commandPreview ?? item.prompt.commandText)
                                .font(AforaType.body)
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                            Text(item.prompt.gatewayStableID)
                                .font(AforaType.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .accessibilityLabel("Review exec approval")
                    .accessibilityValue(item.prompt.commandPreview ?? item.prompt.commandText)
                }
            }
        }

        if let pendingApproval {
            Section("Reviewing") {
                ForEach(self.approvalItems, id: \.id) { item in
                    SettingsApprovalRow(item: item)
                }
                if let warningText = pendingApproval.warningText {
                    Label {
                        Text(warningText)
                            .font(AforaType.caption)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                    }
                    .foregroundStyle(AforaBrand.warn)
                    .fixedSize(horizontal: false, vertical: true)
                }
                if let errorText = self.appModel.pendingExecApprovalPromptErrorText {
                    Text(errorText)
                        .font(AforaType.caption)
                        .foregroundStyle(AforaBrand.danger)
                }
                if let resolvedText = self.appModel.pendingExecApprovalPromptResolvedText {
                    Text(resolvedText)
                        .font(AforaType.caption)
                        .foregroundStyle(self.approvalOutcomeColor)
                    Button {
                        self.appModel.dismissPendingExecApprovalPrompt()
                    } label: {
                        Label("Dismiss", systemImage: "xmark")
                            .font(AforaType.body)
                    }
                } else {
                    if pendingApproval.allowsAllowOnce {
                        Button {
                            Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-once") }
                        } label: {
                            Label("Allow Once", systemImage: "checkmark")
                                .font(AforaType.body)
                        }
                        .disabled(self.appModel.pendingExecApprovalPromptResolving)
                    }
                    if pendingApproval.allowsAllowAlways {
                        Button {
                            Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-always") }
                        } label: {
                            Label("Allow Always", systemImage: "checkmark.shield")
                                .font(AforaType.body)
                        }
                        .disabled(self.appModel.pendingExecApprovalPromptResolving)
                    }
                    if pendingApproval.allowsDeny {
                        Button(role: .destructive) {
                            Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "deny") }
                        } label: {
                            Label("Deny", systemImage: "xmark")
                                .font(AforaType.body)
                        }
                        .disabled(self.appModel.pendingExecApprovalPromptResolving)
                    }
                    if self.appModel.pendingExecApprovalPromptResolving,
                       self.appModel.pendingExecApprovalPromptCanDismiss
                    {
                        Button(role: .cancel) {
                            self.appModel.dismissPendingExecApprovalPrompt()
                        } label: {
                            Label("Dismiss", systemImage: "xmark")
                                .font(AforaType.body)
                        }
                    }
                }
            }
        } else if self.pendingApprovalCount == 0 {
            Section {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("No approvals waiting")
                            .font(AforaType.subheadSemiBold)
                        Text(self.approvalEmptyDetail)
                            .font(AforaType.caption)
                            .foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "checkmark.shield.fill")
                        .foregroundStyle(AforaBrand.ok)
                }
            }
        }
    }

    private var approvalOutcomeColor: Color {
        switch self.appModel.pendingExecApprovalPromptOutcome?.tone {
        case .success:
            AforaBrand.ok
        case .danger:
            AforaBrand.danger
        case .warning:
            AforaBrand.warn
        case .neutral, nil:
            .secondary
        }
    }

    var permissionsDestination: some View {
        Group {
            self.toggleCard(
                title: "Camera",
                isOn: self.$cameraEnabled)

            self.locationModeCard

            self.toggleCard(
                title: "Keep Awake",
                isOn: self.$preventSleep)

            self.appleHealthAccessCard
            self.privacyAccessCard
        }
    }

    var voiceDestination: some View {
        Group {
            self.detailStatusCard(
                icon: "waveform",
                title: "Voice & Talk",
                detail: .verbatim(self.appModel.talkMode.gatewayTalkVoiceModeTitle),
                value: .verbatim(self.voiceDetail),
                color: self.talkEnabled || self.voiceWakeEnabled ? AforaBrand.accent : .secondary)

            self.voiceFeatureCard
            self.talkVoiceSettingsCard
            self.shareSettingsCard
        }
    }

    var diagnosticsDestination: some View {
        Group {
            self.detailStatusCard(
                icon: "checklist.checked",
                title: "Health Check",
                detail: "Run app, permission, and gateway-adjacent checks without editing setup.",
                value: .verbatim(self.diagnosticsHealthValue),
                color: self.gatewayDiagnosticConnected ? AforaBrand.ok : AforaBrand.warn)

            Section {
                Button {
                    Task { await self.runDiagnostics() }
                } label: {
                    Label("Run Diagnostics", systemImage: "cross.case")
                        .font(AforaType.body)
                }
                .disabled(self.isRefreshingGateway)
            }

            self.diagnosticChecksCard

            self.detailListCard {
                SettingsDetailRow("Device", value: .verbatim(DeviceInfoHelper.deviceFamily()))
                SettingsDetailRow(
                    "Platform",
                    value: .verbatim(DeviceInfoHelper.platformStringForDisplay()))
                SettingsDetailRow(
                    "App",
                    value: .verbatim(DeviceInfoHelper.aforaVersionString()))
                SettingsDetailRow("Model", value: .verbatim(DeviceInfoHelper.modelIdentifier()))
            }

            self.diagnosticsAdvancedCard
        }
    }

    var privacyDestination: some View {
        Group {
            self.notificationsSection

            self.toggleCard(
                title: "Camera Access",
                isOn: self.$cameraEnabled)

            self.locationModeCard

            self.toggleCard(
                title: "Background Listening",
                isOn: self.$talkBackgroundEnabled)

            self.appleHealthAccessCard
            self.privacyAccessCard
        }
    }

    var notificationsDestination: some View {
        self.notificationsSection
    }

    var notificationsSection: some View {
        Section("Notifications") {
            HStack(spacing: 12) {
                SettingsIcon(systemName: "bell.fill", color: self.notificationStatusColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Notifications")
                        .font(AforaType.subheadSemiBold)
                    Text(self.notificationStatusDetail)
                        .font(AforaType.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Toggle(isOn: self.notificationToggleBinding) {
                    Text("Notifications")
                        .font(AforaType.subheadSemiBold)
                }
                .labelsHidden()
                .disabled(self.notificationStatus == .checking || self.isRequestingNotificationAuthorization)
                .accessibilityIdentifier("settings-notifications-toggle")
                .accessibilityValue(self.notificationServingActive
                    ? String(localized: "On")
                    : String(localized: "Off"))
                .accessibilityHint("Turns Afora notification delivery on or off")
            }

            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "network")
                    .font(AforaType.captionSemiBold)
                    .foregroundStyle(AforaBrand.accent)
                    .frame(width: 22, height: 22)
                Text(self.notificationRelayDetail)
                    .font(AforaType.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityIdentifier("settings-privacy-notifications-section")
    }

    var gatewayActions: some View {
        Group {
            self.gatewayActionButton(
                title: "Reconnect",
                icon: "arrow.triangle.2.circlepath",
                color: AforaBrand.accent,
                isBusy: self.isReconnectingGateway,
                isDisabled: self.appModel.isAppleReviewDemoModeEnabled)
            {
                Task { await self.reconnectGateway() }
            }

            self.gatewayActionButton(
                title: "Diagnose",
                icon: "cross.case",
                color: AforaBrand.accent,
                isBusy: self.isRefreshingGateway)
            {
                Task { await self.runDiagnostics() }
            }
        }
    }

    @ViewBuilder var licensesDestination: some View {
        let documents = LicenseDocumentLoader.bundledDocuments()
        if documents.isEmpty {
            ContentUnavailableView(
                "No Licenses Bundled",
                systemImage: "doc.text",
                description: Text("License files are not available in this build."))
                .font(AforaType.body)
        } else {
            Section {
                ForEach(documents) { document in
                    NavigationLink {
                        LicenseDocumentDetailView(document: document)
                    } label: {
                        Label {
                            Text(document.title)
                                .font(AforaType.subhead)
                        } icon: {
                            SettingsIcon(systemName: "doc.text", color: .gray)
                        }
                    }
                }
            } footer: {
                Text("Afora appreciates its partners in the open-source community.")
                    .font(AforaType.footnote)
            }
            .accessibilityIdentifier("settings-licenses-list")
        }
    }

    /// Native inset-grouped action row (plain tinted text, no pill chrome).
    func gatewayActionButton(
        title: LocalizedStringKey,
        icon: String,
        color: Color,
        isBusy: Bool,
        isDisabled: Bool = false,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            HStack {
                Label(title, systemImage: icon)
                    .font(AforaType.body)
                Spacer()
                if isBusy {
                    ProgressView().controlSize(.small)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(color)
        .disabled(isBusy || isDisabled)
        .accessibilityLabel(Text(title))
    }

    var aboutDestination: some View {
        Group {
            Section {
                VStack(spacing: 12) {
                    AforaProMark(size: 96, shadowRadius: 18, interactive: true)
                        .accessibilityHidden(true)
                    VStack(spacing: 2) {
                        Text("Afora")
                            .font(AforaType.title2SemiBold)
                        Text("Personal AI on your devices")
                            .font(AforaType.footnote)
                            .foregroundStyle(.secondary)
                        SettingsBuildMetadataStrip(metadata: DeviceInfoHelper.buildMetadata())
                            .padding(.top, 8)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 4)
                .accessibilityElement(children: .contain)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }

            // Concise public details only; deep hardware identifiers live in Diagnostics.
            detailListCard {
                SettingsDetailRow("Device", value: .verbatim(DeviceInfoHelper.deviceFamily()))
                SettingsDetailRow(
                    "iOS",
                    value: .verbatim(DeviceInfoHelper.iOSVersionStringForDisplay()))
            }

            Section {
                self.aboutLinkRow(
                    title: "Website",
                    icon: "globe",
                    color: .blue,
                    url: URL(string: "https://afora.ai")!)
                self.aboutLinkRow(
                    title: "Docs",
                    icon: "book.fill",
                    color: .orange,
                    url: URL(string: "https://docs.afora.ai")!)
                self.aboutLinkRow(
                    title: "GitHub",
                    icon: "chevron.left.slash.chevron.right",
                    color: .gray,
                    url: URL(string: "https://github.com/AforaMosh/afora-agent")!)
                self.aboutLinkRow(
                    title: "Discord",
                    icon: "bubble.left.and.bubble.right.fill",
                    color: .indigo,
                    url: URL(string: "https://discord.gg/clawd")!)
            } footer: {
                Text("© 2026 Afora Foundation — MIT License.")
                    .font(AforaType.footnote)
            }
        }
    }

    /// About link row with explicit branded label; shorthand `Link("Title", ...)`
    /// would bypass the typography audit and AforaType styling.
    func aboutLinkRow(
        title: LocalizedStringKey,
        icon: String,
        color: Color,
        url: URL) -> some View
    {
        Link(destination: url) {
            HStack {
                Label {
                    Text(title)
                        .font(AforaType.subheadSemiBold)
                        .foregroundStyle(.primary)
                } icon: {
                    SettingsIcon(systemName: icon, color: color)
                }
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .accessibilityLabel(Text(title))
    }

    func toggleCard(title: LocalizedStringKey, isOn: Binding<Bool>) -> some View {
        Section {
            self.settingsToggle(title, isOn: isOn)
        }
    }

    var locationModeCard: some View {
        Section {
            VStack(alignment: .leading, spacing: 12) {
                Button {
                    self.handleLocationSharingTap()
                } label: {
                    HStack {
                        Text("Location")
                            .font(AforaType.body)
                            .foregroundStyle(.primary)
                        Spacer(minLength: 8)
                        ZStack {
                            AforaToggleIndicator(isOn: self.locationSettingsPresentation.sharingControlIsOn)
                                .opacity(self.isChangingLocationMode ? 0 : 1)
                            if self.isChangingLocationMode {
                                ProgressView()
                                    .controlSize(.small)
                            }
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(self.isChangingLocationMode)
                .accessibilityIdentifier("settings-location-sharing-toggle")
                .accessibilityLabel("Location Sharing")
                .accessibilityValue(self.locationSettingsPresentation.sharingControlIsOn
                    ? String(localized: "On")
                    : String(localized: "Off"))

                if self.locationSettingsPresentation.showsAccessLevel,
                   let accessLevelText = self.locationSettingsPresentation.accessLevelText
                {
                    Divider()
                    Menu {
                        Button {
                            self.selectLocationAccessLevel(.whileUsing)
                        } label: {
                            Text("While Using the App")
                                .font(AforaType.subheadSemiBold)
                        }
                        Button {
                            self.selectLocationAccessLevel(.always)
                        } label: {
                            Text("Always")
                                .font(AforaType.subheadSemiBold)
                        }
                    } label: {
                        HStack(alignment: .firstTextBaseline) {
                            Text("Access Level")
                                .font(AforaType.body)
                                .foregroundStyle(.primary)
                            Spacer(minLength: 8)
                            Text(accessLevelText)
                                .font(AforaType.subhead)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.trailing)
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.secondary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(self.isChangingLocationMode)
                    .accessibilityElement(children: .ignore)
                    .accessibilityIdentifier("settings-location-access-level")
                    .accessibilityLabel("Access Level")
                    .accessibilityValue(accessLevelText)
                    .accessibilityHint("Chooses While Using the App or Always")
                }

                if let locationPermissionDetailText {
                    Text(locationPermissionDetailText)
                        .font(AforaType.caption2)
                        .foregroundStyle(AforaBrand.warn)
                }

                if let locationPermissionWarningText {
                    Text(locationPermissionWarningText)
                        .font(AforaType.caption2)
                        .foregroundStyle(AforaBrand.warn)
                }
            }
        }
    }

    var agentSelectionCard: some View {
        Section {
            Picker("Default Agent", selection: self.$selectedAgentPickerId) {
                Text("Default").font(AforaType.body).tag("")
                let defaultId = (self.appModel.gatewayDefaultAgentId ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                ForEach(
                    self.appModel.gatewayAgents.filter(\.isSelectableAgent).filter { $0.id != defaultId },
                    id: \.id)
                { agent in
                    let name = (agent.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    Text(name.isEmpty ? agent.id : name).font(AforaType.body).tag(agent.id)
                }
            }
            .font(AforaType.body)
        } footer: {
            Text("Used for new Chat and Talk sessions.")
                .font(AforaType.footnote)
        }
    }

    /// One section owns the whole pairing story: scan, paste, and discovered
    /// gateways; splitting these across the page hid Scan QR below plumbing.
    var gatewaySetupCard: some View {
        Section {
            self.gatewayActionButton(
                title: "Scan QR",
                icon: "qrcode.viewfinder",
                color: AforaBrand.accent,
                isBusy: false,
                isDisabled: self.connectingGateway != nil)
            {
                self.openGatewayQRScanner()
            }
            TextField("Paste setup code", text: self.$setupCode)
                .font(AforaType.body)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .disabled(self.connectingGateway != nil)
            self.gatewayActionButton(
                title: "Connect",
                icon: "bolt.horizontal.circle",
                color: AforaBrand.accent,
                isBusy: self.setupAttemptID != nil,
                isDisabled: !self.canApplyGatewaySetup || self.connectingGateway != nil)
            {
                Task { await self.applySetupCodeAndConnect() }
            }
            if self.gatewayController.gateways.isEmpty {
                Text("No gateways found yet. Use manual setup if Bonjour is blocked.")
                    .font(AforaType.subhead)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(self.gatewayController.gateways) { gateway in
                    self.discoveredGatewayRow(gateway)
                }
            }
        } header: {
            Text("Add Gateway")
                .font(AforaType.subheadSemiBold)
        } footer: {
            if let warning = self.tailnetWarningText {
                Text(warning).font(AforaType.footnote).foregroundStyle(AforaBrand.warn)
            } else if let status = self.setupStatusLine {
                Text(status)
                    .font(AforaType.footnote)
            }
        }
    }

    var pairedGatewaysCard: some View {
        Section {
            if self.gatewayRegistry.entries.isEmpty {
                Text("Pair a gateway to make it available here.")
                    .font(AforaType.subhead)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(self.gatewayRegistry.entries) { entry in
                    self.pairedGatewayRow(entry)
                }
            }
        } header: {
            Text("Paired Gateways")
                .font(AforaType.subheadSemiBold)
        } footer: {
            Text("Keep multiple gateways connected and switch which one is in focus.")
                .font(AforaType.footnote)
        }
    }

    func pairedGatewayRow(_ entry: GatewaySettingsStore.GatewayRegistryEntry) -> some View {
        let isActive = GatewayStableIdentifier.matches(
            entry.stableID,
            self.gatewayRegistry.activeStableID)
        let keepsConnected = self.gatewayRegistry.connectedStableIDs.contains {
            GatewayStableIdentifier.matches($0, entry.stableID)
        }
        return HStack(spacing: 12) {
            Button {
                guard !isActive else { return }
                Task { await self.switchGateway(to: entry) }
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(entry.name)
                        .font(AforaType.subheadSemiBold)
                        .foregroundStyle(.primary)
                    Text(self.gatewayEndpointSummary(entry))
                        .font(AforaType.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
            }
            .buttonStyle(.plain)
            .disabled(self.connectingGateway != nil)

            if self.connectingGateway == .gateway(entry.id) {
                ProgressView()
                    .controlSize(.small)
            } else if isActive {
                Image(systemName: "checkmark.circle.fill")
                    .font(AforaType.subheadSemiBold)
                    .foregroundStyle(AforaBrand.accent)
                    .accessibilityLabel("Focused Gateway")
            } else {
                Button {
                    if self.gatewayController.setGatewayConnectionEnabled(
                        stableID: entry.stableID,
                        enabled: !keepsConnected)
                    {
                        self.refreshGatewayRegistry()
                    }
                } label: {
                    Image(systemName: keepsConnected ? "bolt.horizontal.circle.fill" : "bolt.horizontal.circle")
                        .font(AforaType.subheadSemiBold)
                        .foregroundStyle(keepsConnected ? AforaBrand.accent : .secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(keepsConnected ? "Disconnect Gateway" : "Keep Gateway Connected")
            }
        }
        .contentShape(Rectangle())
        .swipeActions {
            Button(role: .destructive) {
                self.pendingForgetGateway = entry
            } label: {
                Label {
                    Text("Forget")
                        .font(AforaType.captionSemiBold)
                } icon: {
                    Image(systemName: "trash")
                }
            }
        }
        .contextMenu {
            Button(role: .destructive) {
                self.pendingForgetGateway = entry
            } label: {
                Label {
                    Text("Forget Gateway")
                        .font(AforaType.body)
                } icon: {
                    Image(systemName: "trash")
                }
            }
        }
    }

    func discoveredGatewayRow(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> some View {
        let availability = self.gatewayController.discoveredGatewayConnectionAvailability(gateway)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: gateway.name)
                        .font(AforaType.subheadSemiBold)
                    Text(verbatim: self.gatewayDetailLines(gateway).joined(separator: " • "))
                        .font(AforaType.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                if availability.canConnect {
                    Button {
                        Task { await self.connect(gateway) }
                    } label: {
                        if self.connectingGateway == .gateway(gateway.id) {
                            ProgressView().controlSize(.small)
                        } else {
                            Text(availability.actionTitle)
                                .font(AforaType.captionSemiBold)
                        }
                    }
                    .font(AforaType.captionSemiBold)
                    .buttonStyle(.bordered)
                    .disabled(self.connectingGateway != nil)
                } else {
                    Text(availability.actionTitle)
                        .font(AforaType.captionSemiBold)
                        .foregroundStyle(AforaBrand.warn)
                }
            }

            if let guidanceText = availability.guidanceText {
                Text(guidanceText)
                    .font(AforaType.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    var manualGatewayCard: some View {
        Section("Manual Gateway") {
            self.settingsToggle("Use Manual Gateway", isOn: self.manualGatewayEnabledBinding)
            TextField("Host", text: self.manualHostBinding)
                .font(AforaType.body)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("Port", text: self.manualPortBinding)
                .font(AforaType.body)
                .keyboardType(.numberPad)
            Picker(selection: self.manualGatewayTLSBinding) {
                Text("Unencrypted")
                    .font(AforaType.captionSemiBold)
                    .tag(false)
                Text("Secure (TLS)")
                    .font(AforaType.captionSemiBold)
                    .tag(true)
            } label: {
                Text("Connection security")
                    .font(AforaType.captionSemiBold)
            }
            .pickerStyle(.segmented)
            .disabled(self.manualGatewayTransport.requiresTLS)
            if let helperText = self.manualGatewayTransport.helperText {
                Text(helperText)
                    .font(AforaType.footnote)
                    .foregroundStyle(.secondary)
            }
            self.gatewayActionButton(
                title: "Connect Manual",
                icon: "network",
                color: AforaBrand.accent,
                isBusy: self.connectingGateway == .manual,
                isDisabled: self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || !self.manualPortIsValid)
            {
                Task { await self.connectManual() }
            }
        }
        .disabled(self.setupAttemptID != nil)
    }

    private var manualGatewayTransport: GatewayManualTransportPresentation {
        GatewayConnectionController.manualTransportPresentation(
            host: self.manualGatewayHost,
            requestedTLS: self.manualGatewayTLS)
    }

    private var manualGatewayTLSBinding: Binding<Bool> {
        Binding(
            get: { self.manualGatewayTransport.effectiveTLS },
            set: { enabled in
                guard !self.manualGatewayTransport.requiresTLS else { return }
                self.manualGatewayContextPath = nil
                self.manualGatewayTLS = enabled
            })
    }

    var gatewayAdvancedCard: some View {
        Section {
            self.settingsToggle("Auto-connect on launch", isOn: self.$gatewayAutoConnect)
            self.gatewaySecureField("Gateway Auth Token", text: self.gatewayTokenBinding)
            self.gatewaySecureField("Gateway Password", text: self.gatewayPasswordBinding)
            if let headersStableID = self.gatewayCustomHeadersTargetStableID {
                NavigationLink {
                    GatewayCustomHeadersSettingsView(gatewayStableID: headersStableID)
                } label: {
                    Text("Custom Headers")
                        .font(AforaType.body)
                }
            }
            Button(role: .destructive) {
                self.showResetOnboardingAlert = true
            } label: {
                Label("Reset Onboarding", systemImage: "arrow.counterclockwise")
                    .font(AforaType.body)
            }
        }
    }

    func gatewaySecureField(
        _ placeholder: LocalizedStringKey,
        text: Binding<String>) -> some View
    {
        ZStack(alignment: .leading) {
            SecureField("", text: text)
                .font(AforaType.subhead)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel(Text(placeholder))
            if text.wrappedValue.isEmpty {
                Text(placeholder)
                    .font(AforaType.subheadSemiBold)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 8)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .font(AforaType.subhead)
    }

    var voiceFeatureCard: some View {
        Section {
            self.settingsToggle("Voice Wake", isOn: self.$voiceWakeEnabled) { enabled in
                self.appModel.setVoiceWakeEnabled(enabled)
            }
            self.settingsToggle("Talk Mode", isOn: self.$talkEnabled) { enabled in
                guard !self.appModel.isAppleReviewDemoModeEnabled else {
                    self.talkEnabled = false
                    return
                }
                self.appModel.setTalkEnabled(enabled)
            }
            .disabled(self.appModel.isAppleReviewDemoModeEnabled)
            Picker("Speech Language", selection: self.$talkSpeechLocale) {
                ForEach(TalkSpeechLocale.supportedOptions()) { option in
                    Text(option.label).font(AforaType.body).tag(option.id)
                }
            }
            .font(AforaType.body)
            self.settingsToggle("Background Listening", isOn: self.$talkBackgroundEnabled)
            self.settingsToggle("Speakerphone", isOn: self.talkSpeakerphoneBinding)
            NavigationLink {
                VoiceWakeWordsSettingsView()
            } label: {
                SettingsDetailRow(
                    "Wake Words",
                    value: .verbatim(
                        VoiceWakePreferences.displayString(for: self.voiceWake.triggerWords)))
            }
        }
    }

    var talkVoiceSettingsCard: some View {
        Group {
            if self.gatewayConnected,
               let issue = self.appModel.talkMode.gatewayTalkCurrentFallbackIssue
            {
                Section {
                    TalkRuntimeIssueBanner(
                        issue: issue,
                        onOpenSettings: nil,
                        onShowDetails: {
                            self.showTalkIssueDetails = true
                        })
                }
            }
            Section("Voice") {
                Picker("Provider", selection: self.talkProviderSelectionBinding) {
                    ForEach(TalkModeProviderSelection.allCases) { option in
                        Text(option.label).font(AforaType.body).tag(option.rawValue)
                    }
                }
                .font(AforaType.body)
                if self.shouldShowRealtimeVoicePicker {
                    Picker("Realtime Voice", selection: self.talkRealtimeVoiceSelectionBinding) {
                        Text("Gateway Default").font(AforaType.body).tag("")
                        ForEach(TalkModeRealtimeVoiceSelection.voices, id: \.self) { voice in
                            Text(TalkModeRealtimeVoiceSelection.label(for: voice)).font(AforaType.body).tag(voice)
                        }
                    }
                    .font(AforaType.body)
                }
                SettingsDetailRow(
                    "Voice Mode",
                    value: .localized(self.appModel.talkMode.gatewayTalkVoiceModeTitle))
                SettingsDetailRow(
                    "Active Voice",
                    value: .verbatim(self.gatewayTalkActiveVoiceDetail))
                if let issue = self.gatewayTalkLastIssueDetail {
                    SettingsDetailRow("Last Voice Issue", value: .verbatim(issue))
                }
                SettingsDetailRow(
                    "Transport",
                    value: .localized(self.appModel.talkMode.gatewayTalkTransportLabel))
                SettingsDetailRow("API Key", value: .verbatim(self.talkApiKeyStatus))
            }
        }
    }

    var shareSettingsCard: some View {
        Section {
            self.settingsToggle("Show Talk Control", isOn: self.$talkButtonEnabled)
            TextField("Default Share Instruction", text: self.$defaultShareInstruction, axis: .vertical)
                .font(AforaType.body)
                .lineLimit(2...5)
                .textInputAutocapitalization(.sentences)
            Button {
                Task { await self.appModel.runSharePipelineSelfTest() }
            } label: {
                Label("Run Share Self-Test", systemImage: "checkmark.seal")
                    .font(AforaType.body)
            }
        } footer: {
            Text(self.appModel.lastShareEventText)
                .font(AforaType.footnote)
        }
    }

    var privacyAccessCard: some View {
        Section {
            PrivacyAccessSectionView()
        }
    }

    var appleHealthAccessCard: some View {
        Section {
            AppleHealthAccessSectionView()
        } header: {
            Text("Apple Health")
                .font(AforaType.captionSemiBold)
                .foregroundStyle(.secondary)
        }
    }

    var diagnosticsAdvancedCard: some View {
        Section {
            self.settingsToggle("Discovery Debug Logs", isOn: self.$discoveryDebugLogsEnabled) { enabled in
                self.gatewayController.setDiscoveryDebugLoggingEnabled(enabled)
            }
            self.settingsToggle("Debug Screen Status", isOn: self.$canvasDebugStatusEnabled)
            NavigationLink {
                GatewayDiscoveryDebugLogView()
            } label: {
                SettingsDetailRow(
                    "Discovery Logs",
                    value: .verbatim(self.gatewayController.discoveryStatusText))
            }
        }
    }

    var deviceIdentityCard: some View {
        Section("Device") {
            TextField("Device Name", text: self.$displayName)
                .font(AforaType.body)
            SettingsDetailRow("Instance ID", value: .verbatim(self.instanceId))
        }
    }

    func settingsToggle(
        _ title: LocalizedStringKey,
        isOn: Binding<Bool>,
        onChange: ((Bool) -> Void)? = nil) -> some View
    {
        // Native Toggle rows can ignore visible-row taps on iOS 26; reuse the shared indicator row.
        Button {
            isOn.wrappedValue.toggle()
        } label: {
            HStack {
                Text(title)
                    .font(AforaType.body)
                Spacer(minLength: 8)
                AforaToggleIndicator(isOn: isOn.wrappedValue)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(title))
        .accessibilityValue(isOn.wrappedValue
            ? String(localized: "On")
            : String(localized: "Off"))
        .onChange(of: isOn.wrappedValue) { _, enabled in
            onChange?(enabled)
        }
    }
}
