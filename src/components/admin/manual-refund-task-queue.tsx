"use client";

import { useCallback, useEffect, useId, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FocusedActionError } from "@/components/focused-action-error";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { MONEY_INPUT_PROPS, parseDecimalDollarsToCents } from "@/lib/money-input";
import { formatCents } from "@/lib/utils";
import type { ManualRefundTaskKind } from "@prisma/client";
import {
  EDIT_FINANCIAL_REVIEW_CAUSE_LABEL,
  type EditFinancialReviewEvidence,
} from "@/lib/edit-financial-review-context";
import { useClubTime } from "@/components/club-time-provider";
import {
  calendarDateOfSerialisedDbDate,
  formatClubDate,
  type CalendarDate,
} from "@/lib/club-time";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";
import { zeroCompletionRefusal } from "@/lib/manual-refund-task-copy";
// #3213: whether a row may be closed as money that moved is decided ONCE, in a
// client-safe home, and the completion door throws on the same answer
// (`manual-refund-task-resolution.ts`, `INV-SSOT`). Deciding it again here is
// what would let this card go on offering a control the server has started
// refusing - a disagreement nobody sees until an officer presses the button.
import { manualRefundTaskKindAllowsSettlement } from "@/lib/manual-refund-task-settlement-rules";
import {
  checkStoredNightPriceRepair,
  nightPriceRepairUnreadableMessage,
  type NonEmptyDates,
  settlementDeltaCents,
  unpricedNightTargetCents,
  type RecordedNightPrice,
  type StoredNightPriceRepairCheck,
  type UnpricedNightsSummary,
} from "@/lib/stored-night-price-repair";
import {
  parseNightInput,
  UnpricedNightPriceFields,
} from "@/components/admin/unpriced-night-price-fields";

const NOTE_MAX_LENGTH = 500;

interface ManualRefundTask {
  id: string;
  bookingId: string;
  // #2797 (owner decision D2): NULL on an EDIT_FINANCIAL_REVIEW task whose
  // amount the club has not yet priced. Rendered as "Awaiting pricing", never
  // as $0.00 — a magic zero would read as "assessed at nothing".
  amountCents: number | null;
  /**
   * #3033: what the task was RAISED with, so a row whose amount an admin has
   * since confirmed says so on its face instead of only in the audit log. Null
   * exactly when the task was raised with no amount at all, which is the
   * ordinary shape of a financial review.
   */
  raisedAmountCents?: number | null;
  /**
   * #3033: WHY this row exists. Optional on the wire and null for every row
   * written before the column existed, so a cached client bundle against an
   * older route — and every legacy hand-back row — still renders: an absent or
   * null kind is treated as the hand-back it has always been.
   */
  kind?: string | null;
  reason: string;
  createdAt: string;
  memberName: string;
  checkIn: string;
  checkOut: string;
  /**
   * #3033 (owner decision D3): the evidence captured when the edit was applied,
   * already redacted by the route. Null on a hand-back row, on a review row that
   * carries none, and on one whose captured blob this release cannot read — the
   * last of which the flag below distinguishes, because "no evidence was taken"
   * and "the evidence cannot be read" are different things to tell an admin who
   * is about to price a refund.
   */
  reviewEvidence?: EditFinancialReviewEvidence | null;
  reviewEvidenceUnreadable?: boolean;
  /**
   * #3191: this booking's nights that carry no stored price, and the two totals
   * the officer's figures must reconcile against.
   *
   * Optional on the wire and absent on every row that has none — a hand-back, a
   * review whose guest strand was deleted by the edit, or one whose own rows are
   * already complete. An absent field offers no boxes, which is exactly how this
   * screen behaved before #3191, so a cached client bundle against a newer route
   * degrades to the old behaviour rather than throwing.
   */
  unpricedNights?: UnpricedNightsSummary | null;
  /**
   * #3033: this row's booking belongs to the person looking at it, and still
   * exists — so they may open it as its member even without admin bookings
   * access. Per row, because ownership is; absent means false, so a response
   * that cannot say offers no link.
   */
  viewerOwnsBooking?: boolean;
}

/**
 * #3033: the one row kind whose money is genuinely unknown.
 *
 * TYPED AGAINST THE PRISMA ENUM, not left as a bare string. Nothing else here
 * fails if the enum member is renamed — every test supplies `kind` as a fixture
 * string, so the whole suite would stay green while the queue silently printed
 * the cash-hand-back paragraph over financial reviews again, which is the exact
 * defect this issue exists to fix. Annotating the constant makes the rename a
 * compile error instead.
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

function isFinancialReview(task: ManualRefundTask): boolean {
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
 * #2797: how a task's amount reads in the queue. A priced task shows the money;
 * an unpriced EDIT_FINANCIAL_REVIEW task shows that it is waiting for the club
 * to price it, so nobody mistakes an unknown amount for a settled $0.00.
 */
function formatTaskAmount(task: ManualRefundTask): string {
  if (task.amountCents !== null) return formatCents(task.amountCents);
  /*
    #3213: "unknown" means two different things on the two kinds that allow it,
    and one sentence for both would be wrong on one of them.

    A review is waiting for the CLUB to price it, and it will be priced on this
    screen. A withheld share can never be priced here: the amount is unknown
    because the writer that raised it - the payment-recovery replay - holds the
    edit's combined total and cannot say which part the sent invoice already
    carried. Telling an officer that row is "awaiting pricing" would send them
    looking for a control that does not exist on it.
  */
  return isWithheldShare(task) ? "Amount not known" : "Awaiting pricing";
}

/**
 * #3033: one stored night-price row, exactly as it was found.
 *
 * "No stored price" and "$0.00" are printed as different things on purpose. Zero
 * is a real price — a comped night — and an absence is the evidence gap that
 * raised the task in the first place; collapsing them would hide the thing an
 * admin is being asked to look at (`StoredNightPriceEvidence`).
 */
