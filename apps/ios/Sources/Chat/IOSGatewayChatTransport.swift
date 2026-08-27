import Foundation
import AforaChatUI
import AforaKit
import AforaProtocol
import OSLog

struct IOSGatewayChatTransport: AforaChatTransport {
    static let logger = Logger(subsystem: "ai.aforafoundation.app", category: "ios.chat.transport")
    private let gateway: GatewayNodeSession
    private let widgetGateway: GatewayNodeSession?
    private let globalAgentId: String?
    private let outboxGatewayID: String?
    private let sessionMutationRequest: (@Sendable (AforaChatGatewayRequest) async throws -> Data)?
    private let mediaArtifactLoader: IOSMediaArtifactLoader?

    var outboxRequiresSessionRoutingContract: Bool {
        true
    }

    init(
        gateway: GatewayNodeSession,
        widgetGateway: GatewayNodeSession? = nil,
        globalAgentId: String? = nil,
        outboxGatewayID: String? = nil,
        sessionMutationRequest: (@Sendable (AforaChatGatewayRequest) async throws -> Data)? = nil,
        mediaArtifactLoader: IOSMediaArtifactLoader? = nil)
    {
        self.gateway = gateway
        self.widgetGateway = widgetGateway
        let normalized = globalAgentId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        self.globalAgentId = normalized?.isEmpty == false ? normalized : nil
        let normalizedGatewayID = outboxGatewayID?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.outboxGatewayID = normalizedGatewayID?.isEmpty == false ? normalizedGatewayID : nil
        self.sessionMutationRequest = sessionMutationRequest
        self.mediaArtifactLoader = mediaArtifactLoader
    }

    func acquireOutboxRouteLease() async -> AforaChatTransportRouteLeaseResult {
        guard let outboxGatewayID,
              let route = await gateway.currentRoute(ifGatewayID: outboxGatewayID)
        else { return .unavailable(reason: nil) }
        guard let supportsRoutingContract = await gateway.supportsServerCapability(
            .chatSendRoutingContract,
            ifCurrentRoute: route)
        else { return .unavailable(reason: nil) }
        guard supportsRoutingContract else {
            return .unavailable(
                reason: AforaChatTransportUpgradeMessage.routingContract,
                allowsLiveSend: true)
        }
        let transport = self
        guard let routingContract = try? await transport.sessionRoutingContract(ifCurrentRoute: route)
        else { return .unavailable(reason: nil) }
        return .available(AforaChatTransportRouteLease(
            sendTargetedMessage: { sessionKey, agentID, message, thinking, idempotencyKey, attachments in
                try await transport.sendMessage(
                    sessionKey: sessionKey,
                    agentID: agentID,
                    expectedSessionRoutingContract: routingContract,
                    message: message,
                    thinking: thinking,
                    idempotencyKey: idempotencyKey,
                    attachments: attachments,
                    ifCurrentRoute: route,
                    distinguishPreDispatchRouteChange: true)
            },
            requestTargetedHistory: { sessionKey, agentID in
                try await transport.requestHistory(
                    sessionKey: sessionKey,
                    agentID: agentID,
                    ifCurrentRoute: route)
            },
            sessionRoutingContract: routingContract))
    }

    func acquireSwarmRouteLease() async -> AforaChatSwarmRouteLease? {
        guard let route = await self.currentSessionMutationRoute() else { return nil }
        let transport = self
        return AforaChatSwarmRouteLease(
            isEnabled: { sessionKey in
                try await transport.isSwarmEnabled(sessionKey: sessionKey, ifCurrentRoute: route)
            },
            listChildSessions: { parentKey in
                try await transport.listChildSessions(parentKey: parentKey, ifCurrentRoute: route)
            })
    }

    func acquireSessionSettingsRouteLease() async -> AforaChatSessionSettingsRouteLease? {
        let route = await currentSessionMutationRoute()
        guard let route else { return nil }
        let transport = self
        return AforaChatSessionSettingsRouteLease { sessionKey, agentID, patch in
            try await transport.patchSessionSettings(
                sessionKey: sessionKey,
                agentID: agentID,
                patch: patch,
                ifCurrentRoute: route)
        }
    }

