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
import { OptionCard, OptionCardGroup } from "@/components/ui/option-card";
import { Textarea } from "@/components/ui/textarea";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useClubFormat } from "@/components/club-format-provider";
import { useClubTime } from "@/components/club-time-provider";
import { RefundListCard, useShownOnceItHadRows } from "@/components/admin/card-refund-list-card";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import type { PaidAnotherWayXeroPromise } from "@/lib/card-refund-paid-another-way-xero";
import { PAID_BACK_REST_CHOICES, PAID_BACK_REST_LABELS, type PaidBackChoice, type PaidBackRestChoice } from "@/lib/card-refund-paid-back";
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import { parseDecimalDollarsToCents } from "@/lib/money-input";
import { formatCents, formatCentsPlain } from "@/lib/utils";
import { xeroQueuedMessage, xeroRefundNotePromise } from "@/components/admin/dead-card-refunds-xero-copy";
import {
  NothingLeftOwedDialog,
  TryCardAgainDialog,
  type LaterStripeRefundPanelRow,
} from "@/components/admin/dead-card-refund-row-actions";

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
   * way to Xero (`after-receipt-on-its-way`, round 8); the note after a
   * receipt only an officer's retry sends (`after-receipt-failed`,
   * `after-receipt-held-for-officer`, round 9); or no note (`none`).
   */
  xeroRefundNote: PaidAnotherWayXeroPromise;
  /** #4104: how much of it a card refund note already in Xero answers; 0 for none. */
  cardNoteCoversCents: number;
  /** Its last failure looked like a timeout or network error: Stripe may have refunded. */
  stripeMayHaveRefunded: boolean;
  /** #4368: with nothing left owed, the later Stripe refunds its "Nothing left owed" close names. */
  laterStripeRefunds: LaterStripeRefundPanelRow[];
  /** #4368: why "Try the card again" is not offered, or null when it is. */
  tryCardAgainRefusal: string | null;
  paidAnotherWayRefusal: string | null;
}

/** The warning a refund whose last failure may have reached Stripe carries, on its row and in its dialog. */
export const STRIPE_MAY_HAVE_REFUNDED_WARNING =
  "Stripe may have refunded: check the Stripe dashboard first.";