function formatStoredNightPrice(priceCents: number | null): string {
  return priceCents === null ? "no stored price" : formatCents(priceCents);
}

/** A list of lodge nights, or an explicit "none" — never an empty bullet. */
function formatNightList(dates: readonly CalendarDate[]): string {
  return dates.length === 0
    ? "none"
    : dates.map((date) => formatClubDate(date)).join(", ");
}

/**
 * The evidence owner decision D3 asks for, and only that.
 *
 * D3 is "a reason string plus a LINK to the booking's payment and rate history",
 * not a copy of it, so nothing here restates a payment, a refund or an account
 * credit: those live in the payment tables, are live, and would be stale the
 * moment they were copied (`INV-SSOT`). What IS shown is the material the edit
 * DESTROYED — the stored night rows for the nights it surrendered are gone once
 * it commits — plus the safe diagnostic category and the stay window, which is
 * what answers "which rates applied then".
 *
 * NO INTERNAL VOCABULARY AND NO IDS. The cause is rendered through its label
 * map, and the guest's member id and guest-strand id are not on the wire at all
 * (`toEditFinancialReviewEvidence`).
 */
function EditFinancialReviewEvidenceBlock({
  evidence,
}: {
  evidence: EditFinancialReviewEvidence;
}) {
  return (
    <div
      className="space-y-1 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground"
      data-testid="manual-refund-task-review-evidence"
    >
      <p className="font-medium text-foreground">
        {EDIT_FINANCIAL_REVIEW_CAUSE_LABEL[evidence.cause]}
      </p>
      <p>
        Nights given back: {formatNightList(evidence.surrenderedNightDates)}
      </p>
      <p>Nights added by the same change: {formatNightList(evidence.addedNightDates)}</p>
      <p>
        Stored total for this guest:{" "}
        {evidence.storedEvidence.guestTotalCents === null
          ? "none stored"
          : formatCents(evidence.storedEvidence.guestTotalCents)}
      </p>
      <p>
        Stored night prices before the change:{" "}
        {evidence.storedEvidence.nightPrices.length === 0
          ? "none stored"
          : evidence.storedEvidence.nightPrices
              .map(
                (night) =>
                  `${formatClubDate(night.date)} ${formatStoredNightPrice(night.priceCents)}`,
              )
              .join(" · ")}
      </p>
      <p>
        Booked stay: {formatClubDate(evidence.bookingCheckIn)} to{" "}
        {formatClubDate(evidence.bookingCheckOut)}
      </p>
      {evidence.guestsAddedByEdit ? (
        /*
         * #3166: what the same change did to the REST of the party.
         *
         * Everything above describes one guest whose stored prices could not be
         * read — on an add, a guest nobody touched. Without this line the card
         * reads "nights given back: none · nights added: none" while the booking
         * has just gained people the club has charged nothing for, because a
         * parked edit writes the booking's total back unchanged. Their prices
         * live only on their own rows, so this is the only place the person
         * pricing the booking is told the money exists.
         */
        <p className="font-medium text-foreground">
          This change also added {evidence.guestsAddedByEdit.count}{" "}
          {evidence.guestsAddedByEdit.count === 1 ? "guest" : "guests"}, priced
          at{" "}
          {evidence.guestsAddedByEdit.totalPriceCents === null
            ? "an amount that could not be read"
            : formatCents(evidence.guestsAddedByEdit.totalPriceCents)}
          . The booking&rsquo;s own total was left as it was, so that amount has
          not been charged.
        </p>
      ) : null}
    </div>
  );
}

/**
 * #3033: what the confirmation dialog SAYS, per row kind and per priced state.
 *
 * Lifted out of three nested ternaries in the JSX because the combinations are
 * what the wording has to get right and a nested conditional hides which ones
 * exist. Two were wrong while they were inline, and both were wrong in the same
 * way — the hand-back sentence surviving on a row it does not describe:
 *
 *  - a review with a CONFIRMED amount fell to the hand-back arm and was
 *    announced as "Record $45.00 as paid back", over a body saying "only do this
 *    once the money has actually gone back to the member". An adjustment is a
 *    figure the club has just decided; nothing has physically gone anywhere, and
 *    the instruction to wait until it has is the opposite of what to do;
 *  - a HAND-BACK raised with no amount — which #2971 made representable when it
 *    allowed a null `amountCents` — read "Record Awaiting pricing as paid back
 *    to Sam?", because the amount formatter's placeholder was interpolated into
 *    a sentence built for a number.
 *
 * Each function therefore branches on the two facts that actually matter, kind
 * and whether an amount is known, and never falls through to the other kind's
 * words.
 */
type ResolutionTarget = {
  task: ManualRefundTask;
  resolution: "completed" | "dismissed";
};

/**
 * #3170: which way the officer says the money goes.
 *
 * `null` is "not yet chosen" and is the state the dialog OPENS in - there is no
 * default, deliberately. Before this issue the direction was implicit in the word
 * "refund", and that implicitness was the hazard: this is the first release where
 * a parked edit can have raised the price, so an officer reading the evidence can
 * correctly conclude the club is owed, and every settlement path was refund
 * -shaped. A pre-ticked "pay them back" would put the wrong-direction movement
 * one un-noticed default away.
 */
type SettlementDirection = "REFUND_TO_MEMBER" | "CHARGE_TO_MEMBER";

/**
 * What each direction actually does, in the words the officer needs BEFORE they
 * commit rather than in a receipt afterwards. Both sentences name the instrument,
 * and the charge sentence says plainly that nothing is taken from the card here -
 * the completion raises the request and the member pays it, exactly as they would
 * for an ordinary check-out extension.
 */