    func acquireSessionMutationRouteLease() async -> AforaChatSessionMutationRouteLease? {
        guard let route = await currentSessionMutationRoute() else { return nil }
        let transport = self
        return AforaChatSessionMutationRouteLease(
            patchSession: { key, expectedSessionID, label, category, pinned, archived, unread in
                let target = transport.sessionTarget(for: key)
                let request = AforaChatGatewayRequests.patchSession(
                    sessionKey: target.sessionKey,
                    agentID: target.agentID,
                    expectedSessionID: expectedSessionID,
                    label: label,
                    category: category,
                    pinned: pinned,
                    archived: archived,
                    unread: unread)
                _ = try await transport.requestSessionMutation(request, ifCurrentRoute: route)
            },
            deleteSession: { key in
                let target = transport.sessionTarget(for: key)
                let request = AforaChatGatewayRequests.deleteSession(
                    sessionKey: target.sessionKey,
                    agentID: target.agentID)
                _ = try await transport.requestSessionMutation(request, ifCurrentRoute: route)
            })
    }

    func acquireSessionGroupsRouteLease() async -> AforaChatSessionGroupsRouteLease? {
        guard let route = await currentSessionMutationRoute() else { return nil }
        let transport = self
        return Self.makeSessionGroupsRouteLease { request in
            try await transport.requestSessionMutation(request, ifCurrentRoute: route)
        }
    }

    func acquireNewSessionRouteLease() async -> AforaChatNewSessionRouteLease? {
        guard let route = await currentSessionMutationRoute() else { return nil }
        let transport = self
        let request: @Sendable (AforaChatGatewayRequest) async throws -> Data = { request in
            try await transport.requestSessionMutation(request, ifCurrentRoute: route)
        }
        return AforaChatNewSessionRouteLease(
            listAgents: {
                let data = try await request(AforaChatGatewayRequests.agentsList())
                let result = try JSONDecoder().decode(AgentsListResult.self, from: data)
                return AforaChatAgentsListResponse(
                    defaultId: result.defaultid,
                    agents: result.agents.filter(\.isSelectableAgent).map {
                        AforaChatAgentChoice(
                            id: $0.id,
                            name: $0.name,
                            workspaceGit: $0.workspacegit)
                    })
            },
            createSession: { key, label, agentID, parentSessionKey, worktree, worktreeBaseRef in
                let createRequest = transport.createSessionRequest(
                    key: key,
                    label: label,
                    agentID: agentID,
                    parentSessionKey: parentSessionKey,
                    worktree: worktree,
                    worktreeBaseRef: worktreeBaseRef)
                let data = try await request(createRequest)
                return try JSONDecoder().decode(AforaChatCreateSessionResponse.self, from: data)
            })
    }

    private func currentSessionMutationRoute() async -> GatewayNodeSessionRoute? {
        if let outboxGatewayID {
            return await self.gateway.currentRoute(ifGatewayID: outboxGatewayID)
        }
        return await self.gateway.currentRoute()
    }

    private func sessionRoutingContract(
        ifCurrentRoute route: GatewayNodeSessionRoute) async throws -> String
    {
        let data = try await gateway.request(
            AforaChatGatewayRequests.agentsList(),
            ifCurrentRoute: route)
        return try AforaChatGatewayPayloadCodec.decodeSessionRoutingIdentity(data).contract
    }

    typealias SessionTarget = AforaChatSessionTarget

    static func sessionTarget(
        for rawSessionKey: String,
        selectedAgentID: String?,
        overrideAgentID: String? = nil) -> SessionTarget
    {
        AforaChatSessionTarget.resolve(
            rawSessionKey,
            selectedAgentID: selectedAgentID,
            overrideAgentID: overrideAgentID,
            policy: .scopeBareKeysToSelectedAgent)
    }

    private func sessionTarget(
        for sessionKey: String,
        overrideAgentID: String? = nil) -> SessionTarget
    {
        Self.sessionTarget(
            for: sessionKey,
            selectedAgentID: self.globalAgentId,
            overrideAgentID: overrideAgentID)
    }

    private func requestSessionMutation(_ request: AforaChatGatewayRequest) async throws -> Data {
        if let sessionMutationRequest {
            return try await sessionMutationRequest(request)
        }
        return try await self.gateway.request(request)
    }

