import Foundation

public enum AforaAppGroup {
    public static let canonicalIdentifier = "group.ai.aforafoundation.app.shared"

    public static var identifier: String {
        let raw = Bundle.main.object(forInfoDictionaryKey: "AforaAppGroupIdentifier") as? String
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? self.canonicalIdentifier : trimmed
    }
}
