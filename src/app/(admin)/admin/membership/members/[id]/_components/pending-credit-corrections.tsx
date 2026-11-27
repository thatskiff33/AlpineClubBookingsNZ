"use client"

import Link from "next/link"
import { ViewOnlyActionButton } from "@/components/admin/view-only-action"
import { useClubFormat } from "@/components/club-format-provider"
import { adminHref } from "@/lib/admin-hubs"
import { formatSignedCents } from "@/lib/utils"
import type { PendingCreditDeductionCorrectionItem } from "../_types"

/**
 * #5241: approved deductions whose Xero correction is still running. The cents are
 * held off the balance; Cancel restores them only while Xero holds nothing of the correction.
 */
export function PendingCreditCorrections({
  corrections,
  cancellingCorrectionId,
  canEdit,
  onCancel,
}: {
  corrections: PendingCreditDeductionCorrectionItem[]
  cancellingCorrectionId: string | null
  canEdit: boolean | undefined
  onCancel: (correctionId: string) => void
}) {
  const format = useClubFormat()
  if (corrections.length === 0) return null
  return (
    <div className="mb-4 rounded-md border border-warning-6 bg-warning-3 p-4">
      <p className="text-sm font-medium text-warning-11">Waiting for Xero correction</p>
      <p className="mb-3 text-xs text-warning-11">
        These approved deductions are reserved and cannot be spent. Cancel restores the credit only if Xero has not changed.
      </p>
      <ul className="space-y-3">
        {corrections.map((correction) => (
          <li key={correction.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>{formatSignedCents(correction.amountCents, format)}: {correction.description}</span>
            <ViewOnlyActionButton
              canEdit={canEdit}
              size="sm"
              variant="outline"
              disabled={cancellingCorrectionId !== null}
              onClick={() => onCancel(correction.id)}
            >
              {cancellingCorrectionId === correction.id ? "Checking Xero..." : "Cancel correction"}
            </ViewOnlyActionButton>
          </li>
        ))}
      </ul>
      <Link href={`${adminHref("xero")}?section=operations`} className="mt-3 inline-block text-sm underline">
        Retry in Xero operations
      </Link>
    </div>
  )
}
