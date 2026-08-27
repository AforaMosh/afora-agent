import Foundation
import Testing
@testable import AforaKit

struct HealthCommandsTests {
    @Test func `health summary periods use the node command wire values`() throws {
        #expect(AforaHealthCommand.summary.rawValue == "health.summary")
        #expect(AforaHealthSummaryPeriod.allCases.map(\.rawValue) == ["today"])

        let params = AforaHealthSummaryParams(period: .today)
        let data = try JSONEncoder().encode(params)
        #expect(String(decoding: data, as: UTF8.self) == #"{"period":"today"}"#)
    }
}
