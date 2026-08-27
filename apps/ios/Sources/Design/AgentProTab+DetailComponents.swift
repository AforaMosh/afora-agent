import AforaKit
import SwiftUI

extension AgentProTab {
    func detailMetric(label: AforaTextValue, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            label.text
                .font(AforaType.caption2Medium)
                .foregroundStyle(.secondary)
            Text(verbatim: value)
                .font(AforaType.subheadSemiBold)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(
            Color.primary.opacity(0.055),
            in: RoundedRectangle(cornerRadius: AforaRadius.sm, style: .continuous))
    }

    func emptyDetailRow(
        icon: String,
        title: AforaTextValue,
        detail: AforaTextValue) -> some View
    {
        HStack(spacing: 12) {
            ProIconBadge(systemName: icon, color: .secondary)
            VStack(alignment: .leading, spacing: 3) {
                title.text
                    .font(AforaType.subheadSemiBold)
                detail.text
                    .font(AforaType.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
        }
    }
}
