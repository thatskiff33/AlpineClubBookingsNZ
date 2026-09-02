// #3232 — the LINKED MOVE's wire contract: what the member is offered, what binds
// their answer, and where the second booking would go.
//
// This file tests the I/O-free half only (`adult-member-hosting-linked-move.ts`
// plus the one pure helper in the service). The detection and the enforcement live
// in `adult-member-hosting-same-owner.test.ts`, which owns `INV-HOST-049`'s two
// mutation-verified halves; the atomic write and the combined settlement are
// exercised by the route and service suites.
import { describe, expect, it } from "vitest";

import {
  HOSTING_COVERAGE_LINKED_MOVE_CODE,
  LINKED_MOVE_DECLINED_INCIDENT_REASON,
  SameOwnerCoverageLinkedMoveRequiredError,
  buildSameOwnerCoverageLinkedMoveBody,
  formatLinkedMoveOfferMessage,
  hostingCoverageLinkedMoveSchema,
  linkedMoveStateKey,
  type LinkedMoveQuote,
} from "@/lib/adult-member-hosting-linked-move";
import { strandedCoverageStateKey } from "@/lib/adult-member-hosting-same-owner";
import { linkedMoveTargetRange } from "@/lib/booking-linked-date-move-service";

const STRANDED = [
  {
    bookingId: "b-main",
    reference: "BK-MAIN",
    lodgeName: "Ruapehu Lodge",
    nights: ["2026-08-03", "2026-08-04"],
    checkIn: "2026-08-03",
    checkOut: "2026-08-05",
  },
];

function quote(overrides: Partial<LinkedMoveQuote> = {}): LinkedMoveQuote {
  return {
    primary: {
      bookingId: "b-source",
      reference: "BK-SOURCE",
      proposedCheckIn: "2026-08-20",
      proposedCheckOut: "2026-08-22",
      priceDiffCents: 1000,
      changeFeeCents: 2500,
    },
    linked: [
      {
        bookingId: "b-main",
        reference: "BK-MAIN",
        lodgeName: "Ruapehu Lodge",
        uncoveredNights: ["2026-08-03", "2026-08-04"],
        currentCheckIn: "2026-08-03",
        currentCheckOut: "2026-08-05",
        proposedCheckIn: "2026-08-20",
        proposedCheckOut: "2026-08-22",
        priceDiffCents: 500,
        changeFeeCents: 2500,
      },
    ],
    combinedPriceDiffCents: 1500,
    combinedChangeFeeCents: 5000,
    combinedAmountDueCents: 6500,
    combinedRefundCents: 0,
    settlementMethodRequired: false,
    bothChangeFeesCharged: true,
    feasibility: "AVAILABLE",
    ...overrides,
  };
}

describe("where the second booking goes (#3232)", () => {
  it("shifts the dependent by the same number of days, keeping its own length", () => {
    // NOT "to the same nights", which is only well defined when the two stays
    // happen to match. The dependent was covered because it shared nights with the
    // primary; shifting by the primary's arrival delta preserves exactly that,
    // whatever the two lengths are.
    expect(
      linkedMoveTargetRange(
        {
          previousCheckIn: new Date("2026-08-03T00:00:00.000Z"),
          currentCheckIn: new Date("2026-08-20T00:00:00.000Z"),
        },
        { checkIn: "2026-08-03", checkOut: "2026-08-05" },
      ),
    ).toEqual({ checkIn: "2026-08-20", checkOut: "2026-08-22" });
  });

  it("keeps the dependent's length when the primary also changed length", () => {
    // A member extending their own stay has not asked to extend anybody else's,
    // and lengthening a second booking would charge them for nights they never
    // requested. The dependent follows the ARRIVAL delta and nothing else.
    expect(
      linkedMoveTargetRange(
        {
          previousCheckIn: new Date("2026-08-03T00:00:00.000Z"),
          currentCheckIn: new Date("2026-08-10T00:00:00.000Z"),
        },
        { checkIn: "2026-08-03", checkOut: "2026-08-06" },
      ),
      "the dependent keeps its three nights",
    ).toEqual({ checkIn: "2026-08-10", checkOut: "2026-08-13" });
  });

  it("moves it backwards when the primary moved backwards", () => {
    expect(
      linkedMoveTargetRange(
        {
          previousCheckIn: new Date("2026-08-20T00:00:00.000Z"),
          currentCheckIn: new Date("2026-08-03T00:00:00.000Z"),
        },
        { checkIn: "2026-08-20", checkOut: "2026-08-22" },
      ),
    ).toEqual({ checkIn: "2026-08-03", checkOut: "2026-08-05" });
  });
});

