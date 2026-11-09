"use client"

import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
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
import { Label } from "@/components/ui/label"
import {
  EXAMPLE_CREDIT_NOTE_NUMBER,
  HAND_MADE_CREDIT_NOTE_NUMBER_MAX,
} from "@/lib/bank-refund-void-follow-up-copy"
import { XERO_OPERATION_REASON_MAX, XERO_OPERATION_REASON_MIN } from "@/lib/xero-operation-resolution"
import { resolveDialogDescription } from "./resolve-dialog-copy"

export interface ResolveWithNoteAnswer {
  creditNoteNumber: string
  reason: string
}

export interface ResolveWithNoteRequest {
  /** The refund's amount, formatted for the club, that the note must be for. */
  amountLabel: string | null
  /**
   * Sends the answer to the resolve route. Resolves to null when it was
   * recorded (the dialog closes), or to the route's refusal, which the dialog
   * shows while keeping what was typed.
   */
  submit: (answer: ResolveWithNoteAnswer) => Promise<string | null>
}

/**
 * #4421 (owner decision 26 Oct 2026, `INV-INT-028`): "Resolve by hand" on a
 * refund credit note the app never raised asks for the number of the credit
 * note the officer made in Xero, beside the reason. The route checks the note
 * in Xero and records it; the dialog stays open while it does (review,
 * security F3), and shows a refusal in place with the typed values kept.
 */
export function useResolveWithNoteDialog(): {
  openResolveWithNote: (request: ResolveWithNoteRequest) => void
  resolveWithNoteDialog: ReactNode
} {
  const [request, setRequest] = useState<ResolveWithNoteRequest | null>(null)
  const [creditNoteNumber, setCreditNoteNumber] = useState("")
  const [reason, setReason] = useState("")
  const [checking, setChecking] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const inFlight = useRef(false)

  const openResolveWithNote = useCallback((next: ResolveWithNoteRequest) => {
    setCreditNoteNumber("")
    setReason("Made the credit note by hand in Xero")
    setRefusal(null)
    setChecking(false)
    setRequest(next)
  }, [])

  const number = creditNoteNumber.trim()
  const trimmedReason = reason.trim()
  const ready = number.length > 0 && trimmedReason.length >= XERO_OPERATION_REASON_MIN && !checking

  const close = () => {
    if (inFlight.current) return
    setRequest(null)
  }

  const submit = async () => {
    if (!request || !ready || inFlight.current) return
    inFlight.current = true
    setChecking(true)
    setRefusal(null)
    try {
      const refused = await request.submit({ creditNoteNumber: number, reason: trimmedReason })
      if (refused === null) {
        setRequest(null)
      } else {
        setRefusal(refused)
      }
    } finally {
      inFlight.current = false
      setChecking(false)
    }
  }

  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      void submit()
    }
  }

  const resolveWithNoteDialog = (
    <Dialog open={request !== null} onOpenChange={(nextOpen) => { if (!nextOpen) close() }}>
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Resolve this refund credit note?</DialogTitle>
          <DialogDescription>
            Give the number of the credit note you made for this refund in Xero. The app checks it in Xero
            (approved or paid, {request?.amountLabel ? `for ${request.amountLabel}, ` : "for this refund's amount, "}
            for the booking&apos;s Xero contact (the member&apos;s, or the organisation&apos;s), and not allocated to
            another invoice) and records it, so the same note can&apos;t also be recorded against another refund.{" "}
            {resolveDialogDescription("CREDIT_NOTE")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="resolve-credit-note-number">Xero credit note number</Label>
            <Input
              id="resolve-credit-note-number"
              required
              placeholder={EXAMPLE_CREDIT_NOTE_NUMBER}
              maxLength={HAND_MADE_CREDIT_NOTE_NUMBER_MAX}
              value={creditNoteNumber}
              disabled={checking}
              aria-invalid={refusal !== null}
              aria-describedby={refusal !== null ? "resolve-credit-note-refusal" : undefined}
              onChange={(event) => setCreditNoteNumber(event.target.value)}
              onKeyDown={onEnter}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="resolve-credit-note-reason">Reason</Label>
            <Input
              id="resolve-credit-note-reason"
              maxLength={XERO_OPERATION_REASON_MAX}
              value={reason}
              disabled={checking}
              onChange={(event) => setReason(event.target.value)}
              onKeyDown={onEnter}
            />
          </div>
          <div role="alert" id="resolve-credit-note-refusal" className="text-sm text-danger">
            {refusal}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={checking} onClick={close}>Cancel</Button>
          <Button type="button" disabled={!ready} onClick={() => void submit()}>
            {checking ? "Checking in Xero…" : "Resolve"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return { openResolveWithNote, resolveWithNoteDialog }
}
