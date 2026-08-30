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

/**
 * #3033: an unpriced financial review carrying owner decision D3's evidence.
 *
 * The two identifiers at the end are the point of the redaction suite below:
 * they are stored on the row and must not reach the browser.
 */
const REVIEW_CONTEXT = {
  version: 1,
  occurrence: {
    bookingId: "booking-edit",
    bookingGuestId: "guest-strand-1",
    cause: "PARTIAL_STORED_NIGHT_PRICES",
    surrenderedNightDates: ["2026-08-11"],
    addedNightDates: [],
    storedEvidence: {
      guestTotalCents: 12000,
      nightPrices: [
        { date: "2026-08-10", priceCents: 6000 },
        { date: "2026-08-11", priceCents: null },
      ],
    },
  },
  guestMemberId: "member-guest-9",
  bookingCheckIn: "2026-08-10",
  bookingCheckOut: "2026-08-12",
};

const REVIEW_ROW = {
  id: "task-review",
  bookingId: "booking-edit",
  amountCents: null,
  raisedAmountCents: null,
  kind: "EDIT_FINANCIAL_REVIEW",
  reviewContext: REVIEW_CONTEXT,
  reason: "A change to this booking could not be priced from stored history.",
  createdAt: new Date("2026-06-21T00:00:00.000Z"),
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

/** The route's two `findMany` calls, in the order it issues them. */
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
    .mockResolvedValueOnce([AUTO_ROW]);
});

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

  it("keeps the hand-back queue exactly as it was: OPEN, oldest first", async () => {
    await GET();

    expect(calls()[0]).toMatchObject({
      where: { status: "OPEN" },
      orderBy: { createdAt: "asc" },
    });
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
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...AUTO_ROW, completedAt: null }]);

    const body = (await (await GET()).json()) as {
      autoRefunded: { refundedAt: string | null }[];
    };

    expect(body.autoRefunded[0].refundedAt).toBeNull();
  });

  it("returns two empty lists rather than failing when there is nothing to show", async () => {
    mocks.manualRefundTaskFindMany
      .mockReset()
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
      // #3033: whether the booking link is offered at all. Part of the answer
      // for the same reason as the flag above — the card must not have to guess.
      viewerCanViewBookings: true,
    });
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
      .mockRejectedValueOnce(new Error("statement timeout"))
      .mockResolvedValueOnce([AUTO_ROW]);

    await expect(GET()).rejects.toThrow("statement timeout");
  });
});

/**
 * #3033 — the permission and redaction half of the acceptance criteria.
 *
 * MUTATION PROOF. Add `guestMemberId` or `bookingGuestId` to
 * `EditFinancialReviewEvidence` and pass them through
 * `toEditFinancialReviewEvidence`, and "sends no membership-roll identifier"
 * fails. Send `task.reviewContext` raw instead of the projection and it fails
 * too. Hardcode `viewerCanViewBookings: true` and "withholds the booking link
 * from a caller who may not open one" fails. Drop `kind`, `raisedAmountCents`
 * or `reviewContext` from the select and "asks the database for what the card
 * needs" fails. Treat an unreadable context as "no evidence" and "distinguishes
 * evidence it cannot read from evidence that was never taken" fails.
 */
