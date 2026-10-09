"use client";

import { useId, useRef, useState } from "react";
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
import type { PaidAnotherWayXeroPromise, PaidAnotherWayXeroQueued } from "@/lib/card-refund-paid-another-way-xero";
import type { PaidBackChoice } from "@/lib/card-refund-paid-back";
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
  /**
   * How closing it is recorded in Xero: a bank-transfer refund note queued with
   * the close (`now`); a late card charge recorded as a receipt first, with the
   * note after it (`after-receipt`); the note after a receipt already on its
   * way to Xero (`after-receipt-on-its-way`, round 8); or no note (`none`).
   */
  xeroRefundNote: PaidAnotherWayXeroPromise;
  /** Its last failure looked like a timeout or network error: Stripe may have refunded. */
  stripeMayHaveRefunded: boolean;
}

/** One card refund closed as paid another way that Stripe also refunded, as `listCardRefundsPaidTwice` (`card-refund-paid-twice.ts`) returns it. */
export interface CardRefundPaidTwicePanelRow {
  operationId: string;
  bookingId: string;
  bookingReference: string;
  closedAt: string;
  paidAnotherWayCents: number;
  refundedByCardCents: number;
}

/** The warning a refund whose last failure may have reached Stripe carries, on its row and in its dialog. */
export const STRIPE_MAY_HAVE_REFUNDED_WARNING =
  "Stripe may have refunded: check the Stripe dashboard first.";

/**
 * What the dialog says, before the close, about Xero (#3924 rounds 5 to 7).
 * `bankNoteWording` is the bank-transfer note's own wording, from the one home
 * of refund-note words (`describeRefundMethod("internet-banking")`, passed by
 * the server page so this client file does not bundle that module).
 */
function xeroRefundNotePromise(xeroRefundNote: PaidAnotherWayXeroPromise, bankNoteWording: string): string {
  if (xeroRefundNote === "now") {
    return `A Xero refund credit note for the amount, worded "${bankNoteWording}", is queued when you close it.`;
  }
  if (xeroRefundNote === "after-receipt") {
    return `Xero has no record of this late card charge yet. Closing it records the charge in Xero as a payment received into the Stripe account, then queues a Xero refund credit note for the amount, worded "${bankNoteWording}", against it.`;
  }
  if (xeroRefundNote === "after-receipt-on-its-way") {
    return `This late card charge's invoice is on its way to Xero but is not there yet. Once it is, a Xero refund credit note for the amount, worded "${bankNoteWording}", is queued against it.`;
  }
  // Round 7 (UX): an invoice may still be on its way to Xero, so this never
  // says there is none.
  return "No Xero refund credit note is queued: the app has no Xero invoice it can credit for this money yet. Check Xero, and record the refund there by hand if it needs one.";
}

/** What the message after the close says it queued in Xero (`CardRefundPaidAnotherWayResult.xeroQueued`). */
function xeroQueuedMessage(xeroQueued: PaidAnotherWayXeroQueued | undefined, bankNoteWording: string): string {
  if (xeroQueued === "refund-note") return `Its Xero refund credit note, worded "${bankNoteWording}", is queued.`;
  if (xeroQueued === "receipt-then-refund-note") {
    return `The late card charge is queued to be recorded in Xero as a payment received into the Stripe account; its refund credit note, worded "${bankNoteWording}", follows once it is.`;
  }
  if (xeroQueued === "refund-note-after-receipt") {
    return `Its Xero refund credit note, worded "${bankNoteWording}", follows once the late card charge's invoice reaches Xero.`;
  }
  return "No Xero refund credit note was queued: check the refund is recorded in Xero.";
}