    private func requestSessionMutation(
        _ request: AforaChatGatewayRequest,
        ifCurrentRoute route: GatewayNodeSessionRoute) async throws -> Data
    {
        try await self.gateway.request(
            request,
            ifCurrentRoute: route,
            distinguishPreDispatchRouteChange: true)
    }

    static func makeSessionGroupsRouteLease(
        request: @escaping @Sendable (AforaChatGatewayRequest) async throws -> Data)
        -> AforaChatSessionGroupsRouteLease
    {
        AforaChatSessionGroupsRouteLease(
            listGroups: {
                let data = try await request(AforaChatGatewayRequests.sessionGroupsList())
                return try JSONDecoder().decode(AforaChatSessionGroupsResponse.self, from: data)
            },
            putGroups: { names in
                let data = try await request(AforaChatGatewayRequests.sessionGroupsPut(names: names))
                return try JSONDecoder().decode(AforaChatSessionGroupsMutationResponse.self, from: data)
            },
            renameGroup: { name, to in
                let data = try await request(AforaChatGatewayRequests.sessionGroupsRename(name: name, to: to))
                return try JSONDecoder().decode(AforaChatSessionGroupsMutationResponse.self, from: data)
            },
            deleteGroup: { name in
                let data = try await request(AforaChatGatewayRequests.sessionGroupsDelete(name: name))
                return try JSONDecoder().decode(AforaChatSessionGroupsMutationResponse.self, from: data)
            })
    }

    func createSession(
        key: String,
        label: String?,
        parentSessionKey: String?,
        worktree: Bool?) async throws -> AforaChatCreateSessionResponse
    {
        try await self.createSession(
            key: key,
            label: label,
            agentID: nil,
            parentSessionKey: parentSessionKey,
            worktree: worktree,
            worktreeBaseRef: nil)
    }

    func createSession(
        key: String,
        label: String?,
        agentID: String?,
        parentSessionKey: String?,
        worktree: Bool?,
        worktreeBaseRef: String?) async throws -> AforaChatCreateSessionResponse
    {
        let request = self.createSessionRequest(
            key: key,
            label: label,
            agentID: agentID,
            parentSessionKey: parentSessionKey,
            worktree: worktree,
            worktreeBaseRef: worktreeBaseRef)
        let res = try await requestSessionMutation(request)
        return try JSONDecoder().decode(AforaChatCreateSessionResponse.self, from: res)
    }

    private func createSessionRequest(
        key: String,
        label: String?,
        agentID: String?,
        parentSessionKey: String?,
        worktree: Bool?,
        worktreeBaseRef: String?) -> AforaChatGatewayRequest
    {
        let target = self.sessionTarget(for: key, overrideAgentID: agentID)
        let parentTarget = parentSessionKey.map { self.sessionTarget(for: $0) }
        let explicitAgentID = agentID?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return AforaChatGatewayRequests.createSession(
            key: target.sessionKey,
            agentID: explicitAgentID?.isEmpty == false
                ? explicitAgentID
                : target.agentID ?? parentTarget?.agentID,
            label: label,
            parentSessionKey: parentTarget?.sessionKey,
            worktree: worktree,
            worktreeBaseRef: worktreeBaseRef)
    }

    func abortRun(sessionKey: String, runId: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let request = AforaChatGatewayRequests.abortRun(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            runID: runId)
        _ = try await self.gateway.request(request)
    }

    func listSessions(
        limit: Int?,
        search: String?,
        archived: Bool) async throws -> AforaChatSessionsListResponse
    {
        let request = AforaChatGatewayRequests.sessionsList(
            limit: limit,
            search: search,
            archived: archived)
        let res = try await gateway.request(request)
        return try JSONDecoder().decode(AforaChatSessionsListResponse.self, from: res)
    }

    func listChildSessions(parentKey: String) async throws -> [AforaChatSessionEntry] {
        try await self.listChildSessions(parentKey: parentKey, ifCurrentRoute: nil)
    }

