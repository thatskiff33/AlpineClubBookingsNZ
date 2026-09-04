import { describe, expect, it } from "vitest";
import { buildBookingHistoryItems } from "@/lib/booking-history";

describe("buildBookingHistoryItems", () => {
  it("builds a unified history sorted newest-first", () => {
    const items = buildBookingHistoryItems({
      audience: "member",
      createdAt: new Date("2026-04-01T09:00:00Z"),
      payment: {
        status: "PARTIALLY_REFUNDED",
        amountCents: 12000,
        refundedAmountCents: 3000,
        additionalAmountCents: 2500,
        additionalPaymentStatus: "SUCCEEDED",
        createdAt: new Date("2026-04-01T09:00:00Z"),
        updatedAt: new Date("2026-04-04T13:00:00Z"),
      },
      modifications: [
        {
          id: "mod-1",
          modificationType: "DATE_CHANGE",
          previousData: {
            checkIn: "2026-07-01",
            checkOut: "2026-07-03",
          },
          newData: {
            checkIn: "2026-07-02",
            checkOut: "2026-07-04",
          },
          priceDiffCents: 2500,
          changeFeeCents: 1000,
          createdAt: new Date("2026-04-03T12:00:00Z"),
        },
      ],
      refundRequests: [
        {
          id: "refund-1",
          status: "APPROVED",
          reason: "Travel disruption.",
          requestedAmountCents: 3000,
          approvedAmountCents: 3000,
          adminNotes: "Approved after committee review.",
          createdAt: new Date("2026-04-05T10:00:00Z"),
          reviewedAt: new Date("2026-04-06T11:00:00Z"),
        },
      ],
      auditLogs: [
        {
          id: "audit-payment",
          action: "booking.payment.confirmed",
          details: JSON.stringify({
            paymentIntentId: "pi_123",
            amountCents: 12000,
          }),
          createdAt: new Date("2026-04-02T10:00:00Z"),
        },
        {
          id: "audit-cancel",
          action: "booking.cancel",
          details: "Refund 50% = 3000 cents",
          createdAt: new Date("2026-04-07T12:00:00Z"),
        },
      ],
    });

    expect(items.map((item) => item.title)).toEqual([
      "Booking cancelled",
      "Refund appeal approved",
      "Refund appeal submitted",
      "Additional payment recorded",
      "Dates Changed",
      "Payment successful",
      "Booking created",
    ]);

    expect(items[0].category).toBe("Booking");
    expect(items[1].amountDisplay).toBe("$30.00");
    expect(items[4].amountDisplay).toBe("+$25.00");
    expect(items[4].detail).toContain("Change fee applied: $10.00.");
  });

  it("falls back to the payment updated timestamp when no success audit exists", () => {
    const items = buildBookingHistoryItems({
      audience: "member",
      createdAt: new Date("2026-04-01T09:00:00Z"),
      payment: {
        status: "SUCCEEDED",
        amountCents: 9000,
        refundedAmountCents: 0,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
        createdAt: new Date("2026-04-01T09:00:00Z"),
        updatedAt: new Date("2026-04-08T14:00:00Z"),
      },
      modifications: [],
      refundRequests: [],
      auditLogs: [],
    });

    expect(items[0].title).toBe("Payment recorded");
    expect(items[0].occurredAt.toISOString()).toBe("2026-04-08T14:00:00.000Z");
  });

  /*
    #2350: the timeline had fallbacks for a SUCCEEDED and a FAILED additional
    payment but none for one still awaiting the member — the state an
    outstanding delta spends nearly all of its life in. The moment the price
    went up therefore left no mark on the timeline at all.
  */
  describe("an additional payment still awaiting the member (#2350)", () => {
    function build(
      additionalPaymentStatus: string | null,
      additionalAmountCents = 21_000,
      latestAdditionalTransactionCreatedAt: Date | null = new Date(
        "2026-04-05T11:00:00Z",
      ),
    ) {
      return buildBookingHistoryItems({
        audience: "member",
        createdAt: new Date("2026-04-01T09:00:00Z"),
        payment: {
          status: "SUCCEEDED",
          amountCents: 9000,
          refundedAmountCents: 0,
          additionalAmountCents,
          additionalPaymentStatus,
          latestAdditionalTransactionCreatedAt,
          createdAt: new Date("2026-04-01T09:00:00Z"),
          // Deliberately later than everything else: the reminder cron writes
          // its stamps to this row, so `updatedAt` moves every time the member
          // is chased.
          updatedAt: new Date("2026-04-08T14:00:00Z"),
        },
        modifications: [],
        refundRequests: [],
        auditLogs: [],
      });
    }

    /*
      Dated from the obligation, never from the payment row's last touch. The
      #2350 reminder cron stamps this very row each time it chases the member,
      so dating the entry from `updatedAt` marched it up the timeline on every
      nudge, claiming the price had just changed when nothing had.
    */
    it("records the request with its amount and the moment it was raised", () => {
      const item = build("PENDING").find(
        (entry) => entry.id === "payment-additional-pending",
      );

      expect(item).toMatchObject({
        category: "Payment",
        title: "Additional payment requested",
        amountDisplay: "$210.00",
        tone: "warning",
      });
      expect(item?.occurredAt.toISOString()).toBe("2026-04-05T11:00:00.000Z");
      expect(item?.detail).toContain("has not been paid yet");
    });

    it("falls back to the payment's own creation, not its last touch", () => {
      const item = build("PENDING", 21_000, null).find(
        (entry) => entry.id === "payment-additional-pending",
      );

      expect(item?.occurredAt.toISOString()).toBe("2026-04-01T09:00:00.000Z");
    });

    it("does not claim a request when the extra was collected or failed", () => {
      for (const status of ["SUCCEEDED", "FAILED"]) {
        expect(
          build(status).find(
            (entry) => entry.id === "payment-additional-pending",
          ),
        ).toBeUndefined();
      }
    });

    it("stays silent when there is no additional payment at all", () => {
      expect(
        build("PENDING", 0).find(
          (entry) => entry.id === "payment-additional-pending",
        ),
      ).toBeUndefined();
    });

    /*
      A legacy row written before `additionalPaymentStatus` was populated carries
      a null status, and the owed predicate — every admin queue, the finance
      panel, the reports figure and the chase cron — counts it as owing. Matching
      the literal string "PENDING" left exactly those bookings with no timeline
      entry for the moment their price went up, which is the gap this entry
      exists to close.
    */
    it("records a legacy null-status request the owed predicate counts", () => {
      const item = build(null).find(
        (entry) => entry.id === "payment-additional-pending",
      );

      expect(item).toMatchObject({
        title: "Additional payment requested",
        amountDisplay: "$210.00",
        tone: "warning",
      });
    });
  });

  it("renders a #1992 duplicate-capture auto-refund with honest copy when supplied (admin view, #2008)", () => {
    const items = buildBookingHistoryItems({
      audience: "member",
      createdAt: new Date("2026-04-01T09:00:00Z"),
      payment: null,
      modifications: [],
      refundRequests: [],
      auditLogs: [],
      duplicateCaptureRefunds: [
        {
          id: "event-dup-1",
          occurredAt: new Date("2026-04-05T12:00:00Z"),
          amountCents: 5000,
          duplicatePaymentIntentId: "pi_link_dup",
        },
      ],
    });

    const dup = items.find(
      (item) => item.title === "Duplicate capture auto-refunded"
    );
    expect(dup).toBeDefined();
    expect(dup?.id).toBe("duplicate-capture-refund-event-dup-1");
    expect(dup?.category).toBe("Payment");
    expect(dup?.tone).toBe("warning");
    expect(dup?.amountDisplay).toBe("$50.00");
    expect(dup?.detail).toContain("settlement is unaffected");
    expect(dup?.detail).toContain("pi_link_dup");
  });

  it("omits duplicate-capture entries entirely when none are supplied (member view sees nothing new, #2008)", () => {
    const items = buildBookingHistoryItems({
      audience: "member",
      createdAt: new Date("2026-04-01T09:00:00Z"),
      payment: null,
      modifications: [],
      refundRequests: [],
      auditLogs: [],
    });

    expect(
      items.some((item) => item.title === "Duplicate capture auto-refunded")
    ).toBe(false);
    expect(items.map((item) => item.title)).toEqual(["Booking created"]);
  });
});

