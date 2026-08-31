import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

/**
 * #3179 (epic #2797) — AN EDIT THAT SAVES WITHOUT THE PROMO-CODE CHANGE IT
 * CARRIED MUST SAY SO.
 *
 * ## The rule this guard enforces: `INV-MOD-028`
 *
 * Cited by id rather than by issue number, per `AGENTS.md`. It is INV-MOD-028
 * and not a new id of its own, deliberately: this obligation is a clause of
 * "what every parked path does, identically" and is documented inside that
 * rule's own section in `docs/invariants/booking-modifications.md`, where the
 * parked-edit contract already lives. Minting a second id would split one
 * contract across two homes, which is the opposite of what the invariant docs
 * are for. The `STAY_IN_PROGRESS` arm is defence in depth for a refusal that
 * holds (`INV-MOD-019`), not an independently live rule.
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
 * 3. the WIRING, by reading THREE call sites off disk - the save's gate, the
 *    parked preview and the in-progress preview - plus a fourth assertion on the
 *    plan module. Each must build the notice from the one shared function, or a
 *    future edit can make the drop silent again without any test noticing.
 *
 *    NOTE the save's gate is on `promo.promoEngineRan`, NOT on the caller's own
 *    stub branch. Gating it on the branch is the pre-fix shape and it is worth
 *    knowing why it was wrong: the notice was built only where the FIGURES were
 *    stubbed, so an in-progress PRICED edit — the one a future relaxation of the
 *    refusal would create — would have dropped the change with no notice
 *    anywhere.
 *
 *    That third block has no import edge to what it scans — the known blind spot
 *    of source-scanning contracts here — so it is written to name the file and
 *    the missing text in its failure message.
 *
 * MUTATION PROOF (each verified by breaking it, watching the named test fail,
 * and restoring):
 *  - delete the `describePromoChangeNotApplied` call from the save service and
 *    "the SAVE builds the notice on the branch that drops the change" fails;
 *  - delete it from `parkedQuoteResponse` and "the PREVIEW says it before the
 *    member presses Save" fails;
 *  - gate the save's notice on the caller's own stub predicate instead of
 *    `promo.promoEngineRan` and "the notice is gated on whether the promotion
 *    engine RAN, not on which branch priced" fails;
 *  - make `applyPromoCodeChanges` report `promoEngineRan: true` on its
 *    in-progress stub and "reports that it did NOT run on an in-progress plan"
 *    fails;
 *  - drop the row from `bookingModificationSummaryRows` and "the email carries
 *    the sentence" fails;
 *  - return the notice for a removal against a booking with no promotion and
 *    "says nothing when the member's request was not dropped" fails;
 *  - drop the `currentPromoCode` argument in `describePromoChangeNotApplied`'s
 *    apply arm and "never tells a member holding a live discount that their
 *    code is unused" fails;
 *  - ignore `guestRemovalsRequested` in the resent arm (say "who it covers has
 *    not changed either" unconditionally) and "stops claiming who the code
 *    covers is unchanged when the same request removed a guest" fails.
 */

const sendEmail = vi.hoisted(() => vi.fn(async () => ({ delivered: true })));
vi.mock("@/lib/email/core", () => ({ sendEmail }));

// The promotion engine itself, stubbed so `applyPromoCodeChanges` can be run for
// its ANSWER rather than for its arithmetic. Nothing below asserts a discount.
const promoMocks = vi.hoisted(() => ({
  validateAndCalculatePromoDiscount: vi.fn(),
  redeemPromoCode: vi.fn(),
  deletePromoRedemptionAndAdjustCount: vi.fn(),
  replacePromoRedemptionAllocations: vi.fn(),
  shouldPersistPromoRedemption: vi.fn().mockReturnValue(false),
  lockAndRefreshPromoCodeUsage: vi.fn(),
  lockPromoCodeRowsForUpdate: vi.fn(),
}));
vi.mock("@/lib/promo", () => promoMocks);

import {
  describePromoChangeNotApplied,
  promoChangeNotAppliedHeading,
  promoChangeNotAppliedMessage,
  PROMO_CHANGE_NOT_APPLIED_LABEL,
} from "@/lib/promo-change-not-applied";
import { applyPromoCodeChanges } from "@/lib/booking-modify-plan";
import { bookingModificationSummaryRows } from "@/lib/booking-money-lines";
import { requireCalendarDate } from "@/lib/club-time";
import { bookingModifiedTemplate } from "@/lib/email-templates/booking";
import { sendBookingModifiedEmail } from "@/lib/email/booking";