    private func listChildSessions(
        parentKey: String,
        ifCurrentRoute route: GatewayNodeSessionRoute?) async throws -> [AforaChatSessionEntry]
    {
        try await AforaChatChildSessionPager.collect { offset in
            let request = AforaChatGatewayRequests.sessionsList(
                limit: 10000,
                search: nil,
                archived: false,
                includeGlobal: false,
                spawnedBy: parentKey,
                offset: offset,
                configuredAgentsOnly: true)
            let data = try await gateway.request(request, ifCurrentRoute: route)
            return try JSONDecoder().decode(AforaChatSessionsListResponse.self, from: data)
        }
    }

    func listModels() async throws -> [AforaChatModelChoice] {
        let response = try await gateway.request(AforaChatGatewayRequests.modelsList())
        return try AforaChatGatewayPayloadCodec.decodeModelChoices(response)
    }

    func isSwarmEnabled(sessionKey: String) async throws -> Bool {
        try await self.isSwarmEnabled(sessionKey: sessionKey, ifCurrentRoute: nil)
    }

    private func isSwarmEnabled(
        sessionKey: String,
        ifCurrentRoute route: GatewayNodeSessionRoute?) async throws -> Bool
    {
        let request = AforaChatGatewayRequests.chatMetadata(
            sessionKey: sessionKey,
            fallbackAgentID: self.globalAgentId)
        let response = try await gateway.request(request, ifCurrentRoute: route)
        return try JSONDecoder().decode(AforaChatMetadataCapabilities.self, from: response).swarmEnabled
    }

    func setSessionModel(sessionKey: String, model: String?) async throws {
        _ = try await self.patchSessionModel(sessionKey: sessionKey, agentID: nil, model: model)
    }

    func patchSessionModel(
        sessionKey: String,
        agentID: String?,
        model: String?) async throws -> AforaChatModelPatchResult?
    {
        try await self.patchSessionSettings(
            sessionKey: sessionKey,
            agentID: agentID,
            patch: AforaChatSessionSettingsPatch(model: .some(model)))
    }

    func patchSessionSettings(
        sessionKey: String,
        agentID: String?,
        patch: AforaChatSessionSettingsPatch) async throws -> AforaChatModelPatchResult?
    {
        try await self.patchSessionSettings(
            sessionKey: sessionKey,
            agentID: agentID,
            patch: patch,
            ifCurrentRoute: nil)
    }

    private func patchSessionSettings(
        sessionKey: String,
        agentID: String?,
        patch: AforaChatSessionSettingsPatch,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute?) async throws -> AforaChatModelPatchResult?
    {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let request = AforaChatGatewayRequests.patchSessionSettings(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            model: patch.model,
            thinkingLevel: patch.thinkingLevel,
            fastMode: patch.fastMode,
            verboseLevel: patch.verboseLevel)
        let response = if let expectedRoute {
            try await self.gateway.request(
                request,
                ifCurrentRoute: expectedRoute,
                distinguishPreDispatchRouteChange: true)
        } else {
            try await self.requestSessionMutation(request)
        }
        return try Self.decodeModelPatchResult(response)
    }

    static func decodeModelPatchResult(_ data: Data) throws -> AforaChatModelPatchResult {
        try JSONDecoder().decode(AforaChatModelPatchResult.self, from: data)
    }

    func setSessionThinking(sessionKey: String, thinkingLevel: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        _ = try await self.patchSessionSettings(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            patch: AforaChatSessionSettingsPatch(thinkingLevel: .some(thinkingLevel)))
    }

    func patchSession(
        key: String,
        expectedSessionID: String? = nil,
        label: String?? = nil,
        category: String?? = nil,
        pinned: Bool? = nil,
        archived: Bool? = nil,
        unread: Bool? = nil) async throws
    {
        let target = self.sessionTarget(for: key)
        let request = AforaChatGatewayRequests.patchSession(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            expectedSessionID: expectedSessionID,
            label: label,
            category: category,
            pinned: pinned,
            archived: archived,
            unread: unread)
        _ = try await self.requestSessionMutation(request)
    }

