import Foundation
import AforaChatUI
import AforaProtocol

extension MacGatewayChatTransport {
    func acquireNewSessionRouteLease() async -> AforaChatNewSessionRouteLease? {
        guard let serverLease = await self.connection.captureServerLease() else { return nil }
        guard await self.currentOutboxGatewayMatchesConnection() else { return nil }
        let request: @Sendable (AforaChatGatewayRequest) async throws -> Data = { request in
            try await self.connection.request(
                method: request.method,
                params: request.params,
                timeoutMs: request.timeoutMs,
                ifCurrentServerLease: serverLease)
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
            createSession: { key, label, explicitAgentID, parentSessionKey, worktree, worktreeBaseRef in
                let agentID = explicitAgentID
                    ?? AforaChatSessionKey.agentID(from: key)
                    ?? parentSessionKey.flatMap { AforaChatSessionKey.agentID(from: $0) }
                let createRequest = AforaChatGatewayRequests.createSession(
                    key: key,
                    agentID: agentID,
                    label: label,
                    parentSessionKey: parentSessionKey,
                    worktree: worktree,
                    worktreeBaseRef: worktreeBaseRef)
                let data = try await request(createRequest)
                return try JSONDecoder().decode(AforaChatCreateSessionResponse.self, from: data)
            })
    }

    func acquireSessionGroupsRouteLease() async -> AforaChatSessionGroupsRouteLease? {
        guard let serverLease = await self.connection.captureServerLease() else { return nil }
        guard await self.currentOutboxGatewayMatchesConnection() else { return nil }
        let request: @Sendable (AforaChatGatewayRequest) async throws -> Data = { request in
            try await self.connection.request(
                method: request.method,
                params: request.params,
                timeoutMs: request.timeoutMs,
                ifCurrentServerLease: serverLease)
        }
        return AforaChatSessionGroupsRouteLease(
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

    func acquireSessionMutationRouteLease() async -> AforaChatSessionMutationRouteLease? {
        guard let serverLease = await self.connection.captureServerLease() else { return nil }
        guard await self.currentOutboxGatewayMatchesConnection() else { return nil }
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
                _ = try await self.connection.request(
                    method: request.method,
                    params: request.params,
                    timeoutMs: request.timeoutMs,
                    ifCurrentServerLease: serverLease)
            },
            deleteSession: { key in
                let target = transport.sessionTarget(for: key)
                let request = AforaChatGatewayRequests.deleteSession(
                    sessionKey: target.sessionKey,
                    agentID: target.agentID)
                _ = try await self.connection.request(
                    method: request.method,
                    params: request.params,
                    timeoutMs: request.timeoutMs,
                    ifCurrentServerLease: serverLease)
            })
    }

    private func requestSessionAction(_ request: AforaChatGatewayRequest) async throws -> Data {
        guard let serverLease = await self.connection.captureServerLease() else {
            throw AforaChatTransportSendError.notDispatched
        }
        try await self.requireCurrentOutboxGateway()
        return try await self.connection.request(
            method: request.method,
            params: request.params,
            timeoutMs: request.timeoutMs,
            ifCurrentServerLease: serverLease)
    }

    func forkSession(parentKey: String) async throws -> String {
        try await self.forkSession(parentKey: parentKey, fromLastCompleted: false)
    }

    func forkSession(parentKey: String, fromLastCompleted: Bool) async throws -> String {
        let target = self.sessionTarget(for: parentKey)
        let request = AforaChatGatewayRequests.forkSession(
            parentSessionKey: target.sessionKey,
            agentID: target.agentID,
            fromLastCompleted: fromLastCompleted)
        let data = try await self.requestSessionAction(request)
        return try JSONDecoder().decode(AforaChatCreateSessionResponse.self, from: data).key
    }

    func rewindSession(
        sessionKey: String,
        entryId: String) async throws -> AforaChatRewindResponse
    {
        let target = self.sessionTarget(for: sessionKey)
        let request = Self.rewindSessionRequest(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            entryId: entryId)
        let data = try await self.requestSessionAction(request)
        return try JSONDecoder().decode(AforaChatRewindResponse.self, from: data)
    }

    func forkSessionAtMessage(
        sessionKey: String,
        entryId: String) async throws -> AforaChatForkAtMessageResponse
    {
        let target = self.sessionTarget(for: sessionKey)
        let request = Self.forkSessionAtMessageRequest(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            entryId: entryId)
        let data = try await self.requestSessionAction(request)
        return try JSONDecoder().decode(AforaChatForkAtMessageResponse.self, from: data)
    }

    func listSessionBranches(
        sessionKey: String,
        agentID: String?) async throws -> AforaChatSessionBranchesResponse
    {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let request = AforaChatGatewayRequests.listSessionBranches(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        let data = try await self.requestSessionAction(request)
        return try JSONDecoder().decode(AforaChatSessionBranchesResponse.self, from: data)
    }

    func switchSessionBranch(sessionKey: String, agentID: String?, leafEntryId: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let request = AforaChatGatewayRequests.switchSessionBranch(
            sessionKey: target.sessionKey,
            agentID: agentID ?? target.agentID,
            leafEntryId: leafEntryId)
        _ = try await self.requestSessionAction(request)
    }

    static func rewindSessionRequest(
        sessionKey: String,
        agentID: String?,
        entryId: String) -> AforaChatGatewayRequest
    {
        AforaChatGatewayRequests.rewindSession(
            sessionKey: sessionKey,
            agentID: agentID,
            entryId: entryId)
    }

    static func forkSessionAtMessageRequest(
        sessionKey: String,
        agentID: String?,
        entryId: String) -> AforaChatGatewayRequest
    {
        AforaChatGatewayRequests.forkAtMessage(
            sessionKey: sessionKey,
            agentID: agentID,
            entryId: entryId)
    }
}
