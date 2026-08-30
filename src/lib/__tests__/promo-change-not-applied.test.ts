import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

/**
 * #3179 (epic #2797) — AN EDIT THAT SAVES WITHOUT THE PROMO-CODE CHANGE IT
 * CARRIED MUST SAY SO.
 *
 * ## What was actually wrong, which is not quite what the issue said
 *
 * The issue reported the silent drop on the IN-PROGRESS edit path. Measured
 * against the code, that path is not silent: both surfaces refuse a promo change
 * on a stay already under way with a 400 — the modify-quote route in its
 * `isInProgressEdit` block, and the save in `resolveTargetDates` — so
 * `applyPromoCodeChanges`' in-progress stub is never reached carrying one.
 *
 * The drop that IS real and IS silent is the PARKED edit (#3166/#3170,
 * `INV-MOD-028`): a booking whose stored night prices cannot be read commits its
 * structural change and holds the money for a person, and on that branch no
 * promotion is re-run. That branch is reached from the ordinary member edit
 * panel on a stay that has NOT started — which is exactly where the panel does
 * show the promo card. The member got an HTTP 200, a changed booking, and no
 * word about the code.
 *
 * ## What is pinned here
 *
 * 1. the sentence itself, including the two reasons and both tenses;
 * 2. the email carrying it, on BOTH composed bodies (the hand-built HTML and the
 *    admin-editable flat body), which is the durable copy for a member who
 *    closed the panel; and
 * 3. the WIRING, by reading the two call sites off disk: the save's stub branch
 *    and the preview's parked response must each build the notice from the one
 *    shared function, or a future edit can make the drop silent again without
 *    any test noticing. That third block has no import edge to what it scans —
 *    the known blind spot of source-scanning contracts here — so it is written
 *    to name the file and the missing text in its failure message.
 *
 * MUTATION PROOF (each verified by breaking it, watching the named test fail,
 * and restoring):
 *  - delete the `describePromoChangeNotApplied` call from the save service and
 *    "the SAVE builds the notice on the branch that drops the change" fails;
 *  - delete it from `parkedQuoteResponse` and "the PREVIEW says it before the
 *    member presses Save" fails;
 *  - drop the row from `bookingModificationSummaryRows` and "the email carries
 *    the sentence" fails;
 *  - return the notice for a removal against a booking with no promotion and
 *    "says nothing when the member's request was not dropped" fails.
 */

const sendEmail = vi.hoisted(() => vi.fn(async () => ({ delivered: true })));
vi.mock("@/lib/email/core", () => ({ sendEmail }));

import {
  describePromoChangeNotApplied,
  promoChangeNotAppliedHeading,
  promoChangeNotAppliedMessage,
  PROMO_CHANGE_NOT_APPLIED_LABEL,
} from "@/lib/promo-change-not-applied";
import { bookingModificationSummaryRows } from "@/lib/booking-money-lines";
import { bookingModifiedTemplate } from "@/lib/email-templates/booking";
import { sendBookingModifiedEmail } from "@/lib/email/booking";

