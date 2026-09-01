import { describe, expect, it } from "vitest";
import {
  EDIT_FINANCIAL_REVIEW_CAUSES,
  EDIT_FINANCIAL_REVIEW_CAUSE_LABEL,
  parseEditFinancialReviewContext,
  toEditFinancialReviewEvidence,
  type EditFinancialReviewContext,
} from "@/lib/edit-financial-review-context";

/**
 * #3033 (epic #2797) — the one redaction point between a stored review context
 * and an admin screen.
 *
 * The property being pinned is not "these fields are deleted" but "these fields
 * have nowhere to go": `EditFinancialReviewEvidence` declares no
 * `guestMemberId` and no `bookingGuestId`, so a send site cannot forget to strip
 * them. That is the `INV-SSOT` preference for unrepresentable over policed, and
 * it is why the assertion below is over the whole projected object rather than
 * over two named keys — a THIRD identifier added to the context later is
 * withheld by default and shows up here as a failure if somebody admits it.
 *
 * MUTATION PROOF. Return `{ ...context }` from `toEditFinancialReviewEvidence`
 * and "carries no identifier a finance screen has no use for" fails. Add a
 * cause to the vocabulary without a label and "every cause an admin can meet
 * has a sentence" fails. Write a label naming a member or a diagnostic word and
 * "no label blames anybody or leaks internal vocabulary" fails.
 */

const CONTEXT: EditFinancialReviewContext = parseEditFinancialReviewContext({
  version: 1,
  occurrence: {
    bookingId: "booking-edit",
    bookingGuestId: "guest-strand-1",
    cause: "STORED_TOTAL_MISMATCH",
    surrenderedNightDates: ["2026-08-11"],
    addedNightDates: ["2026-08-14"],
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
  // Required by the context schema. NULL is the legitimate "no anchor" shape;
  // OMITTING it fails the `.strict()` parse, which made this fixture null and
  // both projection cases throw rather than assert.
  bookingModificationId: null,
})!;

describe("the evidence projection an admin screen is built from (#3033)", () => {
  it("carries no identifier a finance screen has no use for", () => {
    // Asserted as the WHOLE object: a field admitted later has to be added here
    // deliberately, rather than sliding through because nobody named it.
    expect(toEditFinancialReviewEvidence(CONTEXT)).toEqual({
      cause: "STORED_TOTAL_MISMATCH",
      surrenderedNightDates: ["2026-08-11"],
      addedNightDates: ["2026-08-14"],
      storedEvidence: {
        guestTotalCents: 12000,
        nightPrices: [
          { date: "2026-08-10", priceCents: 6000 },
          { date: "2026-08-11", priceCents: null },
        ],
      },
      bookingCheckIn: "2026-08-10",
      bookingCheckOut: "2026-08-12",
      // #3166. Null here because THIS fixture's edit added nobody; the case
      // below proves a populated one crosses as a count and a figure only.
      guestsAddedByEdit: null,
    });
  });

  it("carries what the same edit ADDED, as a count and a figure and nothing else (#3166)", () => {
    // A parked add writes the booking's total back unchanged, so the money for
    // the new guests is owed and lives only on their own rows. Without this the
    // admin card describes one untouched guest and says nothing about them.
    const context = parseEditFinancialReviewContext({
      version: 1,
      occurrence: CONTEXT.occurrence,
      guestMemberId: "member-guest-9",
      bookingCheckIn: "2026-08-10",
      bookingCheckOut: "2026-08-12",
      guestsAddedByEdit: { count: 2, totalPriceCents: 64000 },
      bookingModificationId: null,
    })!;

    expect(toEditFinancialReviewEvidence(context).guestsAddedByEdit).toEqual({
      count: 2,
      totalPriceCents: 64000,
    });
  });

  it("still reads a row written before #3166, which carries no added-guest field at all", () => {
    // The parser is a whole-object `.strict()` read and every stored row
    // predating this field omits it. Refusing those would blank the evidence on
    // every task already in the queue.
    expect(CONTEXT.guestsAddedByEdit ?? null).toBeNull();
    expect(toEditFinancialReviewEvidence(CONTEXT).guestsAddedByEdit).toBeNull();
  });

  it("keeps an absent stored price as an absence, not as a zero", () => {
    // Zero is a real price the club charged; null is the evidence gap that
    // raised the task. The projection must not flatten one into the other.
    const evidence = toEditFinancialReviewEvidence(CONTEXT);

    expect(evidence.storedEvidence.nightPrices[1].priceCents).toBeNull();
  });

  it("every cause an admin can meet has a sentence", () => {
    // A cause with no label would render `undefined` on the finance queue, on
    // the one screen where an admin is deciding real money.
    for (const cause of EDIT_FINANCIAL_REVIEW_CAUSES) {
      expect(EDIT_FINANCIAL_REVIEW_CAUSE_LABEL[cause]?.trim()).toBeTruthy();
    }
  });

  it("no label blames anybody or leaks internal vocabulary", () => {
    // #3033 forbids corruption terminology and blaming the member. These labels
    // are admin-facing, but the rule is worth holding at the source: they are
    // the one place the closed cause vocabulary turns into English, and a
    // sentence written here is one copy-paste away from a member's screen.
    for (const cause of EDIT_FINANCIAL_REVIEW_CAUSES) {
      const label = EDIT_FINANCIAL_REVIEW_CAUSE_LABEL[cause];
      expect(label).not.toMatch(/corrupt|invalid|bad data|the member|they did/i);
      expect(label).not.toContain(cause);
    }
  });
});
