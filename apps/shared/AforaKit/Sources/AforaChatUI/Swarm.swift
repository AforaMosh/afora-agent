import SwiftUI

private let maxTrackedSwarmGroups = 10000
private let maxTrackedSwarmChildren = 100_000
private let maxRenderedSwarmDotsPerPhase = 256
private let swarmRefreshRetryDelays = [1.0, 2.0, 4.0]

struct AforaChatSwarmActivityState: Equatable {
    private var currentPhaseByGroup: [String: String] = [:]
    private var phaseRankByGroupPhase: [String: Int] = [:]
    private var nextPhaseRank = 0
    private var latestLogByGroup: [String: String] = [:]
    private var phaseByChild: [String: String] = [:]

    mutating func clear() {
        self = AforaChatSwarmActivityState()
    }

    mutating func observe(_ event: AforaChatSessionsChangedEvent) -> Bool {
        guard let groupID = Self.normalized(event.swarmGroupId) else { return false }
        let kind = Self.normalized(event.kind)
        let text = Self.normalized(event.text)
        if let text, kind == "phase" || kind == "log" {
            if kind == "phase" {
                let rankKey = Self.phaseRankKey(groupID: groupID, phase: text)
                if self.phaseRankByGroupPhase[rankKey] == nil {
                    Self.setBounded(
                        &self.phaseRankByGroupPhase,
                        key: rankKey,
                        value: self.nextPhaseRank,
                        limit: maxTrackedSwarmChildren)
                    self.nextPhaseRank += 1
                }
                Self.setBounded(
                    &self.currentPhaseByGroup,
                    key: groupID,
                    value: text,
                    limit: maxTrackedSwarmGroups)
            } else {
                Self.setBounded(
                    &self.latestLogByGroup,
                    key: groupID,
                    value: text,
                    limit: maxTrackedSwarmGroups)
            }
            return true
        }

        guard let childKey = Self.normalized(event.sessionKey) else { return true }
        if let phase = Self.normalized(event.swarmPhase) {
            Self.setBounded(
                &self.phaseByChild,
                key: childKey,
                value: phase,
                limit: maxTrackedSwarmChildren)
            return true
        }
        if event.reason == "create",
           self.phaseByChild[childKey] == nil,
           let currentPhase = currentPhaseByGroup[groupID]
        {
            Self.setBounded(
                &self.phaseByChild,
                key: childKey,
                value: currentPhase,
                limit: maxTrackedSwarmChildren)
        }
        return true
    }

    func decorate(_ sessions: [AforaChatSessionEntry]) -> [AforaChatSessionEntry] {
        sessions.map { row in
            guard let groupID = Self.normalized(row.swarmGroupId) else { return row }
            let phase = self.phaseByChild[row.key] ?? row.swarmPhase
            let rank = phase.flatMap { self.phaseRankByGroupPhase[Self.phaseRankKey(groupID: groupID, phase: $0)] }
                ?? row.swarmPhaseRank
            let log = self.latestLogByGroup[groupID] ?? row.swarmLog
            var decorated = row
            decorated.swarmPhase = phase
            decorated.swarmPhaseRank = rank
            decorated.swarmLog = log
            return decorated
        }
    }

    private static func normalized(_ value: String?) -> String? {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized?.isEmpty == false ? normalized : nil
    }

    private static func phaseRankKey(groupID: String, phase: String) -> String {
        "\(groupID)\u{0}\(phase)"
    }

    private static func setBounded<Value>(
        _ values: inout [String: Value],
        key: String,
        value: Value,
        limit: Int)
    {
        if values[key] == nil, values.count >= limit, let evicted = values.keys.first {
            values.removeValue(forKey: evicted)
        }
        values[key] = value
    }
}

enum AforaChatSwarmDotStatus: Int, Comparable, Sendable {
    case running
    case queued
    case failed
    case done

    static func < (lhs: Self, rhs: Self) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    var label: String {
        switch self {
        case .running: String(localized: "Running")
        case .queued: String(localized: "Queued")
        case .failed: String(localized: "Failed")
        case .done: String(localized: "Done")
        }
    }
}

