"use client";
import { fetchWithRecentAuth } from "@/components/confirm-its-you";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { FocusedActionError } from "@/components/focused-action-error";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { formatCents } from "@/lib/utils";
import type { ManualRefundTaskKind } from "@prisma/client";
import { useClubTime } from "@/components/club-time-provider";
import { formatStayDate } from "@/lib/club-time";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";
import { DISPUTED_HAND_BACK_LOST_DISMISS_DESCRIPTION, RETIRED_EDIT_REVIEW_REFUSAL } from "@/lib/manual-refund-task-copy";
import { ManualRefundTaskDisputeReduction } from "@/components/admin/manual-refund-task-dispute-reduction";
// #3213: whether a row may be closed as money that moved is decided ONCE, in a
// client-safe home, and the completion door throws on the same answer
// (`manual-refund-task-resolution.ts`, `INV-SSOT`). Deciding it again here is
// what would let this card go on offering a control the server has started
// refusing - a disagreement nobody sees until an officer presses the button.
import { manualRefundTaskKindAllowsSettlement } from "@/lib/manual-refund-task-settlement-rules";
// #3498 (owner decision D2): the reopen card is its own file. One card, one
// action, everything by props - and this module already carries two cards, a
// settle dialog and the whole settlement conversation.
import {
  ManualRefundTaskReopenCard,
  type DismissedManualRefundTask,
} from "@/components/admin/manual-refund-task-reopen-card";

import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import type { ClubFormat } from "@/lib/club-format";
import { useClubFormat } from "@/components/club-format-provider";
import { PartPaymentReviewXeroPaidLine } from "@/components/admin/part-payment-review-xero-paid-line";
import { BankRefundVoidAnswerChoice } from "@/components/admin/bank-refund-void-answer-choice";
import { bankRefundVoidQuestion, type BankRefundVoidAnswer } from "@/lib/bank-refund-void-follow-up-copy";
import { formatBookingReference } from "@/lib/booking-reference";
import { AutomaticRefundNoticesCard, type AutoRefundedNotice } from "@/components/admin/automatic-refund-notices-card";
import { notifyAdminQueueChanged } from "@/lib/admin-queue-events";

const NOTE_MAX_LENGTH = MANUAL_PAYMENT_NOTE_MAX;

interface ManualRefundTask {
  id: string;
  bookingId: string;
  // #2797 (owner decision D2): NULL where the task carries no amount. Rendered
  // as "Amount not known", never as $0.00 — a magic zero would read as
  // "assessed at nothing".
  amountCents: number | null;
  /**
   * #3033: what the task was RAISED with, so a row whose amount an admin has
   * since confirmed says so on its face instead of only in the audit log. Null
   * exactly when the task was raised with no amount at all.
   */
  raisedAmountCents?: number | null;
  /**
   * #3033: WHY this row exists. Optional on the wire and null for every row
   * written before the column existed, so a cached client bundle against an
   * older route — and every legacy hand-back row — still renders: an absent or
   * null kind is treated as the hand-back it has always been.
   */
  kind?: string | null;
  /** #3639: a late capture held for a treasurer. Optional: a cached bundle degrades. */
  awaitingLateCaptureApproval?: boolean;
  /** #3643: a part payment the club settles in Xero. Optional, as above. */
  partPaymentReview?: boolean;
  /** #3827: an edit's refund, sent back by bank transfer. Optional, as above. */
  editRefundHandBack?: boolean;
  /** #3827 (D-3813-7): an approved appeal's refund, by bank transfer. Optional, as above. */
  refundRequestHandBack?: boolean;
  paidToGroupOrganiser?: boolean; // #3949: either of those two, paid back to the group organiser
  /** #4042: an organiser's Internet Banking group cancel, repaid to the organiser. Optional, as above. */
  groupOrganiserHandBack?: boolean;
  /** #4516: why the server refuses this hand-back's dismissal, in its words, or null (`journalHandBackDismissal`). Optional, as above. */
  journalHandBackDismissRefusal?: string | null;
  /** #4516: a disputed card payment's hand-back whose dispute is lost, so it may be dismissed. Optional, as above. */
  disputedHandBackLost?: boolean;
  /** #4516: its disputes lost for part of what is still owed: the reduction the server offers. Optional, as above. */
  disputeReduction?: { reducedByCents: number; stillOwedCents: number } | null;
  /** #4516 (owner decision, 18 Nov 2026): set, the server refuses Mark paid (a lost dispute this refund takes), so none is offered. */
  markPaidRefusal?: string | null;
  /** #4097: what a card cancellation's card refund could not carry - by bank transfer, or checked first. Optional, as above. */
  cardShortfallHandBack?: boolean;
  cardShortfallCheck?: boolean;
  /** #4162: a bank refund back on the list because Xero voided its credit note. Optional, as above. */
  bankRefundVoidFollowUp?: { voidedCreditNoteNumber: string | null; voidedAt: string } | null;
  /**
   * #3643 (`INV-PAY-108`): Xero reported the review's invoice paid after the
   * cancel, and the invoice's cash then. Optional, as above.
   */
  partPaymentReviewXeroPaid?: { reportedAt: string; cashCents: number } | null;
  reason: string;
  createdAt: string;
  memberName: string;
  checkIn: string;
  checkOut: string;
  /**
   * #3033: this row's booking belongs to the person looking at it, and still
   * exists — so they may open it as its member even without admin bookings
   * access. Per row, because ownership is; absent means false, so a response
   * that cannot say offers no link.
   */
  viewerOwnsBooking?: boolean;
}

/**
 * #4344 (wave C1 of #4302): the retired officer edit review.
 *
 * The route no longer lists one (wave B closed every open review, and the OPEN
 * query leaves the kind out), so a review row reaches this card only from a
 * response this bundle did not expect - an older route during a blue/green
 * deploy. It is then shown read-only: no settle, no dismiss and no pricing
 * control, because the resolve route refuses the kind and a button whose only
 * outcome is a refusal is worse than none.
 *
 * TYPED AGAINST THE PRISMA ENUM, not left as a bare string, so a rename of the
 * enum member is a compile error rather than a review row silently treated as
 * a hand-back with live controls.
 *
 * `import type` is fully erased at build time, so this pulls no Prisma runtime
 * across the client boundary — the same pattern `my-bookings-list.tsx` already
 * uses for `BookingStatus`, and what `client-server-boundary-census.test.ts`
 * permits.
 *
 * The wire field stays a loose string: an absent or unrecognised kind is a
 * hand-back, which is what every row was before the column existed, and a
 * cached client bundle reading a newer row must degrade rather than throw.
 */