describe("the sentence a member reads when a promo-code change was dropped (#3179)", () => {
  it("names the code, what did not happen, why, and what it means for the price", () => {
    const notice = describePromoChangeNotApplied({
      requestedPromoCode: "spring24",
      removePromoCodeRequested: false,
      currentPromoCode: null,
      reason: "AMOUNT_UNDER_REVIEW",
      phase: "saved",
    });

    expect(notice).not.toBeNull();
    // Uppercased, the way every other surface shows a promo code.
    expect(notice?.promoCode).toBe("SPRING24");
    expect(notice?.requested).toBe("apply");
    expect(notice?.message).toContain("SPRING24 was not applied");
    expect(notice?.message).toMatch(/with the club to price/i);
    expect(notice?.message).toMatch(/does not include a discount/i);
    // The code is not burnt: a member who was refused the discount must know
    // they can still use it, or they will not try again.
    expect(notice?.message).toMatch(/still available for another booking/i);
    expect(notice?.message).toMatch(/everything else in this change was saved/i);
    expect(notice?.message).toMatch(/contact the club/i);
  });

  it("says the stay has already started when THAT is the reason, and never the other way round", () => {
    const inProgress = promoChangeNotAppliedMessage({
      requested: "apply",
      reason: "STAY_IN_PROGRESS",
      promoCode: "SPRING24",
      phase: "saved",
    });
    const parked = promoChangeNotAppliedMessage({
      requested: "apply",
      reason: "AMOUNT_UNDER_REVIEW",
      promoCode: "SPRING24",
      phase: "saved",
    });

    expect(inProgress).toMatch(/stay that has already started/i);
    expect(inProgress).not.toMatch(/with the club to price/i);
    // A parked edit can be on a stay that has not started at all, so telling
    // that member their stay has begun would simply be false.
    expect(parked).not.toMatch(/already started/i);
    expect(parked).toMatch(/with the club to price/i);
  });

  it("tells a REMOVAL the truth about the code it did not release", () => {
    const notice = describePromoChangeNotApplied({
      requestedPromoCode: null,
      removePromoCodeRequested: true,
      currentPromoCode: "SPRING24",
      reason: "AMOUNT_UNDER_REVIEW",
      phase: "saved",
    });

    expect(notice?.requested).toBe("remove");
    expect(notice?.message).toContain("SPRING24 was not removed");
    // The whole point of removing a code is to get it back for another
    // booking, so the one thing this member needs to know is that they did not.
    expect(notice?.message).toMatch(/stays on this booking/i);
    expect(notice?.message).not.toMatch(/still available for another booking/i);
  });

  it("uses the future tense on the PREVIEW and the past tense on the SAVE", () => {
    const shared = {
      requested: "apply" as const,
      reason: "AMOUNT_UNDER_REVIEW" as const,
      promoCode: "SPRING24",
    };

    expect(promoChangeNotAppliedMessage({ ...shared, phase: "preview" })).toContain(
      "will not be applied",
    );
    expect(promoChangeNotAppliedMessage({ ...shared, phase: "saved" })).toContain(
      "was not applied",
    );
    expect(promoChangeNotAppliedHeading("preview")).toMatch(/will not be applied/i);
    expect(promoChangeNotAppliedHeading("saved")).toMatch(/was not applied/i);
  });

  it("says nothing when the member's request was not dropped — the CONTROL", () => {
    // No promo instruction at all: an ordinary parked date change.
    expect(
      describePromoChangeNotApplied({
        requestedPromoCode: null,
        removePromoCodeRequested: false,
        currentPromoCode: "SPRING24",
        reason: "AMOUNT_UNDER_REVIEW",
        phase: "saved",
      }),
    ).toBeNull();

    // "Remove the code" on a booking that has no code: the booking ends up in
    // exactly the state the member asked for, so a warning would be a false
    // alarm — and a false alarm here teaches members to ignore the real one.
    expect(
      describePromoChangeNotApplied({
        requestedPromoCode: null,
        removePromoCodeRequested: true,
        currentPromoCode: null,
        reason: "AMOUNT_UNDER_REVIEW",
        phase: "saved",
      }),
    ).toBeNull();

    // An empty string is not a code.
    expect(
      describePromoChangeNotApplied({
        requestedPromoCode: "   ",
        removePromoCodeRequested: false,
        currentPromoCode: null,
        reason: "STAY_IN_PROGRESS",
        phase: "saved",
      }),
    ).toBeNull();
  });

  it("resolves a request carrying BOTH the way the apply path resolves it — removal wins", () => {
    // `applyPromoCodeChanges` applies a new code only when
    // `input.promoCode && !input.removePromoCode`, so a request carrying both
    // is a removal. The sentence must describe the same request the code does.
    const notice = describePromoChangeNotApplied({
      requestedPromoCode: "OTHER10",
      removePromoCodeRequested: true,
      currentPromoCode: "SPRING24",
      reason: "AMOUNT_UNDER_REVIEW",
      phase: "saved",
    });

    expect(notice?.requested).toBe("remove");
    expect(notice?.promoCode).toBe("SPRING24");
  });
});

const OLD_CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const OLD_CHECK_OUT = new Date("2026-08-05T00:00:00.000Z");
const NEW_CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const NEW_CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

const NOTE = promoChangeNotAppliedMessage({
  requested: "apply",
  reason: "AMOUNT_UNDER_REVIEW",
  promoCode: "SPRING24",
  phase: "saved",
});

function emailParams(overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Sam",
    modificationType: "BATCH_MODIFY",
    oldCheckIn: OLD_CHECK_IN,
    oldCheckOut: OLD_CHECK_OUT,
    newCheckIn: NEW_CHECK_IN,
    newCheckOut: NEW_CHECK_OUT,
    oldGuestCount: 2,
    newGuestCount: 2,
    oldFinalPriceCents: 24000,
    newFinalPriceCents: 24000,
    changeFeeCents: 0,
    refundAmountCents: 0,
    additionalAmountCents: 0,
    financialReviewPending: true,
    ...overrides,
  };
}

beforeEach(() => {
  sendEmail.mockClear();
});