const DIRECTION_CHOICES: ReadonlyArray<{
  value: SettlementDirection;
  label: string;
  detail: string;
}> = [
  {
    value: "REFUND_TO_MEMBER",
    label: "The club owes the member",
    detail:
      "The money goes back to them: to the card they paid with, or as account credit where there is no card behind it.",
  },
  {
    value: "CHARGE_TO_MEMBER",
    label: "The member owes the club",
    detail:
      "They are asked to pay it: added to this booking as an additional payment on their card, or onto the booking's invoice to pay by internet banking. Nothing is taken from their card by this screen.",
  },
];

function completionTitle({ task, resolution }: ResolutionTarget): string {
  if (resolution === "dismissed") {
    if (isWithheldShare(task)) {
      // #3213: not "dismiss", which on every other row means the club decided
      // not to pay something. Here the officer has finished a job - checked
      // Xero, billed anything missing - and is recording that they did.
      return `Close this uncollected amount for ${task.memberName}?`;
    }
    return isFinancialReview(task)
      ? `Close this review for ${task.memberName} with no adjustment?`
      : `Dismiss the refund for ${task.memberName}?`;
  }

  if (isFinancialReview(task)) {
    // #3170: NO DIRECTION IN THE TITLE. It used to say "Record an adjustment",
    // which reads as neutral and settles as a refund - the wording that made a
    // wrong-direction movement one plausible action away once a parked edit could
    // raise the price. The direction is chosen in the body and stated on the
    // button, so the sentence the officer presses is the one that says which way
    // the money goes.
    return `Settle this review for ${task.memberName}?`;
  }

  return task.amountCents === null
    ? `Record this refund as paid back to ${task.memberName}?`
    : `Record ${formatCents(task.amountCents)} as paid back to ${task.memberName}?`;
}

function resolutionDescription({
  task,
  resolution,
}: ResolutionTarget): string {
  if (resolution === "dismissed") {
    if (isWithheldShare(task)) {
      return "This closes the item as dealt with. It moves no money and raises no invoice — closing it never has. Say what the booking's Xero invoices actually showed and what you billed by hand, if anything, because that note is the only record of how this amount was settled.";
    }
    return isFinancialReview(task)
      ? "This closes the review as looked at, with nothing to pay back or credit. It moves no money and records none as having moved. Say what the evidence showed, so the finding makes sense to whoever reads it next."
      : "Dismissing closes the task without refunding anything — for a member who declined the refund, or money settled another way. Say which, so the record makes sense later.";
  }

  if (isFinancialReview(task)) {
    return "Price this from the evidence on the row and the booking's payment history: the amount, and which way it goes. If the club owes the member it is paid back or held as account credit; if the member owes the club they are asked to pay it on this booking. If nothing is owed either way, close the review with no adjustment instead.";
  }

  return "Only do this once the money has actually gone back to the member. It writes the refund into the payment ledger and records a refund on the booking's history.";
}

/**
 * #3170: the button says the DIRECTION, because it is the last thing the officer
 * reads before money moves. "Record the adjustment" was true of both directions
 * and therefore said nothing about either.
 *
 * Before a direction is chosen it stays neutral, and the button is disabled - a
 * label that named one direction while the other was still available would be the
 * pre-ticked default this dialog deliberately does not have.
 */
function confirmButtonLabel(
  { task, resolution }: ResolutionTarget,
  direction: SettlementDirection | null,
): string {
  if (resolution === "dismissed") {
    return isFinancialReview(task) ? "Close with no adjustment" : "Dismiss refund";
  }

  if (isFinancialReview(task)) {
    if (direction === "CHARGE_TO_MEMBER") return "Ask the member to pay";
    if (direction === "REFUND_TO_MEMBER") return "Pay the member back";
    return "Settle the review";
  }

  return "Record as paid back";
}

/**
 * A refund the club never decided: a payment landed on a booking that had
 * already been cancelled — deleted or not — and Stripe handed it straight back
 * (#2750, widened to both populations by #2760).
 */
interface AutoRefundedNotice {
  id: string;
  bookingId: string;
  amountCents: number;
  reason: string;
  note: string | null;
  refundedAt: string | null;
  /**
   * #2760: the booking has since been deleted, as opposed to being cancelled and
   * still on file. It decides which group the row is shown in, because the two
   * need different follow-up. Optional so a cached client against a pre-#2760
   * route still renders (it falls into the cancelled group, which claims less).
   */
  bookingDeleted?: boolean;
  memberName: string;
  checkIn: string;
  checkOut: string;
}

/**
 * One row of the record. Extracted when #2760 gave the card two groups, so both
 * groups print identical rows and neither can drift into saying more than the
 * other about a money movement.
 *
 * NO "View booking" LINK, unlike the hand-back queue above, and the difference is
 * not an oversight (#2750 review, re-justified for #2760's second population).
 *
 * For a DELETED booking the detail page 404s for anybody who is not a Full Admin.
 * For a booking that is merely cancelled the page exists - but it is gated on
 * `bookings:view`, and this card is gated on `finance:view`, which a Finance
 * Viewer holds with no bookings access at all. So a link would be a dead end for
 * part of this card's audience either way, and widening who may open a deleted
 * booking is explicitly not on the table. The identifiers are printed as plain
 * text instead, which is what a Full Admin needs to look the booking up and what a
 * finance operator needs to quote it to somebody who can.
 */
/**
 * A lodge night as the calendar day it IS - no timezone, because a calendar day
 * has none (CT-4, #2870; INV-DATE-010). `checkIn`/`checkOut` are `@db.Date`
 * columns and cross the wire as UTC midnight; the kernel's calendar-date
 * formatter pins UTC over that encoding, so the projection is the identity.
 * What this replaces read the day through a zone - correct east of Greenwich, a
 * day early west of it.
 */
function formatStayDate(value: string): string {
  return formatClubDate(calendarDateOfSerialisedDbDate(value));
}

