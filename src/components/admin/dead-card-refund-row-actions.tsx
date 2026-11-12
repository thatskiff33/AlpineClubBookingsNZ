"use client";
import { fetchWithRecentAuth } from "@/components/confirm-its-you";

import { useId, useState } from "react";
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
import { useClubFormat } from "@/components/club-format-provider";
import { useClubTime } from "@/components/club-time-provider";
import { formatCents } from "@/lib/utils";

/** A later Stripe refund that covers a dead card refund (`laterStripeRefundsCovering`). */
export interface LaterStripeRefundPanelRow {
  stripeRefundId: string;
  amountCents: number;
  madeAt: string;
}

/** What the two dialogs read off one row of "Card refunds Stripe gave up on". */
export interface DeadCardRefundActionRow {
  operationId: string;
  bookingReference: string;
  owedCents: number;
  laterStripeRefunds: LaterStripeRefundPanelRow[];
}

interface DialogProps {
  /** The row the dialog is open for, read from the list; null while closed. */
  row: DeadCardRefundActionRow | null;
  onClose: () => void;
  /** Said on the list's status line after a success. */
  onDone: (notice: string) => void;
  /** Moves focus to that status line once the dialog has closed: the row's button may be gone. */
  focusNotice: () => void;
}

/**
 * The dialog's request and its state: null on success, else the message to
 * show. A 409 refreshes the list (the row moved since the page was read), and
 * so does a success.
 */
function useConfirmedAction(failure: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attention, setAttention] = useState(0);
  const [done, setDone] = useState(false);
  async function post(url: string, body: object): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      const res = await fetchWithRecentAuth(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, confirmed: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : failure);
        setAttention((count) => count + 1);
        if (res.status === 409) router.refresh();
        return false;
      }
      setDone(true);
      router.refresh();
      return true;
    } catch {
      setError(failure);
      setAttention((count) => count + 1);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function reset() {
    setError("");
    setDone(false);
  }
  return { busy, error, attention, done, post, reset };
}

/**
 * #4368 (owner decision 5 on #4361, 25 Oct 2026): the confirm dialog of "Try
 * the card again". The app puts the refund back to run; the recovery runner
 * checks Stripe's refunds on the charge (`INV-PAY-145`) before it sends
 * anything. It carries the owed figure it showed, and the server refuses a
 * moved one. The button is the panel's, gated as "Paid another way" is.
 */
export function TryCardAgainDialog({ row, onClose, onDone, focusNotice }: DialogProps) {
  const format = useClubFormat();
  const errorId = useId();
  const action = useConfirmedAction("Could not try the card again.");
  // The figure the dialog showed, kept from when it opened.
  const [seen, setSeen] = useState<{ operationId: string; owedCents: number } | null>(null);
  if (row !== null && seen?.operationId !== row.operationId) {
    setSeen({ operationId: row.operationId, owedCents: row.owedCents });
    action.reset();
  }
  // Closed: forget it, so opening it again reads the row afresh.
  if (row === null && seen !== null) setSeen(null);
  const owedCents = seen?.owedCents ?? row?.owedCents ?? 0;

  async function submit() {
    if (!row) return;
    const ok = await action.post(`/api/admin/payments/card-refunds/${row.operationId}/try-card-again`, { expectedOwedCents: owedCents });
    if (!ok) return;
    toast.success(`The card will be asked for ${formatCents(owedCents, format)} again shortly.`);
    onDone(`The card refund for booking ${row.bookingReference} will be tried on the card again.`);
    onClose();
  }

  return (
    <Dialog open={row !== null} onOpenChange={(next) => !action.busy && !next && onClose()}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          if (!action.done) return;
          event.preventDefault();
          focusNotice();
        }}
      >
        <DialogHeader>
          <DialogTitle>Try the card again?</DialogTitle>
          <DialogDescription>
            The app will ask Stripe to refund up to {formatCents(owedCents, format)} to the member&apos;s card again. Before
            anything is sent it reads the refunds Stripe already holds on the charge: one it can match to this refund
            is counted instead of sent again, and one made in the Stripe dashboard, or one it cannot match, stops it
            for you to check.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Only do this if you have not paid the member back another way. If the card fails again, the refund comes
          back to this list: then pay the member another way and close it with Paid another way, not with a new refund
          in the Stripe dashboard.
        </p>
        <FocusedActionError id={errorId} error={action.error} attentionKey={action.attention} />
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
          <Button variant="outline" disabled={action.busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={action.busy} onClick={() => void submit()}>
            {action.busy ? "Asking..." : "Try the card again"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * #4368 (owner decision, 25 Oct 2026): the confirm dialog of "Nothing left
 * owed", on a card refund Stripe gave up on whose owed figure reads $0. It
 * names the later Stripe refunds that cover it and sends them with the close,
 * which the server refuses if they changed. No money moves, nothing is sent to
 * Stripe and nothing changes in Xero. The button is the panel's, gated as
 * "Paid another way" is.
 */
export function NothingLeftOwedDialog({ row, onClose, onDone, focusNotice }: DialogProps) {
  const format = useClubFormat();
  const clubTime = useClubTime();
  const errorId = useId();
  const action = useConfirmedAction("Could not close the card refund.");
  const [seen, setSeen] = useState<{ operationId: string; refunds: LaterStripeRefundPanelRow[] } | null>(null);
  if (row !== null && seen?.operationId !== row.operationId) {
    setSeen({ operationId: row.operationId, refunds: row.laterStripeRefunds });
    action.reset();
  }
  // Closed: forget it, so opening it again reads the row afresh.
  if (row === null && seen !== null) setSeen(null);
  const refunds = seen?.refunds ?? row?.laterStripeRefunds ?? [];
  const named = refunds
    .map((refund) => `${refund.stripeRefundId} (${formatCents(refund.amountCents, format)}, ${clubTime.instantDate(new Date(refund.madeAt))})`)
    .join("; ");

  async function submit() {
    if (!row) return;
    const ok = await action.post(`/api/admin/payments/card-refunds/${row.operationId}/nothing-left-owed`, {
      expectedStripeRefundIds: refunds.map((refund) => refund.stripeRefundId),
    });
    if (!ok) return;
    toast.success("Closed with nothing left owed. No money moved, and nothing was sent to Stripe or Xero.");
    onDone(`The card refund for booking ${row.bookingReference} was closed with nothing left owed.`);
    onClose();
  }

  return (
    <Dialog open={row !== null} onOpenChange={(next) => !action.busy && !next && onClose()}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          if (!action.done) return;
          event.preventDefault();
          focusNotice();
        }}
      >
        <DialogHeader>
          <DialogTitle>Close this card refund with nothing left owed?</DialogTitle>
          <DialogDescription>
            A later Stripe refund on this payment already covers it: {named}. Check it in the Stripe dashboard first.
            Closing it moves no money, sends nothing to Stripe and changes nothing in Xero. It leaves this list, and the
            close is kept in the audit log.
          </DialogDescription>
        </DialogHeader>
        <FocusedActionError id={errorId} error={action.error} attentionKey={action.attention} />
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
          <Button variant="outline" disabled={action.busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={action.busy} onClick={() => void submit()}>
            {action.busy ? "Closing..." : "Close with nothing left owed"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