/**
 * #3372 (owner, 7 Oct 2026: "Count + add close action"): the card refunds
 * Stripe gave up on, each with a "Paid another way" close.
 *
 * Each one counts in "Refunds owed" and comes off Net Collected until it is
 * closed here. The close is gated `finance:edit` - the permission that
 * completes a refund paid back by hand - and the section's banner states the
 * view-only reason once, so the row buttons do not (`describeReason={false}`).
 * The dialog is the confirm step. The treasurer chooses, explicitly, "Paid back
 * in full" (the amount is what is owed) or "Paid back part of it" (an amount
 * below that, with a warning naming what stops being owed) - never inferred
 * from the amount (owner, 8 Oct 2026). A note saying how the member was paid
 * back is required. It says up front whether a Xero refund note is raised - and,
 * for a late card charge Xero has no record of, that the charge is recorded as
 * a receipt first (#3924 round 6) - and that a refund made in the Stripe
 * dashboard is not closed here. A refusal
 * shows in the dialog through `FocusedActionError`; a 409 also refreshes the
 * list. The dialog holds only the refund's id and reads the row from the list
 * (#3924 round 5, UX F1): if the refresh drops the row the dialog closes and
 * says why, and if what is owed moved the amount resets and says so.
 */
export function DeadCardRefundsPanel({
  rows,
  bankNoteWording,
}: {
  rows: DeadCardRefundPanelRow[];
  /** The bank-transfer refund note's wording (`describeRefundMethod("internet-banking")`). */
  bankNoteWording: string;
}) {
  const canEdit = useAdminAreaEditAccess("finance");
  const format = useClubFormat();
  const clubTime = useClubTime();
  const router = useRouter();
  const amountId = useId();
  const noteId = useId();
  const errorId = useId();
  const submitHintId = useId();
  const warningId = useId();
  const choiceName = useId();
  const wholeAmountHintId = useId();
  const [targetId, setTargetId] = useState<string | null>(null);
  const [seenOwedCents, setSeenOwedCents] = useState<number | null>(null);
  const [paidBack, setPaidBack] = useState<PaidBackChoice | null>(null);
  const [amountInput, setAmountInput] = useState("");
  // Round 7 (UX): the amount's error waits until the treasurer has typed or left the box.
  const [amountTouched, setAmountTouched] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorAttention, setErrorAttention] = useState(0);
  const [owedChanged, setOwedChanged] = useState("");
  const [listNotice, setListNotice] = useState("");
  // Round 8 (UX): after a close the row is gone, so focus goes to the list's
  // status line, which says what happened, instead of to a vanished button.
  const listNoticeRef = useRef<HTMLParagraphElement>(null);
  const focusNoticeOnClose = useRef(false);

  const target = targetId === null ? null : (rows.find((row) => row.operationId === targetId) ?? null);
  // The list moved under the open dialog (a 409's refresh, another treasurer):
  // adjusted while rendering, from the rows, as React's derived-state pattern does.
  if (targetId !== null && target === null && !busy) {
    setTargetId(null);
    setListNotice("That card refund is no longer waiting to be closed, so its dialog was closed. The list is up to date.");
  }
  if (target !== null && seenOwedCents !== null && target.owedCents !== seenOwedCents) {
    setSeenOwedCents(target.owedCents);
    setAmountInput("");
    setAmountTouched(false);
    setOwedChanged(
      `What is still owed changed to ${formatCents(target.owedCents, format)} since you opened this. Check the amount before closing it.`,
    );
  }

  const partialCents = target && paidBack === "partial" ? parseDecimalDollarsToCents(amountInput) : null;
  const amountCents = target === null || paidBack === null ? null : paidBack === "full" ? target.owedCents : partialCents;
  const amountProblem =
    target === null || paidBack !== "partial"
      ? null
      : partialCents === null || partialCents === 0
        ? "Enter the amount paid back, in dollars and cents."
        : partialCents >= target.owedCents
          ? `Part of it must be less than the ${formatCents(target.owedCents, format)} still owed. If all of it was paid back, choose Paid back in full.`
          : null;
  const noteMissing = note.trim() === "";
  const canSubmit =
    target !== null && paidBack !== null && amountCents !== null && amountProblem === null && !noteMissing && !busy;
  // Why the button is disabled, said beside it (#3924 round 4, U2).
  const submitHint =
    target === null || busy
      ? null
      : paidBack === null
        ? "Choose whether it was paid back in full or in part."
        : (amountProblem ?? (noteMissing ? "Say how the member was paid back to close it." : null));
  const noLongerOwedCents =
    target !== null && paidBack === "partial" && partialCents !== null && amountProblem === null
      ? target.owedCents - partialCents
      : null;

  function fail(message: string) {
    setError(message);
    setErrorAttention((count) => count + 1);
  }

  function open(row: DeadCardRefundPanelRow) {
    setTargetId(row.operationId);
    setSeenOwedCents(row.owedCents);
    // A superseded payment's refund closes in full only.
    setPaidBack(row.wholeAmountOnly ? "full" : null);
    setAmountInput("");
    setAmountTouched(false);
    setNote("");
    setError("");
    setOwedChanged("");
    setListNotice("");
  }

  function close() {
    setTargetId(null);
    setSeenOwedCents(null);
  }

  async function submit() {
    if (!target || amountCents === null || paidBack === null) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/payments/card-refunds/${target.operationId}/paid-another-way`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Round 7 (C7): the owed figure the dialog showed; the close refuses
          // a moved one with a 409, and the refresh below shows the new one.
          body: JSON.stringify({
            amountCents,
            paidBack,
            expectedOwedCents: seenOwedCents ?? target.owedCents,
            note,
            confirmed: true,
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(typeof data.error === "string" ? data.error : "Could not close the card refund.");
        // The refund or its payment moved since this page was read.
        if (res.status === 409) router.refresh();
        return;
      }
      const recorded =
        paidBack === "full"
          ? `Closed. ${formatCents(amountCents, format)} recorded as paid back in full.`
          : `Closed. ${formatCents(amountCents, format)} recorded as paid back; the other ${formatCents(
              target.owedCents - amountCents,
              format,
            )} is no longer owed.`;
      toast.success(`${recorded} ${xeroQueuedMessage(data.xeroQueued, bankNoteWording)}`);
      setListNotice(`The card refund for booking ${target.bookingReference} was closed as paid another way.`);
      focusNoticeOnClose.current = true;
      close();
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
      <p
        ref={listNoticeRef}
        role="status"
        tabIndex={-1}
        className="text-sm text-muted-foreground outline-none empty:hidden"
      >
        {listNotice}
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
              aria-label={`Close the card refund for booking ${row.bookingReference} as paid another way`}
              onClick={() => open(row)}
            >
              Paid another way
            </ViewOnlyActionButton>
          </li>
        ))}
      </ul>

      <Dialog open={target !== null} onOpenChange={(next) => !busy && !next && close()}>
        <DialogContent
          className="max-h-[90vh] overflow-y-auto"
          onCloseAutoFocus={(event) => {
            if (!focusNoticeOnClose.current) return;
            focusNoticeOnClose.current = false;
            event.preventDefault();
            listNoticeRef.current?.focus();
          }}
        >
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
              {target ? xeroRefundNotePromise(target.xeroRefundNote, bankNoteWording) : null}
            </p>
            <p className="font-medium text-foreground">
              {target ? `${formatCents(target.owedCents, format)} is still owed.` : null}
            </p>
            {/* Always mounted, so a screen reader hears the change (round 7, UX). */}
            <p role="status" className="font-medium text-warning-11 empty:hidden">
              {owedChanged}
            </p>
          </div>
          <div className="space-y-3">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">How much was paid back?</legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={choiceName}
                  className="size-4"
                  checked={paidBack === "full"}
                  onChange={() => setPaidBack("full")}
                />
                <span>Paid back in full</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={choiceName}
                  className="size-4"
                  checked={paidBack === "partial"}
                  disabled={target?.wholeAmountOnly === true}
                  aria-describedby={target?.wholeAmountOnly ? wholeAmountHintId : undefined}
                  onChange={() => setPaidBack("partial")}
                />
                <span>Paid back part of it - the rest will no longer be owed</span>
              </label>
              {target?.wholeAmountOnly ? (
                <p id={wholeAmountHintId} className="text-xs text-muted-foreground">
                  This refund replaces a superseded payment, so it closes for the whole amount.
                </p>
              ) : null}
            </fieldset>
            {paidBack !== null && target ? (
              <div className="space-y-1">
                <Label htmlFor={amountId}>Amount paid back</Label>
                <MoneyInput
                  id={amountId}
                  value={paidBack === "full" ? formatCentsPlain(target.owedCents) : amountInput}
                  className="w-32"
                  disabled={paidBack === "full"}
                  required={paidBack === "partial"}
                  aria-required={paidBack === "partial" ? "true" : undefined}
                  aria-describedby={noLongerOwedCents !== null ? warningId : undefined}
                  onValueChange={(value) => {
                    setAmountInput(value);
                    setAmountTouched(true);
                  }}
                  onBlur={() => setAmountTouched(true)}
                  error={amountTouched ? amountProblem : null}
                />
                <p id={warningId} role="status" className="text-xs font-medium text-warning-11 empty:hidden">
                  {noLongerOwedCents !== null
                    ? `${formatCents(noLongerOwedCents, format)} will no longer be owed to the member, and will not be tracked anywhere.`
                    : ""}
                </p>
              </div>
            ) : null}
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
            <Button variant="outline" disabled={busy} onClick={close}>
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

/**
 * #3924 round 5 (concurrency F2): card refunds the treasurer closed as paid
 * another way that Stripe refunded to the card as well - its refund was made
 * before the close and reached the app after it. The member has that money
 * twice; recovering it is the treasurer's, outside the app.
 *
 * #3372 (owner, 9 Oct 2026: "Add a 'Resolved' button"): once it is sorted out
 * with the member, the treasurer marks the row Resolved with a note saying how.
 * The note is audited and the row leaves the list; nothing moves in the app or
 * in Xero. Gated `finance:edit` like the close, with its own section banner
 * (`describeReason={false}` on the row buttons). The Resolved carries the card
 * figure the dialog showed, and the server refuses a moved one (#3924 round 8),
 * so a Stripe refund the treasurer never saw is never marked resolved. A 409
 * shows in the dialog and refreshes the list; if the refresh drops the row the
 * dialog closes and says why, and if the card figure moved it says so. After a
 * success focus moves to the list's status line, which says what was done.
 */
export function CardRefundsPaidTwiceList({ rows }: { rows: CardRefundPaidTwicePanelRow[] }) {
  const canEdit = useAdminAreaEditAccess("finance");
  const format = useClubFormat();
  const clubTime = useClubTime();
  const router = useRouter();
  const noteId = useId();
  const errorId = useId();
  const submitHintId = useId();
  const [targetId, setTargetId] = useState<string | null>(null);
  // Round 8 (concurrency): the card figure the dialog showed, sent with the
  // Resolved; a Stripe refund recorded since is refused with a 409.
  const [seenRefundedByCardCents, setSeenRefundedByCardCents] = useState<number | null>(null);
  const [cardChanged, setCardChanged] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorAttention, setErrorAttention] = useState(0);
  const [listNotice, setListNotice] = useState("");
  const listNoticeRef = useRef<HTMLParagraphElement>(null);
  const focusNoticeOnClose = useRef(false);

  const target = targetId === null ? null : (rows.find((row) => row.operationId === targetId) ?? null);
  if (targetId !== null && target === null && !busy) {
    setTargetId(null);
    setListNotice("That card refund is no longer on this list, so its dialog was closed. The list is up to date.");
  }
  if (target !== null && seenRefundedByCardCents !== null && target.refundedByCardCents !== seenRefundedByCardCents) {
    setSeenRefundedByCardCents(target.refundedByCardCents);
    setCardChanged(
      `Stripe has now refunded ${formatCents(target.refundedByCardCents, format)} to the card. Check it is sorted out before marking it resolved.`,
    );
  }
  const noteMissing = note.trim() === "";
  const canSubmit = target !== null && !noteMissing && !busy;

  function open(row: CardRefundPaidTwicePanelRow) {
    setTargetId(row.operationId);
    setSeenRefundedByCardCents(row.refundedByCardCents);
    setCardChanged("");
    setNote("");
    setError("");
    setListNotice("");
  }

  function fail(message: string) {
    setError(message);
    setErrorAttention((count) => count + 1);
  }

  async function submit() {
    if (!target) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/payments/card-refunds/${target.operationId}/paid-twice-resolved`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note,
          expectedRefundedByCardCents: seenRefundedByCardCents ?? target.refundedByCardCents,
          confirmed: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(typeof data.error === "string" ? data.error : "Could not mark it resolved.");
        if (res.status === 409) router.refresh();
        return;
      }
      toast.success(`Marked resolved. Booking ${target.bookingReference} has left the list, and your note is in the audit log.`);
      setListNotice(`Booking ${target.bookingReference} was marked resolved.`);
      focusNoticeOnClose.current = true;
      setTargetId(null);
      router.refresh();
    } catch {
      fail("Could not mark it resolved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <AdminViewOnlySectionBanner canEdit={canEdit} />
      <p className="text-sm text-muted-foreground">
        Each of these card refunds was closed as paid another way, and then Stripe refunded the card as well,
        so the member was paid back twice. Contact the member to recover the extra money, and record what you
        agree in Xero. Then mark it Resolved, saying how it was sorted out.
      </p>
      <p
        ref={listNoticeRef}
        role="status"
        tabIndex={-1}
        className="text-sm text-muted-foreground outline-none empty:hidden"
      >
        {listNotice}
      </p>
      <ul className="space-y-2" aria-label="Card refunds paid back twice">
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
                {formatCents(row.refundedByCardCents, format)} refunded to the card after{" "}
                {formatCents(row.paidAnotherWayCents, format)} was paid back another way
              </div>
              <div className="text-xs text-muted-foreground">
                Closed as paid another way {clubTime.instantDate(new Date(row.closedAt))}
              </div>
            </div>
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              size="sm"
              aria-label={`Mark booking ${row.bookingReference} resolved`}
              onClick={() => open(row)}
            >
              Resolved
            </ViewOnlyActionButton>
          </li>
        ))}
      </ul>

      <Dialog open={target !== null} onOpenChange={(next) => !busy && !next && setTargetId(null)}>
        <DialogContent
          className="max-h-[90vh] overflow-y-auto"
          onCloseAutoFocus={(event) => {
            if (!focusNoticeOnClose.current) return;
            focusNoticeOnClose.current = false;
            event.preventDefault();
            listNoticeRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Mark this card refund, paid back twice, as resolved?</DialogTitle>
            <DialogDescription>
              Only once it is sorted out with the member. It leaves this list, and your note is kept in the audit
              log. Nothing is refunded or charged, and nothing is sent to Xero: record what you agreed there yourself.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm font-medium text-foreground">
            {target
              ? `Booking ${target.bookingReference}: ${formatCents(target.refundedByCardCents, format)} refunded to the card after ${formatCents(target.paidAnotherWayCents, format)} was paid back another way.`
              : null}
          </p>
          {/* Always mounted, so a screen reader hears the change (round 8). */}
          <p role="status" className="text-sm font-medium text-warning-11 empty:hidden">
            {cardChanged}
          </p>
          <div className="space-y-1">
            <Label htmlFor={noteId}>How was it sorted out? (required)</Label>
            <Textarea
              id={noteId}
              value={note}
              required
              aria-required="true"
              maxLength={MANUAL_PAYMENT_NOTE_MAX}
              placeholder="For example: member paid the extra back by bank transfer on 12 Oct, reference REF123"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <FocusedActionError id={errorId} error={error} attentionKey={errorAttention} />
          <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
            {target !== null && noteMissing && !busy ? (
              <p id={submitHintId} className="text-xs text-muted-foreground sm:mr-auto">
                Say how it was sorted out to mark it resolved.
              </p>
            ) : null}
            <Button variant="outline" disabled={busy} onClick={() => setTargetId(null)}>
              Cancel
            </Button>
            <Button
              disabled={!canSubmit}
              aria-describedby={target !== null && noteMissing && !busy ? submitHintId : undefined}
              onClick={() => void submit()}
            >
              {busy ? "Saving..." : "Mark resolved"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