describe("what binds the member's answer (#3232, INV-HOST-050)", () => {
  const base = {
    stranded: STRANDED,
    sourceBookingId: "b-source",
    proposals: [
      { bookingId: "b-source", checkIn: "2026-08-20", checkOut: "2026-08-22" },
      { bookingId: "b-main", checkIn: "2026-08-20", checkOut: "2026-08-22" },
    ],
    combinedAmountDueCents: 6500,
    combinedRefundCents: 0,
    combinedChangeFeeCents: 5000,
  };

  it("represents a SET of moves, not the order they came back in", () => {
    expect(
      linkedMoveStateKey({
        ...base,
        proposals: [...base.proposals].reverse(),
      }),
    ).toBe(linkedMoveStateKey(base));
  });

  it("changes when the MONEY changes, which is the whole reason it is not the stranded key", () => {
    // A member who accepted $65.00 must not be charged $70.00 because a season
    // rate moved between the offer and the retry. This is what makes an acceptance
    // a statement about a price rather than only about a hazard.
    expect(
      linkedMoveStateKey({ ...base, combinedAmountDueCents: 7000 }),
      "INV-HOST-050: the combined figure is part of what the member accepted",
    ).not.toBe(linkedMoveStateKey(base));
    expect(
      linkedMoveStateKey({ ...base, combinedChangeFeeCents: 2500 }),
      "INV-HOST-050: waiving the second change fee is a different offer",
    ).not.toBe(linkedMoveStateKey(base));
    expect(
      linkedMoveStateKey({ ...base, combinedRefundCents: 1000 }),
    ).not.toBe(linkedMoveStateKey(base));
  });

  it("changes when the proposed dates change", () => {
    expect(
      linkedMoveStateKey({
        ...base,
        proposals: [
          { bookingId: "b-source", checkIn: "2026-08-21", checkOut: "2026-08-23" },
          { bookingId: "b-main", checkIn: "2026-08-20", checkOut: "2026-08-22" },
        ],
      }),
    ).not.toBe(linkedMoveStateKey(base));
  });

  it("changes when a different booking is stranded", () => {
    expect(
      linkedMoveStateKey({
        ...base,
        stranded: [{ ...STRANDED[0]!, bookingId: "b-other" }],
      }),
    ).not.toBe(linkedMoveStateKey(base));
  });

  it("is NOT the decline key, because the two answers bind different things", () => {
    // Declining is a statement about the hazard and carries no price, so it is
    // bound by the stranded set alone — the same key the officer's override uses.
    // Accepting adds the moves and the money. A single key would either let a
    // decline be answered with a price nobody quoted, or force a re-prompt on a
    // decline every time a rate moved.
    expect(linkedMoveStateKey(base)).not.toBe(
      strandedCoverageStateKey(STRANDED, "b-source"),
    );
    expect(linkedMoveStateKey(base)).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(strandedCoverageStateKey(STRANDED, "b-source")).toMatch(
      /^v1:[0-9a-f]{64}$/,
    );
  });

  it("refuses a loose answer body", () => {
    const complete = {
      choice: "MOVE_BOTH" as const,
      acknowledged: true as const,
      stateKey: `v1:${"a".repeat(64)}`,
    };
    expect(hostingCoverageLinkedMoveSchema.safeParse(complete).success).toBe(true);
    for (const bad of [
      { ...complete, acknowledged: false },
      { ...complete, choice: "MOVE_SOME" },
      { ...complete, stateKey: "v1:short" },
      { ...complete, stateKey: `v2:${"a".repeat(64)}` },
      { ...complete, extra: true },
      { choice: "MOVE_BOTH", acknowledged: true },
    ]) {
      expect(
        hostingCoverageLinkedMoveSchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
});

describe("what the member is told (#3232)", () => {
  it("states the real dates and the combined figure, and names both fees", () => {
    const message = formatLinkedMoveOfferMessage(quote());
    expect(message).toContain("BK-MAIN");
    expect(message).toContain("Ruapehu Lodge");
    // The dates outright, because a member can check those against a calendar and
    // cannot check a shifting rule.
    expect(message).toContain("2026-08-20");
    expect(message).toContain("2026-08-22");
    expect(message).toContain("$65.00");
    expect(
      message,
      "a member who moves two bookings and sees one total will assume one fee",
    ).toMatch(/change fee on both bookings/);
    expect(message).toContain("$50.00");
  });

  it("says so when the club has waived the second change fee", () => {
    // D2 made this a club setting, so the sentence has to say which answer the
    // club gave. Describing a waived fee as charged, or the reverse, is worse than
    // saying nothing.
    const message = formatLinkedMoveOfferMessage(
      quote({ bothChangeFeesCharged: false, combinedChangeFeeCents: 2500 }),
    );
    expect(message).toMatch(/waived by the club/);
    expect(message).not.toMatch(/change fee on both bookings/);
  });

  it("offers the warn-and-continue path when there are not beds for both", () => {
    // The owner's "cannot" arm, and it is explicitly NOT a failure: the member can
    // still move their own booking.
    const message = formatLinkedMoveOfferMessage(
      quote({ feasibility: "NO_CAPACITY" }),
    );
    expect(message).toMatch(/not enough beds free/);
    expect(message).toMatch(/You can still move\s+this booking/);
    expect(message).toMatch(/Booking Officer will be told/);
    // And it must not quote a price for a move it is not offering.
    expect(message).not.toContain("$65.00");
  });

  it("asks for the refund-or-credit choice once, covering both bookings", () => {
    const message = formatLinkedMoveOfferMessage(
      quote({
        combinedAmountDueCents: 0,
        combinedRefundCents: 4000,
        settlementMethodRequired: true,
      }),
    );
    expect(message).toContain("$40.00");
    expect(message).toMatch(/the choice covers both bookings/);
  });

  it("never names a person, only the member's own bookings", () => {
    // §11 unchanged: not the qualifying adult, not a guest. The owner is told which
    // of their bookings, which lodge, which nights and how much.
    const message = formatLinkedMoveOfferMessage(quote());
    for (const phrase of ["adult member is", "hosted by", "guest of"]) {
      expect(message, phrase).not.toContain(phrase);
    }
    // What it DOES say is the booking, the lodge, the nights and the money.
    expect(message).toContain("BK-MAIN");
  });
});

describe("the offer's 409 body (#3232)", () => {
  it("carries the machine-readable flag, both keys and the whole quote", () => {
    const error = new SameOwnerCoverageLinkedMoveRequiredError(quote(), {
      acceptStateKey: `v1:${"a".repeat(64)}`,
      declineStateKey: `v1:${"b".repeat(64)}`,
    });
    expect(error.status).toBe(409);
    expect(error.code).toBe(HOSTING_COVERAGE_LINKED_MOVE_CODE);
    const body = buildSameOwnerCoverageLinkedMoveBody(error);
    expect(body.requiresLinkedMoveChoice).toBe(true);
    expect(body.linkedMoveAvailable).toBe(true);
    expect(body.acceptStateKey).toBe(`v1:${"a".repeat(64)}`);
    expect(body.declineStateKey).toBe(`v1:${"b".repeat(64)}`);
    expect(body.combinedAmountDueCents).toBe(6500);
    expect(body.combinedChangeFeeCents).toBe(5000);
    expect(body.bothChangeFeesCharged).toBe(true);
    expect(body.linkedBookings.map((row) => row.bookingId)).toEqual(["b-main"]);
  });

  it("marks the offer unavailable when there are not beds for both", () => {
    const error = new SameOwnerCoverageLinkedMoveRequiredError(
      quote({ feasibility: "NO_CAPACITY" }),
      { acceptStateKey: `v1:${"a".repeat(64)}`, declineStateKey: `v1:${"b".repeat(64)}` },
    );
    const body = buildSameOwnerCoverageLinkedMoveBody(error);
    expect(body.linkedMoveAvailable).toBe(false);
    expect(body.feasibility).toBe("NO_CAPACITY");
  });

  it("keeps every amount in integer cents", () => {
    const body = buildSameOwnerCoverageLinkedMoveBody(
      new SameOwnerCoverageLinkedMoveRequiredError(quote(), {
        acceptStateKey: `v1:${"a".repeat(64)}`,
        declineStateKey: `v1:${"b".repeat(64)}`,
      }),
    );
    for (const amount of [
      body.combinedPriceDiffCents,
      body.combinedChangeFeeCents,
      body.combinedAmountDueCents,
      body.combinedRefundCents,
      body.primary.priceDiffCents,
      body.primary.changeFeeCents,
      ...body.linkedBookings.flatMap((row) => [
        row.priceDiffCents,
        row.changeFeeCents,
      ]),
    ]) {
      expect(Number.isInteger(amount), String(amount)).toBe(true);
    }
    // And the combined fields really are the sums of their parts, so a total
    // nobody can check cannot appear.
    expect(body.combinedChangeFeeCents).toBe(
      body.primary.changeFeeCents +
        body.linkedBookings.reduce((total, row) => total + row.changeFeeCents, 0),
    );
    expect(body.combinedPriceDiffCents).toBe(
      body.primary.priceDiffCents +
        body.linkedBookings.reduce((total, row) => total + row.priceDiffCents, 0),
    );
  });

  it("records why a declined offer's incident exists", () => {
    // So an officer reading their queue sees that a member was asked and answered,
    // rather than inferring it from a cause code that also means "a qualification
    // changed".
    expect(LINKED_MOVE_DECLINED_INCIDENT_REASON).toMatch(/offered the linked move/);
    expect(LINKED_MOVE_DECLINED_INCIDENT_REASON).toMatch(/chose to move only/);
  });
});
