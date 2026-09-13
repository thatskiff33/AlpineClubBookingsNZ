"use client"

import { Input } from "@/components/ui/input"
import { MONEY_INPUT_PROPS } from "@/lib/money-input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { UseXeroEntranceFeeDecisionResult } from "@/lib/admin-xero-entrance-fee"
import {
  JoiningFeePreviewHint,
  useJoiningFeePrefill,
  useJoiningFeePreview,
} from "@/components/admin/joining-fee-preview"

interface MemberXeroEntranceFeeFieldsProps {
  idPrefix: string
  decision: UseXeroEntranceFeeDecisionResult
  onClearError: () => void
  // When set (an existing member), the resolved default joining fee is fetched
  // and surfaced, and the override fields are prefilled (item 15, #1931).
  memberId?: string
}

export function MemberXeroEntranceFeeFields({
  idPrefix,
  decision,
  onClearError,
  memberId,
}: MemberXeroEntranceFeeFieldsProps) {
  const previewState = useJoiningFeePreview({
    pathId: memberId ?? null,
    enabled: Boolean(memberId) && decision.xeroCreateEntranceFeeInvoice,
  })
  useJoiningFeePrefill({
    preview: previewState.preview,
    prefillKey: memberId ?? "",
    amount: decision.xeroEntranceFeeAmount,
    narration: decision.xeroEntranceFeeNarration,
    setAmount: decision.setXeroEntranceFeeAmount,
    setNarration: decision.setXeroEntranceFeeNarration,
  })
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          id={`${idPrefix}-create-invoice`}
          checked={decision.xeroCreateEntranceFeeInvoice}
          onChange={(event) => {
            decision.setXeroCreateEntranceFeeInvoice(event.target.checked)
            onClearError()
          }}
          className="mt-0.5 h-4 w-4 rounded border-border"
        />
        <div>
          <Label htmlFor={`${idPrefix}-create-invoice`}>
            Create membership joining fee invoice after contact creation
          </Label>
          <p className="text-xs text-muted-foreground">
            Leave this unchecked only when the invoice is being handled another way.
          </p>
        </div>
      </div>

      {decision.xeroCreateEntranceFeeInvoice ? (
        <div className="space-y-2">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-amount`}>Invoice amount override</Label>
              <Input
                id={`${idPrefix}-amount`}
                {...MONEY_INPUT_PROPS}
                placeholder="Use configured amount"
                value={decision.xeroEntranceFeeAmount}
                onChange={(event) => decision.setXeroEntranceFeeAmount(event.target.value)}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor={`${idPrefix}-narration`}>Invoice narration</Label>
              <Textarea
                id={`${idPrefix}-narration`}
                value={decision.xeroEntranceFeeNarration}
                onChange={(event) => decision.setXeroEntranceFeeNarration(event.target.value)}
                maxLength={500}
                rows={2}
                placeholder="Optional description to use on the invoice line"
              />
            </div>
          </div>
          {memberId && <JoiningFeePreviewHint state={previewState} />}
        </div>
      ) : (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-skip-reason`}>
            Reason for not raising the joining fee invoice
          </Label>
          <Textarea
            id={`${idPrefix}-skip-reason`}
            value={decision.xeroEntranceFeeSkipReason}
            onChange={(event) => decision.setXeroEntranceFeeSkipReason(event.target.value)}
            maxLength={500}
            rows={2}
            placeholder="Required when no joining fee invoice will be queued"
          />
        </div>
      )}
    </div>
  )
}
