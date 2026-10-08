"use client";

import { useId, useState } from "react";
import Link from "next/link";
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
import { MoneyInput } from "@/components/ui/money-input";
import { Textarea } from "@/components/ui/textarea";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useClubFormat } from "@/components/club-format-provider";
import { useClubTime } from "@/components/club-time-provider";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import { parseDecimalDollarsToCents } from "@/lib/money-input";
import { formatCents, formatCentsPlain } from "@/lib/utils";

/** One dead card refund, as `listDeadCardRefunds` returns it. */
export interface DeadCardRefundPanelRow {
  operationId: string;
  bookingId: string;
  bookingReference: string;
  raisedAt: string;
  owedCents: number;
  wholeAmountOnly: boolean;
  /** Whether closing it queues a Xero refund credit note (a cancellation's card refund). */
  takesXeroRefundNote: boolean;
  /** Its last failure looked like a timeout or network error: Stripe may have refunded. */
  stripeMayHaveRefunded: boolean;
}

/** The warning a refund whose last failure may have reached Stripe carries, on its row and in its dialog. */
export const STRIPE_MAY_HAVE_REFUNDED_WARNING =
  "Stripe may have refunded: check the Stripe dashboard first.";

/**
 * #3372 (owner, 7 Oct 2026: "Count + add close action"): the card refunds
 * Stripe gave up on, each with a "Paid another way" close.
 *
 * Each one counts in "Refunds owed" and comes off Net Collected until it is
 * closed here. The close is gated `finance:edit` - the permission that
 * completes a refund paid back by hand - and the section's banner states the
 * view-only reason once, so the row buttons do not (`describeReason={false}`).
 * The dialog is the confirm step: the amount defaults to what is still owed,
 * and a note saying how the member was paid back is required. It says up front
 * whether a Xero refund note is raised, that a refund made in the Stripe
 * dashboard is not closed here, and that a partial close ends the refund (#3924
 * round 4). A refusal shows in the dialog through `FocusedActionError`; a 409
 * also refreshes the list, since the refund or its payment moved.
 */
