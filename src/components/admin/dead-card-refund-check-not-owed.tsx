"use client";

import { useId, useRef, useState, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FocusedActionError } from "@/components/focused-action-error";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useClubFormat } from "@/components/club-format-provider";
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import { formatCents } from "@/lib/utils";

/**
 * #4210 round 3 (`INV-PAY-136`, UX 2): the confirm step for closing a row
 * raised for an officer to check after a "Paid another way" close as checked -
 * not owed (`closeCardRefundCheckNotOwed`), opened from that row's button on
 * the dead card refunds panel, which is gated `finance:edit` under the
 * section's banner. A note saying why is required. A refusal shows in the
 * dialog; a 409 also refreshes the list. After a close, focus moves to the
 * list's status line, which says what was done (the row and its button are gone).
 */
export function CheckedNotOwedDialog({
  target,
  onDone,
  onClosed,
  statusRef,
}: {
  /** The check row it is open for; null while closed. */
  target: { operationId: string; bookingReference: string; owedCents: number } | null;
  /** Close the dialog. */
  onDone: () => void;
  /** Told after a close, with the sentence for the list's status line. */
  onClosed: (notice: string) => void;
  statusRef: RefObject<HTMLElement | null>;
}) {
  const format = useClubFormat();
  const router = useRouter();
  const noteId = useId();
  const errorId = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorAttention, setErrorAttention] = useState(0);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const closedRef = useRef(false);
  // A new target starts clean: adjusted while rendering, as React's derived-state pattern does.
  if (target !== null && openFor !== target.operationId) {
    setOpenFor(target.operationId);
    setNote("");
    setError("");
  }
  const amount = target ? formatCents(target.owedCents, format) : "";

  function fail(message: string) {
    setError(message);
    setErrorAttention((count) => count + 1);
  }

  async function submit() {
    if (!target) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/payments/card-refunds/${target.operationId}/checked-not-owed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note, confirmed: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(typeof data.error === "string" ? data.error : "Could not close the card refund.");
        if (res.status === 409) router.refresh();
        return;
      }
      toast.success(`Closed. ${amount} is no longer owed, and your note is in the audit log.`);
      closedRef.current = true;
      onClosed(`The card refund for booking ${target.bookingReference} was closed as checked - not owed.`);
      onDone();
      setOpenFor(null);
      router.refresh();
    } catch {
      fail("Could not close the card refund.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (busy || next) return;
        closedRef.current = false;
        setOpenFor(null);
        onDone();
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto"
        onCloseAutoFocus={(event) => {
          if (!closedRef.current) return;
          event.preventDefault();
          statusRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Close this card refund as checked - not owed?</DialogTitle>
          <DialogDescription>
            {amount} leaves Refunds owed and Net Collected, and nothing is paid or recorded in Xero. Only do this once
            you have checked the member is not owed it. If they are, pay them another way and close it as paid another
            way instead.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor={noteId}>Why is it not owed? (required)</Label>
          <Textarea
            id={noteId}
            value={note}
            required
            aria-required="true"
            maxLength={MANUAL_PAYMENT_NOTE_MAX}
            placeholder="For example: the close's bank transfer on 7 Oct covered it"
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <FocusedActionError id={errorId} error={error} attentionKey={errorAttention} />
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
          {note.trim() === "" ? (
            <p className="text-xs text-muted-foreground sm:mr-auto">Say why the member is not owed it to close it.</p>
          ) : null}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              closedRef.current = false;
              setOpenFor(null);
              onDone();
            }}
          >
            Cancel
          </Button>
          <Button disabled={busy || note.trim() === ""} onClick={() => void submit()}>
            {busy ? "Closing..." : "Close as not owed"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