function AutomaticRefundNoticeRow({ notice }: { notice: AutoRefundedNotice }) {
  /**
   * `refundedAt` is the payment task's `completedAt` - a real INSTANT, not a
   * lodge night - so it projects through the club's PERSISTED timezone (CT-4,
   * #2870; INV-CONFIG-002). `instantDate` keeps the medium "16 Apr 2026" shape
   * this row has always shown; only the zone's AUTHORITY changed, from the
   * container's `TZ` to the club's recorded setting.
   */
  const clubTime = useClubTime();
  return (
    <li className="space-y-1 rounded-md border border-border px-3 py-2 text-sm">
      <p className="font-medium text-foreground">
        {notice.memberName} - {formatCents(notice.amountCents)} refunded
        {notice.refundedAt
          ? ` on ${clubTime.instantDate(new Date(notice.refundedAt))}`
          : ""}
      </p>
      <p className="text-muted-foreground">
        {formatStayDate(notice.checkIn)} to{" "}
        {formatStayDate(notice.checkOut)} - booking{" "}
        <span className="font-mono text-xs">{notice.bookingId}</span>
      </p>
      {/*
        Both sentences, not one. The reason names the situation that produced the
        payment; the note says that Stripe already handed the money back. An
        operator reading only the reason - which, on a deleted booking, asks them
        to decide whether to refund - would think the decision is still theirs.
      */}
      <p className="text-xs text-muted-foreground">{notice.reason}</p>
      {notice.note ? (
        <p className="text-xs text-muted-foreground">{notice.note}</p>
      ) : null}
    </li>
  );
}

/**
 * The read-only record of a refund nobody authorised (#2750, completed by #2760).
 *
 * Deliberately buttonless. There is no decision left on these rows - Stripe
 * returned the money before anybody saw the capture - and a control here would
 * imply otherwise. What it does carry is the one thing an operator needs if the
 * cancellation or deletion, not the payment, was the mistake: that the refund has
 * already gone out, so putting the booking back means charging the member again.
 *
 * A separate component from the queue above because it is a different claim
 * about the world, and mixing "you owe this member money" rows with "this money
 * has already gone back" rows in one list is how somebody pays a refund twice.
 *
 * A COMPLETE RECORD SINCE #2760, and the copy says that instead of the
 * qualification it used to carry. Until #2760 a row existed only where the
 * member's browser reached the confirm endpoint before the Stripe webhook did -
 * one of four orderings - so the card was a partial list and said so. The webhook
 * now writes the row itself whenever its fenced close finds nothing, for a
 * deleted AND a merely cancelled booking, so every automatic refund of a late
 * capture inside the window is here.
 *
 * TWO GROUPS, AND THAT IS WHY (#2760, implementor's call under the owner's
 * decision). Widening to every cancelled booking adds rows for what is usually
 * normal operation: cancel a booking somebody is part-way through paying for and
 * this is the expected outcome. Listed together, those rows would bury the case
 * that actually needs a person - a payment refunded on a booking the club
 * DELETED, where remaking the booking means charging the member again. The
 * deleted group is printed first and each group says what it means, so the
 * interesting case cannot be lost in the ordinary one. Grouping rather than
 * re-sorting keeps each group newest-first, which is the order the route answers
 * in and the order an operator reads "what happened lately" in.
 *
 * A THIRD, NEUTRAL GROUP FOR A ROW WHOSE POPULATION IS UNKNOWN (review of #2760).
 * `bookingDeleted` is optional on the wire so a cached pre-#2760 client bundle
 * still renders, and the first cut of the grouping treated absent as "not
 * deleted" on the grounds that the cancelled group claims less. It claims less
 * about the WORK and more about the BOOKING - "cancelled and is still on file" is
 * a positive statement, and if that row's booking was in fact deleted the heading
 * is wrong about the only case here that needs a person. So an unknown row gets a
 * heading that asserts nothing beyond what the card already says, and asks for a
 * reload. Unreachable against the current route, which always sends the field;
 * this is for the minutes after a deploy.
 */
