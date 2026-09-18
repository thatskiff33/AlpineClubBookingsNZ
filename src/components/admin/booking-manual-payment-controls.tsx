"use client";

import { useState } from "react";
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
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BookingNoEmailsNotice } from "@/components/booking-no-emails-notice";
import { FocusedActionError } from "@/components/focused-action-error";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { formatCents } from "@/lib/utils";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";

// #3498 fix round: imported rather than mirrored. `manual-payment-note.ts` is
// the one definition and is deliberately import-free, so a client component
// can reach it without dragging the server module across the boundary.
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";

const NOTE_MAX_LENGTH = MANUAL_PAYMENT_NOTE_MAX;

export interface BookingManualPaymentState {
  /** Amount owing right now, in integer cents — the figure the server re-derives. */
  amountOwingCents: number;
  /**
   * #2265 (#2262 delta MED-3): the member asked to put this much account credit
   * towards the booking and it has not been applied yet. Null on the
   * overwhelming majority of bookings. Recording cash CANNOT honour it — the
   * money has already changed hands outside the app — so the settle clears it
   * and tells the member their credit is untouched. That is a legitimate
   * outcome, not an error, but the admin holding the cash deserves to know
   * before they click rather than after.
   */
  storedCreditElectionCents: number | null;
  /**
   * #2397: an upward price change was recorded on this booking after it was
   * priced, and that extra has never been collected — in integer cents, or 0
   * (the overwhelmingly common case) when there is none.
   *
   * When it is 0 the dialog is EXACTLY as it was: no extra question, no extra
   * figures, no extra field on the request. When it is not, the admin holding
   * the money is shown how the one amount splits and must say whether the cash
   * covers the extra as well, because that answer decides whether the club goes
   * on asking the member for it.
   */
  outstandingAdditionalCents: number;
  /** Whether this booking can be recorded as settled at all. */
  canMarkPaid: boolean;
  /** Why not, when it cannot — shown instead of the action. */
  markPaidBlockedReason: string | null;
  /** Set when this payment already carries a manual settlement. */
  manuallyMarkedPaidAt: string | null;
  manuallyMarkedPaidByName: string | null;
  manualPaymentNote: string | null;
  /** Whether the reversal is offered (the server re-checks every fence). */
  canReverse: boolean;
  reverseBlockedReason: string | null;
}

/**
 * B5 (#2262): record a booking's payment as cash / an off-Xero bank transfer,
 * and reverse a prior manual record.
 *
 * The SERVER is the enforcement point — every fence is re-asserted under the
 * booking locks and re-checked inside the fenced write — so the flags here only
 * decide what to OFFER. An action that is offered can still be refused with a
 * 409, and the message is shown verbatim.
 */