const EDIT_FINANCIAL_REVIEW_KIND: ManualRefundTaskKind =
  "EDIT_FINANCIAL_REVIEW";

function isRetiredReview(task: ManualRefundTask): boolean {
  return task.kind === EDIT_FINANCIAL_REVIEW_KIND;
}

/**
 * #3213: the one row kind that is a NOTICE rather than work the club owes.
 *
 * A settled review share that could not be added to its edit's Xero invoice,
 * because that invoice had been picked up for sending and could no longer be
 * raised. Nothing is billed automatically: a mid-send job can still come back to
 * the queue and be raised to the full amount, so a second invoice raised now
 * could bill the same money twice. An officer checks Xero and closes it.
 *
 * Typed against the Prisma enum for the reason the constant above is, and the
 * wire field stays a loose string for the same reason: a cached client bundle
 * reading a newer row degrades to a hand-back rather than throwing.
 *
 * REGISTERED BUT NOT YET WRITTEN. No row can carry this kind until the runtime
 * half of the two-release enum addition ships (migration 20260910010000;
 * `uncollected-edit-review-share-expand.test.ts` holds the line). The wording
 * lands now so that release changes a writer rather than a writer plus a screen.
 */
const WITHHELD_SHARE_KIND: ManualRefundTaskKind = "UNCOLLECTED_EDIT_REVIEW_SHARE";

function isWithheldShare(task: ManualRefundTask): boolean {
  return task.kind === WITHHELD_SHARE_KIND;
}

/**
 * #3639 (owner decision 26 Sep 2026): a card payment captured after its booking
 * was cancelled, held for a treasurer because the club asked for approval
 * instead of an automatic refund. Completing it refunds the CARD through Stripe
 * - nothing is paid back by hand - so none of the hand-back wording fits it.
 * Its kind is the #2700 late-capture kind; the route's flag is what marks it.
 */
function isLateCaptureApproval(task: ManualRefundTask): boolean {
  return task.awaitingLateCaptureApproval === true;
}

/**
 * #3643 (owner decision 28 Sep 2026, `INV-PAY-107`): an officer cancelled an
 * internet banking booking as unpaid while Xero recorded a payment against its
 * invoice that the app could not hand back as credit. The club settles that
 * payment in Xero, so the row carries no amount and is closed by dismissal
 * only. Its kind is the ordinary hand-back one; the route's flag marks it.
 */
function isPartPaymentReview(task: ManualRefundTask): boolean {
  return task.partPaymentReview === true;
}

/**
 * #3827 (owner decision D-3813-6, `INV-PAY-117`): an edit lowered the price of
 * a booking paid by internet banking or by hand, so the club owes the
 * difference back by bank transfer. Completed exactly like a cancellation's
 * hand-back; only the sentence explaining where it came from differs, because
 * the booking was not cancelled. The route's flag marks it.
 */
function isEditRefundHandBack(task: ManualRefundTask): boolean {
  return task.editRefundHandBack === true;
}

/**
 * #3827 (owner decision D-3813-7, `INV-PAY-118`): a refund appeal the club
 * approved on a booking that was not paid by card, so the approved amount (or
 * the part a card refund could not carry) goes back by bank transfer. The
 * route's flag marks it.
 */
function isRefundRequestHandBack(task: ManualRefundTask): boolean {
  return task.refundRequestHandBack === true;
}

/**
 * #2797: how a task's amount reads in the queue. A priced task shows the money;
 * one without an amount says so, so nobody mistakes an unknown amount for a
 * settled $0.00. It used to read "Awaiting pricing" on an officer review, which
 * this screen priced; that review is retired (#4344), and no row left here is
 * priced on this screen.
 */
function formatTaskAmount(task: ManualRefundTask, format: ClubFormat): string {
  return task.amountCents === null ? "Amount not known" : formatCents(task.amountCents, format);
}

/**
 * #3033: what the confirmation dialog SAYS, per row kind and per priced state.
 *
 * Lifted out of three nested ternaries in the JSX because the combinations are
 * what the wording has to get right and a nested conditional hides which ones
 * exist. One was wrong while it was inline - the hand-back sentence surviving
 * on a row it does not describe: a HAND-BACK raised with no amount — which
 * #2971 made representable when it allowed a null `amountCents` — read "Record
 * Awaiting pricing as paid back to Sam?", because the amount formatter's
 * placeholder was interpolated into a sentence built for a number.
 *
 * No branch here speaks for a retired officer review (#4344): the card offers
 * no control on one, so this dialog never opens for it.
 *
 * Each function therefore branches on the two facts that actually matter, kind
 * and whether an amount is known, and never falls through to the other kind's
 * words.
 */
type ResolutionTarget = {
  task: ManualRefundTask;
  resolution: "completed" | "dismissed";
};

