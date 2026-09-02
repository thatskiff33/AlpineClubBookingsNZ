// #3232 — the browser's reader for the linked-move offer.
//
// FAIL-CLOSED IS THE WHOLE CONTRACT, and it is not defensiveness for its own
// sake. A half-read offer puts a price in front of a member that the server never
// quoted, or renders a "Move both" button whose state key is missing — which the
// server rejects as stale, so the member clicks a button that cannot work and is
// given no reason. Anything short of the complete body must therefore read as no
// offer at all, which falls back to the plain refusal sentence the panel already
// renders.
import { describe, expect, it } from "vitest";

import { linkedMoveStateKey } from "@/lib/adult-member-hosting-linked-move";
import { strandedCoverageStateKey } from "@/lib/adult-member-hosting-same-owner";
import {
  hostingCoverageLinkedMoveAnswer,
  readHostingCoverageLinkedMovePrompt,
} from "@/lib/hosting-coverage-linked-move-client";
import {
  HOSTING_COVERAGE_STATE_KEY_PATTERN,
  HOSTING_COVERAGE_STATE_KEY_VERSION,
  hostingCoverageStateKeyOf,
} from "@/lib/hosting-coverage-override-client";

const KEY_A = `v1:${"a".repeat(64)}`;
const KEY_B = `v1:${"b".repeat(64)}`;

