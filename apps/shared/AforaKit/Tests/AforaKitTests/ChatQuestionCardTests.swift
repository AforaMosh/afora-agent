import Foundation
import AforaProtocol
import Testing
@testable import AforaChatUI

@MainActor
private func questionRecord(
    multiSelect: Bool = false,
    isOther: Bool = true,
    createdAtMs: Int = 1_000_000,
    expiresAtMs: Int = 4_000_000_000_000,
    status: QuestionStatus = .pending,
    answers: QuestionAnswers? = nil,
    runId: String? = "run-question") -> QuestionRecord
{
    QuestionRecord(
        id: "ask_123",
        questions: [
            Question(
                questionid: "meal",
                header: "Meal",
                question: "Choose dinner",
                options: [
                    QuestionOption(label: "Pizza", description: "Fast"),
                    QuestionOption(label: "Tacos"),
                ],
                multiselect: multiSelect,
                isother: isOther),
        ],
        agentid: "main",
        sessionkey: "agent:main:main",
        runid: runId,
        createdatms: createdAtMs,
        expiresatms: expiresAtMs,
        status: status,
        answers: answers)
}

@MainActor
@Test func `question card single select and other are exclusive`() {
    let model = AforaQuestionCardModel(record: questionRecord())
    model.toggleOption(questionID: "meal", label: "Pizza")
    #expect(model.beginSubmission() == ["meal": ["Pizza"]])
    model.failSubmission("retry")

    model.setOtherText(questionID: "meal", value: "  Salad  ")
    #expect(model.selectedOptions["meal"]?.isEmpty == true)
    #expect(model.beginSubmission() == ["meal": ["Salad"]])
}

@MainActor
@Test func `question card multi select uses declared option order`() {
    let model = AforaQuestionCardModel(record: questionRecord(multiSelect: true))
    model.toggleOption(questionID: "meal", label: "Tacos")
    model.toggleOption(questionID: "meal", label: "Pizza")
    #expect(model.beginSubmission() == ["meal": ["Pizza", "Tacos"]])
}

@MainActor
@Test func `question card number selection uses declared option order`() {
    let model = AforaQuestionCardModel(record: questionRecord(multiSelect: true))

    #expect(model.toggleOption(questionID: "meal", optionNumber: 2))
    #expect(model.toggleOption(questionID: "meal", optionNumber: 1))
    #expect(!model.toggleOption(questionID: "meal", optionNumber: 4))
    #expect(model.beginSubmission() == ["meal": ["Pizza", "Tacos"]])
}

@MainActor
@Test func `question card maps expiry and answer origin`() {
    let now = Date(timeIntervalSince1970: 1500)
    let expired = AforaQuestionCardModel(record: questionRecord(expiresAtMs: 1_499_000))
    #expect(expired.status(at: now) == .expired)
    #expect(expired.remainingSeconds(at: now) == 0)

    let remote = AforaQuestionCardModel(record: questionRecord())
    remote.apply(resolved: AforaQuestionResolvedEvent(id: remote.id, status: .answered))
    #expect(remote.status(at: Date(timeIntervalSince1970: 1500)) == .answeredElsewhere)

    let local = AforaQuestionCardModel(record: questionRecord())
    local.markAnsweredLocally(answers: ["meal": ["Pizza"]])
    local.apply(resolved: AforaQuestionResolvedEvent(id: local.id, status: .answered))
    #expect(local.status(at: Date(timeIntervalSince1970: 1500)) == .answered)
}

@MainActor
@Test func `question card pending refresh preserves submission`() {
    let model = AforaQuestionCardModel(record: questionRecord(expiresAtMs: Int.max))
    model.toggleOption(questionID: "meal", label: "Pizza")
    #expect(model.beginSubmission() != nil)

    #expect(model.apply(record: questionRecord(createdAtMs: 2_000_000, expiresAtMs: Int.max)))
    #expect(model.status(at: Date(timeIntervalSince1970: 1500)) == .submitting)

    #expect(model.apply(record: questionRecord(createdAtMs: 2_000_000, expiresAtMs: Int.max, status: .answered)))
    #expect(model.status(at: Date(timeIntervalSince1970: 1500)) == .answeredElsewhere)
}

@MainActor
@Test func `question card ignores replayed pending record after terminal event`() {
    let model = AforaQuestionCardModel(record: questionRecord())
    model.apply(resolved: .init(id: model.id, status: .answered))

    #expect(!model.apply(record: questionRecord(createdAtMs: 2_000_000)))
    #expect(model.status() == .answeredElsewhere)
}

@MainActor
@Test func `question card preserves submitted answers across answerless refresh`() throws {
    let model = AforaQuestionCardModel(record: questionRecord())
    model.toggleOption(questionID: "meal", label: "Pizza")
    let answers = try #require(model.beginSubmission())
    model.markAnsweredLocally(answers: answers)

    #expect(model.apply(record: questionRecord(createdAtMs: 2_000_000, status: .answered)))
    #expect(model.terminalSummaryText(for: model.record.questions[0]) == "Pizza")
}

