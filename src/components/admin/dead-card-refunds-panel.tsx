"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
}

/**
 * #3372 (owner, 7 Oct 2026: "Count + add close action"): the card refunds
 * Stripe gave up on, each with a "Paid another way" close.
 *
 * Each one counts in "Refunds owed" and comes off Net Collected until it is
 * closed here. The close is gated `finance:edit` - the permission that
 * completes a refund paid back by hand - and the section's banner states the
 * view-only reason once, so the row buttons do not (`describeReason={false}`).
 * The dialog is the confirm step: the amount defaults to what is still owed,
 * and a note saying how the member was paid back is required.
 */
export function DeadCardRefundsPanel({ rows }: { rows: DeadCardRefundPanelRow[] }) {
  const canEdit = useAdminAreaEditAccess("finance");
  const format = useClubFormat();
  const clubTime = useClubTime();
  const router = useRouter();
  const amountId = useId();
  const noteId = useId();
  const [target, setTarget] = useState<DeadCardRefundPanelRow | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
  const canSubmit = target !== null && amountProblem === null && note.trim() !== "" && !busy;

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
        setError(typeof data.error === "string" ? data.error : "Could not close the card refund.");
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
      setError("Could not close the card refund.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <AdminViewOnlySectionBanner canEdit={canEdit} />
      <p className="text-sm text-muted-foreground">
        Stripe stopped retrying these card refunds. Each still counts in Refunds owed and comes off Net
        Collected. If the member was paid back another way, for example by bank transfer, close it here.
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close this card refund as paid another way?</DialogTitle>
            <DialogDescription>
              Stripe will not be asked again. The amount is recorded as refunded on the payment, and the refund
              leaves Refunds owed. Only do this once the member has the money.
            </DialogDescription>
          </DialogHeader>
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
            </div>
            <div className="space-y-1">
              <Label htmlFor={noteId}>How was it paid back?</Label>
              <Textarea
                id={noteId}
                value={note}
                maxLength={MANUAL_PAYMENT_NOTE_MAX}
                placeholder="For example: bank transfer on 7 Oct, reference REF123"
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          </div>
          {error ? (
            <div role="alert" className="rounded-md bg-danger-3 p-3 text-sm text-danger-11">
              {error}
            </div>
          ) : null}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button disabled={!canSubmit} onClick={() => void submit()}>
              {busy ? "Closing..." : "Close as paid another way"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