struct AforaChatSwarmDot: Identifiable, Sendable {
    let id: String
    let label: String
    let status: AforaChatSwarmDotStatus
}

struct AforaChatSwarmPhase: Identifiable, Sendable {
    let id: String
    let title: String?
    let dots: [AforaChatSwarmDot]
    let hidden: Int
}

struct AforaChatSwarmGroup: Identifiable, Sendable {
    let id: String
    let label: String
    let running: Int
    let done: Int
    let failed: Int
    let narrator: String?
    let phases: [AforaChatSwarmPhase]
}

func buildAforaChatSwarmGroups(
    sessions: [AforaChatSessionEntry],
    matchesParent: (String) -> Bool) -> [AforaChatSwarmGroup]
{
    struct Entry {
        let phase: String?
        let phaseRank: Int
        let log: String?
        let dot: AforaChatSwarmDot
    }

    var byGroup: [String: [Entry]] = [:]
    for row in sessions {
        guard let groupID = row.swarmGroupId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !groupID.isEmpty,
              SelfContainedSwarmHelpers.belongsToParent(row, groupID: groupID, matchesParent: matchesParent),
              let status = SelfContainedSwarmHelpers.status(row)
        else { continue }
        let label = [row.label, row.displayName, row.derivedTitle, row.key]
            .compactMap { value -> String? in
                let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines)
                return normalized?.isEmpty == false ? normalized : nil
            }
            .first ?? row.key
        byGroup[groupID, default: []].append(Entry(
            phase: row.swarmPhase?.trimmingCharacters(in: .whitespacesAndNewlines),
            phaseRank: row.swarmPhaseRank ?? .max,
            log: row.swarmLog?.trimmingCharacters(in: .whitespacesAndNewlines),
            dot: AforaChatSwarmDot(id: row.key, label: label, status: status)))
    }

    return byGroup.map { groupID, entries in
        var phaseBuckets: [String: (title: String?, rank: Int, dots: [AforaChatSwarmDot])] = [:]
        for entry in entries {
            let phaseKey = entry.phase?.isEmpty == false ? entry.phase! : "\u{0}"
            var bucket = phaseBuckets[phaseKey] ?? (entry.phase, entry.phaseRank, [])
            bucket.rank = min(bucket.rank, entry.phaseRank)
            bucket.dots.append(entry.dot)
            phaseBuckets[phaseKey] = bucket
        }
        let phases = phaseBuckets.map { key, bucket -> AforaChatSwarmPhase in
            let ordered = bucket.dots.count > maxRenderedSwarmDotsPerPhase
                ? bucket.dots.sorted { $0.status < $1.status }
                : bucket.dots
            return AforaChatSwarmPhase(
                id: key,
                title: bucket.title,
                dots: Array(ordered.prefix(maxRenderedSwarmDotsPerPhase)),
                hidden: max(0, ordered.count - maxRenderedSwarmDotsPerPhase))
        }.sorted { lhs, rhs in
            let leftRank = phaseBuckets[lhs.id]?.rank ?? .max
            let rightRank = phaseBuckets[rhs.id]?.rank ?? .max
            if leftRank != rightRank {
                return leftRank < rightRank
            }
            return lhs.id < rhs.id
        }
        let dots = entries.map(\.dot)
        return AforaChatSwarmGroup(
            id: groupID,
            label: groupID.split(separator: ":").last.map(String.init) ?? groupID,
            running: dots.count { $0.status == .running },
            done: dots.count { $0.status == .done },
            failed: dots.count { $0.status == .failed },
            narrator: entries.compactMap(\.log).first { !$0.isEmpty },
            phases: phases)
    }.filter { group in
        group.phases.contains { phase in
            phase.dots.contains { $0.status == .queued || $0.status == .running }
        }
    }.sorted { $0.id < $1.id }
}

enum SelfContainedSwarmHelpers {
    static func status(_ row: AforaChatSessionEntry) -> AforaChatSwarmDotStatus? {
        if row.status == "running" || row.hasActiveRun == true {
            return .running
        }
        if row.status == "done" {
            return .done
        }
        if row.status == "failed" || row.status == "killed" || row.status == "timeout" {
            return .failed
        }
        return row.subagentRunState == "active" || row.hasActiveSubagentRun == true ? .queued : nil
    }