describe("the sentence a member reads when a promo-code change was dropped (#3179)", () => {
  it("names the code, what did not happen, why, and what it means for the price", () => {
    const notice = describePromoChangeNotApplied({
      requestedPromoCode: "spring24",
      removePromoCodeRequested: false,
      currentPromoCode: null,
      guestRemovalsRequested: false,
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
      guestRemovalsRequested: false,
    });
    const parked = promoChangeNotAppliedMessage({
      requested: "apply",
      reason: "AMOUNT_UNDER_REVIEW",
      promoCode: "SPRING24",
      phase: "saved",
      guestRemovalsRequested: false,
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
      guestRemovalsRequested: false,
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
      guestRemovalsRequested: false,
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
        guestRemovalsRequested: false,
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
        guestRemovalsRequested: false,
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
        guestRemovalsRequested: false,
        reason: "STAY_IN_PROGRESS",
        phase: "saved",
      }),
    ).toBeNull();
  });

  it("never tells a member holding a live discount that their code is unused", () => {
    // REACHABLE THROUGH THE ORDINARY PANEL. On a stay that has not started the
    // member presses Remove, then re-enters the SAME code to change who it
    // covers: `promoAction.type === "new"` sends `promoCode` with no
    // `removePromoCode`. The priced path treats that as remove-then-reapply. If
    // that edit parks, this is the sentence they read — and the fixed wording
    // told them the code "has not been used, so it is still available for
    // another booking" while its redemption sat on their booking and its
    // discount sat in the total on screen. Both clauses were false.
    const notice = describePromoChangeNotApplied({
      requestedPromoCode: "spring24",
      removePromoCodeRequested: false,
      currentPromoCode: "SPRING24",
      guestRemovalsRequested: false,
      reason: "AMOUNT_UNDER_REVIEW",
      phase: "saved",
    });

    expect(notice?.requested).toBe("apply");
    expect(notice?.promoCode).toBe("SPRING24");
    // The two false clauses, gone.
    expect(notice?.message).not.toMatch(/still available for another booking/i);
    expect(notice?.message).not.toMatch(/has not been used/i);
    expect(notice?.message).not.toMatch(/does not include a discount/i);
    // What is actually true of their booking.
    expect(notice?.message).toMatch(/change to promo code SPRING24 was not applied/i);
    expect(notice?.message).toMatch(/stays on this booking exactly as it was/i);
    expect(notice?.message).toMatch(/price still includes its discount/i);
    // Re-sending a code is how the panel asks to change WHO it covers, so the
    // one thing that member changed is the one thing the sentence must answer.
    expect(notice?.message).toMatch(/who it covers has not changed/i);
  });

  it("names BOTH codes on a swap, because the old one is still discounting the total", () => {
    const notice = describePromoChangeNotApplied({
      requestedPromoCode: "winter30",
      removePromoCodeRequested: false,
      currentPromoCode: "SPRING24",
      guestRemovalsRequested: false,
      reason: "AMOUNT_UNDER_REVIEW",
      phase: "saved",
    });

    // The requested code: not applied, not burnt.
    expect(notice?.message).toContain("WINTER30 was not applied");
    expect(notice?.message).toMatch(/still available for another booking/i);
    // The code the member is still being discounted by. A sentence naming only
    // WINTER30 leaves them to work out for themselves why the total moved.
    expect(notice?.message).toContain("SPRING24 stays on this booking");
    expect(notice?.message).toMatch(/price still includes its discount/i);
  });

  it("stops claiming who the code covers is unchanged when the same request removed a guest", () => {
    // REACHABLE THROUGH THE ORDINARY PANEL, and only ever in the safe
    // direction. `PromoRedemptionGuestTarget.bookingGuest` is
    // `onDelete: Cascade` and a PARKED edit still deletes the rows for the
    // guests it removes, so a booking whose SPRING24 covered Ann and Bob loses
    // Bob's target row when the member removes Bob and re-sends SPRING24 in the
    // same request. The stored discount is written back untouched — nothing is
    // repriced — but who the code covers really did narrow, so
    // "Who it covers has not changed either" was false.
    //
    // Nobody is misled into acting WRONGLY by it: the panel builds the promo
    // selection from the guests that REMAIN, so coverage can only ever shrink to
    // a subset the member's own request already excluded. It is still a sentence
    // that is sometimes false, which is worse than one sentence fewer.
    const withRemoval = describePromoChangeNotApplied({
      requestedPromoCode: "SPRING24",
      removePromoCodeRequested: false,
      currentPromoCode: "SPRING24",
      guestRemovalsRequested: true,
      reason: "AMOUNT_UNDER_REVIEW",
      phase: "saved",
    });

    expect(withRemoval?.message).not.toMatch(/who it covers/i);
    // "exactly as it was" makes the same claim in weaker words, so it goes too.
    expect(withRemoval?.message).not.toMatch(/exactly as it was/i);
    // What is still true is still said — the clause is dropped, not the notice.
    expect(withRemoval?.message).toMatch(/stays on this booking/i);
    expect(withRemoval?.message).toMatch(/price still includes its discount/i);

    // THE CONTROL. A resent code with NO removals still gets the clause, or the
    // change above would be a blanket deletion wearing a condition.
    const withoutRemoval = describePromoChangeNotApplied({
      requestedPromoCode: "SPRING24",
      removePromoCodeRequested: false,
      currentPromoCode: "SPRING24",
      guestRemovalsRequested: false,
      reason: "AMOUNT_UNDER_REVIEW",
      phase: "saved",
    });

    expect(withoutRemoval?.message).toMatch(/who it covers has not changed/i);
    expect(withoutRemoval?.message).toMatch(/stays on this booking exactly as it was/i);

    // A SWAP says "as it was" about the OLD code, which its own cascading target
    // rows falsify in exactly the same way, so it drops the same claim.
    const swapWithRemoval = describePromoChangeNotApplied({
      requestedPromoCode: "WINTER30",
      removePromoCodeRequested: false,
      currentPromoCode: "SPRING24",
      guestRemovalsRequested: true,
      reason: "AMOUNT_UNDER_REVIEW",
      phase: "saved",
    });

    expect(swapWithRemoval?.message).toContain("SPRING24 stays on this booking,");
    expect(swapWithRemoval?.message).not.toMatch(/as it was/i);
    // ...and the requested code's own half is untouched by any of this.
    expect(swapWithRemoval?.message).toContain("WINTER30 was not applied");
    expect(swapWithRemoval?.message).toMatch(/still available for another booking/i);
  });

  it("keeps the plain wording when the booking carries no promotion — the CONTROL", () => {
    // Nothing to be still-true about, so neither of the two arms above may
    // fire: an unqualified "the code is still available for another booking" is
    // exactly right here, and the resent/swap sentences would be false.
    const notice = describePromoChangeNotApplied({
      requestedPromoCode: "SPRING24",
      removePromoCodeRequested: false,
      currentPromoCode: null,
      guestRemovalsRequested: false,
      reason: "AMOUNT_UNDER_REVIEW",
      phase: "saved",
    });

    expect(notice?.message).toContain("SPRING24 was not applied");
    expect(notice?.message).not.toMatch(/your change to promo code/i);
    expect(notice?.message).toMatch(/still available for another booking/i);
    expect(notice?.message).not.toMatch(/stays on this booking/i);
    expect(notice?.message).not.toMatch(/who it covers/i);
  });

  it("resolves a request carrying BOTH the way the apply path resolves it — removal wins", () => {
    // `applyPromoCodeChanges` applies a new code only when
    // `input.promoCode && !input.removePromoCode`, so a request carrying both
    // is a removal. The sentence must describe the same request the code does.
    const notice = describePromoChangeNotApplied({
      requestedPromoCode: "OTHER10",
      removePromoCodeRequested: true,
      currentPromoCode: "SPRING24",
      guestRemovalsRequested: false,
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
  guestRemovalsRequested: false,
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
const PLAN_MODULE = "src/lib/booking-modify-plan.ts";

describe("neither surface can drop a promo-code change silently again (#3179)", () => {
  it("the SAVE builds the notice on the branch that drops the change", () => {
    const source = executableSource(SAVE_SERVICE);

    expect(
      source,
      `${SAVE_SERVICE} must call describePromoChangeNotApplied where it stubs the promotion figures — without it a parked or in-progress edit returns 200 having quietly discarded the member's promo-code change (#3179).`,
    ).toContain("describePromoChangeNotApplied(");
  });

  it("the notice is gated on whether the promotion engine RAN, not on which branch priced", () => {
    const source = executableSource(SAVE_SERVICE);

    expect(
      source,
      `${SAVE_SERVICE} must gate the member's notice on promo.promoEngineRan. Gating it on this service's own stub predicate covers the parked branch and MISSES the in-progress priced one, where applyPromoCodeChanges stubs the figures itself - the exact branch the STAY_IN_PROGRESS wording exists for (#3179, INV-MOD-028).`,
    ).toContain("const promoChangeNotApplied = promo.promoEngineRan");

    // ...and the local stub must answer the same question, so a new caller
    // branch cannot be added without deciding it (`INV-SSOT`).
    expect(source).toContain("promoEngineRan: false");

    const plan = executableSource(PLAN_MODULE);
    expect(
      plan,
      `${PLAN_MODULE} must report promoEngineRan: false on its in-progress stub - it is the only code that knows it skipped, and a caller re-deriving that from the pricing branch is the two-expressions-for-one-question defect INV-SSOT names (#3179).`,
    ).toContain("promoEngineRan: false");
    expect(plan).toContain("promoEngineRan: true");
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

    // The IN-PROGRESS branch builds it too, and resolves to null today because
    // the route refuses a promo change on that path a few hundred lines above.
    // It is wired anyway: wording nothing calls for warns nobody, and this is
    // the preview half of "relaxing either refusal cannot re-open the silence".
    expect(
      source,
      `${QUOTE_ROUTE} must build the notice on its in-progress branch as well - leaving it unwired because the refusal above makes it unreachable is exactly what would make relaxing that refusal silent again (#3179).`,
    ).toContain("promoChangeNotApplied = describePromoChangeNotApplied(");
    // ...and put it on the wire, or the panel never sees it.
    expect(source).toMatch(/promoCoverage,\s+promoChangeNotApplied,/);
  });

  it("both surfaces answer the coverage question from the removals the request really made", () => {
    expect(
      executableSource(SAVE_SERVICE),
      `${SAVE_SERVICE} must pass guestRemovalsRequested from the RESOLVED removals (guestPlan.removedGuests). A resent code's sentence claims who it covers has not changed; PromoRedemptionGuestTarget.bookingGuest is onDelete: Cascade and a parked edit still deletes the removed guest rows, so an edit carrying a removal narrows the coverage while the stored discount is written back untouched (#3179).`,
    ).toContain("guestRemovalsRequested: guestPlan.removedGuests.length > 0");

    const quote = executableSource(QUOTE_ROUTE);
    expect(
      quote.split("guestRemovalsRequested: removedGuests.length > 0").length - 1,
      `${QUOTE_ROUTE} must pass the same resolved removals on BOTH branches that build the notice (the parked response and the in-progress preview), or the preview promises a coverage the save it is previewing then narrows (#3179).`,
    ).toBe(2);
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

/**
 * THE HALF THE DISK SCAN BELOW CANNOT SEE.
 *
 * The save decides whether to warn the member by asking the promotion helper
 * whether it ran, not by re-reading the pricing branch — because there are TWO
 * stubs and the caller can see only one of them. An in-progress edit that prices
 * normally takes neither of the caller's own stub branches, calls the helper,
 * and gets the helper's internal stub back. `promoEngineRan` is the one answer
 * both stubs give, and this is where it is exercised for real rather than read
 * off disk.
 */
describe("applyPromoCodeChanges reports whether the promotion engine ran (#3179)", () => {
  const tx = { promoCode: { findUnique: vi.fn() } };

  function baseArgs(overrides: Record<string, unknown>) {
    return {
      booking: {
        memberId: "m1",
        lodgeId: "lodge-1",
        promoRedemption: null,
        discountCents: 0,
        promoAdjustmentCents: 0,
      } as never,
      bookingId: "b1",
      input: {} as never,
      inProgressPlan: null,
      newCheckIn: new Date("2026-08-01T00:00:00.000Z"),
      newTotalPriceCents: 20_000,
      guestNightRates: [],
      // #3123: the club's own calendar day is a required argument here. This
      // call site is not about a date boundary, so the frozen clock's day is
      // what it should be.
      todayAtClub: requireCalendarDate("2026-07-01"),
      ...overrides,
    };
  }

  it("reports that it did NOT run on an in-progress plan", async () => {
    const result = await applyPromoCodeChanges(
      tx as never,
      baseArgs({
        inProgressPlan: {
          newDiscountCents: 1_500,
          newPromoAdjustmentCents: -1_500,
        },
      }) as never,
    );

    expect(result.promoEngineRan).toBe(false);
    // The figures really are carried across rather than recomputed, which is
    // what makes the dropped request a drop rather than a reprice.
    expect(result.newDiscountCents).toBe(1_500);
    expect(result.promoChanged).toBe(false);
    expect(result.promoRemoved).toBe(false);
  });

  it("reports that it DID run on an ordinary edit — the CONTROL", async () => {
    // Without this the flag could be hard-wired to `false` and every assertion
    // above would still pass, while every ordinary edit started warning members
    // about a promo change they never asked for.
    const result = await applyPromoCodeChanges(tx as never, baseArgs({}) as never);

    expect(result.promoEngineRan).toBe(true);
    expect(result.promoChanged).toBe(false);
    expect(result.promoRemoved).toBe(false);
  });
});