function completionTitle({ task, resolution }: ResolutionTarget, format: ClubFormat): string {
  if (resolution === "dismissed") {
    if (isWithheldShare(task)) {
      // #3213: not "dismiss", which on every other row means the club decided
      // not to pay something. Here the officer has finished a job - checked
      // Xero, billed anything missing - and is recording that they did.
      return `Close this uncollected amount for ${task.memberName}?`;
    }
    if (isLateCaptureApproval(task)) {
      return `Close this payment from ${task.memberName} without refunding it here?`;
    }
    if (isPartPaymentReview(task)) {
      return `Close this payment from ${task.memberName} as settled in Xero?`;
    }
    // #4162: "No, the club keeps it" is this row's dismissal.
    if (task.bankRefundVoidFollowUp && task.amountCents !== null) {
      return `The club keeps the ${formatCents(task.amountCents, format)}, and ${task.memberName} is not paid?`;
    }
    return `Dismiss the refund for ${task.memberName}?`;
  }

  if (task.bankRefundVoidFollowUp && task.amountCents !== null) {
    return `Has the ${formatCents(task.amountCents, format)} gone to ${task.memberName}?`;
  }

  if (isLateCaptureApproval(task) && task.amountCents !== null) {
    return `Refund ${formatCents(task.amountCents, format)} to ${task.memberName}'s card?`;
  }

  if (task.groupOrganiserHandBack === true && task.amountCents !== null) {
    return `Record ${formatCents(task.amountCents, format)} as repaid to the group organiser, ${task.memberName}?`;
  }
  // #3949 review: a joiner's refund that goes to the group organiser who paid for their place.
  if (task.paidToGroupOrganiser === true && task.amountCents !== null) {
    return `Record ${formatCents(task.amountCents, format)} as paid back to the group organiser for ${task.memberName}?`;
  }
  return task.amountCents === null
    ? `Record this refund as paid back to ${task.memberName}?`
    : `Record ${formatCents(task.amountCents, format)} as paid back to ${task.memberName}?`;
}

function resolutionDescription({
  task,
  resolution,
}: ResolutionTarget): string {
  if (resolution === "dismissed") {
    if (isWithheldShare(task)) {
      return "This closes the item as dealt with. It moves no money and raises no invoice — closing it never has. Say what the booking's Xero invoices actually showed and what you billed by hand, if anything, because that note is the only record of how this amount was settled.";
    }
    if (isLateCaptureApproval(task)) {
      return "Nothing is refunded from here. Use this to keep the payment - for example, when the cancellation was a mistake and the booking is being put back - or when it was already refunded in the Stripe dashboard. Say which, so the record makes sense later.";
    }
    if (isPartPaymentReview(task)) {
      return "This closes the item as dealt with. It moves no money here, and the Xero repair tool stops listing the booking for review. Say how the payment was settled in Xero - refunded, or applied - and how the rest of the invoice was cleared, because that note is the record of it.";
    }
    if (task.bankRefundVoidFollowUp) {
      return "The refund stays out of the payment's records and no credit note is raised. Give the reason the club is keeping it, so the record makes sense later.";
    }
    if (task.paidToGroupOrganiser === true) { // #3949 review
      return "Dismissing closes the task without refunding anything — for a group organiser who declined the refund, or money settled another way. Say which, so the record makes sense later.";
    }
    if (task.disputedHandBackLost === true) return DISPUTED_HAND_BACK_LOST_DISMISS_DESCRIPTION; // #4516 (owner decision, 15 Nov 2026)
    if (task.cardShortfallCheck === true) return "Only dismiss this once you have confirmed in Stripe that the card refund reached the member. It closes the task without refunding anything and takes the refund off what the club owes. Say how the member was refunded, so the record makes sense later."; // #4516 (owner decision, 15 Nov 2026)
    return "Dismissing closes the task without refunding anything — for a member who declined the refund, or money settled another way. Say which, so the record makes sense later.";
  }

  if (isLateCaptureApproval(task)) {
    return "This refunds the payment to the card it came from, through Stripe, now. If you already refunded it in the Stripe dashboard, close it without refunding instead, saying so.";
  }

  if (task.bankRefundVoidFollowUp) {
    return "Answer once the money has gone to the member, whenever that was. It records the refund on the payment again; the member is not told anything. If it has not gone yet, cancel and leave it on the list.";
  }
  if (task.groupOrganiserHandBack === true) {
    return "Only do this once the money has actually gone back to the organiser. It records that the club repaid them and who did it; the joiners' refunds are already in the ledger, so nothing more is written there or on the bookings' history.";
  }
  if (task.paidToGroupOrganiser === true) return "Only do this once the money has actually gone back to the group organiser, who paid for this booking. It writes the refund into the payment ledger and records a refund on the booking's history; admins are then emailed to raise its Xero credit note by hand."; // #3949
  if (task.cardShortfallCheck === true) return "Only do this once you have checked the member really is owed it. The app first checks it can record this; pay straight after it accepts. It writes the refund into the payment ledger and records a refund on the booking's history. If it refuses, follow what it says."; // #4154 review (M3): mark first, then pay
  return "Only do this once the money has actually gone back to the member. It writes the refund into the payment ledger and records a refund on the booking's history.";
}

/** The confirm button names what pressing it does, per row kind. */
function confirmButtonLabel({ task, resolution }: ResolutionTarget): string {
  if (resolution === "dismissed") {
    if (isLateCaptureApproval(task)) return "Close without refunding";
    if (isPartPaymentReview(task)) return "Close as settled in Xero";
    if (task.bankRefundVoidFollowUp) return "The club keeps it";
    return "Dismiss refund";
  }
  if (task.bankRefundVoidFollowUp) return "Record the answer";

  if (isLateCaptureApproval(task)) return "Refund to card";

  return "Record as paid back";
}

/**
 * B5 (#2262): the cash hand-back queue.
 *
 * A cancelled booking that was settled in cash (or by an off-Xero bank
 * transfer) has no card charge to reverse and no Xero invoice to credit, so the
 * cancellation raises a durable task here instead of pretending money moved.
 * "Paid back" writes the refund allocation and the REFUNDED booking event —
 * that is the moment the ledger says the money went back — and "dismiss"
 * (which requires a note) closes it without moving anything.
 *
 * TWO CARDS SINCE #2750, and only the first is a queue. The second is the
 * operator surface for a refund nobody authorised: when a payment is captured
 * against a booking the club has already cancelled — a payment for a change to it,
 * or (since #2773) the booking's own payment — the Stripe
 * webhook has refunded it in full since #1350, and #2700 made that leave a
 * `ManualRefundTask` behind — which the webhook then closes itself, because
 * there is genuinely nothing left to pay back by hand. Closing it took it off
 * this screen, since the queue lists OPEN rows, so the one durable record of the
 * money movement was visible only to somebody who thought to query the table.
 *
 * #2760 finished that: the webhook now WRITES the DISMISSED row itself when its
 * close finds nothing, so the three orderings that used to leave no row leave one
 * — and it does so for a booking that is cancelled but not deleted as well, which
 * the confirm route's raise never covered at all. The second card is a complete
 * list of the last thirty days rather than one ordering's worth, and it groups the
 * two populations so the deleted case is not buried by the ordinary one.
 *
 * The decision #2750 recorded is that the automatic refund STAYS: money going
 * back to the member is the safe direction when nobody is watching. What it adds
 * is that the record is seen. That is why the second card carries no buttons —
 * there is no action, and offering one would imply the refund is still open to
 * decide. What an operator does with it is off-screen work: if the cancellation
 * or the DELETION was the mistake rather than the payment, the booking has to be
 * put back and the member charged again, and the card says so in those words.
 */