    static func belongsToParent(
        _ row: AforaChatSessionEntry,
        groupID: String,
        matchesParent: (String) -> Bool) -> Bool
    {
        if let parent = row.parentSessionKey, matchesParent(parent) {
            return true
        }
        if let spawnedBy = row.spawnedBy, matchesParent(spawnedBy) {
            return true
        }
        return self.generatedGroupBelongsToParent(groupID, matchesParent: matchesParent)
    }

    static func isActivityNote(_ event: AforaChatSessionsChangedEvent) -> Bool {
        let kind = self.normalized(event.kind)
        return kind == "phase" || kind == "log"
    }

    static func eventBelongsToParent(
        _ event: AforaChatSessionsChangedEvent,
        matchesParent: (String) -> Bool) -> Bool
    {
        if let parent = normalized(event.parentSessionKey) ?? normalized(event.spawnedBy) {
            return matchesParent(parent)
        }
        let kind = self.normalized(event.kind)
        if kind == "phase" || kind == "log" {
            guard let sessionKey = normalized(event.sessionKey) else { return false }
            return matchesParent(sessionKey)
        }
        guard let groupID = normalized(event.swarmGroupId) else { return false }
        return self.generatedGroupBelongsToParent(groupID, matchesParent: matchesParent)
    }

    private static func generatedGroupBelongsToParent(
        _ groupID: String,
        matchesParent: (String) -> Bool) -> Bool
    {
        let parts = groupID.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.first == "swarm", parts.count > 2 else { return false }
        return matchesParent(parts.dropFirst().dropLast().joined(separator: ":"))
    }

    private static func normalized(_ value: String?) -> String? {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized?.isEmpty == false ? normalized : nil
    }
}

extension AforaChatViewModel {
    private func updateSwarmProjection() {
        self.activeSwarmGroups = buildAforaChatSwarmGroups(sessions: self.swarmSessions) { candidate in
            self.matchesCurrentSessionKey(incoming: candidate, current: self.sessionKey)
        }
    }

    func observeSwarmEvent(_ event: AforaChatSessionsChangedEvent) -> Bool {
        guard swarmEnabled,
              SelfContainedSwarmHelpers.eventBelongsToParent(event, matchesParent: { candidate in
                  self.matchesCurrentSessionKey(
                      incoming: candidate,
                      agentId: event.agentId,
                      current: self.sessionKey)
              })
        else { return false }
        var nextActivity = swarmActivityState
        guard nextActivity.observe(event) else { return false }
        swarmActivityState = nextActivity
        swarmSessions = nextActivity.decorate(swarmSessions)
        self.updateSwarmProjection()
        if event.kind != "phase", event.kind != "log" {
            self.scheduleSwarmRefresh()
        }
        return true
    }

    func refreshSwarmCapability(
        sessionSnapshot: SessionSnapshot? = nil,
        retryAttempt: Int = 0) async
    {
        let requestedKey = sessionSnapshot?.key ?? sessionKey
        guard matchesCurrentSessionKey(incoming: requestedKey, current: sessionKey) else { return }
        guard let routeLease = await transport.acquireSwarmRouteLease() else {
            self.scheduleSwarmCapabilityRetry(
                sessionKey: requestedKey,
                sessionSnapshot: sessionSnapshot,
                retryAttempt: retryAttempt)
            return
        }
        do {
            let enabled = try await routeLease.isEnabled(sessionKey: requestedKey)
            guard matchesCurrentSessionKey(incoming: requestedKey, current: sessionKey) else { return }
            swarmEnabled = enabled
            guard enabled else {
                self.resetSwarmProgress()
                return
            }
            await self.refreshSwarmSessions(
                sessionKey: requestedKey,
                sessionSnapshot: sessionSnapshot,
                routeLease: routeLease)
        } catch {
            guard matchesCurrentSessionKey(incoming: requestedKey, current: sessionKey) else { return }
            chatUILogger.debug("swarm capability refresh failed: \(error.localizedDescription, privacy: .public)")
            self.scheduleSwarmCapabilityRetry(
                sessionKey: requestedKey,
                sessionSnapshot: sessionSnapshot,
                retryAttempt: retryAttempt)
        }
    }