@MainActor
@Test func `question card preserves submitted answers across answerless resolved event`() throws {
    let model = AforaQuestionCardModel(record: questionRecord())
    model.toggleOption(questionID: "meal", label: "Pizza")
    let answers = try #require(model.beginSubmission())
    model.markAnsweredLocally(answers: answers)

    model.apply(resolved: .init(id: model.id, status: .answered))

    #expect(model.terminalSummaryText(for: model.record.questions[0]) == "Pizza")
}

@MainActor
@Test func `question card preserves run identity across local terminal records`() {
    let answered = AforaQuestionCardModel(record: questionRecord())
    answered.markAnsweredLocally(answers: ["meal": ["Pizza"]])
    #expect(answered.record.runid == "run-question")

    let skipped = AforaQuestionCardModel(record: questionRecord())
    skipped.markSkippedLocally()
    #expect(skipped.record.runid == "run-question")

    let elsewhere = AforaQuestionCardModel(record: questionRecord())
    elsewhere.markAnsweredElsewhere()
    #expect(elsewhere.record.runid == "run-question")

    let resolved = AforaQuestionCardModel(record: questionRecord())
    resolved.apply(resolved: .init(id: resolved.id, status: .answered))
    #expect(resolved.record.runid == "run-question")

    let refreshed = AforaQuestionCardModel(record: questionRecord(answers: .init(answers: [:])))
    #expect(refreshed.apply(record: questionRecord(status: .answered, runId: "run-refresh")))
    #expect(refreshed.record.runid == "run-refresh")
}

@MainActor
@Test func `question card locally expired state remains terminal`() {
    let expiresAt = Date(timeIntervalSince1970: 1500)
    let model = AforaQuestionCardModel(record: questionRecord(expiresAtMs: 1_500_000))

    #expect(model.observeLocalExpiry(at: expiresAt))
    #expect(!model.observeLocalExpiry(at: expiresAt.addingTimeInterval(15)))
    #expect(model.status(at: expiresAt.addingTimeInterval(15)) == .expired)
}

@MainActor
@Test func `question card stores local answers in gateway record shape`() throws {
    let model = AforaQuestionCardModel(record: questionRecord())
    model.toggleOption(questionID: "meal", label: "Pizza")
    let answers = try #require(model.beginSubmission())
    model.markAnsweredLocally(answers: answers)

    let data = try JSONEncoder().encode(model.record.answers)
    let json = try #require(String(data: data, encoding: .utf8))
    #expect(json.contains("\"meal\":[\"Pizza\"]"))
    #expect(model.terminalSummaryText(for: model.record.questions[0]) == "Pizza")
}

@MainActor
@Test func `question completions override unavailable recovery race`() throws {
    let answered = AforaQuestionCardModel(record: questionRecord())
    answered.toggleOption(questionID: "meal", label: "Pizza")
    let answers = try #require(answered.beginSubmission())
    answered.markRecoveryUnavailable()
    answered.markAnsweredLocally(answers: answers)
    #expect(answered.status() == .answered)

    let skipped = AforaQuestionCardModel(record: questionRecord())
    #expect(skipped.beginSkip())
    skipped.markRecoveryUnavailable()
    skipped.markSkippedLocally()
    #expect(skipped.status() == .cancelled)

    let answeredElsewhere = AforaQuestionCardModel(record: questionRecord())
    answeredElsewhere.markRecoveryUnavailable()
    answeredElsewhere.markAnsweredElsewhere()
    #expect(answeredElsewhere.status() == .answeredElsewhere)
}

@MainActor
@Test func `question card terminal summaries prefer resolved answers`() {
    let answers = QuestionAnswers(answers: [
        "meal": AnyCodable(["Pizza", "extra hot"]),
    ])
    let answered = AforaQuestionCardModel(record: questionRecord(status: .answered, answers: answers))
    let question = answered.record.questions[0]
    #expect(answered.terminalSummaryText(for: question) == "Pizza, extra hot")

    let elsewhere = AforaQuestionCardModel(record: questionRecord(status: .answered))
    #expect(elsewhere.terminalSummaryText(for: question) == "Answered elsewhere")

    let skipped = AforaQuestionCardModel(record: questionRecord(status: .cancelled))
    #expect(skipped.terminalSummaryText(for: question) == "Skipped")

    let expired = AforaQuestionCardModel(record: questionRecord(status: .expired))
    #expect(expired.terminalSummaryText(for: question) == "Expired")

    let unavailable = AforaQuestionCardModel(record: questionRecord())
    unavailable.markRecoveryUnavailable()
    #expect(unavailable.status() == .unavailable)
    #expect(unavailable.terminalSummaryText(for: question) == "Unavailable")
    #expect(!unavailable.apply(record: questionRecord()))
    #expect(unavailable.status() == .unavailable)
}

@MainActor
@Test func `question card skip transitions to persistent skipped summary`() {
    let model = AforaQuestionCardModel(record: questionRecord())

    #expect(model.beginSkip())
    #expect(model.isSkipping)
    model.markSkippedLocally()

    #expect(model.status() == .cancelled)
    #expect(model.terminalSummaryText(for: model.record.questions[0]) == "Skipped")
}
