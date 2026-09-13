"use client"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { MONEY_INPUT_PROPS } from "@/lib/money-input"
import { Label } from "@/components/ui/label"
import { FocusedActionError } from "@/components/focused-action-error"
import {
  JoiningFeePreviewHint,
  useJoiningFeePrefill,
  useJoiningFeePreview,
} from "@/components/admin/joining-fee-preview"
import type { MemberDetail } from "../_types"

interface MemberXeroCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  member: MemberDetail
  pushing: boolean
  error: string
  createEntranceFeeInvoice: boolean
  entranceFeeSkipReason: string
  entranceFeeAmount: string
  entranceFeeNarration: string
  onChangeCreateEntranceFeeInvoice: (value: boolean) => void
  onChangeEntranceFeeSkipReason: (value: string) => void
  onChangeEntranceFeeAmount: (value: string) => void
  onChangeEntranceFeeNarration: (value: string) => void
  onSubmit: () => void
}

export function MemberXeroCreateDialog({
  open,
  onOpenChange,
  member,
  pushing,
  error,
  createEntranceFeeInvoice,
  entranceFeeSkipReason,
  entranceFeeAmount,
  entranceFeeNarration,
  onChangeCreateEntranceFeeInvoice,
  onChangeEntranceFeeSkipReason,
  onChangeEntranceFeeAmount,
  onChangeEntranceFeeNarration,
  onSubmit,
}: MemberXeroCreateDialogProps) {
  const previewState = useJoiningFeePreview({
    pathId: member.id,
    enabled: open && createEntranceFeeInvoice,
  })
  useJoiningFeePrefill({
    preview: previewState.preview,
    prefillKey: member.id,
    amount: entranceFeeAmount,
    narration: entranceFeeNarration,
    setAmount: onChangeEntranceFeeAmount,
    setNarration: onChangeEntranceFeeNarration,
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Xero Contact</DialogTitle>
          <DialogDescription>
            Create a brand-new Xero contact for {member.firstName} {member.lastName}. We&apos;ll check for similar
            existing contacts before the new contact is created.
          </DialogDescription>
        </DialogHeader>
        <FocusedActionError id="member-xero-create-error" error={error} />
        <div className="space-y-4">
          <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
            Use this only when you&apos;re confident the member should not be linked to an existing Xero contact.
          </div>
          <div className="flex items-start gap-2">
            <input
              type="checkbox"
              id="member-detail-xero-create-invoice"
              checked={createEntranceFeeInvoice}
              onChange={(e) => onChangeCreateEntranceFeeInvoice(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-border"
            />
            <div>
              <Label htmlFor="member-detail-xero-create-invoice">
                Create membership joining fee invoice after contact creation
              </Label>
              <p className="text-xs text-muted-foreground">
                If this is not raised, record why for the audit trail.
              </p>
            </div>
          </div>
          {createEntranceFeeInvoice ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="member-detail-xero-entrance-amount">Amount override ($)</Label>
                <Input
                  id="member-detail-xero-entrance-amount"
                  {...MONEY_INPUT_PROPS}
                  placeholder="Use configured amount"
                  value={entranceFeeAmount}
                  onChange={(e) => onChangeEntranceFeeAmount(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="member-detail-xero-entrance-narration">Narration override</Label>
                <Input
                  id="member-detail-xero-entrance-narration"
                  placeholder="Use default narration"
                  value={entranceFeeNarration}
                  onChange={(e) => onChangeEntranceFeeNarration(e.target.value)}
                />
              </div>
              <div className="sm:col-span-2">
                <JoiningFeePreviewHint state={previewState} />
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="member-detail-xero-entrance-skip-reason">Reason for not raising invoice</Label>
              <textarea
                id="member-detail-xero-entrance-skip-reason"
                className="min-h-20 w-full rounded-md border border-border px-3 py-2 text-sm"
                value={entranceFeeSkipReason}
                onChange={(e) => onChangeEntranceFeeSkipReason(e.target.value)}
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pushing}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={pushing}>
            {pushing ? "Checking..." : "Continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