    func deleteSession(key: String) async throws {
        let target = self.sessionTarget(for: key)
        let request = AforaChatGatewayRequests.deleteSession(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        _ = try await self.requestSessionMutation(request)
    }

    func forkSession(parentKey: String) async throws -> String {
        try await self.forkSession(parentKey: parentKey, fromLastCompleted: false)
    }

    func forkSession(parentKey: String, fromLastCompleted: Bool) async throws -> String {
        let target = self.sessionTarget(for: parentKey)
        let childAgentID = target.agentID ?? AforaChatSessionKey.agentID(from: target.sessionKey)
        let request = AforaChatGatewayRequests.forkSession(
            parentSessionKey: target.sessionKey,
            agentID: childAgentID,
            fromLastCompleted: fromLastCompleted)
        let response = try await requestSessionMutation(request)
        return try JSONDecoder().decode(AforaChatCreateSessionResponse.self, from: response).key
    }

    func rewindSession(
        sessionKey: String,
        entryId: String) async throws -> AforaChatRewindResponse
    {
        let target = self.sessionTarget(for: sessionKey)
        let request = AforaChatGatewayRequests.rewindSession(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            entryId: entryId)
        let response = try await requestSessionMutation(request)
        return try JSONDecoder().decode(AforaChatRewindResponse.self, from: response)
    }

    func forkSessionAtMessage(
        sessionKey: String,
        entryId: String) async throws -> AforaChatForkAtMessageResponse
    {
        let target = self.sessionTarget(for: sessionKey)
        let request = AforaChatGatewayRequests.forkAtMessage(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            entryId: entryId)
        let response = try await requestSessionMutation(request)
        return try JSONDecoder().decode(AforaChatForkAtMessageResponse.self, from: response)
    }

    func listSessionBranches(
        sessionKey: String,
        agentID: String?) async throws -> AforaChatSessionBranchesResponse
    {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let request = AforaChatGatewayRequests.listSessionBranches(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        let response = try await gateway.request(request)
        return try JSONDecoder().decode(AforaChatSessionBranchesResponse.self, from: response)
    }

    func switchSessionBranch(sessionKey: String, agentID: String?, leafEntryId: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let request = AforaChatGatewayRequests.switchSessionBranch(
            sessionKey: target.sessionKey,
            agentID: agentID ?? target.agentID,
            leafEntryId: leafEntryId)
        _ = try await self.requestSessionMutation(request)
    }

    func setActiveSessionKey(_ sessionKey: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let request = AforaChatGatewayRequests.subscribeSessionMessages(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        _ = try await self.gateway.request(request)
    }

    func resetSession(sessionKey: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let request = AforaChatGatewayRequests.resetSession(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        _ = try await self.gateway.request(request)
    }

    func compactSession(sessionKey: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let request = AforaChatGatewayRequests.compactSession(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        let response = try await gateway.request(request)
        try AforaSessionsCompactResponse.requireSuccess(from: response)
    }

    func requestHistory(sessionKey: String) async throws -> AforaChatHistoryPayload {
        try await self.requestHistory(sessionKey: sessionKey, agentID: nil, ifCurrentRoute: nil)
    }

    func resolveInlineWidgetResource(
        path: String,
        replacing failedResource: AforaChatWidgetResource?) async -> AforaChatWidgetResource?
    {
        let gateway = self.gateway
        let widgetGateway = self.widgetGateway
        return await AforaChatWidgetURLResolver.resolveResource(
            target: path,
            replacing: failedResource,
            currentSurfaceRoutes: {
                let node = await widgetGateway?.currentCanvasHostRoute()
                let operatorSurface = await gateway.currentCanvasHostRoute()
                return (node: node, operatorSurface: operatorSurface)
            },
            // Prefer the device's node route; operator rotation covers clients
            // whose node role is unavailable or intentionally disabled.
            refreshNodeSurfaceRoute: { observed in
                await widgetGateway?.refreshCanvasHostRoute(replacing: observed?.url)
            },
            refreshOperatorSurfaceRoute: { observed in
                await gateway.refreshCanvasHostRoute(replacing: observed?.url)
            })
    }

    func loadMediaArtifact(
        sessionKey: String,
        artifactId: String,
        kind: AforaChatMediaKind,
        playback: AforaChatPlaybackMode?) async throws -> AforaChatLoadedMedia?
    {
        guard kind.acceptsManagedArtifactID(artifactId),
              let mediaArtifactLoader,
              let route = await gateway.currentRoute(),
              let gatewayID = await gateway.currentGatewayID(ifCurrentRoute: route)
        else { return nil }
        let target = self.sessionTarget(for: sessionKey)
        let request = AforaChatGatewayRequests.artifactDownload(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            artifactId: artifactId)
        let data = try await gateway.request(request, ifCurrentRoute: route)
        let response = try JSONDecoder().decode(ArtifactsDownloadResult.self, from: data)
        guard await self.gateway.currentRoute() == route else { throw CancellationError() }
        let loaded = try await mediaArtifactLoader.load(
            response: response,
            kind: kind,
            playback: playback,
            expectedGatewayID: gatewayID)
        guard await self.gateway.currentRoute() == route else { throw CancellationError() }
        return loaded
    }

    func resolveInlineWidgetURL(path: String, replacing failedURL: URL?) async -> URL? {
        await self.resolveInlineWidgetResource(
            path: path,
            replacing: failedURL.map { AforaChatWidgetResource(url: $0) })?.url
    }

    func requestHistory(
        sessionKey: String,
        agentID: String? = nil,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute?) async throws -> AforaChatHistoryPayload
    {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let request = AforaChatGatewayRequests.history(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        let res = try await gateway.request(
            request,
            ifCurrentRoute: expectedRoute)
        return try JSONDecoder().decode(AforaChatHistoryPayload.self, from: res)
    }

    var supportsSlashCommandCatalog: Bool {
        true
    }

    func listCommands(sessionKey: String) async throws -> [AforaChatCommandChoice] {
        let request = AforaChatGatewayRequests.commandsList(
            sessionKey: sessionKey,
            fallbackAgentID: self.globalAgentId)
        let res = try await gateway.request(request)
        let decoded = try JSONDecoder().decode(CommandsListResult.self, from: res)
        return decoded.commands.map(AforaChatGatewayPayloadCodec.commandChoice)
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [AforaChatAttachmentPayload]) async throws -> AforaChatSendResponse
    {
        try await self.sendMessage(
            sessionKey: sessionKey,
            agentID: nil,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments,
            ifCurrentRoute: nil)
    }

    func sendMessage(
        sessionKey: String,
        agentID: String?,
        expectedSessionRoutingContract: String?,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [AforaChatAttachmentPayload]) async throws -> AforaChatSendResponse
    {
        let route: GatewayNodeSessionRoute? = if let outboxGatewayID {
            await self.gateway.currentRoute(ifGatewayID: outboxGatewayID)
        } else {
            await self.gateway.currentRoute()
        }
        guard let route,
              let supportsRoutingContract = await gateway.supportsServerCapability(
                  .chatSendRoutingContract,
                  ifCurrentRoute: route)
        else { throw AforaChatTransportSendError.notDispatched }
        // Durable replay requires the atomic server guard and is blocked in
        // acquireOutboxRouteLease. Keep ordinary live chat compatible with
        // older gateways by retaining the captured route but omitting the
        // unsupported request field.
        let guardedContract = AforaChatSessionRoutingContract.expectedValue(
            expectedSessionRoutingContract,
            serverSupportsGuard: supportsRoutingContract)
        return try await self.sendMessage(
            sessionKey: sessionKey,
            agentID: agentID,
            expectedSessionRoutingContract: guardedContract,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments,
            ifCurrentRoute: route,
            distinguishPreDispatchRouteChange: true)
    }

    func sendMessage(
        sessionKey: String,
        agentID: String? = nil,
        expectedSessionRoutingContract: String? = nil,
        message: String,
        thinking: String?,
        idempotencyKey: String,
        attachments: [AforaChatAttachmentPayload],
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute?,
        distinguishPreDispatchRouteChange: Bool = false) async throws -> AforaChatSendResponse
    {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let startLogMessage =
            "chat.send start sessionKey=\(target.sessionKey) "
                + "len=\(message.count) attachments=\(attachments.count)"
        Self.logger.info(
            "\(startLogMessage, privacy: .public)")
        GatewayDiagnostics.log(startLogMessage)
        let request = AforaChatGatewayRequests.sendMessage(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            expectedSessionRoutingContract: expectedSessionRoutingContract,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments)
        do {
            let res = try await gateway.request(
                request,
                ifCurrentRoute: expectedRoute,
                distinguishPreDispatchRouteChange: distinguishPreDispatchRouteChange)
            let decoded = try JSONDecoder().decode(AforaChatSendResponse.self, from: res)
            Self.logger.info("chat.send ok runId=\(decoded.runId, privacy: .public)")
            GatewayDiagnostics.log("chat.send ok runId=\(decoded.runId) status=\(decoded.status)")
            return decoded
        } catch is GatewayNodeSessionRequestError {
            Self.logger.info("chat.send skipped because the captured route changed before dispatch")
            GatewayDiagnostics.log("chat.send skipped before dispatch: route changed")
            throw AforaChatTransportSendError.notDispatched
        } catch {
            Self.logger.error("chat.send failed \(error.localizedDescription, privacy: .public)")
            GatewayDiagnostics.log("chat.send failed error=\(error.localizedDescription)")
            throw error
        }
    }

    func waitForRunCompletion(
        runId rawRunId: String,
        timeoutMs: Int) async -> AforaChatRunObservation
    {
        let route = await gateway.currentRoute()
        return await self.waitForRunCompletion(
            runId: rawRunId,
            timeoutMs: timeoutMs,
            ifCurrentRoute: route)
    }

    func waitForRunCompletion(
        runId rawRunId: String,
        timeoutMs: Int,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute?) async -> AforaChatRunObservation
    {
        let runId = rawRunId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !runId.isEmpty, let expectedRoute else { return .unavailable }

        do {
            let request = AforaChatGatewayRequests.agentWait(runID: runId, timeoutMs: timeoutMs)
            GatewayDiagnostics.log("agent.wait start runId=\(runId)")
            let res = try await gateway.request(
                request,
                ifCurrentRoute: expectedRoute)
            let observation = try AforaChatGatewayPayloadCodec.decodeAgentWaitObservation(res)
            GatewayDiagnostics.log("agent.wait completed runId=\(runId) observation=\(observation)")
            return observation
        } catch {
            Self.logger.warning("agent.wait failed \(error.localizedDescription, privacy: .public)")
            GatewayDiagnostics.log("agent.wait failed runId=\(runId) error=\(error.localizedDescription)")
            return .unavailable
        }
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        let res = try await gateway.request(AforaChatGatewayRequests.health(timeoutMs: timeoutMs))
        return (try? JSONDecoder().decode(AforaGatewayHealthOK.self, from: res))?.ok ?? true
    }

    func listQuestions() async throws -> [QuestionRecord] {
        let data = try await gateway.request(AforaChatGatewayRequests.questionList())
        return try JSONDecoder().decode(QuestionListResult.self, from: data).questions
    }

    func listTasks(sessionKey: String, agentID: String?) async throws -> [TaskSummary] {
        let data = try await gateway.request(AforaChatGatewayRequests.tasksList(
            sessionKey: sessionKey,
            agentID: agentID))
        return try JSONDecoder().decode(TasksListResult.self, from: data).tasks
    }

    func getQuestion(id: String) async throws -> QuestionRecord {
        let data = try await gateway.request(AforaChatGatewayRequests.questionGet(id: id))
        return try JSONDecoder().decode(QuestionGetResult.self, from: data).question
    }

    func resolveQuestion(id: String, answers: [String: [String]]) async throws {
        _ = try await self.gateway.request(AforaChatGatewayRequests.resolveQuestion(id: id, answers: answers))
    }

    func cancelQuestion(id: String) async throws {
        _ = try await self.gateway.request(AforaChatGatewayRequests.cancelQuestion(id: id))
    }

    func events() -> AsyncStream<AforaChatTransportEvent> {
        AsyncStream { continuation in
            let task = Task {
                let stream = await self.gateway.subscribeServerEvents()
                for await evt in stream {
                    if Task.isCancelled {
                        return
                    }
                    if let mapped = AforaChatGatewayPayloadCodec.event(from: evt) {
                        continuation.yield(mapped)
                    }
                }
            }

            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
        }
    }
}
