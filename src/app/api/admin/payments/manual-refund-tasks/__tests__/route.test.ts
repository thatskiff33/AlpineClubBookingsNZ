import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/admin/payments/manual-refund-tasks — the finance queue's loader.
 *
 * #2750 gave it a second list. `tasks` is unchanged: OPEN hand-back rows an
 * operator has to settle. `autoRefunded` is the record of a refund nobody
 * authorised — a modification payment captured against a booking the club had
 * already deleted, which the #1350 webhook refunded automatically and whose
 * `ManualRefundTask` the webhook then closed itself. Closing it took it off this
 * route's only list, so the money movement had no screen at all; this is the
 * screen, and this suite is what stops the two lists blurring into each other.
 *
 * #3033 lifted the two row mappers into `manual-refund-task-queue-payload.ts`
 * when this route crossed its 250-line budget — a budget an allowance may not
 * carry a file over for the first time, so the split was the only answer. This
 * suite still exercises them through the route, unmocked, because what it is
 * pinning is the RESPONSE: which fields reach the browser and which cannot.
 * Testing the mapper in isolation and mocking it here would leave the wiring —
 * the half that actually decides what a finance screen receives — asserted
 * nowhere.
 *
 * Mock shape follows the house route-test precedent
 * (src/app/api/admin/member-guest-settings/__tests__/route.test.ts): the guard
 * and the delegate are stubbed, and the route's real mapping runs.
 *
 * MUTATION PROOF. Drop the shared filter from the second query and "asks the
 * database for exactly the rows the shared filter defines" fails. Drop the
 * `completedAt` window and "bounds the record to a review window" fails. Return
 * the second list under the first list's key, or map `note` away, and the two
 * mapping tests fail. Refuse the route to finance:view and "a finance viewer may
 * read both lists" fails. Put the notices query back inside the bare
 * `Promise.all` and "answers 200 with the hand-back queue intact when the notices
 * query fails" fails; swallow the OPEN query's failure the same way and "still
 * fails loudly when the hand-back queue itself cannot be read" fails.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  manualRefundTaskFindMany: vi.fn(),
  loggerError: vi.fn(),
  hasAdminAreaAccess: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/admin-permissions", () => ({
  hasAdminAreaAccess: mocks.hasAdminAreaAccess,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    manualRefundTask: { findMany: mocks.manualRefundTaskFindMany },
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn() },
}));

import { GET } from "../route";
import {
  AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX,
  AUTOMATIC_REFUND_NOTICE_WINDOW_DAYS,
  automaticCancelledBookingRefundNote,
  automaticallyRefundedManualRefundTaskFilter,
  cancelledBookingModificationRefundReason,
  deletedBookingModificationRefundReason,
} from "@/lib/deleted-booking-modification-payment";

const CHECK_IN = new Date("2026-08-10T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-12T00:00:00.000Z");
const REFUNDED_AT = new Date("2026-06-28T09:00:00.000Z");

const OPEN_ROW = {
  id: "task-open",
  bookingId: "booking-cash",
  amountCents: 8000,
  raisedAmountCents: 8000,
  kind: "CANCELLED_CASH_BOOKING",
  reviewContext: null,
  reason: "Cancelled after a cash payment",
  createdAt: new Date("2026-06-20T00:00:00.000Z"),
  booking: {
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    memberId: "member-ada",
    deletedAt: null,
    member: { firstName: "Ada", lastName: "Lovelace" },
  },
};

const AUTO_ROW = {
  id: "task-auto",
  bookingId: "booking-deleted",
  amountCents: 2500,
  reason: deletedBookingModificationRefundReason("pi_modification"),
  note: automaticCancelledBookingRefundNote("pi_modification"),
  completedAt: REFUNDED_AT,
  booking: {
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    // #2760: the card groups the two populations, so the route reads the
    // booking's deletion state and answers it as a boolean.
    deletedAt: new Date("2026-06-27T00:00:00.000Z"),
    member: { firstName: "Grace", lastName: "Hopper" },
  },
};