export function ManualRefundTaskQueue() {
  const format = useClubFormat();
  const clubTime = useClubTime();
  const canEdit = useAdminAreaEditAccess("finance");
  const [tasks, setTasks] = useState<ManualRefundTask[] | null>(null);
  const [autoRefunded, setAutoRefunded] = useState<AutoRefundedNotice[]>([]);
  /**
   * The load failed, as distinct from having found nothing (#2750 review).
   *
   * Blanking the cards on a failure is right — a stale list of money owed is
   * worse than none — but blanking them SILENTLY makes a 500 look exactly like
   * "nothing to pay back and no automatic refunds", and this card exists so that
   * an absence of rows can be trusted. One line says which it was.
   */
  const [loadFailed, setLoadFailed] = useState(false);
  /**
   * The route answered, but its automatic-refund read specifically failed, so it
   * sent an empty list it does not stand behind. Separate from `loadFailed`
   * because the hand-back queue beside it IS trustworthy in that case, and
   * telling the operator their work queue is broken when it is not would send
   * them looking for a problem that is not there.
   */
  const [autoRefundedUnavailable, setAutoRefundedUnavailable] = useState(false);
  // #3498: dismissals an officer could put back, and whether that read failed.
  const [dismissed, setDismissed] = useState<DismissedManualRefundTask[]>([]);
  const [dismissedUnavailable, setDismissedUnavailable] = useState(false);
  /**
   * #3033: whether this admin may open a booking at all.
   *
   * FAIL-CLOSED, and that is the whole reason it is a piece of state rather than
   * an inline `data.viewerCanViewBookings` read: a response that omits the field
   * — an older route, a degraded answer, a cached bundle — must offer no link,
   * because a Finance Viewer holds `finance:view` with no bookings access and a
   * link would be a dead end for them (the #2823 stuck-state default, and the
   * same reasoning the automatic-refund card beside this one already records).
   */
  const [viewerCanViewBookings, setViewerCanViewBookings] = useState(false);
  const [target, setTarget] = useState<ResolutionTarget | null>(null);
  const [note, setNote] = useState("");
  // #4162: a re-confirmed bank refund's answer, with no default, and the hand-made note's number.
  const [voidAnswer, setVoidAnswer] = useState<BankRefundVoidAnswer | null>(null);
  const [handMadeNoteNumber, setHandMadeNoteNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /**
   * #2668 review SF-5: the sentence for an outcome that was never read, held on
   * screen rather than thrown as a toast.
   *
   * The dialog stays open on a failure and the button re-arms in `finally`, so
   * a transient toast is very likely to be gone before the operator's next
   * press — and this is money. The notice sits inside the dialog, above the
   * button it disarms, until they act on it. Refusals the server reported keep
   * their toast: those say what actually happened.
   */
  const [unverified, setUnverified] = useState<string | null>(null);
  /**
   * Bumped with each unread outcome so the recovery alert takes focus again on a
   * repeat. Focus is not decoration here: this branch disables the button that
   * was just pressed, and a control disabled in the same turn cannot hold focus,
   * so without the alert taking it the operator would be dropped to `<body>`.
   */
  const [unverifiedAttention, setUnverifiedAttention] = useState(0);
  /*
    #2264: the worked example for the note used to be its placeholder, which
    reads as a value already typed and disappears on the first keystroke. It is
    helper text under the box now. It still switches on the resolution — the
    example for "paid back" is not the example for "dismissed" — but it says
    NOTHING about the note being required or optional: the Label above already
    carries that, and repeating it there would announce it twice.
  */
  const noteHint = useFieldHint();
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/payments/manual-refund-tasks");
      if (!response.ok) {
        setTasks([]);
        setAutoRefunded([]);
        setAutoRefundedUnavailable(false);
        setDismissed([]);
        setDismissedUnavailable(false);
        setViewerCanViewBookings(false);
        setLoadFailed(true);
        return;
      }
      const data = (await response.json()) as {
        tasks: ManualRefundTask[];
        autoRefunded?: AutoRefundedNotice[];
        autoRefundedUnavailable?: boolean;
        dismissed?: DismissedManualRefundTask[];
        dismissedUnavailable?: boolean;
        viewerCanViewBookings?: boolean;
      };
      setTasks(data.tasks ?? []);
      setAutoRefunded(data.autoRefunded ?? []);
      setAutoRefundedUnavailable(Boolean(data.autoRefundedUnavailable));
      setDismissed(data.dismissed ?? []);
      setDismissedUnavailable(Boolean(data.dismissedUnavailable));
      setViewerCanViewBookings(data.viewerCanViewBookings === true);
      setLoadFailed(false);
    } catch {
      setTasks([]);
      setAutoRefunded([]);
      setAutoRefundedUnavailable(false);
      setDismissed([]);
      setDismissedUnavailable(false);
      setViewerCanViewBookings(false);
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    if (!target) return;
    setSubmitting(true);
    setUnverified(null);
    try {
      const response = await fetchWithRecentAuth(
        `/api/admin/payments/manual-refund-tasks/${target.task.id}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resolution: target.resolution,
            confirmed: true,
            note: note.trim() || null,
            ...(target.resolution === "completed" && target.task.groupOrganiserHandBack === true
              ? // #4042: the total this card showed; the server refuses it once another share has grown the task.
                { confirmedAmountCents: target.task.amountCents }
              : {}),
            // #4162: a re-confirmed bank refund's answer, only on its own completion.
            ...(target.resolution === "completed" && target.task.bankRefundVoidFollowUp && voidAnswer
              ? {
                  bankRefundVoidAnswer:
                    voidAnswer === "recorded-in-xero"
                      ? { answer: voidAnswer, creditNoteNumber: handMadeNoteNumber.trim() }
                      : { answer: voidAnswer },
                }
              : {}),
          }),
        },
      );
      const data = (await response.json().catch(() => null)) as
        | { error?: string; message?: string }
        | null;
      if (!response.ok) {
        toast.error(data?.error ?? "Could not close this refund task.");
        return;
      }
      toast.success(data?.message ?? "Done.");
      setTarget(null);
      setNote("");
      setVoidAnswer(null);
      setHandMadeNoteNumber("");
      notifyAdminQueueChanged();
      await load();
    } catch {
      /*
        #2668. This used to say "Nothing was changed." A rejected `fetch` also
        covers the case where the POST landed, the refund allocation and the
        REFUNDED booking event were written, and only the answer was lost — so
        "nothing was changed" can be a statement about the ledger that is
        exactly backwards. The queue is deliberately NOT reloaded from here: a
        failed read blanks the card (see `load`), which would take the evidence
        off screen at the moment it is needed.

        Review SF-5: held in the dialog rather than thrown as a toast, with the
        close button disarmed behind it. A toast fades; the next press does not
        wait for it, and on this queue that press is either a second refund
        allocation attempt or a dismissal of a task that may already be closed.
        The server does refuse a second close on an already-closed task, so the
        ledger is safe either way — but "check the queue first" is the
        instruction, and the dialog now holds still long enough to be read.
      */
      setUnverified(
        unverifiedWriteMessage(
          "this refund task was closed",
          "Reload the page and check the queue before trying again.",
        ),
      );
      setUnverifiedAttention((value) => value + 1);
    } finally {
      setSubmitting(false);
    }
  }

  /*
    The hand-back queue keeps its original behaviour exactly: it shows while the
    load is still in flight (`tasks === null`) and disappears once the load says
    there is nothing to pay back. The automatic-refund card is independent — one
    can be present without the other, and when both are empty AND the load
    succeeded this component still renders nothing at all. A failed load is the
    one case where "nothing" is not the answer: it renders the line below instead,
    because silence there is indistinguishable from a clean slate.
  */
  const showQueue = tasks === null || tasks.length > 0;
  /*
    #3033: which SENTENCES the card is entitled to print.

    The standing paragraph said every row in this queue "was paid in cash or by a
    bank transfer that never reached Xero, and have since been cancelled". That
    was true of every row this card could hold until #3030 added the
    EDIT_FINANCIAL_REVIEW kind, and it is false of one: a review row is a LIVE
    booking whose stay change saved and whose adjustment the club has not been
    able to work out from stored history. Nothing was cancelled and no cash was
    necessarily involved. So each sentence is now rendered only when the queue
    actually holds a row it describes, and neither speaks for the other. A
    retired review (#4344) gets no paragraph: its row says what it is itself.
  */
  const openTasks = tasks ?? [];
  const hasWithheldShareRows = openTasks.some(isWithheldShare);
  /*
    #3213: a withheld share is neither a hand-back nor a review, so it must fall
    out of the hand-back sentence rather than into it by default. That sentence
    says the booking "was paid in cash or by a bank transfer that never reached
    Xero, and [has] since been cancelled" - three claims, none of them true of a
    live booking whose change invoice was mid-send. The default arm is what made
    the same sentence wrong about reviews before #3033, and this is the same
    mistake waiting one kind along.
  */
  const hasLateCaptureRows = openTasks.some(isLateCaptureApproval);
  const hasPartPaymentReviewRows = openTasks.some(isPartPaymentReview);
  // #3949 review: a row paid back to a group organiser has its own sentence, not the member's.
  const toMember = (task: ManualRefundTask) => task.paidToGroupOrganiser !== true;
  const hasEditRefundRows = openTasks.some((task) => isEditRefundHandBack(task) && toMember(task));
  const hasRefundRequestRows = openTasks.some((task) => isRefundRequestHandBack(task) && toMember(task));
  const hasOrganiserPayeeRows = openTasks.some((task) => !toMember(task));
  const hasGroupOrganiserRows = openTasks.some((task) => task.groupOrganiserHandBack === true);
  const hasCardShortfallRows = openTasks.some((task) => task.cardShortfallHandBack === true);
  const hasCardShortfallCheckRows = openTasks.some((task) => task.cardShortfallCheck === true);
  const hasHandBackRows = openTasks.some(
    (task) =>
      !isRetiredReview(task) &&
      !isWithheldShare(task) &&
      !isLateCaptureApproval(task) &&
      !isPartPaymentReview(task) &&
      !isEditRefundHandBack(task) &&
      !isRefundRequestHandBack(task) &&
      task.groupOrganiserHandBack !== true &&
      task.cardShortfallHandBack !== true &&
      task.cardShortfallCheck !== true &&
      !task.bankRefundVoidFollowUp && toMember(task),
  );
  const hasBankRefundVoidRows = openTasks.some((task) => Boolean(task.bankRefundVoidFollowUp));
  if (
    !showQueue &&
    autoRefunded.length === 0 &&
    dismissed.length === 0 &&
    !dismissedUnavailable &&
    !loadFailed &&
    !autoRefundedUnavailable
  ) {
    return null;
  }

  return (
    <div className="space-y-6">
      {/*
        A failed read says so (#2750 review). Rendered above the cards because it
        is a statement about what is missing from them, and as its own line rather
        than as an empty card so it cannot be mistaken for a list with no rows.
      */}
      {loadFailed ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="manual-refund-task-load-error"
        >
          Refund tasks could not be loaded, so this page cannot say whether any
          are waiting or whether a payment was refunded automatically. Reload the
          page.
        </p>
      ) : null}
      {showQueue ? (
        <Card data-testid="manual-refund-task-queue">
          <CardHeader>
            <CardTitle className="text-base">
              Money to settle
              {tasks ? ` (${tasks.length})` : ""}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/*
              Rendered only when a row it describes is actually here (#3033).
              While the load is still in flight neither sentence shows, which is
              correct: the card cannot yet say what kind of work it holds.
            */}
            {hasHandBackRows ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="manual-refund-task-hand-back-intro"
              >
                Some of these bookings were paid in cash or by a bank transfer
                that never reached Xero, and have since been cancelled. There is
                no card payment to reverse, so the club has to pay the member
                back directly. Mark a refund as paid back once the money has
                actually gone — that is when the ledger records it.
              </p>
            ) : null}
            {hasBankRefundVoidRows ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="manual-refund-task-bank-refund-void-intro"
              >
                Some of these are bank refunds the club had recorded as paid,
                whose Xero credit note has since been voided. The app has taken
                each back out of the payment&apos;s records until you say what
                happened. If the money has gone to the member, say so and choose
                how Xero records it. If it has not gone yet, leave it here. If
                the club is keeping it, say why.
              </p>
            ) : null}
            {hasEditRefundRows ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="manual-refund-task-edit-refund-intro"
              >
                Some of these are booking changes that lowered the price of a
                booking paid by internet banking or in cash. There is no card
                to refund, so the club sends the difference back by bank
                transfer; the member has been told it is coming. The Xero
                credit note for the change was raised with the change. Mark a
                refund as paid back once the money has actually gone.
              </p>
            ) : null}
            {hasRefundRequestRows ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="manual-refund-task-refund-request-intro"
              >
                Some of these are refund appeals the club approved on bookings
                that were not paid by card. There is no card to refund, so the
                club sends the approved amount by bank transfer; the member has
                been told it is coming. Mark a refund as paid back once the
                money has actually gone.
              </p>
            ) : null}
            {hasOrganiserPayeeRows ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="manual-refund-task-organiser-payee-intro"
              >
                Some of these are refunds on joiners&apos; bookings that a group
                organiser paid for by internet banking, after a change lowered
                the price, an appeal was approved or the joiner cancelled. That money came from the
                organiser, so it goes back to the organiser by bank transfer,
                not to the joiner; the joiner has been told so. The app raises
                no Xero credit note for these: once you mark one paid back,
                admins are emailed to credit the group&apos;s Xero invoice by
                hand. Mark a refund as paid back once the money has actually
                gone.
              </p>
            ) : null}
            {hasCardShortfallRows ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="manual-refund-task-card-shortfall-intro"
              >
                Some of these are from card cancellations whose card refund could
                not carry all of the refund due; each is the part the
                payment&apos;s other (non-card) charges hold. The member is told
                (on their booking page, and by email unless emails were turned
                off) that the club will refund it by bank transfer: mark it paid back first, which
                records it and, where the booking has a Xero invoice, raises its refund credit note,
                then pay it by bank transfer straight after the app accepts. None can be marked
                until the card refund itself has gone through.
              </p>
            ) : null}
            {hasCardShortfallCheckRows ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="manual-refund-task-card-shortfall-check-intro"
              >
                Some of these are the rest of a card refund that the payment&apos;s records show already
                refunded, or that nothing holds: from a card cancellation, or from a booking cancelled because
                its dates filled up during the card payment. The member is told only that the club will be in
                touch: on their booking page, and for a cancellation by email unless emails were turned off.
                Check Stripe and the bank before paying anything, then contact the member with what you found.
                Dismiss it with a note saying how only once you have confirmed the card refund reached them. If it really is owed, mark it paid
                back first, once any bank-transfer part and the card refund are done, and pay it by bank
                transfer straight after the app accepts; if it refuses, follow what it says.
              </p>
            ) : null}
            {hasGroupOrganiserRows ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="manual-refund-task-group-organiser-intro"
              >
                Some of these are group bookings paid by internet banking that
                the organiser cancelled. Each joiner&apos;s refund is already
                recorded in the app&apos;s ledger, but the money has not gone:
                the club repays the organiser by bank transfer. The row lists
                each joiner&apos;s share. Mark it paid back once the money has
                actually gone; it cannot be dismissed. If the club decides not
                to repay them, take it to the treasurer. Marking it paid back
                sends nothing to Xero.
              </p>
            ) : null}
            {hasWithheldShareRows ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="manual-refund-task-withheld-share-intro"
              >
                Some of these are amounts the club may not have asked for. A
                booking change was settled as money the member owes, but the Xero
                invoice for that change had already been picked up for sending,
                so it could not be raised to include the extra. Nothing was
                invoiced automatically, on purpose: an invoice in that state can
                still come back and go out at the full amount, and a second one
                raised now could bill the member twice. Check the booking&apos;s
                invoices in Xero first — if they already come to the settled
                total, nothing is owed and you can close the item saying so.
              </p>
            ) : null}
            {hasLateCaptureRows ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="manual-refund-task-late-capture-intro"
              >
                Some of these are card payments that went through after their
                booking had been cancelled and were held for a treasurer to
                approve, so the money is still with the club. Refund one to send
                it back to the card through Stripe, or close it without refunding
                — to keep it, for example when the cancellation was a mistake, or
                because it was already refunded in the Stripe dashboard.
              </p>
            ) : null}
            {hasPartPaymentReviewRows ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="manual-refund-task-part-payment-review-intro"
              >
                Some of these are internet banking bookings an officer cancelled
                as unpaid while Xero showed a payment against the invoice that
                the club could not hold as account credit — the booking belongs
                to an organisation, or Xero could not give the exact amount.
                Nothing was refunded, credited or cleared. Settle the payment in
                Xero, clear what the invoice still owes, then close the item
                saying what you did.
              </p>
            ) : null}
            {tasks === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <ul className="space-y-3">
                {tasks.map((task) => (
                  <li
                    key={task.id}
                    className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border px-3 py-2"
                  >
                    <div className="space-y-1 text-sm">
                      <p className="font-medium text-foreground">
                        {task.memberName} — {formatTaskAmount(task, format)}
                        {/*
                          #3033: the row says on its face when the amount has
                          been amended since the task was raised, rather than
                          leaving that only in the audit log. Printed only when
                          the two genuinely differ AND the task was raised with
                          a figure — a review raised unpriced and later
                          confirmed has nothing to compare against, and saying
                          "was Awaiting pricing" would read as a money movement.
                        */}
                        {task.raisedAmountCents != null &&
                        task.amountCents != null &&
                        task.raisedAmountCents !== task.amountCents ? (
                          <span className="font-normal text-muted-foreground">
                            {" "}
                            (raised at {formatCents(task.raisedAmountCents, format)})
                          </span>
                        ) : null}
                      </p>
                      <p className="text-muted-foreground">
                        {formatStayDate(task.checkIn, format)} to{" "}
                        {formatStayDate(task.checkOut, format)} ·{" "}
                        {/*
                          #3033 (owner decision D3: a LINK to the booking's
                          payment and rate history). Offered only to an admin who
                          may open a booking. This card is gated on
                          `finance:view`, which a Finance Viewer holds with no
                          bookings access at all, so for them the link was a dead
                          end — the same reason the automatic-refund card below
                          has never carried one. They get the identifier instead,
                          which is what they need in order to quote the booking
                          to somebody who can open it.

                          Or to an admin whose OWN booking this is, who reaches
                          the same page as its member. Two ways to hold the same
                          authority, so either is enough; both default false, so
                          a response that establishes neither offers no link.
                        */}
                        {viewerCanViewBookings ||
                        task.viewerOwnsBooking === true ? (
                          <Link
                            className="underline"
                            href={`/bookings/${task.bookingId}`}
                          >
                            View the booking&apos;s payment and rate history
                          </Link>
                        ) : (
                          <>
                            booking{" "}
                            <span className="font-mono text-xs">
                              {task.bookingId}
                            </span>
                          </>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">{task.reason}</p>
                      {task.bankRefundVoidFollowUp && task.amountCents !== null ? (
                        <p className="text-sm text-foreground" data-testid="manual-refund-task-bank-refund-void-question">
                          {bankRefundVoidQuestion({
                            bookingReference: formatBookingReference(task.bookingId),
                            amount: formatCents(task.amountCents, format),
                            memberName: task.memberName,
                            creditNoteNumber: task.bankRefundVoidFollowUp.voidedCreditNoteNumber,
                            voidedOn: clubTime.instantDate(new Date(task.bankRefundVoidFollowUp.voidedAt)),
                          })}
                        </p>
                      ) : null}
                      {isPartPaymentReview(task) && task.partPaymentReviewXeroPaid ? (
                        <PartPaymentReviewXeroPaidLine
                          xeroPaid={task.partPaymentReviewXeroPaid}
                        />
                      ) : null}
                      {/*
                        #3213: what to DO, on the row, in the order an officer
                        does it. The standing paragraph says why nothing was
                        invoiced; this says what to check and what to raise, and
                        names the amount rather than leaving them to carry the
                        figure down from the heading.

                        THE CHECK COMES BEFORE THE BILL, deliberately. The whole
                        hazard here runs one way - billing a member a second time
                        for money already asked for - so an instruction that led
                        with "raise a supplementary invoice" would be the defect
                        wearing an interface. On the row whose amount is not
                        knowable it cannot say a figure at all, and says so
                        rather than printing the settled total, which an officer
                        could reasonably read as the thing to bill.
                      */}
                      {isWithheldShare(task) ? (
                        <p
                          className="text-xs text-warning-11"
                          data-testid="manual-refund-task-withheld-share-instruction"
                        >
                          {task.amountCents === null
                            ? "Open this booking's invoices in Xero and compare them against the settled total on the change. This item cannot say how much is missing — it was raised by the recovery pass, which knows the change's combined total but not which part the sent invoice already carried. If the invoices fall short, bill the difference by hand. Then close the item with a note saying what Xero showed and what you billed."
                            : `Open this booking's invoices in Xero and check whether they already include ${formatCents(task.amountCents, format)}. If they do, nothing is owed. If they fall short, raise a supplementary invoice for that amount only — never for the change's full total, which the member has already been asked for. Then close the item with a note saying what Xero showed and what you billed.`}
                        </p>
                      ) : null}
                      {/*
                        #4344: a retired officer review is shown, never acted
                        on. The route stopped listing them, so this is only an
                        older route's answer during a deploy; the resolve route
                        refuses the kind, so the row offers no control at all.
                        It says what the route's refusal says, in the same
                        words (RETIRED_EDIT_REVIEW_REFUSAL, INV-SSOT).
                      */}
                      {isRetiredReview(task) ? (
                        <p
                          className="text-xs text-muted-foreground"
                          data-testid="manual-refund-task-retired-review"
                        >
                          {RETIRED_EDIT_REVIEW_REFUSAL}
                        </p>
                      ) : null}
                    </div>
                    {isRetiredReview(task) ? null : (
                    <div className="flex gap-2">
                      {/*
                        #3213: NO COMPLETION CONTROL ON A WITHHELD SHARE, and
                        the button is absent rather than disabled.

                        The kind is dismiss-only at the completion door
                        (`manual-refund-task-resolution.ts`), because COMPLETED
                        with no direction reads as REFUND_TO_MEMBER and reaches
                        the allocation path. A control whose only outcome is a
                        refusal is worse than no control - the house "no button
                        that fails" rule, the same one that keeps every control
                        off a retired review - and a disabled one would still say the
                        club might owe this money back, which it does not.

                        ASKED OF THE SHARED RULE rather than of `isWithheldShare`
                        beside it, so this control's existence and the server's
                        refusal are one decision and not two that agree today
                        (`INV-SSOT`). The wording branches below are about which
                        kind a row IS; this one is about what may be done to it,
                        and only the second is a rule the door also holds.

                        The server refusal is the guarantee; this is the screen
                        agreeing with it.
                      */}
                      {manualRefundTaskKindAllowsSettlement(
                        task.kind,
                        isPartPaymentReview(task),
                      ) && !task.markPaidRefusal ? (
                      <ViewOnlyActionButton
                        canEdit={canEdit}
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setNote("");
                          setUnverified(null);
                          setTarget({ task, resolution: "completed" });
                        }}
                      >
                        {/* #3033: the same control, named for what it does on this row. */}
                        {isLateCaptureApproval(task)
                          ? "Refund to card"
                          : task.bankRefundVoidFollowUp
                            ? "Yes, it has gone"
                            : "Mark paid back"}
                      </ViewOnlyActionButton>
                      ) : null}
                      {/* #4042: a group organiser's hand-back is paid, never dismissed. #4516: nor, for now, a real bank or cash hand-back; its row says why. */}
                      {task.groupOrganiserHandBack === true ? null : task.journalHandBackDismissRefusal ? (
                        <><p className="text-xs text-muted-foreground" data-testid="manual-refund-task-dismiss-unavailable">
                          {task.journalHandBackDismissRefusal}
                        </p><ManualRefundTaskDisputeReduction task={task} canEdit={canEdit} onReduced={load} /></>
                      ) : (
                      <ViewOnlyActionButton
                        canEdit={canEdit}
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setNote("");
                          setUnverified(null);
                          setTarget({ task, resolution: "dismissed" });
                        }}
                      >
                        {isWithheldShare(task) || isPartPaymentReview(task)
                          ? "Close this item"
                          : isLateCaptureApproval(task)
                            ? "Close without refunding"
                            : task.bankRefundVoidFollowUp
                              ? "No, the club keeps it"
                              : "Dismiss"}
                      </ViewOnlyActionButton>
                      )}
                    </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>

          <Dialog
            open={target !== null}
            onOpenChange={(open) => {
              // The notice belongs to the attempt that produced it; a stale one
              // over the next task would read as that task's outcome.
              if (!open) {
                setTarget(null);
                setUnverified(null);
                // An answer belongs to the task it was given for.
                setVoidAnswer(null);
                setHandMadeNoteNumber("");
              }
            }}
          >
            <DialogContent>
              {target && (
                <>
                  <DialogHeader>
                    <DialogTitle>{completionTitle(target, format)}</DialogTitle>
                    <DialogDescription>
                      {resolutionDescription(target)}
                    </DialogDescription>
                  </DialogHeader>
                  {target.resolution === "completed" && target.task.bankRefundVoidFollowUp ? (
                    <BankRefundVoidAnswerChoice
                      answer={voidAnswer}
                      creditNoteNumber={handMadeNoteNumber}
                      disabled={submitting || unverified !== null}
                      onAnswer={setVoidAnswer}
                      onCreditNoteNumber={setHandMadeNoteNumber}
                    />
                  ) : null}
                  <div className="space-y-2">
                    <Label htmlFor="manual-refund-task-note">
                      Note{target.resolution === "dismissed" ? " (required)" : " (optional)"}
                    </Label>
                    <Textarea
                      id="manual-refund-task-note"
                      value={note}
                      maxLength={NOTE_MAX_LENGTH}
                      onChange={(event) => setNote(event.target.value)}
                      {...noteHint.fieldProps}
                    />
                    <FieldHint {...noteHint.hintProps}>
                      {target.resolution === "completed"
                        ? "e.g. cash handed back at the lodge"
                        : "e.g. member asked us to keep it as a donation"}
                    </FieldHint>
                  </div>
                  {/*
                    #2668 SF-5. The house recovery alert (`focused-action-error.tsx`,
                    #2597 / #2635): permanently mounted so the live region exists
                    before it has anything to say — one injected already-populated is
                    silently dropped by some screen-reader/browser pairings —
                    assertive, and it takes focus when the message arrives, which is
                    what keeps the operator from being dropped to `<body>` as the
                    button they just pressed is disabled behind it.
                  */}
                  <FocusedActionError
                    id="manual-refund-unverified-notice"
                    error={unverified ?? ""}
                    attentionKey={unverifiedAttention}
                  />
                  <DialogFooter className="gap-2 sm:gap-2">
                    {/*
                      After an unread outcome "Cancel" would itself be a claim —
                      there may be nothing left to cancel — so the way out is named
                      for what it does.
                    */}
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setTarget(null);
                        setUnverified(null);
                      }}
                      disabled={submitting}
                    >
                      {unverified ? "Close and check" : "Cancel"}
                    </Button>
                    <Button
                      onClick={submit}
                      disabled={
                        submitting ||
                        unverified !== null ||
                        /*
                          #3033: a task with no amount cannot be completed - the
                          server refuses it, and a button whose only outcome is a
                          refusal is worse than no button.
                        */
                        (target.resolution === "completed" &&
                          target.task.amountCents === null) ||
                        (target.resolution === "dismissed" && note.trim().length === 0) ||
                        // #4162: a re-confirmed bank refund needs its answer (and the note number for "already in Xero").
                        (target.resolution === "completed" &&
                          Boolean(target.task.bankRefundVoidFollowUp) &&
                          (voidAnswer === null || (voidAnswer === "recorded-in-xero" && handMadeNoteNumber.trim().length === 0)))
                      }
                    >
                      {confirmButtonLabel(target)}
                    </Button>
                  </DialogFooter>
                </>
              )}
            </DialogContent>
          </Dialog>
        </Card>
      ) : null}
      {/*
        The route answered but could not read this list. Said in one line instead
        of an empty card, for the same reason as above: an empty card asserts that
        no money was refunded automatically, and a query that failed has not
        earned the right to assert that.
      */}
      {autoRefundedUnavailable ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="automatic-refund-notices-unavailable"
        >
          The record of automatic refunds could not be loaded, so this page
          cannot say whether any payment was refunded automatically. The
          hand-back queue above is unaffected. Reload the page.
        </p>
      ) : null}
      {/*
        #3498: the read failed, said in a line of its own rather than by showing
        an empty card. "Nothing was dismissed lately" is a claim about money
        decisions, and a failed query is not entitled to make it.
      */}
      {dismissedUnavailable ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="dismissed-manual-refund-tasks-unavailable"
        >
          We could not read the money tasks that were closed recently, so they
          are not listed. Reload the page to try again; nothing about them has
          changed.
        </p>
      ) : null}
      {dismissed.length > 0 ? (
        <ManualRefundTaskReopenCard dismissed={dismissed} onReopened={load} />
      ) : null}
      {autoRefunded.length > 0 ? (
        <AutomaticRefundNoticesCard notices={autoRefunded} />
      ) : null}
    </div>
  );
}