describe("the email carries the sentence (#3179)", () => {
  it("adds one change row, labelled, with the member's own sentence", () => {
    const rows = bookingModificationSummaryRows({
      oldCheckIn: OLD_CHECK_IN,
      oldCheckOut: OLD_CHECK_OUT,
      newCheckIn: NEW_CHECK_IN,
      newCheckOut: NEW_CHECK_OUT,
      oldGuestCount: 2,
      newGuestCount: 2,
      oldFinalPriceCents: 24000,
      newFinalPriceCents: 24000,
      changeFeeCents: 0,
      promoChangeNotAppliedNote: NOTE,
    });

    expect(rows).toContainEqual({
      label: PROMO_CHANGE_NOT_APPLIED_LABEL,
      value: NOTE,
    });
  });

  it("adds NO such row when the edit carried nothing it had to drop — the CONTROL", () => {
    const rows = bookingModificationSummaryRows({
      oldCheckIn: OLD_CHECK_IN,
      oldCheckOut: OLD_CHECK_OUT,
      newCheckIn: NEW_CHECK_IN,
      newCheckOut: NEW_CHECK_OUT,
      oldGuestCount: 2,
      newGuestCount: 2,
      oldFinalPriceCents: 24000,
      newFinalPriceCents: 24000,
      changeFeeCents: 0,
    });

    expect(
      rows.some((row) => row.label === PROMO_CHANGE_NOT_APPLIED_LABEL),
    ).toBe(false);
  });

  it("says it in the HTML email AND in the admin-editable flat body, identically", async () => {
    const silent = bookingModifiedTemplate(emailParams());
    const honest = bookingModifiedTemplate(
      emailParams({ promoChangeNotAppliedNote: NOTE }),
    );

    expect(silent).not.toMatch(/was not applied to this booking/i);
    expect(honest).toMatch(/SPRING24 was not applied to this booking/i);

    await sendBookingModifiedEmail({
      bookingId: "booking-1",
      recipientMemberId: "member-1",
      email: "sam@example.org",
      ...emailParams({ promoChangeNotAppliedNote: NOTE }),
    });
    const [call] = sendEmail.mock.calls as unknown as [
      [{ templateData: { changeSummary: string } }],
    ];

    // The same words, from the same rows: the two bodies cannot tell one member
    // two stories about the code they asked for.
    expect(call[0].templateData.changeSummary).toContain(NOTE);
  });
});

/**
 * The wiring, read off disk.
 *
 * `vitest related` cannot select this block — it has no import edge to the files
 * it reads — so it is CI that runs it, and its failure messages have to be able
 * to explain themselves to somebody who has never seen this file.
 */
const REPO_ROOT = path.resolve(__dirname, "../../..");

function executableSource(relativePath: string): string {
  return stripComments(
    readFileSync(path.join(REPO_ROOT, relativePath), "utf8"),
  );
}

const SAVE_SERVICE = "src/lib/booking-batch-modification-service.ts";
const QUOTE_ROUTE = "src/app/api/bookings/[id]/modify-quote/route.ts";

describe("neither surface can drop a promo-code change silently again (#3179)", () => {
  it("the SAVE builds the notice on the branch that drops the change", () => {
    const source = executableSource(SAVE_SERVICE);

    expect(
      source,
      `${SAVE_SERVICE} must call describePromoChangeNotApplied where it stubs the promotion figures — without it a parked or in-progress edit returns 200 having quietly discarded the member's promo-code change (#3179).`,
    ).toContain("describePromoChangeNotApplied(");

    // ONE predicate decides both "was the promotion engine skipped" and "does
    // the member need telling". Two expressions for one question is how these
    // two answers would drift apart (`INV-SSOT`).
    const predicateUses = source.match(/promoEngineSkipped/g) ?? [];
    expect(
      predicateUses.length,
      `${SAVE_SERVICE} must decide "the promotion engine did not run" ONCE and read that one answer for both the stubbed figures and the member's notice (#3179).`,
    ).toBeGreaterThanOrEqual(3);
  });

  it("the save carries the notice to every surface that owes the member an answer", () => {
    const source = executableSource(SAVE_SERVICE);

    // The panel reads it off the response.
    expect(source).toContain("promoChangeNotApplied: result.promoChangeNotApplied");
    // The booking's own history replays it.
    expect(source).toContain("promoChangeNotAppliedNote: promoChangeNotApplied.message");
    // The email is the durable copy for a member who closed the panel.
    expect(source).toContain(
      "promoChangeNotAppliedNote: result.promoChangeNotApplied?.message ?? null",
    );
  });

  it("the PREVIEW says it before the member presses Save", () => {
    const source = executableSource(QUOTE_ROUTE);

    expect(
      source,
      `${QUOTE_ROUTE} must build the same notice in its parked quote response, or the preview quotes a settled-looking total while silently ignoring the code the member just applied (#3179).`,
    ).toContain("describePromoChangeNotApplied(");
    expect(source).toContain("promoChangeNotApplied: describePromoChangeNotApplied(");
  });

  it("both surfaces compose it from the one shared module, never their own words", () => {
    for (const file of [SAVE_SERVICE, QUOTE_ROUTE]) {
      const source = executableSource(file);
      expect(
        source,
        `${file} must import the sentence from @/lib/promo-change-not-applied — a second wording is how two surfaces come to tell one member two different stories (INV-SSOT).`,
      ).toContain("@/lib/promo-change-not-applied");
      // No surface writes the sentence itself.
      expect(source).not.toMatch(/was not applied to this booking/);
    }
  });
});