/** #2760's second population: auto-refunded on a booking still on file. */
const AUTO_ROW_CANCELLED_ONLY = {
  ...AUTO_ROW,
  id: "task-auto-cancelled",
  bookingId: "booking-cancelled-live",
  reason: cancelledBookingModificationRefundReason("pi_modification_2"),
  note: automaticCancelledBookingRefundNote("pi_modification_2"),
  booking: { ...AUTO_ROW.booking, deletedAt: null },
};

/** The route's three `findMany` calls, in the order it issues them. */
function calls() {
  return mocks.manualRefundTaskFindMany.mock.calls.map(
    (call) => call[0] as Record<string, unknown>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  // #3033: the default caller here holds bookings:view. The redaction suite
  // below drives it the other way.
  mocks.hasAdminAreaAccess.mockReturnValue(true);
  mocks.manualRefundTaskFindMany
    .mockResolvedValueOnce([OPEN_ROW])
    .mockResolvedValueOnce([AUTO_ROW])
    // #3498: the reopen card's list. Empty by default, which is the ordinary
    // shape - most days nothing has been dismissed.
    .mockResolvedValueOnce([]);
  /*
    #3498: and a FALLBACK for every call past the queue above, so a case that
    pins only the two lists it is about does not hand `readOrDegrade` an
    `undefined` and fail on the list it was not testing. A chain of `Once`s that
    has to be lengthened every time the route reads one more list is a fixture
    that breaks for reasons nothing to do with what it asserts.
  */
  mocks.manualRefundTaskFindMany.mockResolvedValue([]);
});

/**
 * #4344 (wave C1 of #4302): every list but a retired officer edit review. The
 * `kind: null` arm keeps a legacy row written before the column existed - a
 * bare `kind: { not: ... }` is `kind <> ...` in SQL, never true of a NULL.
 */
const NOT_A_RETIRED_REVIEW = {
  OR: [{ kind: null }, { kind: { not: "EDIT_FINANCIAL_REVIEW" } }],
};