    private func scheduleSwarmCapabilityRetry(
        sessionKey requestedKey: String,
        sessionSnapshot: SessionSnapshot?,
        retryAttempt: Int)
    {
        guard matchesCurrentSessionKey(incoming: requestedKey, current: sessionKey),
              swarmRefreshRetryDelays.indices.contains(retryAttempt)
        else { return }
        let delay = swarmRefreshRetryDelays[retryAttempt]
        swarmRefreshTask?.cancel()
        swarmRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.refreshSwarmCapability(
                sessionSnapshot: sessionSnapshot,
                retryAttempt: retryAttempt + 1)
        }
    }

    func scheduleSwarmRefresh() {
        guard swarmEnabled else { return }
        let requestedKey = sessionKey
        swarmRefreshTask?.cancel()
        swarmRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await self?.refreshSwarmSessions(sessionKey: requestedKey)
        }
    }

    func refreshSwarmSessions(
        sessionKey requestedSessionKey: String? = nil,
        sessionSnapshot: SessionSnapshot? = nil,
        routeLease: AforaChatSwarmRouteLease? = nil,
        retryAttempt: Int = 0) async
    {
        guard swarmEnabled else { return }
        let requestedKey = requestedSessionKey ?? sessionSnapshot?.key ?? sessionKey
        guard matchesCurrentSessionKey(incoming: requestedKey, current: sessionKey) else { return }
        let activeRouteLease: AforaChatSwarmRouteLease
        if let routeLease {
            activeRouteLease = routeLease
        } else if let capturedRouteLease = await transport.acquireSwarmRouteLease() {
            guard swarmEnabled,
                  matchesCurrentSessionKey(incoming: requestedKey, current: sessionKey)
            else { return }
            do {
                let enabled = try await capturedRouteLease.isEnabled(sessionKey: requestedKey)
                guard swarmEnabled,
                      matchesCurrentSessionKey(incoming: requestedKey, current: sessionKey)
                else { return }
                guard enabled else {
                    swarmEnabled = false
                    self.resetSwarmProgress()
                    return
                }
            } catch {
                guard swarmEnabled,
                      matchesCurrentSessionKey(incoming: requestedKey, current: sessionKey)
                else { return }
                self.scheduleSwarmSessionRetry(
                    sessionKey: requestedKey,
                    sessionSnapshot: sessionSnapshot,
                    retryAttempt: retryAttempt)
                return
            }
            guard swarmEnabled,
                  matchesCurrentSessionKey(incoming: requestedKey, current: sessionKey)
            else { return }
            activeRouteLease = capturedRouteLease
        } else {
            guard swarmEnabled,
                  matchesCurrentSessionKey(incoming: requestedKey, current: sessionKey)
            else { return }
            self.scheduleSwarmSessionRetry(
                sessionKey: requestedKey,
                sessionSnapshot: sessionSnapshot,
                retryAttempt: retryAttempt)
            return
        }
        guard swarmEnabled,
              matchesCurrentSessionKey(incoming: requestedKey, current: sessionKey)
        else { return }
        if swarmSessionKey != sessionKey {
            swarmSessionKey = sessionKey
            swarmActivityState.clear()
            swarmSessions = []
            self.updateSwarmProjection()
        }
        swarmRefreshGeneration &+= 1
        let generation = swarmRefreshGeneration
        do {
            let rows = try await activeRouteLease.listChildSessions(parentKey: requestedKey)
            guard generation == swarmRefreshGeneration,
                  swarmEnabled,
                  matchesCurrentSessionKey(incoming: requestedKey, current: sessionKey)
            else { return }
            swarmSessions = swarmActivityState.decorate(rows)
            self.updateSwarmProjection()
        } catch {
            guard generation == swarmRefreshGeneration,
                  swarmEnabled,
                  matchesCurrentSessionKey(incoming: requestedKey, current: sessionKey)
            else { return }
            chatUILogger.debug("swarm child refresh failed: \(error.localizedDescription, privacy: .public)")
            self.scheduleSwarmSessionRetry(
                sessionKey: requestedKey,
                sessionSnapshot: sessionSnapshot,
                retryAttempt: retryAttempt)
        }
    }

    private func scheduleSwarmSessionRetry(
        sessionKey requestedKey: String,
        sessionSnapshot: SessionSnapshot?,
        retryAttempt: Int)
    {
        guard swarmEnabled,
              matchesCurrentSessionKey(incoming: requestedKey, current: sessionKey),
              swarmRefreshRetryDelays.indices.contains(retryAttempt)
        else { return }
        let delay = swarmRefreshRetryDelays[retryAttempt]
        swarmRefreshTask?.cancel()
        swarmRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.refreshSwarmSessions(
                sessionKey: requestedKey,
                sessionSnapshot: sessionSnapshot,
                retryAttempt: retryAttempt + 1)
        }
    }

    func resetSwarmProgress() {
        swarmRefreshTask?.cancel()
        swarmRefreshTask = nil
        swarmRefreshGeneration &+= 1
        swarmSessionKey = sessionKey
        swarmActivityState.clear()
        swarmSessions = []
        self.updateSwarmProjection()
    }
}