/**
 * #2265 (#2319) — the member's answer to "what happened to my credit?".
 *
 * A settlement that takes the full price cannot honour a stored credit election,
 * so it clears the column. Cleared silently, a member who had chosen to spend
 * $45 and then paid in full could not tell which of two very different things
 * had happened: their balance was debited, or it was not. It was not — a clear
 * never moves money — and this note is where they read that.
 */
describe("buildBookingHistoryItems — unapplied credit election (#2265)", () => {
  function build(details: string | null) {
    return buildBookingHistoryItems({
      audience: "member",
      createdAt: new Date("2026-04-01T09:00:00Z"),
      payment: null,
      modifications: [],
      refundRequests: [],
      auditLogs: [
        {
          id: "audit-election",
          action: "booking.credit_election.unapplied",
          details,
          createdAt: new Date("2026-04-02T10:00:00Z"),
        },
      ],
    });
  }

  it("names the amount that went unapplied and quotes the member's LIVE balance, never the elected figure", () => {
    // #2262 delta MED-2: elected $450 long ago, $50 left today. The old copy
    // said the elected figure "is still available", which overstated the
    // balance ninefold and invited a refund the account could not cover.
    const item = build(
      JSON.stringify({
        source: "xero-inbound-invoice",
        creditElectionCents: 45000,
        paidAmountCents: 12000,
        availableCreditCents: 5000,
        refundableCents: 5000,
      })
    ).find((entry) => entry.id === "audit-audit-election");

    expect(item).toMatchObject({
      category: "Payment",
      title: "Saved account credit was not applied",
      // The amount of the EVENT: how much credit went unapplied.
      amountDisplay: "$450.00",
      tone: "warning",
    });
    // The elected figure appears only as a past choice...
    expect(item?.detail).toContain("You had chosen to put $450.00");
    // ...and the only figure described as available is the live balance.
    expect(item?.detail).toContain("$50.00 of account credit available");
    expect(item?.detail).not.toContain("$450.00 of account credit available");
    // The load-bearing sentence: nothing was spent.
    expect(item?.detail).toContain("balance was not reduced");
    expect(item?.detail).not.toContain("undefined");
  });

  it("a balance of zero is stated plainly rather than dressed up as availability", () => {
    const item = build(
      JSON.stringify({
        source: "manual-mark-paid",
        creditElectionCents: 45000,
        paidAmountCents: 12000,
        availableCreditCents: 0,
        refundableCents: 0,
      })
    ).find((entry) => entry.id === "audit-audit-election");

    expect(item?.detail).toContain("$0.00 of account credit available");
    expect(item?.detail).toContain("balance was not reduced");
  });

  it("omits the availability figure entirely on a legacy row that carries no balance", () => {
    // Rows written before the balance was recorded must not fall back to the
    // elected figure — they say only what is certainly true.
    const item = build(
      JSON.stringify({
        source: "xero-inbound-invoice",
        creditElectionCents: 45000,
        paidAmountCents: 12000,
      })
    ).find((entry) => entry.id === "audit-audit-election");

    expect(item?.detail).toContain("You had chosen to put $450.00");
    expect(item?.detail).toContain("balance was not reduced");
    expect(item?.detail).not.toContain("available");
  });

  it("still renders an honest note when the amount cannot be read", () => {
    // A malformed or legacy details payload must not produce "$NaN" or a missing
    // row — the member is told the credit went unused either way.
    const item = build("not json at all").find(
      (entry) => entry.id === "audit-audit-election"
    );

    expect(item).toMatchObject({
      title: "Saved account credit was not applied",
      amountDisplay: null,
      tone: "warning",
    });
    expect(item?.detail).toContain("balance was not reduced");
  });
});