export function BookingManualPaymentControls({
  bookingId,
  memberName,
  state,
  noEmails = false,
}: {
  bookingId: string;
  memberName: string;
  state: BookingManualPaymentState;
  /**
   * #2259 honesty rule: with the booking's "No emails" switch on, the
   * confirmation is withheld by the mailer whatever is chosen here, so the
   * dialog states the position instead of offering a choice it cannot honour.
   */
  noEmails?: boolean;
}) {
  const router = useRouter();
  // Writes /api/admin/bookings/[id]/mark-paid, which is FINANCE-gated (the
  // bookings prefix is deliberately overridden in SPECIAL_ROUTE_AREA_PATTERNS),
  // so the affordance follows finance:edit, not bookings:edit.
  const canEdit = useAdminAreaEditAccess("finance");
  const [dialog, setDialog] = useState<null | "paid" | "unpaid">(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /**
   * #2668 review SF-5: the sentence for an outcome that was never read, held on
   * screen rather than thrown as a toast.
   *
   * A toast is the wrong carrier for this one message. The dialog stays open on
   * a failure and the confirm button re-arms in `finally`, so the operator's
   * likeliest next act — a second press — happens while the toast is still
   * fading in, and this is the surface where a second press costs the most. The
   * notice sits inside the dialog, above the buttons it disarms, until they act
   * on it. The server's own refusals keep their toast: those say what happened.
   */
  const [unverified, setUnverified] = useState<string | null>(null);
  /**
   * Bumped with each unread outcome so the recovery alert takes focus again on a
   * repeat. It has to take focus at all because this branch DISABLES the button
   * that was just pressed, and a control disabled in the same turn cannot hold
   * focus — it would fall to `<body>` and leave a keyboard user with no place
   * and no explanation, which is the failure `FocusedActionError` exists for.
   */
  const [unverifiedAttention, setUnverifiedAttention] = useState(0);
  /*
    #2264: the "e.g. …" specimens used to sit in each note box as a placeholder.
    Grey example text INSIDE a control reads as a value the form already holds,
    and it vanishes the moment the admin starts typing — exactly when the
    example is still wanted. Both now render as helper text under the field,
    wired to it with `aria-describedby`. The settle-note hint ABSORBS the
    "kept with the club's records" paragraph that already sat there rather than
    stacking a second line beneath it.
  */
  const paymentNoteHint = useFieldHint();
  const reversalNoteHint = useFieldHint();
  /**
   * #2397: the admin's answer about the outstanding extra. Starts UNANSWERED
   * and has no default — recording the payment is blocked until they choose,
   * because guessing either way is a guess about money.
   */
  const [additionalCovered, setAdditionalCovered] = useState<boolean | null>(
    null
  );

  const isSettled = state.manuallyMarkedPaidAt !== null;
  const outstandingAdditionalCents = state.outstandingAdditionalCents;
  const hasOutstandingAdditional = outstandingAdditionalCents > 0;
  // The extra is a SLICE of the amount owing, not a sum on top of it: an upward
  // change raised the booking's price by the same amount it recorded as the
  // extra. So the booking's worth before the change is the difference.
  const baseAmountCents = state.amountOwingCents - outstandingAdditionalCents;
  const additionalAnswered = !hasOutstandingAdditional || additionalCovered !== null;
  /**
   * What will actually be RECORDED AS RECEIVED (owner decision, 31 Jul 2026).
   * The answer changes it: saying the cash did not cover the addition records
   * only the amount from before the change, so the club's books show what was
   * handed over rather than what the booking is worth. Null until answered —
   * the dialog must not put a figure in the title it cannot stand behind.
   */
  const recordedAmountCents = !hasOutstandingAdditional
    ? state.amountOwingCents
    : additionalCovered === null
      ? null
      : additionalCovered
        ? state.amountOwingCents
        : baseAmountCents;

  function openDialog(direction: "paid" | "unpaid") {
    setNote("");
    setAdditionalCovered(null);
    setUnverified(null);
    setDialog(direction);
  }

  /**
   * Closing the dialog also clears the notice — it belongs to the attempt that
   * produced it, and a stale one over a fresh dialog would read as an outcome
   * of the press that has not happened yet.
   */
  function closeDialog() {
    setDialog(null);
    setUnverified(null);
  }

  /**
   * #2259 H1: dispatch the silenced path so the send is ATTEMPTED, not skipped.
   *
   * `notifyMember: false` would make the ROUTE skip the send outright, so the
   * mailer's "No emails" gate never runs, no `SKIPPED_NO_EMAILS` row is written,
   * and the booking's withheld-list banner would omit the confirmation the
   * member was never sent — the very banner the operator guide tells the officer
   * to work down. The sibling surfaces achieve that by OMITTING the flag; this
   * route cannot, because #2260 makes the choice REQUIRED on the paid direction
   * (an absent flag is a 422, deliberately, so an ambiguous money action is
   * refused rather than guessed). So the silenced path asks for the send and
   * lets the mailer withhold and RECORD it, which is the same audit outcome by
   * the stronger route: the member is not emailed either way, and the returned
   * receipt reports not-delivered rather than claiming a send.
   */
  function confirmSilenced() {
    void submit("paid", true);
  }

  async function submit(direction: "paid" | "unpaid", notifyMember?: boolean) {
    setSubmitting(true);
    setUnverified(null);
    try {
      const response = await fetch(`/api/admin/bookings/${bookingId}/mark-paid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          direction,
          confirmed: true,
          note: note.trim() || null,
          ...(direction === "paid"
            ? {
                notifyMember: notifyMember === true,
                // The amount the admin was shown. The server recomputes the
                // settlement amount under its locks and refuses if this no
                // longer matches, so a price that moved is never recorded at
                // the figure on a stale screen.
                expectedAmountCents: state.amountOwingCents,
                // #2397: sent ONLY when this screen showed an outstanding
                // extra. Omitting it is the claim that it did not, which the
                // server re-checks under its locks.
                ...(hasOutstandingAdditional
                  ? {
                      additionalCoverage: {
                        covered: additionalCovered === true,
                        expectedAdditionalAmountCents:
                          outstandingAdditionalCents,
                      },
                    }
                  : {}),
              }
            : {}),
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { error?: string; message?: string }
        | null;
      if (!response.ok) {
        toast.error(data?.error ?? "Could not record this payment.");
        return;
      }
      toast.success(data?.message ?? "Done.");
      setDialog(null);
      router.refresh();
    } catch {
      /*
        #2668. This used to say "Nothing was recorded." It is the worst place in
        the app to guess that: `fetch` also rejects when the POST reached the
        server and the connection dropped before the answer came back, in which
        case the cash payment IS on the booking — and an admin told nothing
        happened records it a second time. Say what is actually known and send
        them at the booking, which is where the truth is.

        Review SF-5: on this surface the message is also DELIVERED differently
        from a refusal. It is held in the dialog and the recording buttons stay
        disarmed behind it, because the operator's next press is the act the
        message exists to prevent and a toast is gone before it is read. The
        server does refuse a second manual settlement on an already-settled
        booking, so no money moves either way — but "check first" is the
        instruction, and the screen now behaves like it means it.
      */
      setUnverified(
        unverifiedWriteMessage(
          "this payment was recorded",
          "Reload the booking and check before recording it again.",
        ),
      );
      setUnverifiedAttention((value) => value + 1);
    } finally {
      setSubmitting(false);
    }
  }

  /*
    #2668 SF-5. The house recovery alert (`focused-action-error.tsx`, #2597 /
    #2635): permanently mounted so the live region is registered in the
    accessibility tree before it has anything to say — one injected
    already-populated is silently dropped by some screen-reader/browser pairings
    — assertive, and it TAKES FOCUS when the message arrives. Focus matters more
    here than on the surfaces that component was written for: this branch
    disables the button that was just pressed, so without it focus would fall to
    `<body>` and a keyboard operator would be left with neither a place nor the
    explanation. Its focus timing is a passive effect on purpose; assert it with
    `expectRecoveryAlertToHoldFocus`, never a synchronous `activeElement` check.
  */
  const unverifiedNotice = (
    <FocusedActionError
      id="manual-payment-unverified-notice"
      error={unverified ?? ""}
      attentionKey={unverifiedAttention}
    />
  );

  return (
    <div
      className="space-y-2 rounded-md border border-border px-3 py-2"
      data-testid="booking-manual-payment-controls"
    >
      <p className="text-sm font-medium text-foreground">
        Cash / off-Xero payment
      </p>

      {isSettled ? (
        <p className="text-sm text-muted-foreground">
          Recorded as paid manually
          {state.manuallyMarkedPaidByName
            ? ` by ${state.manuallyMarkedPaidByName}`
            : ""}
          .{" "}
          {state.manualPaymentNote ? `Note: ${state.manualPaymentNote}` : null}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Record a payment the club received in cash, or by a bank transfer that
          never reached Xero. This never contacts Xero and never creates or
          settles an invoice.
        </p>
      )}

      {!isSettled &&
        (state.canMarkPaid ? (
          <ViewOnlyActionButton
            canEdit={canEdit}
            type="button"
            variant="outline"
            onClick={() => openDialog("paid")}
          >
            Record manual payment ({formatCents(state.amountOwingCents)})
          </ViewOnlyActionButton>
        ) : (
          <p className="text-sm text-warning-11">
            {state.markPaidBlockedReason ??
              "This booking's payment cannot be recorded manually."}
          </p>
        ))}

      {isSettled &&
        (state.canReverse ? (
          <ViewOnlyActionButton
            canEdit={canEdit}
            type="button"
            variant="outline"
            onClick={() => openDialog("unpaid")}
          >
            Reverse manual payment
          </ViewOnlyActionButton>
        ) : (
          <p className="text-sm text-warning-11">
            {state.reverseBlockedReason ??
              "This manual payment can no longer be reversed — cancel the booking instead."}
          </p>
        ))}

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent>
          {dialog === "paid" ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {recordedAmountCents === null
                    ? `Record a payment for ${memberName}?`
                    : `Record ${formatCents(recordedAmountCents)} as paid for ${memberName}?`}
                </DialogTitle>
                <DialogDescription>
                  This records money the club has already received in cash or by
                  an off-Xero bank transfer. The booking becomes paid and its
                  beds are claimed. It never contacts Xero, and no invoice is
                  created or emailed.
                </DialogDescription>
              </DialogHeader>
              {state.storedCreditElectionCents != null ? (
                <p
                  className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11"
                  data-testid="manual-payment-credit-election-warning"
                >
                  {memberName} asked to put{" "}
                  {formatCents(state.storedCreditElectionCents)} of their account
                  credit towards this booking, and it has not been applied yet.
                  Recording cash cannot use it — the money has already changed
                  hands — so that credit will stay unused and remain available on
                  their account, and they will be told so. Take the full{" "}
                  {formatCents(state.amountOwingCents)} only if that is what they
                  have actually handed over.
                </p>
              ) : null}
              {hasOutstandingAdditional ? (
                <div
                  className="space-y-3 rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11"
                  data-testid="manual-payment-additional-coverage"
                >
                  <p>
                    A later change to this booking added{" "}
                    <strong>{formatCents(outstandingAdditionalCents)}</strong>,
                    which is recorded separately and is still marked as unpaid.
                    That amount is part of the{" "}
                    {formatCents(state.amountOwingCents)} this booking owes, not
                    on top of it:
                  </p>
                  <dl className="space-y-1">
                    <div className="flex justify-between gap-4">
                      <dt>Booking before the change</dt>
                      <dd data-testid="manual-payment-additional-base">
                        {formatCents(baseAmountCents)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt>Later addition, still marked unpaid</dt>
                      <dd data-testid="manual-payment-additional-extra">
                        {formatCents(outstandingAdditionalCents)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4 border-t border-warning-6 pt-1">
                      <dt>Owed in total</dt>
                      <dd data-testid="manual-payment-additional-owing">
                        {formatCents(state.amountOwingCents)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4 font-medium">
                      <dt>Total being recorded as paid</dt>
                      <dd data-testid="manual-payment-additional-total">
                        {recordedAmountCents === null
                          ? "answer below"
                          : formatCents(recordedAmountCents)}
                      </dd>
                    </div>
                  </dl>
                  <fieldset className="space-y-2">
                    <legend className="font-medium">
                      Does the money you have received cover that{" "}
                      {formatCents(outstandingAdditionalCents)} addition as
                      well?
                    </legend>
                    <label className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="manual-payment-additional-covered"
                        className="mt-1"
                        checked={additionalCovered === true}
                        onChange={() => setAdditionalCovered(true)}
                      />
                      <span>
                        Yes — record the full{" "}
                        {formatCents(state.amountOwingCents)}, including the{" "}
                        {formatCents(outstandingAdditionalCents)} addition. The
                        booking is fully paid and the member will not be asked
                        for the addition again.
                      </span>
                    </label>
                    <label className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="manual-payment-additional-covered"
                        className="mt-1"
                        checked={additionalCovered === false}
                        onChange={() => setAdditionalCovered(false)}
                      />
                      <span>
                        No — record only the{" "}
                        {formatCents(baseAmountCents)} owed before the change.
                        The booking is marked paid, but the{" "}
                        {formatCents(outstandingAdditionalCents)} addition stays
                        recorded as owing and the club will keep asking the
                        member for it. If the member has a card payment set up
                        for that addition it is left open, so they can pay it
                        from their own booking page; you will be told which
                        applies once the payment is recorded.
                      </span>
                    </label>
                  </fieldset>
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="manual-booking-payment-note">
                  Note (optional)
                </Label>
                <Textarea
                  id="manual-booking-payment-note"
                  value={note}
                  maxLength={NOTE_MAX_LENGTH}
                  onChange={(event) => setNote(event.target.value)}
                  {...paymentNoteHint.fieldProps}
                />
                <FieldHint {...paymentNoteHint.hintProps}>
                  e.g. cash at the lodge, or bank transfer ref 1234. Kept with
                  the club&apos;s records — the member never sees this note.
                </FieldHint>
              </div>
              {noEmails ? (
                <BookingNoEmailsNotice />
              ) : (
                <p className="text-sm text-muted-foreground">
                  The payment is recorded either way. Choose whether the member
                  is emailed the usual booking confirmation — your choice is
                  recorded in the audit log.
                </p>
              )}
              {unverifiedNotice}
              <DialogFooter className="gap-2 sm:gap-2">
                {/*
                  After an unread outcome "Cancel" would itself be a claim —
                  there may be nothing left to cancel — so the way out is named
                  for what it does.
                */}
                <Button
                  variant="ghost"
                  onClick={closeDialog}
                  disabled={submitting}
                >
                  {unverified ? "Close and check" : "Cancel"}
                </Button>
                {!noEmails ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => submit("paid", false)}
                      disabled={
                        submitting || !additionalAnswered || unverified !== null
                      }
                    >
                      Record without emailing
                    </Button>
                    <Button
                      onClick={() => submit("paid", true)}
                      disabled={
                        submitting || !additionalAnswered || unverified !== null
                      }
                    >
                      Record and email member
                    </Button>
                  </>
                ) : (
                  <Button
                    onClick={confirmSilenced}
                    disabled={
                      submitting || !additionalAnswered || unverified !== null
                    }
                  >
                    Record payment
                  </Button>
                )}
              </DialogFooter>
            </>
          ) : dialog === "unpaid" ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  Reverse the manual payment for {memberName}?
                </DialogTitle>
                <DialogDescription>
                  The booking goes back to being unpaid and the manual payment
                  record is cleared. It is NOT cancelled. The member is not
                  emailed — there is no reversal notice. A booking restored to
                  awaiting-payment stops holding its beds, so other bookings
                  can take them — and recording the payment again later can be
                  refused if the lodge has filled in the meantime. This is only
                  possible while nothing has happened since that a reversal
                  could not undo: no refund, no card payment, no open refund
                  task, and no Xero invoice.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="manual-booking-reversal-note">
                  Note (optional)
                </Label>
                <Textarea
                  id="manual-booking-reversal-note"
                  value={note}
                  maxLength={NOTE_MAX_LENGTH}
                  onChange={(event) => setNote(event.target.value)}
                  {...reversalNoteHint.fieldProps}
                />
                <FieldHint {...reversalNoteHint.hintProps}>
                  e.g. recorded against the wrong booking
                </FieldHint>
              </div>
              {unverifiedNotice}
              <DialogFooter className="gap-2 sm:gap-2">
                <Button
                  variant="ghost"
                  onClick={closeDialog}
                  disabled={submitting}
                >
                  {unverified ? "Close and check" : "Cancel"}
                </Button>
                <Button
                  onClick={() => submit("unpaid")}
                  disabled={submitting || unverified !== null}
                >
                  Reverse payment
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