/**
 * #3372 (owner, 7 Oct 2026: "Count + add close action"): the card refunds
 * Stripe gave up on, each with a "Paid another way" close. #4368 (owner
 * decision, 25 Oct 2026): beside it "Try the card again", and on a row whose
 * owed figure reads $0 "Nothing left owed" instead
 * (`dead-card-refund-row-actions.tsx`), gated by the same finance:edit answer
 * under the same banner.
 *
 * Each one counts in "Refunds owed" and comes off Net Collected until it is
 * closed here. The close is gated `finance:edit` - the permission that
 * completes a refund paid back by hand - and the section's banner states the
 * view-only reason once, so the row buttons do not (`describeReason={false}`).
 * The dialog is the confirm step. The treasurer chooses, explicitly, "Paid back
 * in full" (the amount is what is owed) or "Paid back part of it" (an amount
 * below that) - never inferred from the amount (owner, 8 Oct 2026). A part
 * close then asks what happens to the rest, with nothing chosen for them
 * (#4516; owner, 2 Nov 2026: "Ask exactly and officer chooses"): the club
 * keeps it (a warning names what stops being owed), or it is still owed to the
 * member (it stays on this list for a later close). A note saying how the member was paid
 * back is required. It says up front whether a Xero refund note is raised - and,
 * for a late card charge Xero has no record of, that the charge is recorded as
 * a receipt first (#3924 round 6) - and that it is settled here, never with a
 * new Stripe dashboard refund (#4368, decision 7). A refusal
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
  const [rest, setRest] = useState<PaidBackRestChoice | null>(null); // #4516: no default
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
  // Round 10: so too when the dialog closes because its row vanished - any
  // close that leaves a notice, since opening the dialog clears it.
  const listNoticeRef = useRef<HTMLParagraphElement>(null);
  const shown = useShownOnceItHadRows(rows.length);

  // #4368: the "Try the card again" and "Nothing left owed" dialogs, each open for one row's id.
  const [tryAgainId, setTryAgainId] = useState<string | null>(null);
  const [nothingLeftId, setNothingLeftId] = useState<string | null>(null);
  const tryAgainRow = tryAgainId === null ? null : (rows.find((row) => row.operationId === tryAgainId && row.owedCents > 0 && row.tryCardAgainRefusal === null) ?? null);
  const nothingLeftRow = nothingLeftId === null ? null : (rows.find((row) => row.operationId === nothingLeftId && row.owedCents === 0) ?? null);
  if ((tryAgainId !== null && tryAgainRow === null) || (nothingLeftId !== null && nothingLeftRow === null)) {
    setTryAgainId(null);
    setNothingLeftId(null);
    setListNotice("That card refund changed, so its dialog was closed. The list is up to date.");
  }

  const listedTarget = targetId === null ? null : (rows.find((row) => row.operationId === targetId) ?? null);
  const target = listedTarget && !listedTarget.paidAnotherWayRefusal ? listedTarget : null;
  // The list moved under the open dialog (a 409's refresh, another treasurer):
  // adjusted while rendering, from the rows, as React's derived-state pattern does.
  if (targetId !== null && target === null && !busy) {
    setTargetId(null);
    setListNotice(
      listedTarget
        ? "That card refund changed, so its dialog was closed. The list is up to date."
        : "That card refund is no longer waiting to be closed, so its dialog was closed. The list is up to date.",
    );
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
  const restMissing = paidBack === "partial" && rest === null;
  const canSubmit =
    target !== null && paidBack !== null && amountCents !== null && amountProblem === null && !restMissing && !noteMissing && !busy;
  // Why the button is disabled, said beside it (#3924 round 4, U2).
  const submitHint =
    target === null || busy
      ? null
      : paidBack === null
        ? "Choose whether it was paid back in full or in part."
        : (amountProblem ?? (restMissing ? "Choose whether the club keeps the rest or it is still owed to the member."
          : noteMissing ? "Say how the member was paid back to close it." : null));
  const restCents =
    target !== null && paidBack === "partial" && partialCents !== null && amountProblem === null
      ? target.owedCents - partialCents
      : null;
  const noLongerOwedCents = rest === "club-keeps" ? restCents : null;

  function fail(message: string) {
    setError(message);
    setErrorAttention((count) => count + 1);
  }

  function open(row: DeadCardRefundPanelRow) {
    setTargetId(row.operationId);
    setSeenOwedCents(row.owedCents);
    // A superseded payment's refund closes in full only.
    setPaidBack(row.wholeAmountOnly ? "full" : null);
    setRest(null);
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

  function openOther(setId: (id: string | null) => void, row: DeadCardRefundPanelRow) {
    setListNotice("");
    setId(row.operationId);
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
            ...(paidBack === "partial" && rest ? { rest } : {}),
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
            )} ${rest === "still-owed" ? "is still owed to the member and stays on this list." : "is kept by the club and no longer owed."}`;
      toast.success(`${recorded} ${xeroQueuedMessage(data.xeroQueued, bankNoteWording)}`);
      setListNotice(`The card refund for booking ${target.bookingReference} was closed as paid another way.`);
      close();
      router.refresh();
    } catch {
      fail("Could not close the card refund.");
    } finally {
      setBusy(false);
    }
  }

  if (!shown) return null;
  return (
    <RefundListCard title="Card refunds Stripe gave up on">
      <div className="space-y-3">
        <AdminViewOnlySectionBanner canEdit={canEdit} />
        <p className="text-sm text-muted-foreground">
          The app will not ask Stripe for these card refunds again on its own: Stripe stopped retrying them, or
          accepted one and later reported it failed - a retry that failed again, or a refund made before the app
          could notice such failures, which the member may already have been paid back by hand. Each still
          counts in Refunds owed and comes off Net Collected until it is settled here. If you paid the member
          back another way, for example by bank transfer, close it with Paid another way. To have the app ask
          the card again, use Try the card again. Once a later Stripe refund covers one, it says nothing is left
          owed: close it with Nothing left owed. Do not settle one with a new refund in the Stripe dashboard.
        </p>
        <p
          ref={listNoticeRef}
          role="status"
          tabIndex={-1}
          className="text-sm text-muted-foreground outline-none empty:hidden"
        >
          {listNotice}
        </p>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No card refunds are waiting to be closed.</p>
        ) : null}
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
                  {row.owedCents === 0 ? "nothing left owed" : `${formatCents(row.owedCents, format)} still owed`}
                </div>
                <div className="text-xs text-muted-foreground">
                  Refund started {clubTime.instantDate(new Date(row.raisedAt))}
                </div>
                {row.stripeMayHaveRefunded ? (
                  <div className="text-xs font-medium text-warning-11">{STRIPE_MAY_HAVE_REFUNDED_WARNING}</div>
                ) : null}
              </div>
              {row.owedCents === 0 ? (
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  variant="outline"
                  size="sm"
                  aria-label={`Close the card refund for booking ${row.bookingReference} with nothing left owed`}
                  onClick={() => openOther(setNothingLeftId, row)}
                >
                  Nothing left owed
                </ViewOnlyActionButton>
              ) : (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {row.tryCardAgainRefusal === null ? (
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      variant="outline"
                      size="sm"
                      aria-label={`Try the card again for the card refund on booking ${row.bookingReference}`}
                      onClick={() => openOther(setTryAgainId, row)}
                    >
                      Try the card again
                    </ViewOnlyActionButton>
                  ) : (
                    <p className="max-w-sm text-xs text-muted-foreground">{row.tryCardAgainRefusal}</p>
                  )}
                  {row.paidAnotherWayRefusal ? (
                    <p className="max-w-sm text-xs text-muted-foreground">{row.paidAnotherWayRefusal}</p>
                  ) : (
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
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>

        <TryCardAgainDialog
          row={tryAgainRow}
          onClose={() => setTryAgainId(null)}
          onDone={setListNotice}
          focusNotice={() => listNoticeRef.current?.focus()}
        />
        <NothingLeftOwedDialog
          row={nothingLeftRow}
          onClose={() => setNothingLeftId(null)}
          onDone={setListNotice}
          focusNotice={() => listNoticeRef.current?.focus()}
        />

        <Dialog open={target !== null} onOpenChange={(next) => !busy && !next && close()}>
          <DialogContent
            className="max-h-[90vh] overflow-y-auto"
            onCloseAutoFocus={(event) => {
              if (listNotice === "") return;
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
                Settle it here, not with a new refund in the Stripe dashboard.
              </p>
              <p className="text-muted-foreground">
                {target
                  ? xeroRefundNotePromise(target.xeroRefundNote, bankNoteWording, formatCents(target.cardNoteCoversCents, format))
                  : null}
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
                  <span>Paid back part of it</span>
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
                      ? `${formatCents(noLongerOwedCents, format)} will no longer be owed to the member: the club keeps it, as this close records.`
                      : rest === "still-owed" && restCents !== null
                        ? `${formatCents(restCents, format)} stays owed to the member, on this list, until it is closed.`
                        : ""}
                  </p>
                </div>
              ) : null}
              {paidBack === "partial" ? (
                // #4516 (owner, 2 Nov 2026): asked exactly, nothing chosen for the treasurer.
                <OptionCardGroup label="What happens to the rest?">
                  {PAID_BACK_REST_CHOICES.map((choice) => (
                    <OptionCard key={choice} selected={rest === choice} onSelect={() => setRest(choice)} title={PAID_BACK_REST_LABELS[choice]} />
                  ))}
                </OptionCardGroup>
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
    </RefundListCard>
  );
}
