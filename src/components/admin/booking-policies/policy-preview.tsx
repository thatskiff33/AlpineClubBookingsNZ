import type { PolicyRule } from "./types"
import { describeCancellationSchedule } from "@/lib/cancellation-schedule"
import { useClubFormat } from "@/components/club-format-provider"

export function PolicyPreview({ rules }: { rules: PolicyRule[] }) {
  const format = useClubFormat()
  const rows = describeCancellationSchedule(rules, format)
  return (
    <ul className="space-y-1">
      {rows.map((row, index) => (
        <li key={index} className="flex items-center space-x-2">
          <div
            className="w-3 h-3 rounded-full"
            style={{
              backgroundColor: `hsl(${(row.refundPercentage / 100) * 120}, 70%, 50%)`,
            }}
          />
          <span className="text-sm">{row.description}</span>
        </li>
      ))}
    </ul>
  )
}
