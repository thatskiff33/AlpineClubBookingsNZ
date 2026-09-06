import { NextResponse } from "next/server";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import {
  AUTOMATIC_REFUND_NOTICE_WINDOW_DAYS,
  automaticallyRefundedManualRefundTaskFilter,
} from "@/lib/deleted-booking-modification-payment";
import {
  toAutoRefundedManualRefundTaskPayload,
  toOpenManualRefundTaskPayload,
} from "@/lib/manual-refund-task-queue-payload";
import { unpricedNightsSummariesForQueue } from "@/lib/stored-night-price-repair-queue";

/**
 * GET /api/admin/payments/manual-refund-tasks
 *
 * B5 (#2262): the open hand-back queue for cancelled cash-settled bookings.
 * Read-only, so finance:view is enough; closing a task is the finance:edit
 * sibling route.
 *
 * TWO LISTS SINCE #2750, and the second one has nothing to do. `tasks` is the
 * work: OPEN rows an operator has to settle by hand. `autoRefunded` is the
 * record: rows the Stripe webhook closed — or, since #2760, wrote itself — because
 * it had refunded the capture, which the operator can only read. They are returned together
 * rather than from two endpoints because they render as two cards on one screen
 * from one load, and a second round trip would buy nothing.
 *
 * Both are `take`-bounded and neither paginates, matching the pre-existing
 * behaviour of this route: it is a queue card, not a dataset surface.
 *
 * THE SECOND LIST CANNOT TAKE THE FIRST DOWN WITH IT (#2750 review). One
 * `Promise.all` rejection rejects the whole batch, the client blanks both lists
 * on a non-OK answer, and the OPEN list is money the club still owes members by
 * hand — so a failure of the informational query would have removed the
 * actionable queue from the screen. The failure mode is specific to the new
 * query rather than hypothetical: `note: { startsWith }` is an unindexed
 * `LIKE 'prefix%'` scan over the DISMISSED slice, so it is the one of the two
 * that can time out as the table grows. It is therefore caught on its own,
 * answered as an empty list with `autoRefundedUnavailable: true`, and logged.
 * The flag matters as much as the fallback: an empty list means "no automatic
 * refunds", and a degraded read must not be allowed to say that.
 */
/**
 * An informational list that degrades to "unavailable" rather than rejecting the
 * batch carrying the actionable queue beside it (#2750 review).
 *
 * Generic over the row so the empty fallback keeps the query's own type — a bare
 * `[]` in a `.catch` widens to `never[]` and makes the result unmappable — and
 * returning the flag beside the rows is what stops the caller forgetting it: an
 * empty list and a failed read look identical on screen, and on a refund notice
 * that difference is the entire point of the card.
 */