describe("GET manual-refund-tasks (#2262, #2750)", () => {
  it("a finance viewer may read both lists — neither is a write", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "view" },
    });
  });

  it("refuses with the guard's own response when the actor may not see finance", async () => {
    mocks.requireAdmin.mockReset().mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });

    const response = await GET();

    expect(response.status).toBe(403);
    expect(mocks.manualRefundTaskFindMany).not.toHaveBeenCalled();
  });

  it("flags a late capture held for a treasurer, by its marker and not by its kind (#3639)", async () => {
    // Both rows are the #2700 kind, which the previous app version reads; only
    // the marker says completing one refunds the card through Stripe.
    mocks.manualRefundTaskFindMany
      .mockReset()
      .mockResolvedValue([])
      .mockResolvedValueOnce([
        { ...OPEN_ROW, id: "task-held", kind: "DELETED_BOOKING_LATE_CAPTURE", lateCaptureApprovalIntentId: "pi_late" },
        { ...OPEN_ROW, id: "task-2700", kind: "DELETED_BOOKING_LATE_CAPTURE", lateCaptureApprovalIntentId: null },
      ]);

    const body = (await (await GET()).json()) as {
      tasks: { id: string; awaitingLateCaptureApproval: boolean }[];
    };

    expect(calls()[0].select).toMatchObject({
      paymentId: true, lateCaptureApprovalIntentId: true });
    expect(body.tasks.map((t) => [t.id, t.awaitingLateCaptureApproval])).toEqual([
      ["task-held", true],
      ["task-2700", false],
    ]);
    // The intent id itself is not the browser's business.
    expect(JSON.stringify(body)).not.toContain("pi_late");
  });

  it("flags a part-payment review by its marker, not its hand-back kind (#3643)", async () => {
    mocks.manualRefundTaskFindMany
      .mockReset()
      .mockResolvedValue([])
      .mockResolvedValueOnce([
        { ...OPEN_ROW, id: "task-review", kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: null, raisedAmountCents: null, partPaymentReviewPaymentId: "payment-secret" },
        { ...OPEN_ROW, id: "task-cash", kind: "CANCELLED_BOOKING_HAND_BACK", partPaymentReviewPaymentId: null },
      ]);

    const body = (await (await GET()).json()) as {
      tasks: { id: string; partPaymentReview: boolean; amountCents: number | null }[];
    };

    expect(calls()[0].select).toMatchObject({ partPaymentReviewPaymentId: true });
    expect(body.tasks.map((t) => [t.id, t.partPaymentReview, t.amountCents])).toEqual([
      ["task-review", true, null],
      ["task-cash", false, OPEN_ROW.amountCents],
    ]);
    expect(JSON.stringify(body)).not.toContain("payment-secret");
  });

  // #3643 (`INV-PAY-108`, ORCHESTRATOR DECISION 3): the inbound sync's note that
  // Xero reported a reviewed invoice paid reaches the card, because it - not the
  // best-effort email - is the record.
  it("carries the sync's Xero-paid note on a part-payment review, and on nothing else (#3643)", async () => {
    mocks.manualRefundTaskFindMany
      .mockReset()
      .mockResolvedValue([])
      .mockResolvedValueOnce([
        {
          ...OPEN_ROW,
          id: "task-review",
          kind: "CANCELLED_BOOKING_HAND_BACK",
          amountCents: null,
          raisedAmountCents: null,
          partPaymentReviewPaymentId: "payment-secret",
          partPaymentReviewXeroPaidAt: new Date("2026-07-01T00:00:00.000Z"),
          partPaymentReviewXeroPaidCents: 20000,
        },
        {
          ...OPEN_ROW,
          id: "task-review-quiet",
          kind: "CANCELLED_BOOKING_HAND_BACK",
          amountCents: null,
          raisedAmountCents: null,
          partPaymentReviewPaymentId: "payment-quiet",
          partPaymentReviewXeroPaidAt: null,
          partPaymentReviewXeroPaidCents: null,
        },
      ]);

    const body = (await (await GET()).json()) as {
      tasks: {
        id: string;
        partPaymentReviewXeroPaid: { reportedAt: string; cashCents: number } | null;
      }[];
    };

    expect(calls()[0].select).toMatchObject({
      partPaymentReviewXeroPaidAt: true,
      partPaymentReviewXeroPaidCents: true,
    });
    expect(body.tasks.map((t) => [t.id, t.partPaymentReviewXeroPaid])).toEqual([
      ["task-review", { reportedAt: "2026-07-01T00:00:00.000Z", cashCents: 20000 }],
      ["task-review-quiet", null],
    ]);
  });

  it("keeps the hand-back queue as it was: OPEN, oldest first", async () => {
    await GET();

    expect(calls()[0]).toMatchObject({
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    expect((calls()[0].where as { status: string }).status).toBe("OPEN");
  });

  it("leaves a retired officer review out IN THE QUERY, keeping rows with no kind (#4344)", async () => {
    /*
      In the `where`, before the `take`: filtering the answer instead would let
      leftover reviews push a hand-back the club still owes past the limit. And
      with the NULL arm, because a legacy hand-back has no kind at all.
    */
    await GET();

    expect(calls()[0].where).toEqual({ status: "OPEN", ...NOT_A_RETIRED_REVIEW });
  });

  it("asks the database for exactly the rows the shared filter defines", async () => {
    // Not a restatement of the conditions: the route must use the exported
    // filter, so a change to what counts as an automatic refund reaches this
    // screen without anybody remembering to edit it here.
    await GET();

    expect(calls()[1].where).toMatchObject(
      automaticallyRefundedManualRefundTaskFilter as Record<string, unknown>,
    );
    expect(
      (calls()[1].where as { note: { startsWith: string } }).note.startsWith,
    ).toBe(AUTOMATIC_CANCELLED_BOOKING_REFUND_NOTE_PREFIX);
  });

  it("bounds the record to a review window, newest first", async () => {
    // Newest first, and it is the opposite of the queue above on purpose: the
    // queue is worked from the top, whereas the most recent automatic refund is
    // the one an operator can still act on if the deletion was the mistake.
    await GET();

    const second = calls()[1];
    expect(second.orderBy).toEqual({ completedAt: "desc" });
    const window = (second.where as { completedAt: { gte: Date } }).completedAt;
    const days = Math.round(
      (Date.now() - window.gte.getTime()) / (24 * 60 * 60 * 1000),
    );
    expect(days).toBe(AUTOMATIC_REFUND_NOTICE_WINDOW_DAYS);
  });

  it("returns the automatic refunds under their own key, never mixed into the queue", async () => {
    // One list says "you owe this member money" and the other says "this money
    // has already gone back". Merging them is how somebody refunds twice.
    const body = (await (await GET()).json()) as {
      tasks: { id: string }[];
      autoRefunded: { id: string }[];
    };

    expect(body.tasks.map((task) => task.id)).toEqual(["task-open"]);
    expect(body.autoRefunded.map((task) => task.id)).toEqual(["task-auto"]);
  });

  it("carries the reason AND the note, because the reason alone still asks for a decision", async () => {
    const body = (await (await GET()).json()) as {
      autoRefunded: {
        bookingId: string;
        amountCents: number;
        reason: string;
        note: string | null;
        refundedAt: string | null;
        memberName: string;
        checkIn: string;
        checkOut: string;
      }[];
    };

    expect(body.autoRefunded[0]).toEqual({
      id: "task-auto",
      bookingId: "booking-deleted",
      amountCents: 2500,
      reason: deletedBookingModificationRefundReason("pi_modification"),
      note: automaticCancelledBookingRefundNote("pi_modification"),
      refundedAt: REFUNDED_AT.toISOString(),
      bookingDeleted: true,
      memberName: "Grace Hopper",
      checkIn: CHECK_IN.toISOString(),
      checkOut: CHECK_OUT.toISOString(),
    });
  });

  it("says which population each row is, and sends no deletion date (#2760)", async () => {
    /*
      The card groups a refund on a DELETED booking (remake it and charge again)
      apart from one on a booking that is merely cancelled (normal operation), so
      the row has to carry which it was. A boolean, not the date: the date is not
      the operator's business on this card and there is no reason to put it on the
      wire.
    */
    mocks.manualRefundTaskFindMany
      .mockReset()
      .mockResolvedValue([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([AUTO_ROW, AUTO_ROW_CANCELLED_ONLY]);

    const body = (await (await GET()).json()) as {
      autoRefunded: Record<string, unknown>[];
    };

    expect(body.autoRefunded.map((row) => row.bookingDeleted)).toEqual([
      true,
      false,
    ]);
    expect(body.autoRefunded[0]).not.toHaveProperty("deletedAt");
    // And the row keeps the sentence that was true when the money went back.
    expect(body.autoRefunded[1].reason).toBe(
      cancelledBookingModificationRefundReason("pi_modification_2"),
    );
  });

  it("asks the database for the deletion state it groups on", async () => {
    // Without it in the select, every row would answer `bookingDeleted: false`
    // and the interesting population would silently merge into the ordinary one.
    await GET();

    expect(calls()[1].select).toMatchObject({
      booking: { select: { deletedAt: true } },
    });
  });

  it("answers a missing refund date as null rather than inventing one", async () => {
    // `completedAt` is nullable in the schema and never null on a row the filter
    // matched, since the close writes both in one update. If that ever stops
    // being true the card must render a row whose date it cannot state, not a
    // date it made up.
    mocks.manualRefundTaskFindMany
      .mockReset()
      .mockResolvedValue([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...AUTO_ROW, completedAt: null }]);

    const body = (await (await GET()).json()) as {
      autoRefunded: { refundedAt: string | null }[];
    };

    expect(body.autoRefunded[0].refundedAt).toBeNull();
  });

  it("returns empty lists rather than failing when there is nothing to show", async () => {
    mocks.manualRefundTaskFindMany
      .mockReset()
      .mockResolvedValue([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const body = (await (await GET()).json()) as {
      tasks: unknown[];
      autoRefunded: unknown[];
    };

    // `autoRefundedUnavailable: false` is part of the answer, not noise: the
    // surface has to be able to tell "no automatic refunds" from "could not
    // look", and only an explicit false lets it.
    expect(body).toEqual({
      tasks: [],
      autoRefunded: [],
      autoRefundedUnavailable: false,
      // #3498: and the same for the reopen card's list, for the same reason -
      // "nothing has been dismissed lately" is a claim about money decisions
      // that a failed read has not earned.
      dismissed: [],
      dismissedUnavailable: false,
      // #3033: whether the booking link is offered at all. Part of the answer
      // for the same reason as the flag above — the card must not have to guess.
      viewerCanViewBookings: true,
    });
  });
});

describe("the rows an officer could put back (#3498, owner decision D2)", () => {
  const DISMISSED_ROW = {
    id: "task-dismissed",
    bookingId: "booking-cash",
    amountCents: null,
    kind: "CANCELLED_BOOKING_HAND_BACK",
    reason: "Cancelled after a cash payment.",
    note: "Nothing owed either way.",
    completedAt: new Date("2026-06-25T02:00:00.000Z"),
    booking: {
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      deletedAt: null,
      member: { firstName: "Ada", lastName: "Lovelace" },
      organisation: null,
    },
  };

  beforeEach(() => {
    mocks.manualRefundTaskFindMany
      .mockReset()
      .mockResolvedValue([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([DISMISSED_ROW]);
  });

  it("asks only for dismissals an OFFICER took, inside the reopen window", async () => {
    /*
      THE FENCE IS IN THE QUERY, and it is the safety half rather than the tidy
      half. `completedByMemberId: { not: null }` excludes the Stripe webhook's
      own dismissals, which record a capture it had ALREADY refunded - offering
      one a "put back on the queue" button would invite a second refund of money
      that has gone back. The window excludes nothing but old rows, and the
      reopen door itself refuses on neither age nor anything this query decides.
    */
    await GET();
    const dismissedQuery = calls()[2];
    expect(dismissedQuery.where).toMatchObject({
      status: "DISMISSED",
      completedByMemberId: { not: null },
      // #4343/#4344: a retired review is never offered back, and a legacy row
      // with no kind still is.
      ...NOT_A_RETIRED_REVIEW,
    });
    expect(dismissedQuery.orderBy).toEqual({ completedAt: "desc" });
  });

  it("sends what the card needs to decide, and nothing it does not", async () => {
    const body = (await (await GET()).json()) as {
      dismissed: Array<Record<string, unknown>>;
      dismissedUnavailable: boolean;
    };
    expect(body.dismissedUnavailable).toBe(false);
    // The WHOLE object: no identifier the card has no use for. This list offers one action, so it
    // carries what is needed to decide on that action and stops.
    expect(body.dismissed).toEqual([
      {
        id: "task-dismissed",
        bookingId: "booking-cash",
        amountCents: null,
        kind: "CANCELLED_BOOKING_HAND_BACK",
        reason: "Cancelled after a cash payment.",
        note: "Nothing owed either way.",
        dismissedAt: "2026-06-25T02:00:00.000Z",
        bookingDeleted: false,
        memberName: "Ada Lovelace",
        checkIn: CHECK_IN.toISOString(),
        checkOut: CHECK_OUT.toISOString(),
      },
    ]);
  });

  it("degrades on its own rather than taking the money queue down with it", async () => {
    // The same asymmetry #2750 drew for the notices beside it: losing a
    // correction surface must never remove the list of money the club owes
    // members by hand, and an empty list is a claim a failed read has not
    // earned - hence the flag.
    mocks.manualRefundTaskFindMany
      .mockReset()
      .mockResolvedValue([])
      .mockResolvedValueOnce([OPEN_ROW])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("statement timeout"));

    const response = await GET();
    const body = (await response.json()) as {
      tasks: { id: string }[];
      dismissed: unknown[];
      dismissedUnavailable: boolean;
    };
    expect(response.status).toBe(200);
    expect(body.tasks.map((task) => task.id)).toEqual(["task-open"]);
    expect(body.dismissed).toEqual([]);
    expect(body.dismissedUnavailable).toBe(true);
    expect(mocks.loggerError).toHaveBeenCalled();
  });
});

describe("a failed notices read must not take the work queue with it (#2750 review)", () => {
  /*
    The second query is the informational one; the first is money the club still
    owes members by hand. Inside one `Promise.all` a single rejection rejects the
    batch, the client blanks BOTH cards on a non-OK answer, and the actionable
    queue would disappear because a card that only informs could not be read.

    Not hypothetical for this query in particular: `note: { startsWith }` is an
    unindexed `LIKE 'prefix%'` over the DISMISSED slice, so it is the one of the
    two that can hit a statement timeout as the table grows, and any future edit
    to the shared filter object can make it a Prisma validation error.
  */
  it("answers 200 with the hand-back queue intact when the notices query fails", async () => {
    mocks.manualRefundTaskFindMany
      .mockReset()
      .mockResolvedValue([])
      .mockResolvedValueOnce([OPEN_ROW])
      .mockRejectedValueOnce(new Error("statement timeout"));

    const response = await GET();
    const body = (await response.json()) as {
      tasks: { id: string }[];
      autoRefunded: unknown[];
      autoRefundedUnavailable: boolean;
    };

    expect(response.status).toBe(200);
    expect(body.tasks.map((task) => task.id)).toEqual(["task-open"]);
    // Empty AND flagged. An empty list on its own is a claim that no money was
    // refunded automatically, which a query that failed has not earned.
    expect(body.autoRefunded).toEqual([]);
    expect(body.autoRefundedUnavailable).toBe(true);
    expect(mocks.loggerError).toHaveBeenCalled();
  });

  it("still fails loudly when the hand-back queue itself cannot be read", async () => {
    // The asymmetry is the point. Degrading the informational list is safe;
    // degrading the queue of refunds an operator must pay would answer "nothing
    // to pay back" when the truth is unknown, so that one propagates.
    mocks.manualRefundTaskFindMany
      .mockReset()
      .mockResolvedValue([])
      .mockRejectedValueOnce(new Error("statement timeout"))
      .mockResolvedValueOnce([AUTO_ROW]);

    await expect(GET()).rejects.toThrow("statement timeout");
  });
});

/**
 * #3033 — what the card needs, and who may follow its booking link.
 *
 * MUTATION PROOF. Hardcode `viewerCanViewBookings: true` and "withholds the
 * booking link from a caller who may not open one" fails. Drop `kind`,
 * `raisedAmountCents` or `reviewContext` from the select and "asks the database
 * for what the card needs" fails. Send `reviewContext` raw and "never sends the
 * stored context raw" fails.
 */
describe("what the card is sent (#3033)", () => {
  it("asks the database for what the card needs to describe a row", async () => {
    // Without `kind` the card cannot tell one kind of row from another and
    // prints the cash sentence over all of them. `reviewContext` holds a group
    // hand-back's or a re-confirmed bank refund's own facts.
    await GET();

    expect(calls()[0].select).toMatchObject({
      kind: true,
      raisedAmountCents: true,
      reviewContext: true,
    });
  });

  it("never sends the stored context raw, nor any review evidence (#4344)", async () => {
    mocks.manualRefundTaskFindMany
      .mockReset()
      .mockResolvedValue([])
      .mockResolvedValueOnce([
        { ...OPEN_ROW, reviewContext: { guestMemberId: "member-guest-9" } },
      ]);

    const body = (await (await GET()).json()) as { tasks: Record<string, unknown>[] };

    expect(JSON.stringify(body)).not.toContain("member-guest-9");
    expect(body.tasks[0]).not.toHaveProperty("reviewContext");
    expect(body.tasks[0]).not.toHaveProperty("reviewEvidence");
    expect(body.tasks[0]).not.toHaveProperty("unpricedNights");
  });

  it("withholds the booking link from a caller who may not open one", async () => {
    /*
      The card is gated on finance:view, which a Finance Viewer holds with no
      bookings access at all. Owner decision D3 asks for a link to the booking's
      payment and rate history, so it has to land somewhere when it is offered;
      for everybody else the identifier is printed instead. Read off the
      DB-verified matrix requireAdmin() just resolved, which is the #2823
      stuck-state shape.
    */
    mocks.hasAdminAreaAccess.mockReturnValue(false);

    const body = (await (await GET()).json()) as {
      viewerCanViewBookings: boolean;
    };

    expect(mocks.hasAdminAreaAccess).toHaveBeenCalledWith(
      { id: "admin-1" },
      { area: "bookings", level: "view" },
    );
    expect(body.viewerCanViewBookings).toBe(false);
  });

  it("offers the booking link to a caller who may open one", async () => {
    mocks.hasAdminAreaAccess.mockReturnValue(true);

    const body = (await (await GET()).json()) as {
      viewerCanViewBookings: boolean;
    };

    expect(body.viewerCanViewBookings).toBe(true);
  });
});

/**
 * #3033 — the OTHER way somebody reaches `/bookings/{id}`.
 *
 * `viewerCanViewBookings` answers "may this admin open anybody's booking". The
 * booking's own member may open their own without it: the page's `isBookingOwner`
 * compares `booking.memberId` against `session.user.id`, which IS the member id.
 * So a finance-only admin whose own booking sat in this queue was handed an
 * identifier for a page they can open.
 *
 * MUTATION PROOF. Drop the ownership comparison and "an admin who owns the
 * booking may open it without bookings access" fails. Drop the deleted-booking
 * exclusion and "does not offer a link into a booking that has been deleted"
 * fails. Compare against anything but the session's own id and "does not offer
 * somebody else's booking to a finance-only admin" fails.
 */
describe("the booking link an owner holds regardless of admin access (#3033)", () => {
  async function bodyFor(row: Record<string, unknown>, canViewBookings: boolean) {
    mocks.hasAdminAreaAccess.mockReturnValue(canViewBookings);
    mocks.manualRefundTaskFindMany
      .mockReset()
      .mockResolvedValue([])
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([]);
    const response = await GET();
    return (await response.json()) as {
      viewerCanViewBookings: boolean;
      tasks: { viewerOwnsBooking: boolean }[];
    };
  }

  const owned = {
    ...OPEN_ROW,
    booking: { ...OPEN_ROW.booking, memberId: "admin-1" },
  };

  it("an admin who owns the booking may open it without bookings access", async () => {
    const body = await bodyFor(owned, false);

    expect(body.viewerCanViewBookings).toBe(false);
    expect(body.tasks[0]?.viewerOwnsBooking).toBe(true);
  });

  it("does not offer somebody else's booking to a finance-only admin", async () => {
    // The control: same shape, a different member. Nothing about the row itself
    // grants the link.
    const body = await bodyFor(OPEN_ROW, false);

    expect(body.tasks[0]?.viewerOwnsBooking).toBe(false);
  });

  it("does not offer a link into a booking that has been deleted", async () => {
    // That page 404s for a non-admin even when they own it, and a link into a
    // 404 is the dead end the printed identifier exists to avoid.
    const body = await bodyFor(
      {
        ...owned,
        booking: { ...owned.booking, deletedAt: new Date("2026-06-27T00:00:00.000Z") },
      },
      false,
    );

    expect(body.tasks[0]?.viewerOwnsBooking).toBe(false);
  });

  it("reads the owner and the deletion state for the hand-back list only", async () => {
    // The automatic-refund list offers no link at all, so it has no use for a
    // membership-roll identifier and does not ask for one.
    await bodyFor(OPEN_ROW, true);
    const [handBack, autoRefunded] = calls() as [
      { select: { booking: { select: Record<string, unknown> } } },
      { select: { booking: { select: Record<string, unknown> } } },
    ];

    expect(handBack.select.booking.select).toMatchObject({
      memberId: true,
      deletedAt: true,
    });
    expect(autoRefunded.select.booking.select).not.toHaveProperty("memberId");
  });
});
