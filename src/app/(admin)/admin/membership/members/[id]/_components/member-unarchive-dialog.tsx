"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FieldHint, useFieldHint } from "@/components/ui/field-hint"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

interface MemberUnarchiveDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  error: string
  submitting: boolean
  /** Resolves true once the member is unarchived, which closes the dialog. */
  onSubmit: (reason: string) => Promise<boolean>
}

/** #5540: one Full Admin, one step, a required reason. */
export function MemberUnarchiveDialog({
  open,
  onOpenChange,
  error,
  submitting,
  onSubmit,
}: MemberUnarchiveDialogProps) {
  const [reason, setReason] = useState("")
  // #2264: the example sits under the box, never as placeholder text in it.
  const reasonHint = useFieldHint()

  function changeOpen(next: boolean) {
    if (!next) setReason("")
    onOpenChange(next)
  }

  async function submit() {
    if (await onSubmit(reason.trim())) changeOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unarchive Member</DialogTitle>
          <DialogDescription>
            This clears the archive only. The member stays cancelled and inactive, cannot sign in,
            and does not get back the family links the archive removed. The archive stays in their
            history.
          </DialogDescription>
        </DialogHeader>
        {error && <div className="rounded border border-danger-6 bg-danger-3 p-2 text-sm text-danger-11">{error}</div>}
        <div className="space-y-2">
          <Label htmlFor="unarchive-reason">Reason *</Label>
          <Textarea
            id="unarchive-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={4}
            maxLength={1000}
            {...reasonHint.fieldProps}
          />
          <FieldHint {...reasonHint.hintProps}>
            Example: Archived by mistake
          </FieldHint>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => changeOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting || !reason.trim()}>
            {submitting ? "Unarchiving..." : "Unarchive Member"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