function AutomaticRefundNoticesCard({
  notices,
}: {
  notices: AutoRefundedNotice[];
}) {
  // `=== true` / `=== false`, NOT truthiness, and the third bucket is why. A row
  // with `bookingDeleted` absent is a stale client bundle talking to the current
  // route (which always sends the field), and it is genuinely UNKNOWN - so it
  // belongs in neither group, because each group's heading makes a positive claim
  // about the booking's state. Filing an unknown row under "cancelled and is
  // still on file" claims LESS about the work and MORE about the world, and if
  // that booking was in fact deleted it hides the one case that needs a person.
  const deletedNotices = notices.filter(
    (notice) => notice.bookingDeleted === true,
  );
  const cancelledNotices = notices.filter(
    (notice) => notice.bookingDeleted === false,
  );
  const unknownNotices = notices.filter(
    (notice) => notice.bookingDeleted === undefined,
  );

  return (
    <Card data-testid="automatic-refund-notices">
      <CardHeader>
        <CardTitle className="text-base">
          Refunded automatically &mdash; nothing to pay back ({notices.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {/*
            #2773 dropped "for a booking change" from this sentence. Both
            late-capture handlers write these rows now - a payment for a change to
            a booking, and the booking's own payment - so naming only one of them
            told an operator the card was narrower than it is. Each row's own
            reason sentence still says which payment it was.
          */}
          A payment arrived after the booking had already been cancelled. Stripe
          returned the money to the member straight away, so there is nothing for
          you to pay back and nothing to close here. This card is here so somebody
          sees it happened.
        </p>
        {/*
          #2760 replaced the "this card does not catch every one" paragraph that
          #2750 shipped. It was true then: the row only existed on one of the four
          orderings, so an empty card was not evidence. The webhook now writes the
          row itself on every ordering and for both populations, so the card IS
          the list - and the audit log is named as the permanent record because
          this card is bounded to the last 30 days, not because it misses events.

          ONE CLAUSE OF EXCEPTION, NOT A PARAGRAPH, and it is there because the
          claim would otherwise be false (review of #2760). If an operator closed
          the hand-back task themselves before Stripe's refund landed, the row
          carries THEIR name and note, so it is on neither card - the writer will
          not put two rows on one capture. A footnote an operator reads in passing
          keeps the claim honest; the old partial-list paragraph told them to
          distrust the whole card, which is how a card stops being read.
          `INV-ADDPAY-037` carries the reasoning; keeping the carve-out rather
          than writing a second row is #2774 D1, the orchestrator's call on that
          issue's Recommended option, which the owner has not ruled on
          (`INV-ADDPAY-039`'s authority line). This copy describes what the code
          does either way - it makes no claim about who chose it.

          AND #2773 LIFTED THE OTHER QUALIFICATION: this used to say "of a late
          booking-change payment", because the sibling handler for a booking's OWN
          payment wrote no row at all. It does now, through the same writer, so the
          word came out. Do NOT widen this sentence further and do NOT narrow it
          back: an operator who reads an empty card as proof that no automatic
          refund happened is worse off than before the card existed, and one told
          to distrust a complete list stops reading it.
        */}
        <p className="text-sm text-muted-foreground">
          This is every automatic refund of a late payment from the last 30 days
          &mdash; unless somebody had already closed the hand-back task for it by
          hand, in which case their own record of it is in the
          booking&apos;s history instead. Older ones are not shown here:
          the permanent record is the booking&apos;s audit log (the{" "}
          <span className="font-mono text-xs">
            booking.payment.refunded_after_cancellation
          </span>{" "}
          entry) together with the payment alert email the club is sent at the
          time.
        </p>
        {deletedNotices.length > 0 ? (
          <section
            className="space-y-2"
            data-testid="automatic-refund-notices-deleted"
          >
            <h3 className="text-sm font-medium text-foreground">
              The booking was deleted ({deletedNotices.length})
            </h3>
            <p className="text-sm text-muted-foreground">
              Worth a look. If deleting the booking was the mistake rather than
              the payment, the booking has to be made again and the member charged
              again &mdash; the refund has already gone out.
            </p>
            <ul className="space-y-3">
              {deletedNotices.map((notice) => (
                <AutomaticRefundNoticeRow key={notice.id} notice={notice} />
              ))}
            </ul>
          </section>
        ) : null}
        {cancelledNotices.length > 0 ? (
          <section
            className="space-y-2"
            data-testid="automatic-refund-notices-cancelled"
          >
            <h3 className="text-sm font-medium text-foreground">
              The booking was cancelled and is still on file (
              {cancelledNotices.length})
            </h3>
            <p className="text-sm text-muted-foreground">
              Normally nothing to do. This is the expected outcome when a booking
              is cancelled while the member is part-way through paying for it, or
              for a change to it. If the cancellation was the mistake, the same
              applies as above: the money has gone back, so the booking has to be
              remade and charged again.
            </p>
            <ul className="space-y-3">
              {cancelledNotices.map((notice) => (
                <AutomaticRefundNoticeRow key={notice.id} notice={notice} />
              ))}
            </ul>
          </section>
        ) : null}
        {unknownNotices.length > 0 ? (
          <section
            className="space-y-2"
            data-testid="automatic-refund-notices-unknown"
          >
            <h3 className="text-sm font-medium text-foreground">
              Refunded automatically ({unknownNotices.length})
            </h3>
            <p className="text-sm text-muted-foreground">
              Reload the page to sort these into the two groups above. The money
              has already gone back either way, so there is nothing to pay back
              &mdash; but if the club deleted one of these bookings, remaking it
              means charging the member again.
            </p>
            <ul className="space-y-3">
              {unknownNotices.map((notice) => (
                <AutomaticRefundNoticeRow key={notice.id} notice={notice} />
              ))}
            </ul>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
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
  /**
   * #3170: the officer's pricing of a review, held only while the dialog is open.
   *
   * `direction` opens as null on purpose (see `SettlementDirection`), and
   * `amountInput` is the typed text rather than a number - `parseDecimalDollarsToCents`
   * is the boundary for money a person typed (`INV-MONEY-003`), and it returns
   * null for anything malformed rather than a zero.
   */
  const [direction, setDirection] = useState<SettlementDirection | null>(null);
  const [amountInput, setAmountInput] = useState("");
  /**
   * #3191: what the officer says each unpriced night sold for, as typed text
   * keyed by lodge night.
   *
   * OPENS EMPTY AND IS NEVER PRE-FILLED - not from the remaining balance, not
   * from an even split, not from the amount above. `INV-MOD-028` prohibits
   * deriving a historical amount, and a box that arrives with a number in it is
   * a derivation an officer can accept by pressing a button.
   */
  const [nightPriceInputs, setNightPriceInputs] = useState<
    Record<string, string>
  >({});
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
  /*
    #3170: the review pricing box's hint, on the house field-hint wiring.

    #3195 fix round: the $0.00 refusal is passed as a PRECEDING description, so
    a screen-reader user hears "this is wrong, and here is why" before "here is
    an example" - the ordering `field-hint.tsx` exists to make the default. It
    matters more here than at most field-hint sites: the confirm button is
    disabled behind that sentence, so without it the officer is left with a
    control that will not press and no reason given, which is the bare refusal
    the owner's 31 Aug 2026 decision rejected.
  */
  const zeroAmountRefusalId = useId();
  const amountHint = useFieldHint(zeroAmountRefusalId);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/payments/manual-refund-tasks");
      if (!response.ok) {
        setTasks([]);
        setAutoRefunded([]);
        setAutoRefundedUnavailable(false);
        setViewerCanViewBookings(false);
        setLoadFailed(true);
        return;
      }
      const data = (await response.json()) as {
        tasks: ManualRefundTask[];
        autoRefunded?: AutoRefundedNotice[];
        autoRefundedUnavailable?: boolean;
        viewerCanViewBookings?: boolean;
      };
      setTasks(data.tasks ?? []);
      setAutoRefunded(data.autoRefunded ?? []);
      setAutoRefundedUnavailable(Boolean(data.autoRefundedUnavailable));
      setViewerCanViewBookings(data.viewerCanViewBookings === true);
      setLoadFailed(false);
    } catch {
      setTasks([]);
      setAutoRefunded([]);
      setAutoRefundedUnavailable(false);
      setViewerCanViewBookings(false);
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * #3170: the officer's figure in integer cents, or null when what they typed is
   * not a well-formed amount. `parseDecimalDollarsToCents` returns null rather
   * than zero for malformed text (#2685), and null here disables the button -
   * a completion at zero is refused by the server anyway, and "nothing is owed"
   * has its own control.
   */
  const pricingReview =
    target !== null &&
    target.resolution === "completed" &&
    isFinancialReview(target.task);
  const pricedAmountCents = pricingReview
    ? parseDecimalDollarsToCents(amountInput)
    : null;
  const reviewPricingIncomplete =
    pricingReview &&
    (direction === null || pricedAmountCents === null || pricedAmountCents <= 0);
  /**
   * #3195 question 1: a settlement of exactly $0.00 is refused, and the officer
   * is told why HERE rather than after a round trip - the button is disabled, so
   * without this they would press nothing and be told nothing, which is the bare
   * refusal the owner's decision rejected. The sentence is the server's own
   * (`zeroCompletionRefusal`), so the two can never say different things.
   */
  const zeroAmountRefusal =
    pricingReview && pricedAmountCents === 0
      ? zeroCompletionRefusal(true)
      : null;

  /**
   * #3191: the per-night repair, as it stands while the officer types.
   *
   * Everything below is derived rather than stored, so the boxes are the only
   * state and there is no second copy of the answer to fall out of step. The
   * VERDICT comes from the shared checker the server runs on the same input
   * (`INV-SSOT`): a screen with its own arithmetic would enable a button the
   * server then refuses, or the reverse.
   */
  const unpricedNights =
    target !== null && target.task.unpricedNights
      ? target.task.unpricedNights
      : null;
  const nightPriceDeltaCents =
    target === null || target.resolution === "dismissed"
      ? 0
      : direction !== null && pricedAmountCents !== null
        ? settlementDeltaCents({
            direction,
            amountCents: pricedAmountCents,
          })
        : null;
  const nightPriceEntries: RecordedNightPrice[] = [];
  /*
    Boxes holding something that is NOT an amount, kept apart from boxes holding
    nothing. `parseDecimalDollarsToCents` answers null for "1,200.00", "$45",
    "45." and a stray letter alike, and folding those in with "not typed" is how
    an officer looking at a full column of figures gets told to "give an amount
    for every night listed" - true of the entries this screen built, and visibly
    false of what is on their screen. `money-input.ts` says the caller must turn
    that null into a validation error the person can see (#2685); this is that
    caller.
  */
  let unreadableNightDates: NonEmptyDates | null = null;
  let nightBoxesTyped = 0;
  if (unpricedNights) {
    for (const date of unpricedNights.dates) {
      const raw = nightPriceInputs[date] ?? "";
      if (raw.trim() === "") continue;
      nightBoxesTyped += 1;
      const cents = parseNightInput(raw);
      /*
        Built as a NON-EMPTY list by construction (#3191 fix round), because
        that is the only shape the refusal below accepts - handed an empty one
        it would render "The amounts for  are not ones these boxes can read."
        The type is what stops that, rather than the `.length > 0` check the
        branch below used to rely on.
      */
      if (cents === null) {
        unreadableNightDates =
          unreadableNightDates === null
            ? [date]
            : [...unreadableNightDates, date];
      } else nightPriceEntries.push({ date, priceCents: cents });
    }
  }
  // A partial or malformed answer never reaches the checker as if it were whole:
  // the entries are only complete when every box parsed, and an unreadable one
  // is answered here, by name, before the checker sees a vector it would call
  // short. Neither branch fills anything in.
  const nightPriceCheck: StoredNightPriceRepairCheck | null =
    !unpricedNights || nightBoxesTyped === 0 || nightPriceDeltaCents === null
      ? null
      : unreadableNightDates !== null
        ? {
            ok: false,
            message: nightPriceRepairUnreadableMessage(unreadableNightDates),
            // The ONE definition of what the blanks must come to, shared with
            // the checker rather than restated for this branch.
            targetCents: unpricedNightTargetCents(
              unpricedNights,
              nightPriceDeltaCents,
            ),
          }
        : checkStoredNightPriceRepair({
            summary: unpricedNights,
            entries: nightPriceEntries,
            deltaCents: nightPriceDeltaCents,
          });
  /*
    Blocked, not required. Leaving every box blank is a valid answer and settles
    exactly as it did before #3191; having typed into SOME of them and not
    reached a set of figures that adds up is not, because that is an answer the
    server would refuse after the task had already been claimed.
  */
  const nightPricesBlocked =
    unpricedNights !== null &&
    nightBoxesTyped > 0 &&
    (nightPriceDeltaCents === null || nightPriceCheck?.ok !== true);

  async function submit() {
    if (!target) return;
    setSubmitting(true);
    setUnverified(null);
    try {
      const response = await fetch(
        `/api/admin/payments/manual-refund-tasks/${target.task.id}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resolution: target.resolution,
            confirmed: true,
            note: note.trim() || null,
            // #3170: a POSITIVE magnitude plus an explicit direction, never a
            // signed amount. Sent only where the officer was asked for them, so
            // a legacy hand-back posts exactly the body it always did.
            ...(pricingReview
              ? {
                  confirmedAmountCents: pricedAmountCents,
                  direction,
                }
              : {}),
            /*
              #3191: sent only when the officer filled every box and the figures
              reconcile. A partial answer is never posted - the button is
              disabled behind it - and an untouched section posts nothing at all,
              so a settle with no repair sends exactly the body it sent before
              this issue.
            */
            ...(nightPriceCheck?.ok
              ? { recordedNightPrices: nightPriceCheck.entries }
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
      setDirection(null);
      setAmountInput("");
      setNightPriceInputs({});
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
    actually holds a row it describes, and neither speaks for the other.
  */
  const openTasks = tasks ?? [];
  const hasReviewRows = openTasks.some(isFinancialReview);
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
  const hasHandBackRows = openTasks.some(
    (task) => !isFinancialReview(task) && !isWithheldShare(task),
  );
  if (
    !showQueue &&
    autoRefunded.length === 0 &&
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
              Money to settle by hand
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
            {hasReviewRows ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="manual-refund-task-review-intro"
              >
                Some of these are booking changes that saved normally but whose
                adjustment could not be worked out from what the booking has
                stored. Nothing has been refunded or credited for them and no
                amount has been assumed. Use the evidence on each row, together
                with the booking&apos;s own payment and rate history, to decide
                the amount — or dismiss the row if, on the evidence, nothing is
                owed.
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
                        {task.memberName} — {formatTaskAmount(task)}
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
                            (raised at {formatCents(task.raisedAmountCents)})
                          </span>
                        ) : null}
                      </p>
                      <p className="text-muted-foreground">
                        {formatStayDate(task.checkIn)} to{" "}
                        {formatStayDate(task.checkOut)} ·{" "}
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
                            : `Open this booking's invoices in Xero and check whether they already include ${formatCents(task.amountCents)}. If they do, nothing is owed. If they fall short, raise a supplementary invoice for that amount only — never for the change's full total, which the member has already been asked for. Then close the item with a note saying what Xero showed and what you billed.`}
                        </p>
                      ) : null}
                      {task.reviewEvidence ? (
                        <EditFinancialReviewEvidenceBlock
                          evidence={task.reviewEvidence}
                        />
                      ) : null}
                      {/*
                        Evidence WAS captured and cannot be read back. Said out
                        loud rather than rendered as an absence: the captured
                        rows are the only record of what the edit destroyed, so
                        an admin who silently sees no evidence section would
                        reasonably assume none was ever taken and price from the
                        wrong material.
                      */}
                      {task.reviewEvidenceUnreadable ? (
                        <p
                          className="text-xs text-warning-11"
                          data-testid="manual-refund-task-review-evidence-unreadable"
                        >
                          The evidence recorded with this review cannot be read
                          by this version of the site. Decide the amount from the
                          booking&apos;s own payment and rate history, and tell
                          the club administrator.
                        </p>
                      ) : null}
                    </div>
                    <div className="flex gap-2">
                      {/*
                        #3213: NO COMPLETION CONTROL ON A WITHHELD SHARE, and
                        the button is absent rather than disabled.

                        The kind is dismiss-only at the completion door
                        (`manual-refund-task-resolution.ts`), because COMPLETED
                        with no direction reads as REFUND_TO_MEMBER and reaches
                        the allocation path. A control whose only outcome is a
                        refusal is worse than no control - the house "no button
                        that fails" rule, the same one that governs the unpriced
                        review above - and a disabled one would still say the
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
                      {manualRefundTaskKindAllowsSettlement(task.kind) ? (
                      <ViewOnlyActionButton
                        canEdit={canEdit}
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setNote("");
                          setUnverified(null);
                          // #3170: open with no direction chosen, and with the
                          // amount the task already carries where it has one -
                          // a review raised unpriced opens blank rather than at
                          // a figure nobody decided.
                          setDirection(null);
                          /*
                            #3191: the ONE thing in this file the night-price
                            census does not scan, and it is five lines wide. It
                            is the task's own settled amount rendered into its
                            box - cents to dollars, the conversion every money
                            input on this screen does - and no night price passes
                            through it. EVERYTHING ELSE IN THIS FILE IS SCANNED,
                            so a helper that could produce a per-night figure
                            cannot be written anywhere in it, one line above the
                            night-price code or a thousand lines below.

                            Adding to the region is a real decision rather than
                            paperwork: the census caps how large it may grow, and
                            refuses a region that excludes nothing. Each marker
                            sits on a line of its own and is a WHOLE comment, so
                            removing the region cannot leave a half-open
                            delimiter behind and blank the rest of the file.
                          */
                          /* MONEY-DISPLAY EXEMPTION START (stored-night-price-repair-census) */
                          setAmountInput(
                            task.amountCents === null
                              ? ""
                              : (task.amountCents / 100).toFixed(2),
                          );
                          /* MONEY-DISPLAY EXEMPTION END (stored-night-price-repair-census) */
                          // #3191: always empty. See `nightPriceInputs`.
                          setNightPriceInputs({});
                          setTarget({ task, resolution: "completed" });
                        }}
                      >
                        {/*
                          #3033: the same control, named for what it does on
                          this row. On a hand-back it records money that has
                          already physically gone; on a financial review it
                          records the adjustment the club has decided on. One
                          render site, two honest labels.
                        */}
                        {isFinancialReview(task)
                          ? "Record the adjustment"
                          : "Mark paid back"}
                      </ViewOnlyActionButton>
                      ) : null}
                      <ViewOnlyActionButton
                        canEdit={canEdit}
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setNote("");
                          setUnverified(null);
                          setDirection(null);
                          setAmountInput("");
                          setNightPriceInputs({});
                          setTarget({ task, resolution: "dismissed" });
                        }}
                      >
                        {isFinancialReview(task)
                          ? "No adjustment"
                          : isWithheldShare(task)
                            ? "Close this item"
                            : "Dismiss"}
                      </ViewOnlyActionButton>
                    </div>
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
                // #3170: a direction and an amount belong to the task they were
                // typed for. Carrying either onto the next row would offer a
                // pre-filled figure nobody priced.
                setDirection(null);
                setAmountInput("");
                // #3191: figures typed for one booking's nights must never be
                // carried onto another's, for the same reason the amount is not.
                setNightPriceInputs({});
              }
            }}
          >
            <DialogContent>
              {target && (
                <>
                  <DialogHeader>
                    <DialogTitle>{completionTitle(target)}</DialogTitle>
                    <DialogDescription>
                      {/*
                        #3033: four sentences, not two, because a dismissal means
                        different things on the two kinds of row. On a hand-back
                        it is "declined, or settled another way". On a financial
                        review it is "somebody looked, and nothing is owed" —
                        which is a FINDING about the money, not a decision to
                        skip it, and the record has to read that way later.
                      */}
                      {resolutionDescription(target)}
                    </DialogDescription>
                  </DialogHeader>
                  {pricingReview ? (
                    <div className="space-y-4">
                      {/*
                        #3170: the direction FIRST, and with no default. Every
                        settlement path used to hand money back, so an officer who
                        correctly read the evidence as "the member owes us" had one
                        plausible action that paid them instead. Asking which way
                        before asking how much is what stops the amount being typed
                        into a control whose direction the officer never saw.
                      */}
                      <fieldset className="space-y-2">
                        <legend className="text-sm font-medium">
                          Which way does this money go?
                        </legend>
                        {DIRECTION_CHOICES.map((choice) => (
                          <label
                            key={choice.value}
                            htmlFor={`manual-refund-task-direction-${choice.value}`}
                            className="flex gap-2 rounded-md border border-border p-2 text-sm"
                          >
                            <input
                              type="radio"
                              id={`manual-refund-task-direction-${choice.value}`}
                              name="manual-refund-task-direction"
                              className="mt-1"
                              value={choice.value}
                              checked={direction === choice.value}
                              onChange={() => setDirection(choice.value)}
                            />
                            <span className="space-y-1">
                              <span className="block font-medium">
                                {choice.label}
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                {choice.detail}
                              </span>
                            </span>
                          </label>
                        ))}
                      </fieldset>
                      <div className="space-y-2">
                        <Label htmlFor="manual-refund-task-amount">Amount</Label>
                        <div className="flex items-center gap-2">
                          <span className="text-sm">$</span>
                          <Input
                            id="manual-refund-task-amount"
                            {...MONEY_INPUT_PROPS}
                            value={amountInput}
                            className="w-32"
                            onChange={(event) =>
                              setAmountInput(event.target.value)
                            }
                            {...amountHint.fieldProps}
                          />
                        </div>
                        <FieldHint {...amountHint.hintProps}>
                          {/*
                            The box takes a magnitude, never a sign: the direction
                            above is what says which way it goes, and a money box
                            that accepts a minus sign is the overloading this epic
                            exists to remove.
                          */}
                          Example: 45.00 — how much, without a plus or minus
                        </FieldHint>
                        {/*
                          #3195 question 1. The confirm button is disabled at
                          zero, so this sentence is the whole of what the officer
                          gets to work with — and a refusal that does not name the
                          way out is the version the owner's decision rejected.

                          Permanently mounted and empty when there is nothing to
                          say, for the two reasons the same shape is used on the
                          night boxes and on `focused-action-error.tsx`: a live
                          region injected already populated is silently dropped
                          by some screen-reader/browser pairings, and the amount
                          box's `aria-describedby` names this id whether or not a
                          zero has been typed.
                        */}
                        <p
                          id={zeroAmountRefusalId}
                          aria-live="polite"
                          className="text-xs text-warning-11"
                          {...(zeroAmountRefusal
                            ? {
                                "data-testid":
                                  "manual-refund-task-zero-amount-refusal",
                              }
                            : {})}
                        >
                          {zeroAmountRefusal ?? ""}
                        </p>
                      </div>
                    </div>
                  ) : null}
                  {/*
                    #3191. Offered on a dismissal as well as a completion, and
                    that is not symmetry for its own sake: a parked edit whose
                    guest kept the same nights owes nothing either way, so "no
                    adjustment" is its ordinary ending — and if only a completion
                    could fill the blanks in, exactly those bookings would park
                    forever, which is the defect this issue exists to remove.
                  */}
                  {unpricedNights ? (
                    <UnpricedNightPriceFields
                      summary={unpricedNights}
                      values={nightPriceInputs}
                      onChange={(date, value) =>
                        setNightPriceInputs((current) => ({
                          ...current,
                          [date]: value,
                        }))
                      }
                      targetKnown={nightPriceDeltaCents !== null}
                      check={nightPriceCheck}
                      disabled={submitting || unverified !== null}
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
                        : isFinancialReview(target.task)
                          ? "e.g. the nights given back were never charged for, so nothing is owed"
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
                          #3033: an unpriced review cannot be completed — the
                          server refuses a completion with no amount, and a
                          button whose only outcome is a refusal is worse than
                          no button (the house "no button that fails" rule).
                          The dialog above says why and points at the way out.
                          Supplying the confirmed amount is #3032's; this only
                          stops the dead press in the meantime.
                        */
                        /*
                          #3170: a review completion is armed only once the
                          officer has said which way and how much. It replaces the
                          #3033 guard that disabled the button whenever the task
                          carried no amount - which was right while nothing on
                          this screen could supply one, and would now disable the
                          control that supplies it.
                        */
                        reviewPricingIncomplete ||
                        /*
                          #3191: a half-filled or non-reconciling set of night
                          prices disarms the button rather than being dropped
                          silently. Dropping them would settle the task and lose
                          the officer's typing; posting them would be refused
                          after the task was already claimed.
                        */
                        nightPricesBlocked ||
                        (target.resolution === "completed" &&
                          !isFinancialReview(target.task) &&
                          target.task.amountCents === null) ||
                        (target.resolution === "dismissed" && note.trim().length === 0)
                      }
                    >
                      {confirmButtonLabel(target, direction)}
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
      {autoRefunded.length > 0 ? (
        <AutomaticRefundNoticesCard notices={autoRefunded} />
      ) : null}
    </div>
  );
}