/**
 * #2397 — an admin recorded a cash / off-Xero payment on a booking that still
 * carried an uncollected price increase, and confirmed the money covered that
 * increase too. The extra moved, so the timeline has to say so.
 */
describe("buildBookingHistoryItems — a manually settled extra (#2397)", () => {
  function build(auditLogs: Parameters<typeof buildBookingHistoryItems>[0]["auditLogs"]) {
    return buildBookingHistoryItems({
      audience: "member",
      createdAt: new Date("2026-07-01T09:00:00Z"),
      payment: {
        status: "SUCCEEDED",
        amountCents: 12100,
        refundedAmountCents: 0,
        additionalAmountCents: 2100,
        additionalPaymentStatus: "SUCCEEDED",
        createdAt: new Date("2026-07-01T09:00:00Z"),
        updatedAt: new Date("2026-07-05T09:00:00Z"),
      },
      modifications: [],
      refundRequests: [],
      auditLogs,
    });
  }

  it("renders the manual settlement of the extra, naming the amount", () => {
    const items = build([
      {
        id: "audit-additional",
        action: "booking-payment.manual-payment.additional-settled",
        details: JSON.stringify({ additionalAmountCents: 2100 }),
        createdAt: new Date("2026-07-05T09:00:00Z"),
      },
    ]);

    const item = items.find((entry) => entry.id === "audit-audit-additional");
    expect(item).toMatchObject({
      title: "Additional payment recorded manually",
      category: "Payment",
      amountDisplay: "$21.00",
      tone: "success",
    });
    expect(item?.detail).toContain("also covered the extra owing");
  });

  it("replaces the generic fallback rather than doubling it up", () => {
    // Without the flag the payment-row fallback would add a second, vaguer
    // "Additional payment recorded" entry for the same money.
    const titles = build([
      {
        id: "audit-additional",
        action: "booking-payment.manual-payment.additional-settled",
        details: JSON.stringify({ additionalAmountCents: 2100 }),
        createdAt: new Date("2026-07-05T09:00:00Z"),
      },
    ]).map((entry) => entry.title);

    expect(titles.filter((title) => title.startsWith("Additional payment"))).toEqual([
      "Additional payment recorded manually",
    ]);
  });
});