describe("financial-review evidence: what may cross the wire (#3033)", () => {
  beforeEach(() => {
    mocks.manualRefundTaskFindMany
      .mockReset()
      .mockResolvedValueOnce([REVIEW_ROW])
      .mockResolvedValueOnce([]);
  });

  it("asks the database for what the card needs to describe a review row", async () => {
    // Without `kind` the card cannot tell a review from a hand-back and prints
    // the cash sentence over both. Without `reviewContext` owner decision D3's
    // evidence never leaves the database.
    await GET();

    expect(calls()[0].select).toMatchObject({
      kind: true,
      raisedAmountCents: true,
      reviewContext: true,
    });
  });

  it("sends no membership-roll identifier, whatever the caller may see", async () => {
    /*
      `guestMemberId` and `bookingGuestId` are stored ON the row and are the two
      fields with no rendering use: the card already names the booking's own
      member, and a raw cuid tells an operator nothing. They are dropped by
      being absent from the shape the projection builds, not by being deleted
      here — so this asserts the property that matters, which is that no payload
      can carry them.
    */
    mocks.hasAdminAreaAccess.mockReturnValue(true);

    const body = (await (await GET()).json()) as { tasks: unknown[] };
    const serialised = JSON.stringify(body);

    expect(serialised).not.toContain("guestMemberId");
    expect(serialised).not.toContain("member-guest-9");
    expect(serialised).not.toContain("bookingGuestId");
    expect(serialised).not.toContain("guest-strand-1");
  });

  it("sends the evidence an admin prices from, and nothing behind it", async () => {
    const body = (await (await GET()).json()) as {
      tasks: {
        kind: string;
        amountCents: number | null;
        raisedAmountCents: number | null;
        reviewEvidence: Record<string, unknown> | null;
        reviewEvidenceUnreadable: boolean;
      }[];
    };

    expect(body.tasks[0].kind).toBe("EDIT_FINANCIAL_REVIEW");
    // No magic zero anywhere: an unpriced review crosses the wire as null.
    expect(body.tasks[0].amountCents).toBeNull();
    expect(body.tasks[0].raisedAmountCents).toBeNull();
    expect(body.tasks[0].reviewEvidenceUnreadable).toBe(false);
    expect(body.tasks[0].reviewEvidence).toEqual({
      cause: "PARTIAL_STORED_NIGHT_PRICES",
      surrenderedNightDates: ["2026-08-11"],
      addedNightDates: [],
      storedEvidence: {
        guestTotalCents: 12000,
        nightPrices: [
          { date: "2026-08-10", priceCents: 6000 },
          // Null, not 0. An absent stored price and a comped night are
          // different evidence and the card prints them differently.
          { date: "2026-08-11", priceCents: null },
        ],
      },
      bookingCheckIn: "2026-08-10",
      bookingCheckOut: "2026-08-12",
    });
  });

  it("distinguishes evidence it cannot read from evidence that was never taken", async () => {
    /*
      A row written by a shape this release does not know parses to null. The
      task, its amount and its booking must still reach the screen — but the
      card has to be able to SAY that the one record of what the edit destroyed
      is unreadable, rather than render an absence an admin would read as "no
      evidence was captured".
    */
    mocks.manualRefundTaskFindMany
      .mockReset()
      .mockResolvedValueOnce([
        { ...REVIEW_ROW, reviewContext: { version: 99, nonsense: true } },
        { ...REVIEW_ROW, id: "task-review-none", reviewContext: null },
      ])
      .mockResolvedValueOnce([]);

    const body = (await (await GET()).json()) as {
      tasks: {
        id: string;
        reviewEvidence: unknown;
        reviewEvidenceUnreadable: boolean;
      }[];
    };

    expect(body.tasks[0]).toMatchObject({
      id: "task-review",
      reviewEvidence: null,
      reviewEvidenceUnreadable: true,
    });
    expect(body.tasks[1]).toMatchObject({
      id: "task-review-none",
      reviewEvidence: null,
      reviewEvidenceUnreadable: false,
    });
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
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([]);
    const response = await GET();
    return (await response.json()) as {
      viewerCanViewBookings: boolean;
      tasks: { viewerOwnsBooking: boolean }[];
    };
  }

  const owned = {
    ...REVIEW_ROW,
    booking: { ...REVIEW_ROW.booking, memberId: "admin-1" },
  };

  it("an admin who owns the booking may open it without bookings access", async () => {
    const body = await bodyFor(owned, false);

    expect(body.viewerCanViewBookings).toBe(false);
    expect(body.tasks[0]?.viewerOwnsBooking).toBe(true);
  });

  it("does not offer somebody else's booking to a finance-only admin", async () => {
    // The control: same shape, a different member. Nothing about the row itself
    // grants the link.
    const body = await bodyFor(REVIEW_ROW, false);

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
    await bodyFor(REVIEW_ROW, true);
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