function readOrDegrade<T>(
  query: Promise<T[]>,
  what: string,
): Promise<{ rows: T[]; unavailable: boolean }> {
  return query.then(
    (rows) => ({ rows, unavailable: false }),
    (err: unknown) => {
      logger.error(
        { err },
        `Failed to read the ${what} for the finance queue; the hand-back queue is answered without them`,
      );
      return { rows: [], unavailable: true };
    },
  );
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;

  /*
    #3033. Whether this caller may open a booking at all, read off the
    DB-verified matrix `requireAdmin()` just resolved onto the session — the
    #2823 stuck-state shape, and defaulted to FALSE on the client for the same
    reason that route's own flag is: a caller that omits it must fail closed.

    It is a real distinction on this card and not a hypothetical one. The card is
    gated on `finance:view`, which a Finance Viewer holds with NO bookings access
    at all, and the automatic-refund card beside it already prints identifiers as
    plain text rather than linking, precisely because `/bookings/{id}` 403s or
    404s for part of this card's audience. Owner decision D3 asks for "a link to
    the booking's payment and rate history", so the link has to land somewhere
    when it is offered; for everyone else the booking id is printed instead, which
    is what a finance operator needs in order to quote it to somebody who can open
    it.
  */
  const viewerCanViewBookings = hasAdminAreaAccess(guard.session.user, {
    area: "bookings",
    level: "view",
  });

  const bookingSummary = {
    checkIn: true,
    checkOut: true,
    member: { select: { firstName: true, lastName: true } },
  } as const;

  /*
    #3033. The hand-back queue's own summary additionally reads who OWNS the
    booking and whether it still exists, for the ownership case below. Kept off
    `bookingSummary` itself so the automatic-refund list, which offers no link at
    all, does not start reading an identifier it has no use for.
  */
  const handBackBookingSummary = {
    ...bookingSummary,
    memberId: true,
    deletedAt: true,
  } as const;

  /*
    #2760: the record now covers two populations — a late capture auto-refunded on
    a booking the club DELETED, and one on a booking that is cancelled but still
    on file — and the card groups them, because the deleted case is the
    interesting one and the cancelled case is normal operation that would
    otherwise bury it. `deletedAt` is read only for that grouping and answered as
    a boolean; the date itself is not the operator's business here and is not sent
    to the browser.

    Read as CURRENT state, not as the state at the moment of the refund. Deletion
    is one-way (there is one writer of `deletedAt` and no restore path), so the
    only disagreement possible is a row written while the booking was merely
    cancelled and deleted afterwards — and for that row the present-tense grouping
    ("this booking is deleted") is the more useful of the two truths: it is what
    decides whether remaking the booking is even possible. The row's own stored
    reason still says what was true when the money went back.
  */
  const autoRefundedBookingSummary = {
    ...bookingSummary,
    deletedAt: true,
  } as const;

  /*
    An INSTANT window, not a calendar day, which is why it reads the raw clock
    rather than the club's calendar. `INV-DATE-019` governs deriving "today" as a
    `yyyy-MM-dd` day — the mistake it forbids is turning an instant into a UTC
    day string, which lands on the previous NZ day all morning. Nothing here is
    turned into a day: `completedAt` is a `DateTime` and this compares it against
    a `DateTime` thirty times twenty-four hours ago. Sending it through
    `getTodayDateOnly()` would make the window's edge depend on the time of day
    the page was opened, which is worse rather than better.
  */
  const noticesSince = new Date(
    Date.now() - AUTOMATIC_REFUND_NOTICE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  const [tasks, autoRefundedRead] = await Promise.all([
    prisma.manualRefundTask.findMany({
      where: { status: "OPEN" },
      orderBy: { createdAt: "asc" },
      take: 100,
      select: {
        id: true,
        bookingId: true,
        amountCents: true,
        /*
          #3033. `kind` decides which SENTENCE the card prints beside a row: the
          queue's standing paragraph says every row "was paid in cash or by a
          bank transfer that never reached Xero", which is simply untrue of an
          EDIT_FINANCIAL_REVIEW row. `raisedAmountCents` is what the task was
          raised with, so a row whose amount an admin has since amended says so
          on its face rather than only in the audit log. `reviewContext` is owner
          decision D3's evidence — projected below, never sent raw.
        */
        kind: true,
        raisedAmountCents: true,
        reviewContext: true,
        reason: true,
        createdAt: true,
        booking: { select: handBackBookingSummary },
      },
    }),
    /*
      #2750. Newest first, and oldest-first would be wrong here for the same
      reason it is right above: the OPEN queue is worked from the top, whereas
      this is "what happened lately" and the most recent automatic refund is the
      one an operator can still act on if the deletion was the mistake.
    */
    readOrDegrade(
      prisma.manualRefundTask.findMany({
        where: {
          ...automaticallyRefundedManualRefundTaskFilter,
          completedAt: { gte: noticesSince },
        },
        orderBy: { completedAt: "desc" },
        /*
          The same 100 as the queue above, on purpose. The card prints its own
          length as a count, so a tighter `take` would silently make that count a
          lie about a money movement the moment a club had more of them than the
          limit — and the honest bound here is the thirty-day window, not a row
          cap. A club with 100 of these inside a month has a problem it needs to
          see in full.
        */
        take: 100,
        select: {
          id: true,
          bookingId: true,
          amountCents: true,
          reason: true,
          note: true,
          completedAt: true,
          booking: { select: autoRefundedBookingSummary },
        },
      }),
      "automatically refunded late-capture notices",
    ),
  ]);

  // #3191: which reviews have unpriced nights the settle screen can offer to fill
  // in. Keyed by TASK id so no payload has to hold a guest-strand id to find its
  // own; fails closed on its own rather than taking the money queue down with it.
  // Both reasons are on `unpricedNightsSummariesForQueue`.
  const unpricedNights = await unpricedNightsSummariesForQueue({
    tasks,
    store: prisma,
  });

  return NextResponse.json({
    // #3033: whether the "open the booking's payment and rate history" link is
    // offered at all. Sent as an explicit boolean, never inferred by the card
    // from the presence of anything else.
    viewerCanViewBookings,
    /*
      Shaped by `manual-refund-task-queue-payload.ts`, which is also where the
      redaction lives: the stored review context is parsed there and the raw
      column never crosses the wire.
    */
    tasks: tasks.map((task) =>
      toOpenManualRefundTaskPayload(
        task,
        guard.session.user.id,
        unpricedNights.get(task.id) ?? null,
      ),
    ),
    // True only when the notices read itself failed. The surface says so in a
    // line of its own rather than showing an empty card, because "no automatic
    // refunds in the last 30 days" is a claim about money and a failed query is
    // not entitled to make it.
    autoRefundedUnavailable: autoRefundedRead.unavailable,
    autoRefunded: autoRefundedRead.rows.map(
      toAutoRefundedManualRefundTaskPayload,
    ),
  });
}