/**
 * #3033 (epic #2797) — the timeline's own money figure, beside a banner saying
 * no figure is known.
 *
 * `priceDiffCents` is real: it is how far the booking's own total moved, and the
 * structural edit did move it. What is not established is the refund or credit
 * that follows from it. The row printed that number in the SUCCESS tone, which
 * is the same green a completed refund gets — so a member reading "-$120.00"
 * under "the club is working the amount out" read it as money returned.
 *
 * MUTATION PROOF. Restore the unconditional success/warning tone and "does not
 * colour an unresolved adjustment as money returned" fails. Drop the qualifying
 * sentence and "says on the row that the adjustment is outstanding" fails. Widen
 * the qualifier from the latest priced modification to every modification, or
 * pick the head of the caller's array instead of the latest row by `createdAt`,
 * and "leaves an older, settled change alone" fails — the fixture is ordered so
 * those two answers differ. Drop the priced-only filter and "passes over a
 * change that moved no money" fails, for the same reason. Hide or rewrite the
 * figure and "keeps the real figure rather than hiding or correcting it" fails.
 */
describe("a modification whose adjustment is still with the club (#3033)", () => {
  function modification(
    id: string,
    priceDiffCents: number,
    createdAt: string,
  ) {
    return {
      id,
      modificationType: "GUEST_REMOVE",
      previousData: { guestCount: 3 },
      newData: { guestCount: 2 },
      priceDiffCents,
      changeFeeCents: 0,
      createdAt: new Date(createdAt),
    };
  }

  function build(financialReviewPending: boolean) {
    return buildBookingHistoryItems({
      audience: "member",
      createdAt: new Date("2026-04-01T09:00:00Z"),
      payment: null,
      modifications: [
        // Deliberately oldest-FIRST, so array order and `createdAt` disagree: a
        // builder that took the head of the list instead of the latest row
        // would qualify the settled change from two months earlier.
        modification("mod-old", -4500, "2026-04-02T10:00:00Z"),
        modification("mod-new", -12000, "2026-06-01T10:00:00Z"),
      ],
      refundRequests: [],
      auditLogs: [],
      financialReviewPending,
    });
  }

  const rowFor = (id: string, pending: boolean) =>
    build(pending).find((item) => item.id === `modification-${id}`);

  it("does not colour an unresolved adjustment as money returned", () => {
    expect(rowFor("mod-new", false)?.tone).toBe("success");
    expect(rowFor("mod-new", true)?.tone).toBe("default");
  });

  it("says on the row that the adjustment is outstanding", () => {
    expect(rowFor("mod-new", true)?.detail).toMatch(
      /still being worked out by the club/i,
    );
    expect(rowFor("mod-new", false)?.detail).not.toMatch(
      /still being worked out/i,
    );
  });

  it("keeps the real figure rather than hiding or correcting it", () => {
    // Hiding it would leave the member with no number at all; correcting it is
    // the estimation this epic exists to forbid.
    expect(rowFor("mod-new", true)?.amountDisplay).toBe("-$120.00");
  });

  it("leaves an older, settled change alone", () => {
    // A review is raised BY a priced edit and no later priced edit can exist
    // above it, so only the most recent priced modification is a candidate.
    // Saying an edit from months ago is unresolved would be false.
    expect(rowFor("mod-old", true)?.tone).toBe("success");
    expect(rowFor("mod-old", true)?.detail).not.toMatch(
      /still being worked out/i,
    );
  });

  it("qualifies nothing when the caller has not asked", () => {
    // Defaulted false: a caller that has not checked makes no claim about this
    // member's money.
    const items = buildBookingHistoryItems({
      audience: "member",
      createdAt: new Date("2026-04-01T09:00:00Z"),
      payment: null,
      modifications: [modification("mod-new", -12000, "2026-06-01T10:00:00Z")],
      refundRequests: [],
      auditLogs: [],
    });

    expect(items.find((item) => item.id === "modification-mod-new")?.tone).toBe(
      "success",
    );
  });

  it("passes over a change that moved no money, which carries no figure", () => {
    // A credit-election edit has no amount on its row, so there is nothing on it
    // to qualify — and qualifying it would point at the wrong change.
    const items = buildBookingHistoryItems({
      audience: "member",
      createdAt: new Date("2026-04-01T09:00:00Z"),
      payment: null,
      modifications: [
        // The unpriced edit is the LATEST of the two, so a builder that took the
        // most recent modification without checking it moved money would point
        // the qualifier at a row that carries no figure to qualify.
        modification("mod-priced", -12000, "2026-06-01T10:00:00Z"),
        {
          ...modification("mod-free", 0, "2026-06-02T10:00:00Z"),
          modificationType: "CREDIT_ELECTION",
        },
      ],
      refundRequests: [],
      auditLogs: [],
      financialReviewPending: true,
    });

    const free = items.find((item) => item.id === "modification-mod-free");
    const priced = items.find((item) => item.id === "modification-mod-priced");

    expect(free?.detail).not.toMatch(/still being worked out/i);
    expect(priced?.detail).toMatch(/still being worked out/i);
  });

  /**
   * #3232 D3: WHY THIS BOOKING IS FLAGGED, on the booking, in words.
   *
   * The guide promised an officer that "the booking's history says, in words,
   * that the member was asked about the other booking and chose to move only this
   * one". Three things stopped that being true: the incident writer set no
   * `targetId`, so the page's `targetId = booking.id` query never saw the row;
   * this switch had no case for it; and the page's action allowlist did not name
   * it. The officer clicked through from the queue, saw the generic cause and
   * nothing else, and did exactly what the guide said they would not — guess.
   *
   * The page feeds these two actions only to admin viewers, because `details` can
   * be an officer's PRIVATE override reason.
   */
  const incidentRows = [
    {
      id: "audit-incident",
      action: "booking.hostingCoverage.incidentOpened",
      details:
        "The member was asked whether to move this booking to the same new " +
        "nights as the booking they were editing, and chose to move only " +
        "that one.",
      createdAt: new Date("2026-04-09T12:00:00Z"),
    },
    {
      id: "audit-incident-again",
      action: "booking.hostingCoverage.incidentUpdated",
      details: "A later change moved which nights are uncovered.",
      createdAt: new Date("2026-04-10T12:00:00Z"),
    },
  ];

  it("renders a hosting-coverage incident's own recorded explanation (#3232)", () => {
    const items = buildBookingHistoryItems({
      audience: "staff",
      createdAt: new Date("2026-04-01T09:00:00Z"),
      payment: null,
      modifications: [],
      refundRequests: [],
      auditLogs: incidentRows,
    });

    const opened = items.find((item) => item.id === "audit-audit-incident");
    expect(opened?.title).toBe("Adult member cover flagged");
    expect(opened?.detail).toMatch(/chose to move only that one/);
    expect(opened?.tone).toBe("warning");

    const updated = items.find(
      (item) => item.id === "audit-audit-incident-again",
    );
    expect(updated?.title).toBe("Adult member cover flag updated");
    expect(updated?.detail).toMatch(/which nights are uncovered/);
  });

  /**
   * AND A MEMBER READING THEIR OWN BOOKING GETS NEITHER (#3232 D3, fix round).
   *
   * `details` on these two rows is whoever's explanation applies — the member's
   * own recorded decision, or an OFFICER'S PRIVATE OVERRIDE REASON. The owner's
   * decision of 4 September 2026 is that it is readable by anyone with
   * booking-edit access and by nobody else.
   *
   * Before the audience argument existed, the only thing standing between a
   * member and that text was a conditional array a hundred and seventy lines away
   * in the page — and the guard on it was satisfiable by a comment, which was
   * measured. This is the assertion no source scan can be fooled about: the rows
   * are handed in, and the member's timeline does not contain them.
   */
  it("withholds the incident rows from the booking's own member (#3232 D3)", () => {
    const items = buildBookingHistoryItems({
      audience: "member",
      createdAt: new Date("2026-04-01T09:00:00Z"),
      payment: null,
      modifications: [],
      refundRequests: [],
      auditLogs: incidentRows,
    });

    // NOT "the list is empty" — the booking-created row is always there, so an
    // empty list would mean the builder had failed rather than withheld anything.
    expect(items.some((item) => item.id === "booking-created")).toBe(true);
    expect(items.map((item) => item.id)).not.toContain("audit-audit-incident");
    expect(items.map((item) => item.id)).not.toContain(
      "audit-audit-incident-again",
    );
    // And no row anywhere carries the text, whatever it might have been titled.
    for (const item of items) {
      expect(item.detail ?? "").not.toMatch(/chose to move only that one/);
    }
  });
});
