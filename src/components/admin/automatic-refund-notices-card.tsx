"use client";

// The read-only card of refunds Stripe made by itself, and its row, moved
// verbatim from `manual-refund-task-queue.tsx` so that file shrinks below its
// length on main (#4926: past the hard ceiling a file may only stay or shrink).
// The queue renders the card exactly as before.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useClubTime } from "@/components/club-time-provider";
import { useClubFormat } from "@/components/club-format-provider";
import { formatStayDate } from "@/lib/club-time";
import { formatCents } from "@/lib/utils";

/**
 * A refund the club never decided: a payment landed on a booking that had
 * already been cancelled — deleted or not — and Stripe handed it straight back
 * (#2750, widened to both populations by #2760).
 */
export interface AutoRefundedNotice {
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
function AutomaticRefundNoticeRow({ notice }: { notice: AutoRefundedNotice }) {
  const format = useClubFormat();
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
        {notice.memberName} - {formatCents(notice.amountCents, format)} refunded
        {notice.refundedAt
          ? ` on ${clubTime.instantDate(new Date(notice.refundedAt))}`
          : ""}
      </p>
      <p className="text-muted-foreground">
        {formatStayDate(notice.checkIn, format)} to{" "}
        {formatStayDate(notice.checkOut, format)} - booking{" "}
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
export function AutomaticRefundNoticesCard({
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