struct AforaChatSwarmProgressView: View {
    let groups: [AforaChatSwarmGroup]

    var body: some View {
        if !self.groups.isEmpty {
            ScrollView(.vertical) {
                VStack(spacing: 6) {
                    ForEach(self.groups) { group in
                        AforaChatSwarmGroupView(group: group)
                    }
                }
                .padding(.trailing, 2)
            }
            .frame(maxHeight: 260)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text("Swarm"))
        }
    }
}

private struct AforaChatSwarmGroupView: View {
    let group: AforaChatSwarmGroup

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: self.group.label)
                    .font(AforaChatTypography.captionSemiBold)
                    .lineLimit(1)
                Text(verbatim: String(
                    format: String(localized: "%1$lld Running · %2$lld Done · %3$lld Failed"),
                    Int64(self.group.running),
                    Int64(self.group.done),
                    Int64(self.group.failed)))
                    .font(AforaChatTypography.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            if let narrator = self.group.narrator, !narrator.isEmpty {
                Text(verbatim: narrator)
                    .font(AforaChatTypography.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            ForEach(self.group.phases) { phase in
                HStack(alignment: .top, spacing: 8) {
                    Text(verbatim: phase.title ?? String(localized: "Unphased"))
                        .font(AforaChatTypography.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .frame(minWidth: 56, alignment: .leading)
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: 9, maximum: 9), spacing: 6)],
                        alignment: .leading,
                        spacing: 6)
                    {
                        ForEach(phase.dots) { dot in
                            AforaChatSwarmDotView(dot: dot)
                        }
                        if phase.hidden > 0 {
                            Text(verbatim: "+\(phase.hidden)")
                                .font(AforaChatTypography.caption2)
                                .foregroundStyle(.secondary)
                                .accessibilityLabel(Text(
                                    verbatim: phase.hidden == 1
                                        ? String(localized: "1 more worker")
                                        : String(
                                            format: String(localized: "%1$lld more workers"),
                                            Int64(phase.hidden))))
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(AforaChatTheme.assistantBubble.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(AforaChatTheme.accent.opacity(0.2), lineWidth: 1)
        }
    }
}

private struct AforaChatSwarmDotView: View {
    let dot: AforaChatSwarmDot

    var body: some View {
        self.shape
            .frame(width: 9, height: 9)
            .accessibilityElement()
            .accessibilityLabel(Text(verbatim: "\(self.dot.label): \(self.dot.status.label)"))
    }

    @ViewBuilder
    private var shape: some View {
        switch self.dot.status {
        case .queued:
            Circle().stroke(AforaChatTheme.muted, lineWidth: 1)
        case .running:
            Circle().fill(AforaChatTheme.accent)
        case .done:
            Circle().fill(AforaChatTheme.success)
        case .failed:
            RoundedRectangle(cornerRadius: 2)
                .fill(AforaChatTheme.danger)
                .rotationEffect(.degrees(45))
                .scaleEffect(0.82)
        }
    }
}
