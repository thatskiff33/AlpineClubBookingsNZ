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
import { FieldHint, useFieldHint } from "@/components/ui/field-hint"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

interface MemberDeleteRequestDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  reason: string
  error: string
  submitting: boolean
  onChangeReason: (value: string) => void
  onSubmit: () => void
}

export function MemberDeleteRequestDialog({
  open,
  onOpenChange,
  reason,
  error,
  submitting,
  onChangeReason,
  onSubmit,
}: MemberDeleteRequestDialogProps) {
  // #2264 — the example reason moves out of the placeholder, where grey text
  // inside the box reads as a reason already typed.
  const reasonHint = useFieldHint()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request Member Delete</DialogTitle>
          <DialogDescription>
            Submit this member for second-admin approval before hard deletion.
          </DialogDescription>
        </DialogHeader>
        {error && <div className="rounded border border-danger-6 bg-danger-3 p-2 text-sm text-danger-11">{error}</div>}
        <div className="space-y-2">
          <Label htmlFor="delete-reason">Reason</Label>
          <Textarea
            id="delete-reason"
            value={reason}
            onChange={(event) => onChangeReason(event.target.value)}
            rows={4}
            {...reasonHint.fieldProps}
          />
          <FieldHint {...reasonHint.hintProps}>
            Example: Record was created in error
          </FieldHint>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onSubmit} disabled={submitting || !reason.trim()}>
            {submitting ? "Submitting..." : "Submit Delete Request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