function body(overrides: Record<string, unknown> = {}) {
  return {
    error: "Booking BK-MAIN is relying on this booking for adult supervision.",
    code: "SAME_OWNER_COVERAGE_LINKED_MOVE_REQUIRED",
    details: "…",
    requiresLinkedMoveChoice: true,
    acceptStateKey: KEY_A,
    declineStateKey: KEY_B,
    linkedMoveAvailable: true,
    feasibility: "AVAILABLE",
    primary: {
      bookingId: "b-source",
      reference: "BK-SOURCE",
      proposedCheckIn: "2026-08-20",
      proposedCheckOut: "2026-08-22",
      priceDiffCents: 1000,
      changeFeeCents: 2500,
    },
    linkedBookings: [
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
    ...overrides,
  };
}

describe("reading the linked-move offer (#3232)", () => {
  it("reads the complete body", () => {
    const prompt = readHostingCoverageLinkedMovePrompt(body());
    expect(prompt).not.toBeNull();
    expect(prompt?.acceptStateKey).toBe(KEY_A);
    expect(prompt?.declineStateKey).toBe(KEY_B);
    expect(prompt?.linkedMoveAvailable).toBe(true);
    expect(prompt?.combinedAmountDueCents).toBe(6500);
    expect(prompt?.linkedBookings[0]?.proposedCheckIn).toBe("2026-08-20");
  });

  it("reads the not-enough-beds form, which is an offer with one arm", () => {
    // The owner's "cannot" arm still has to render: the member is told plainly and
    // offered the warn-and-continue path. Refusing to read it would show them the
    // bare refusal instead, which names an officer rather than the choice they
    // actually have.
    const prompt = readHostingCoverageLinkedMovePrompt(
      body({ linkedMoveAvailable: false, feasibility: "NO_CAPACITY" }),
    );
    expect(prompt?.linkedMoveAvailable).toBe(false);
  });

  it("reads no offer from the officer's override body", () => {
    // The two 409s live side by side in the same `handleSave`, so each reader must
    // match only its own code. A reader that accepted the other's body would put
    // an override prompt's data behind a Move-both button.
    expect(
      readHostingCoverageLinkedMovePrompt({
        ...body(),
        code: "SAME_OWNER_COVERAGE_OVERRIDE_REQUIRED",
      }),
    ).toBeNull();
  });

  it("fails closed on every incomplete or malformed shape", () => {
    for (const [label, patch] of [
      ["no flag", { requiresLinkedMoveChoice: false }],
      ["no message", { error: "   " }],
      ["accept key missing", { acceptStateKey: undefined }],
      ["accept key wrong shape", { acceptStateKey: "v1:short" }],
      ["accept key wrong version", { acceptStateKey: `v2:${"a".repeat(64)}` }],
      ["decline key missing", { declineStateKey: undefined }],
      ["availability not a boolean", { linkedMoveAvailable: "yes" }],
      ["no linked bookings", { linkedBookings: [] }],
      ["linked bookings not an array", { linkedBookings: {} }],
      // The money, which is the half a member acts on.
      ["fractional cents", { combinedAmountDueCents: 65.5 }],
      ["money as a string", { combinedAmountDueCents: "6500" }],
      ["change fee missing", { combinedChangeFeeCents: undefined }],
      ["refund missing", { combinedRefundCents: undefined }],
      ["settlement flag missing", { settlementMethodRequired: undefined }],
      ["fee flag missing", { bothChangeFeesCharged: undefined }],
    ] as const) {
      expect(
        readHostingCoverageLinkedMovePrompt(body(patch as never)),
        label,
      ).toBeNull();
    }
  });

  it("fails closed on a malformed booking row", () => {
    for (const [label, patch] of [
      ["no reference", { reference: "  " }],
      ["no lodge name", { lodgeName: "" }],
      ["no uncovered nights", { uncoveredNights: [] }],
      ["a night that is not a lodge night", { uncoveredNights: ["3 Aug"] }],
      ["current arrival missing", { currentCheckIn: undefined }],
      ["proposed departure malformed", { proposedCheckOut: "20/08/2026" }],
      ["fractional price difference", { priceDiffCents: 12.5 }],
      ["change fee as a string", { changeFeeCents: "2500" }],
    ] as const) {
      expect(
        readHostingCoverageLinkedMovePrompt(
          body({
            linkedBookings: [{ ...body().linkedBookings[0], ...(patch as object) }],
          }),
        ),
        label,
      ).toBeNull();
    }
  });

  it("reads nothing from a non-object", () => {
    for (const value of [null, undefined, "no", 1, [], true]) {
      expect(readHostingCoverageLinkedMovePrompt(value)).toBeNull();
    }
  });
});

describe("which key travels with which answer (#3232, INV-HOST-050)", () => {
  it("sends the ACCEPT key when the member moves both", () => {
    const prompt = readHostingCoverageLinkedMovePrompt(body())!;
    expect(hostingCoverageLinkedMoveAnswer(prompt, "MOVE_BOTH")).toEqual({
      choice: "MOVE_BOTH",
      acknowledged: true,
      stateKey: KEY_A,
    });
  });

  it("sends the DECLINE key when the member moves only one", () => {
    // The two keys are derived differently on the server — the accept key covers
    // the money, the decline key only the stranded set — so sending the wrong one
    // does not match and the member is re-prompted for no visible reason.
    const prompt = readHostingCoverageLinkedMovePrompt(body())!;
    expect(hostingCoverageLinkedMoveAnswer(prompt, "LEAVE_UNCOVERED")).toEqual({
      choice: "LEAVE_UNCOVERED",
      acknowledged: true,
      stateKey: KEY_B,
    });
  });

  it("has no accept answer to give when there are not beds for both", () => {
    // Answering an offer the server did not make. Returning null means the save
    // carries no answer and the server re-prompts, rather than the member being
    // told their acceptance was stale.
    const prompt = readHostingCoverageLinkedMovePrompt(
      body({ linkedMoveAvailable: false, feasibility: "NO_CAPACITY" }),
    )!;
    expect(hostingCoverageLinkedMoveAnswer(prompt, "MOVE_BOTH")).toBeNull();
    // Declining is still answerable, which is the whole point of the arm.
    expect(
      hostingCoverageLinkedMoveAnswer(prompt, "LEAVE_UNCOVERED")?.stateKey,
    ).toBe(KEY_B);
  });
});

/**
 * #3232: ONE STATE-KEY FORMAT, ONE MINT, ONE PATTERN.
 *
 * The literal `v1:` was written at six sites — two minters, two request schemas
 * and two browser readers — and the code already anticipated the drift that
 * invites: the prefix exists so a future change to what a key must cover fails
 * CLOSED rather than colliding with an old value. With six copies, a bump in the
 * minters alone leaves the readers silently discarding every offer the server
 * makes, so a member clicks a "Move both" button that can never work.
 */
describe("the hosting-coverage state-key format (#3232, INV-SSOT-001)", () => {
  const digest = "a".repeat(64);

  it("mints what its own pattern matches", () => {
    expect(hostingCoverageStateKeyOf(digest)).toBe(
      `${HOSTING_COVERAGE_STATE_KEY_VERSION}:${digest}`,
    );
    expect(hostingCoverageStateKeyOf(digest)).toMatch(
      HOSTING_COVERAGE_STATE_KEY_PATTERN,
    );
    expect(`v0:${digest}`).not.toMatch(HOSTING_COVERAGE_STATE_KEY_PATTERN);
    expect(`${HOSTING_COVERAGE_STATE_KEY_VERSION}:nothex`).not.toMatch(
      HOSTING_COVERAGE_STATE_KEY_PATTERN,
    );
  });

  it("is what BOTH real minters produce, so a bump reaches every reader", () => {
    const stranded = [
      {
        bookingId: "b-main",
        reference: "BK-MAIN",
        lodgeName: "Ruapehu Lodge",
        nights: ["2026-08-10"],
        checkIn: "2026-08-10",
        checkOut: "2026-08-12",
      },
    ];
    const accept = linkedMoveStateKey({
      stranded,
      sourceBookingId: "b-source",
      proposals: [
        { bookingId: "b-main", checkIn: "2026-08-20", checkOut: "2026-08-22" },
      ],
      combinedAmountDueCents: 100,
      combinedRefundCents: 0,
      combinedChangeFeeCents: 50,
      combinedPriceDiffCents: 50,
    });
    const decline = strandedCoverageStateKey(stranded, "b-source");
    for (const key of [accept, decline]) {
      expect(key).toMatch(HOSTING_COVERAGE_STATE_KEY_PATTERN);
      expect(key.startsWith(`${HOSTING_COVERAGE_STATE_KEY_VERSION}:`)).toBe(true);
    }
    // And a body carrying them still reads, which is the end-to-end statement:
    // the minters and this module's reader agree on the format by construction.
    expect(
      readHostingCoverageLinkedMovePrompt(
        body({ acceptStateKey: accept, declineStateKey: decline }),
      ),
    ).not.toBeNull();
  });
});