export function DeadCardRefundsPanel({ rows }: { rows: DeadCardRefundPanelRow[] }) {
  const canEdit = useAdminAreaEditAccess("finance");
  const format = useClubFormat();
  const clubTime = useClubTime();
  const router = useRouter();
  const amountId = useId();
  const noteId = useId();
  const errorId = useId();
  const submitHintId = useId();
  const [target, setTarget] = useState<DeadCardRefundPanelRow | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorAttention, setErrorAttention] = useState(0);

  const amountCents = target ? parseDecimalDollarsToCents(amountInput) : null;
  const amountProblem =
    target === null
      ? null
      : amountCents === null
        ? "Enter the amount paid back, in dollars and cents."
        : amountCents > target.owedCents
          ? `That is more than the ${formatCents(target.owedCents, format)} still owed.`
          : amountCents === 0 && target.owedCents > 0
            ? "Enter the amount the member was paid back."
            : null;
  const noteMissing = note.trim() === "";
  const canSubmit = target !== null && amountProblem === null && !noteMissing && !busy;
  // Why the button is disabled, said beside it (#3924 round 4, U2).
  const submitHint =
    target === null || busy
      ? null
      : (amountProblem ?? (noteMissing ? "Say how the member was paid back to close it." : null));
  const partial = target !== null && amountCents !== null && amountProblem === null && amountCents < target.owedCents;

  function fail(message: string) {
    setError(message);
    setErrorAttention((count) => count + 1);
  }

  function open(row: DeadCardRefundPanelRow) {
    setTarget(row);
    setAmountInput(formatCentsPlain(row.owedCents));
    setNote("");
    setError("");
  }

  async function submit() {
    if (!target || amountCents === null) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/payments/card-refunds/${target.operationId}/paid-another-way`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amountCents, note, confirmed: true }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(typeof data.error === "string" ? data.error : "Could not close the card refund.");
        // The refund or its payment moved since this page was read.
        if (res.status === 409) router.refresh();
        return;
      }
      toast.success(
        data.xeroRefundNoteQueued === true
          ? `Closed. ${formatCents(amountCents, format)} recorded as paid back, and its Xero refund credit note is queued.`
          : `Closed. ${formatCents(amountCents, format)} recorded as paid back. Check the refund is recorded in Xero.`,
      );
      setTarget(null);
      router.refresh();
    } catch {
      fail("Could not close the card refund.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <AdminViewOnlySectionBanner canEdit={canEdit} />
      <p className="text-sm text-muted-foreground">
        Stripe stopped retrying these card refunds. Each still counts in Refunds owed and comes off Net
        Collected. If the member was paid back another way, for example by bank transfer, close it here. If
        you refunded it in the Stripe dashboard instead, do not close it here: wait for that refund to show on
        the payment.
      </p>
      <ul className="space-y-2" aria-label="Card refunds Stripe gave up on">
        {rows.map((row) => (
          <li
            key={row.operationId}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted p-2"
          >
            <div>
              <div className="text-sm font-medium">
                <Link href={`/admin/bookings/${row.bookingId}`} className="underline">
                  Booking {row.bookingReference}
                </Link>
                {" - "}
                {formatCents(row.owedCents, format)} still owed
              </div>
              <div className="text-xs text-muted-foreground">
                Refund started {clubTime.instantDate(new Date(row.raisedAt))}
              </div>
              {row.stripeMayHaveRefunded ? (
                <div className="text-xs font-medium text-warning-11">{STRIPE_MAY_HAVE_REFUNDED_WARNING}</div>
              ) : null}
            </div>
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              size="sm"
              onClick={() => open(row)}
            >
              Paid another way
            </ViewOnlyActionButton>
          </li>
        ))}
      </ul>

      <Dialog open={target !== null} onOpenChange={(next) => !busy && !next && setTarget(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Close this card refund as paid another way?</DialogTitle>
            <DialogDescription>
              Stripe will not be asked again. The amount is recorded as refunded on the payment, and the refund
              leaves Refunds owed. Only do this once the member has the money.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            {target?.stripeMayHaveRefunded ? (
              <p className="font-medium text-warning-11">{STRIPE_MAY_HAVE_REFUNDED_WARNING}</p>
            ) : null}
            <p className="text-muted-foreground">
              Refunded it in the Stripe dashboard instead? Do not close it here: wait for that refund to show on
              the payment.
            </p>
            <p className="text-muted-foreground">
              {target?.takesXeroRefundNote
                ? "A Xero refund credit note for the amount, as a bank transfer, is queued when you close it."
                : "No Xero refund credit note is raised. A refund from a booking change was already credited on the invoice by the change's own credit note; check Xero for any other."}
            </p>
            <p className="text-muted-foreground">
              Paying back less than is owed ends the refund: the rest stops being owed and is no longer tracked.
            </p>
          </div>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor={amountId}>Amount paid back</Label>
              <MoneyInput
                id={amountId}
                value={amountInput}
                className="w-32"
                disabled={target?.wholeAmountOnly === true}
                onValueChange={setAmountInput}
                error={amountProblem}
              />
              {target?.wholeAmountOnly ? (
                <p className="text-xs text-muted-foreground">
                  This refund replaces a superseded payment, so it closes for the whole amount.
                </p>
              ) : null}
              {partial && target ? (
                <p className="text-xs font-medium text-warning-11">
                  {formatCents(target.owedCents - (amountCents ?? 0), format)} will no longer be owed or tracked.
                </p>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label htmlFor={noteId}>How was it paid back? (required)</Label>
              <Textarea
                id={noteId}
                value={note}
                required
                aria-required="true"
                maxLength={MANUAL_PAYMENT_NOTE_MAX}
                placeholder="For example: bank transfer on 7 Oct, reference REF123"
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          </div>
          <FocusedActionError id={errorId} error={error} attentionKey={errorAttention} />
          <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
            {submitHint ? (
              <p id={submitHintId} className="text-xs text-muted-foreground sm:mr-auto">
                {submitHint}
              </p>
            ) : null}
            <Button variant="outline" disabled={busy} onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={!canSubmit}
              aria-describedby={submitHint ? submitHintId : undefined}
              onClick={() => void submit()}
            >
              {busy ? "Closing..." : "Close as paid another way"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
