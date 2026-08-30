/**
 * Editing a booking that is already under way, in two rules that share one
 * function.
 *
 * **#2736 — price the nights a guest holds, not their envelope.**
 * `BookingGuestNight` is the canonical night set; `stayStart`/`stayEnd` is the
 * derived half-open envelope (INV-DATE-012). `buildInProgressGuestRangePlan`
 * used to carry only the envelope, so an edit to a stay in progress priced,
 * quoted and persisted a SPARSE guest as one continuous run — the gap night was
 * charged, written back as a `BookingGuestNight` row and reserved a bed
 * (INV-MOD-025).
 *
 * **#2743 — sell only the nights the edit creates.** The added-nights leg ran
 * from a guest's own last held night to the new check-out whether or not the
 * check-out had moved, so a #713 partial-stay guest who had already gone home
 * was put back on the booking for the rest of its nights and charged for them by
 * an edit that changed nothing else. It now starts at the booking's OLD
 * check-out as well, so `[bookingCheckOut, newCheckOut)` is the only ground it
 * can cover.
 *
 * Three parts to this file, and the FIRST is the one that makes both changes
 * safe:
 *
 *  1. `contiguous stays` re-implements the pre-#2736 arithmetic — untouched by
 *     #2743, so it is still the historical answer — and compares the plan
 *     against it over a matrix of ordinary edits. Every case must either agree
 *     to the cent, to the night and to the thrown error, or differ by EXACTLY
 *     the nights #2743 stops selling, derived from the legacy answer rather than
 *     recomputed from the implementation's own formula. Nothing else may move,
 *     in either direction.
 *  2. `a sparse stay` covers what #2736 changed, including the two shapes where
 *     real money moved the wrong way: a mid-stay REMOVAL and a SHORTENED
 *     check-out both used to refund the guest for gap nights they had never been
 *     charged for in the first place.
 *  3. `#2743` covers the re-admission itself, boundary by boundary. The
 *     discriminator is NOT "has the guest gone home" — it is whether their held
 *     nights reach the BOOKING'S own check-out — so the cases are: a guest who
 *     runs to it, one whose stay ends on the check-out day (#2029), one who is
 *     in the lodge tonight but leaves early, and one who went home a week ago.
 *     Plus the state the fix newly makes reachable (a check-out ahead of the
 *     last night anybody holds), the refusal it newly makes (proved re-runnable
 *     with the date it names), and the two things it deliberately does NOT do.
 */
import { describe, expect, it } from "vitest";
import {
  buildInProgressGuestRangePlan,
  type BuildInProgressGuestRangePlanInput,
} from "@/lib/booking-edit-guest-ranges";
import {
  calculateBookingPrice,
  type GroupDiscountConfig,
  type SeasonRateData,
} from "@/lib/pricing";
import { eachDateOnlyInRange, normalizeDateOnlyForTimeZone } from "@/lib/date-only";
import { storedSoldPriceEvidenceForGuest } from "@/lib/stored-sold-price-evidence";

/**
 * The zone the LEGACY oracle below reads, named rather than left to
 * `normalizeDateOnlyForTimeZone`'s `APP_TIME_ZONE` default, which #3123 deletes.
 *
 * It is New Zealand because that is what `APP_TIME_ZONE` resolves to here — CI
 * sets no `TZ` — so naming it transcribes the pre-#2736 code exactly rather than
 * modernising the oracle. On the UTC-midnight `@db.Date` values this file feeds
 * it, that read is the identity, which is what makes the oracle agree with the
 * shipped `storedDateOnly` the implementation now uses.
 */
const CLUB_ZONE = "Pacific/Auckland";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const key = (d: Date) => d.toISOString().slice(0, 10);

const MEMBER_TYPE = "type-member";
const LOW = 5000; // per adult member night, early season
const HIGH = 9000; // per adult member night, from 2026-08-23

/**
 * Two seasons with different nightly rates, so "priced per night" and "one rate
 * times a night count" cannot possibly agree. Every expectation below is built
 * from the per-night rates, never from a multiplication.
 */
const SEASONS: SeasonRateData[] = [
  {
    seasonId: "s-low",
    startDate: D("2026-08-01"),
    endDate: D("2026-08-22"),
    rates: [
      { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: LOW },
    ],
  },
  {
    seasonId: "s-high",
    startDate: D("2026-08-23"),
    endDate: D("2026-09-30"),
    rates: [
      { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: HIGH },
    ],
  },
];

/** The season rate for one night, straight off the table above. */
function rateFor(night: string): number {
  return night <= "2026-08-22" ? LOW : HIGH;
}

/** What a set of nights genuinely costs, summed night by night in cents. */
function priceNights(nights: string[]): number {
  return nights.reduce((sum, night) => sum + rateFor(night), 0);
}

type TestGuest = {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: "ADULT";
  isMember: true;
  memberId: string;
  rateMembershipTypeId: string;
  rateSource: "OWN_TYPE";
  stayStart: Date;
  stayEnd: Date;
  // `priceCents` is on the real `BookingGuestNight` row and is what
  // `lockedNightPricesForGuest` reads on the other edit paths — carried here so
  // a test can show whether this plan consults it. Optional, because most cases
  // do not care.
  nights?: Array<{ stayDate: Date; priceCents?: number }>;
  priceCents: number;
};

/**
 * A guest built from the nights they hold. `stayStart`/`stayEnd` is derived the
 * way the writer derives it — first night, last night + 1 — so the envelope and
 * the night rows always agree, exactly as they do in the database.
 *
 * `withNightRows: false` drops the rows and leaves only the envelope: a legacy
 * guest from before `BookingGuestNight` existed, or one on a booking created by
 * approving a booking request, which still writes no rows at all (#2739). That
 * guest must keep behaving exactly as before.
 *
 * `withStoredPrices` puts the CURRENT season rate on each row, which is every
 * booking where no rate has moved since it was made (#2744). Those guests come
 * out exactly where they came out before — the locked price and the fresh lookup
 * are the same number — which is what the matrix below uses to separate "honours
 * what was paid" from "changes ordinary bookings".
 *
 * #3031 made it default to TRUE, and the default is load-bearing rather than
 * convenient. A stay whose rows carry no price no longer prices at all — it is
 * the unpriceable case, refused rather than valued at today's rate — so a
 * fixture without stored prices is now a fixture ABOUT that refusal, and every
 * case that is about something else has to carry real prices to reach the code
 * it is testing.
 *
 * `driftCents` moves the guest's stored TOTAL away from the sum of their rows,
 * which is the one unpriceable case a guest whose rows are all present and
 * priced can still be in (`STORED_TOTAL_MISMATCH`).
 */
function guestFromNights(
  nights: string[],
  id = "g1",
  withNightRows = true,
  withStoredPrices = true,
  driftCents = 0,
): TestGuest {
  const sorted = [...nights].sort();
  const last = sorted[sorted.length - 1];
  return {
    id,
    firstName: "Guest",
    lastName: id,
    ageTier: "ADULT",
    isMember: true,
    memberId: `m-${id}`,
    rateMembershipTypeId: MEMBER_TYPE,
    rateSource: "OWN_TYPE",
    stayStart: D(sorted[0]),
    stayEnd: new Date(D(last).getTime() + 86_400_000),
    ...(withNightRows
      ? {
          nights: sorted.map((night) => ({
            stayDate: D(night),
            ...(withStoredPrices ? { priceCents: rateFor(night) } : {}),
          })),
        }
      : {}),
    priceCents: priceNights(sorted) + driftCents,
  };
}

function planInput(args: {
  guests: TestGuest[];
  editableFrom: string;
  newCheckOut: string;
  removeGuestIds?: string[];
  addGuests?: BuildInProgressGuestRangePlanInput["addGuests"];
  checkIn?: string;
  checkOut?: string;
}): BuildInProgressGuestRangePlanInput {
  const totalPriceCents = args.guests.reduce((s, g) => s + g.priceCents, 0);
  const starts = args.guests.map((g) => g.stayStart.getTime());
  const ends = args.guests.map((g) => g.stayEnd.getTime());
  return {
    booking: {
      id: "booking-under-way",
      checkIn: args.checkIn ? D(args.checkIn) : new Date(Math.min(...starts)),
      checkOut: args.checkOut ? D(args.checkOut) : new Date(Math.max(...ends)),
      totalPriceCents,
      discountCents: 0,
      promoAdjustmentCents: 0,
      finalPriceCents: totalPriceCents,
      guests: args.guests,
    },
    editableFrom: D(args.editableFrom),
    newCheckOut: D(args.newCheckOut),
    seasons: SEASONS,
    ...(args.removeGuestIds ? { removeGuestIds: args.removeGuestIds } : {}),
    ...(args.addGuests ? { addGuests: args.addGuests } : {}),
  };
}


/**
 * The plan, insisting it priced (#3031).
 *
 * `buildInProgressGuestRangePlan` now answers with a discriminated result, and
 * unwrapping it through an assertion rather than a cast is deliberate: a fixture
 * that drifts into the unpriceable case fails HERE, naming the causes, rather
 * than failing later on an expectation about a number that was never produced.
 */
function pricedPlan(input: BuildInProgressGuestRangePlanInput) {
  const result = buildInProgressGuestRangePlan(input);
  if (result.kind !== "priced") {
    throw new Error(
      `Expected a priced plan, got financial review: ${result.occurrences
        .map((occurrence) => `${occurrence.bookingGuestId}:${occurrence.cause}`)
        .join(", ")}`,
    );
  }
  return result.plan;
}

/** The review verdict, insisting the edit was NOT priced (#3031). */
function reviewOf(input: BuildInProgressGuestRangePlanInput) {
  const result = buildInProgressGuestRangePlan(input);
  if (result.kind !== "financial_review_required") {
    throw new Error(
      "Expected financial review, got a priced plan — an amount was invented",
    );
  }
  return result.occurrences;
}

// ---------------------------------------------------------------------------
// 1. The safety property: nothing about a contiguous stay moves.
// ---------------------------------------------------------------------------

/**
 * The pre-#2736 arithmetic, re-implemented from the shipped source rather than
 * described: every guest is reduced to `[stayStart, stayEnd)`, the future window
 * is priced as a bare range, and the persisted nights are that range expanded.
 *
 * This exists so "contiguous stays are byte-identical" is a PROOF over a matrix
 * rather than a claim in a PR body. It is deliberately not shared with the
 * implementation — a helper both sides called could drift together and prove
 * nothing.
 *
 * **#2743 deliberately did not touch it.** It is the historical answer, and the
 * matrix now compares against it PLUS a stated correction (`backfilledNights`
 * below) rather than against a second copy of the new formula. That keeps the
 * blast radius measurable: every difference the matrix sees has to be explained
 * by the nights #2743 stops selling, and by nothing else.
 */
function legacyPlan(input: BuildInProgressGuestRangePlanInput) {
  const editableFrom = normalizeDateOnlyForTimeZone(input.editableFrom, CLUB_ZONE);
  const bookingCheckIn = normalizeDateOnlyForTimeZone(
    input.booking.checkIn,
    CLUB_ZONE,
  );
  const bookingCheckOut = normalizeDateOnlyForTimeZone(
    input.booking.checkOut,
    CLUB_ZONE,
  );
  const newCheckOut = normalizeDateOnlyForTimeZone(input.newCheckOut, CLUB_ZONE);
  const addGuests = input.addGuests ?? [];
  const removeSet = new Set(input.removeGuestIds ?? []);
  const max = (a: Date, b: Date) => (a > b ? a : b);
  const min = (a: Date, b: Date) => (a < b ? a : b);

  if (newCheckOut < editableFrom) {
    throw new Error("Check-out cannot move before NZ tomorrow");
  }
  if (addGuests.length > 0 && newCheckOut <= editableFrom) {
    throw new Error("Guests can only be added when the booking has future nights");
  }

  const priceRange = (
    start: Date,
    end: Date,
    guest: { ageTier: "ADULT"; isMember: boolean; rateMembershipTypeId: string },
  ) => {
    const s = normalizeDateOnlyForTimeZone(start, CLUB_ZONE);
    const e = normalizeDateOnlyForTimeZone(end, CLUB_ZONE);
    if (e <= s) return 0;
    return calculateBookingPrice(
      s,
      e,
      [
        {
          ageTier: guest.ageTier,
          isMember: guest.isMember,
          rateMembershipTypeId: guest.rateMembershipTypeId,
        },
      ],
      input.seasons,
    ).totalPriceCents;
  };

  const existing = input.booking.guests.map((guest) => {
    const stayStart = normalizeDateOnlyForTimeZone(
      guest.stayStart ?? bookingCheckIn,
      CLUB_ZONE,
    );
    const stayEnd = normalizeDateOnlyForTimeZone(
      guest.stayEnd ?? bookingCheckOut,
      CLUB_ZONE,
    );
    const oldFuturePriceCents = priceRange(
      max(stayStart, editableFrom),
      stayEnd,
      guest as never,
    );
    const removedFromFuture = removeSet.has(guest.id);
    const proposedStayEnd = removedFromFuture
      ? min(stayEnd, editableFrom)
      : newCheckOut;
    const futureStart = max(stayStart, min(editableFrom, stayEnd));
    const newFuturePriceCents = removedFromFuture
      ? 0
      : priceRange(futureStart, proposedStayEnd, guest as never);
    const futureDeltaCents = newFuturePriceCents - oldFuturePriceCents;
    return {
      id: guest.id,
      stayStart,
      stayEnd: proposedStayEnd,
      // The guest's stay end BEFORE the edit. Carried only so the #2743
      // correction below can be derived from this answer; the arithmetic above
      // is untouched.
      originalStayEnd: stayEnd,
      futureStart,
      removedFromFuture,
      priceCents: guest.priceCents + futureDeltaCents,
      oldFuturePriceCents,
      newFuturePriceCents,
      futureDeltaCents,
      // What `splitContiguousNights` used to expand, and what `syncGuestNights`
      // then wrote back as this guest's night rows.
      nights: eachDateOnlyInRange(stayStart, proposedStayEnd).map(key),
    };
  });

  const added = addGuests.map((guest) => ({
    stayStart: editableFrom,
    stayEnd: newCheckOut,
    priceCents: priceRange(editableFrom, newCheckOut, guest as never),
    nights: eachDateOnlyInRange(editableFrom, newCheckOut).map(key),
  }));

  const futureActiveGuestCount =
    existing.filter((e) => !e.removedFromFuture && e.futureStart < e.stayEnd)
      .length + added.length;
  if (newCheckOut > editableFrom && futureActiveGuestCount === 0) {
    throw new Error("Booking must have at least one guest for future nights");
  }

  const newTotalPriceCents =
    existing.reduce((s, e) => s + e.priceCents, 0) +
    added.reduce((s, a) => s + a.priceCents, 0);

  return {
    existing,
    added,
    futureActiveGuestCount,
    newTotalPriceCents,
    newFinalPriceCents: newTotalPriceCents + input.booking.promoAdjustmentCents,
    priceDiffCents:
      newTotalPriceCents +
      input.booking.promoAdjustmentCents -
      input.booking.finalPriceCents,
    futureExistingDeltaCents: existing.reduce((s, e) => s + e.futureDeltaCents, 0),
    capacityGuestRanges: [
      ...existing
        .filter((e) => !e.removedFromFuture && e.futureStart < e.stayEnd)
        .map((e) => ({ stayStart: e.futureStart, stayEnd: e.stayEnd })),
      ...added.map((a) => ({ stayStart: a.stayStart, stayEnd: a.stayEnd })),
    ],
  };
}

function run<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * The nights the PRE-#2743 arithmetic sold this guest between their own last
 * night and the booking's OLD check-out — the back-fill the fix stops, and the
 * only thing that may differ between the legacy answer and the plan.
 *
 * Derived entirely from the legacy entry (`futureStart`, the guest's original
 * `stayEnd`, and the proposed one) plus the booking's stored check-out, so it
 * states the CLAIM — "an edit stops selling nights it did not create" — instead
 * of re-running the implementation's own `maxDate(...)` chain and agreeing with
 * it by construction.
 */
function backfilledNights(
  entry: { originalStayEnd: Date; stayEnd: Date; futureStart: Date },
  bookingCheckOut: Date,
): string[] {
  const from =
    entry.futureStart > entry.originalStayEnd
      ? entry.futureStart
      : entry.originalStayEnd;
  const bound = from > bookingCheckOut ? from : bookingCheckOut;
  const to = bound < entry.stayEnd ? bound : entry.stayEnd;
  return eachDateOnlyInRange(from, to).map(key);
}

describe("#2736/#2743 contiguous stays", () => {
  // Ordinary stays, one per row: the nights the guest holds, then every edit
  // window and new check-out worth trying against them. Deliberately spans the
  // 08-22/08-23 season boundary in both directions so a rate change inside the
  // repriced window is exercised, not just a flat rate.
  const STAYS: string[][] = [
    ["2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"],
    ["2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23"],
    ["2026-08-22", "2026-08-23", "2026-08-24"],
    ["2026-08-24"],
  ];
  // The booking every case is an edit to. Three of the four stays above finish
  // before it does, which is exactly the #713 partial-stay shape #2743 is about
  // — so this matrix is not only the safety net for #2736, it is also where the
  // new rule's blast radius is measured.
  const BOOKING_CHECK_IN = "2026-08-18";
  const BOOKING_CHECK_OUT_KEY = "2026-08-25";
  const BOOKING_CHECK_OUT = D(BOOKING_CHECK_OUT_KEY);
  const EDITABLE_FROM = [
    "2026-08-19",
    "2026-08-21",
    "2026-08-22",
    "2026-08-23",
    "2026-08-25",
    "2026-08-26",
  ];
  const NEW_CHECK_OUT = [
    "2026-08-21",
    "2026-08-23",
    "2026-08-25",
    "2026-08-26",
    "2026-08-28",
  ];

  // What the guest's stored `BookingGuestNight` rows look like. ONE of the four
  // is priced, and the other three are the reasons an edit can no longer be
  // priced at all (#3031). The matrix asks a different question of each:
  //
  //  - `rows+prices` is the ordinary live booking whose rates have not moved
  //    since it was made, so #2744's locked prices ARE the current rates and
  //    every number has to come out the same as the pre-#2736 arithmetic.
  //    Without this row the matrix could not tell "honours what was paid" apart
  //    from "changes ordinary bookings", because the others carry no price to
  //    honour. It is the only variant the equivalence claim is ABOUT.
  //  - `drifted` is that same guest with a stored TOTAL that no longer matches
  //    the sum of their rows. It used to be priced anyway — the per-night
  //    amounts written back fell back to an even split of the total across the
  //    nights — and that output became the evidence the NEXT edit read as a sold
  //    price. #3031 deletes the fallback: this is `STORED_TOTAL_MISMATCH` and it
  //    goes to a person. It is the only unpriceable case reachable by a guest
  //    whose rows are all present and priced, which is why it is worth a whole
  //    matrix pass.
  //  - `rows` is a guest whose rows arrive WITHOUT their price. The schema makes
  //    `BookingGuestNight.priceCents` NOT NULL and both production loaders ask
  //    for it, so this is not a state the database can hold — it is the shape a
  //    THINNER `select` would produce, and it is here because that select is a
  //    one-word edit away and the plan cannot tell it from a guest who was never
  //    priced. `in-progress-edit-sold-price-census.test.ts` is what stops it
  //    happening; this row is what proves the degradation stays safe if it did.
  //  - `envelope` is a guest with no rows at all: pre-`BookingGuestNight`, or a
  //    booking created by approving a request, which still writes none (#2739).
  const ROW_VARIANTS = [
    { label: "rows+prices", withNightRows: true, withStoredPrices: true, driftCents: 0 },
    { label: "drifted", withNightRows: true, withStoredPrices: true, driftCents: 101 },
    { label: "rows", withNightRows: true, withStoredPrices: false, driftCents: 0 },
    { label: "envelope", withNightRows: false, withStoredPrices: false, driftCents: 0 },
  ];

  /**
   * Why each variant cannot be priced (#3031). `rows+prices` has no entry
   * because it always can.
   */
  const EXPECTED_CAUSE: Record<string, string> = {
    // Rows all present and priced, and a stored total that no longer matches
    // their sum. Nothing is missing; the evidence simply does not add up.
    drifted: "STORED_TOTAL_MISMATCH",
    // Rows present, no usable price on any of them.
    rows: "NO_STORED_NIGHT_PRICES",
    // No rows at all, so the envelope says which nights and nothing says what
    // they cost.
    envelope: "NO_STORED_NIGHT_PRICES",
  };

  /**
   * How the 960 land, pinned so a later change cannot quietly move cases between
   * buckets. Measured, then asserted — see the per-variant reasoning below the
   * loop for why the four variants no longer agree.
   */
  const EXPECTED_BUCKETS = {
    // 100 for the priced variant, plus the 56 cases per variant that the LEGACY
    // arithmetic itself refused and that every variant still refuses identically.
    identical: 100 + 3 * 56,
    corrected: 135,
    refused: 4 * 5,
    // Everything the priced variant valued (100 + 135), less those 56 legacy
    // refusals, for each of the three variants with nothing exact to read.
    review: 3 * (100 + 135 - 56),
  };
  const EXPECTED_PRICED_VARIANT_BUCKETS = {
    identical: 100,
    corrected: 135,
    refused: 5,
    review: 0,
  };

  const cases: Array<{
    name: string;
    variant: string;
    input: () => BuildInProgressGuestRangePlanInput;
  }> = [];
  for (const [stayIndex, stay] of STAYS.entries()) {
    for (const variant of ROW_VARIANTS) {
      for (const editableFrom of EDITABLE_FROM) {
        for (const newCheckOut of NEW_CHECK_OUT) {
          for (const removed of [false, true]) {
            cases.push({
              name: `stay#${stayIndex} ${variant.label} from=${editableFrom} to=${newCheckOut} removed=${removed}`,
              variant: variant.label,
              input: () =>
                planInput({
                  // A second, always-contiguous guest so a removal does not
                  // trivially empty the booking on every row.
                  guests: [
                    guestFromNights(
                      stay,
                      "g1",
                      variant.withNightRows,
                      variant.withStoredPrices,
                      variant.driftCents,
                    ),
                    guestFromNights(
                      ["2026-08-20", "2026-08-21", "2026-08-22"],
                      "g2",
                      variant.withNightRows,
                      variant.withStoredPrices,
                      variant.driftCents,
                    ),
                  ],
                  editableFrom,
                  newCheckOut,
                  ...(removed ? { removeGuestIds: ["g1"] } : {}),
                  checkIn: BOOKING_CHECK_IN,
                  checkOut: BOOKING_CHECK_OUT_KEY,
                }),
            });
          }
        }
      }
    }
  }

  it(`differs from the pre-#2736 arithmetic by exactly the back-filled nights, on all ${cases.length} ordinary edits`, () => {
    expect(cases.length).toBeGreaterThan(600);
    // How the 960 land. Pinned so a later change cannot quietly move cases
    // between buckets.
    //
    // The grid is four row variants (#2744) over the 240 edits below, and since
    // #3031 they DO NOT all land identically — the buckets asserted above are
    // what says so, case by case. Only `rows+prices` is priced at all; the other
    // three carry no exact evidence to read and every edit on them is
    // `financial_review_required`. That separation IS the #3031 half of this
    // matrix, and it is the assertion that would fail if a fallback came back:
    // an estimator would move those cases out of `review` and into `identical`
    // or `corrected`.
    //
    // What survives from #2744 is narrower and still load-bearing: on the ONE
    // variant that can be priced, every ordinary edit agrees with the pre-#2736
    // arithmetic to the cent, so "honours what was paid" is still separated from
    // "changes ordinary bookings". Per-variant buckets are counted and compared
    // as well as totalled, so a change that moved only the priced variant could
    // not hide inside a total.
    //
    // Read the proportions as a property of THIS matrix, not of the club's
    // diary: three of its four stays deliberately finish before the booking
    // does, and so does the companion guest, because that is the shape under
    // test. A booking whose guests all stay to the check-out — the ordinary one
    // — lands in `identical` every time, which is what the #2029 suite and the
    // whole-run guest in the #2743 block below demonstrate directly.
    let identical = 0;
    let corrected = 0;
    let refused = 0;
    let review = 0;
    /** Per variant: cases the LEGACY arithmetic itself refused. */
    let identicalRefusals = 0;
    const byVariant = new Map<
      string,
      {
        identical: number;
        corrected: number;
        refused: number;
        review: number;
      }
    >(
      ROW_VARIANTS.map((variant) => [
        variant.label,
        { identical: 0, corrected: 0, refused: 0, review: 0 },
      ]),
    );
    const tally = (
      testCase: { variant: string },
      bucket: "identical" | "corrected" | "refused" | "review",
    ) => {
      const counts = byVariant.get(testCase.variant);
      if (!counts) throw new Error(`unknown row variant ${testCase.variant}`);
      counts[bucket] += 1;
    };

    for (const testCase of cases) {
      const legacy = run(() => legacyPlan(testCase.input()));
      const current = run(() => buildInProgressGuestRangePlan(testCase.input()));

      if (!legacy.ok) {
        // A refusal the pre-#2736 arithmetic already made. #2743 only ever
        // withholds nights, so it can never turn one of these back into a save.
        // #3031 leaves them where they are too: these guards run before any
        // money is looked at, so they fire for every row variant alike.
        expect(current.ok, testCase.name).toBe(false);
        expect(current.ok ? "" : current.error, testCase.name).toBe(legacy.error);
        identical += 1;
        if (testCase.variant === ROW_VARIANTS[0].label) identicalRefusals += 1;
        tally(testCase, "identical");
        continue;
      }

      const before = legacy.value;

      // The corrected expectation: the legacy answer with the back-filled
      // nights taken out of it, guest by guest. Everything else — the old-price
      // leg, the futureStart anchor, the proposed envelope, the added guests —
      // must be untouched.
      const backfill = before.existing.map((entry) =>
        backfilledNights(entry, BOOKING_CHECK_OUT),
      );
      const withheldTotalCents = backfill.reduce(
        (sum, nights) => sum + priceNights(nights),
        0,
      );
      const expectedExisting = before.existing.map((entry, index) => {
        const withheld = new Set(backfill[index]);
        const withheldCents = priceNights(backfill[index]);
        const nights = entry.nights.filter((night) => !withheld.has(night));
        return {
          id: entry.id,
          stayStart: key(entry.stayStart),
          stayEnd: key(entry.stayEnd),
          futureStart: key(entry.futureStart),
          priceCents: entry.priceCents - withheldCents,
          oldFuturePriceCents: entry.oldFuturePriceCents,
          newFuturePriceCents: entry.newFuturePriceCents - withheldCents,
          futureDeltaCents: entry.futureDeltaCents - withheldCents,
          removedFromFuture: entry.removedFromFuture,
          nights,
          futureNights: nights.filter((night) => night >= key(entry.futureStart)),
        };
      });
      const expectedActive = expectedExisting.filter(
        (entry) => !entry.removedFromFuture && entry.futureNights.length > 0,
      );
      const expectedActiveCount = expectedActive.length + before.added.length;

      if (
        expectedActiveCount === 0 &&
        testCase.input().newCheckOut > testCase.input().editableFrom
      ) {
        // Nobody is left holding a future night once the back-fill stops, so the
        // save is refused instead of quietly selling those nights to a guest who
        // has gone. Which of the two sentences it uses is pinned by name in the
        // #2743 block below, not guessed at here.
        expect(current.ok, testCase.name).toBe(false);
        expect(current.ok ? "" : current.error, testCase.name).toMatch(
          /(No remaining guest is booked for a night on or after|at least one guest for future nights)/,
        );
        refused += 1;
        tally(testCase, "refused");
        continue;
      }

      expect(current.ok, testCase.name).toBe(true);
      if (!current.ok) continue;

      // #3031: THREE OF THE FOUR ROW VARIANTS NO LONGER PRICE AT ALL, and that
      // is the whole change this matrix now measures.
      //
      // Before, all four landed in identical buckets, and that was the proof
      // that reading the sold price changed nothing about ordinary bookings. It
      // was also, read the other way, the proof that a guest with NO recoverable
      // price was being valued by the same arithmetic as one whose rows recorded
      // exactly what they paid — from today's rate table on the credit leg, and
      // from an even split on the rows written back. Epic #2797 prohibits both.
      //
      // So `rows+prices` — the ordinary live booking — must still land case for
      // case where it always did, and the other three must return
      // `financial_review_required` naming why, with no numeric result to read.
      // The structural refusals above are deliberately checked BEFORE this: an
      // edit that cannot stand up as a STAY is refused as one whatever the state
      // of its money, which is what keeps the two verdicts separable.
      if (testCase.variant !== "rows+prices") {
        expect(current.value.kind, testCase.name).toBe(
          "financial_review_required",
        );
        if (current.value.kind !== "financial_review_required") continue;
        // Both guests carry the same variant, so both strands are unpriceable —
        // including the one this edit does not touch, because the writer
        // rewrites every existing guest's night rows.
        expect(
          current.value.occurrences.map((occurrence) => ({
            bookingGuestId: occurrence.bookingGuestId,
            cause: occurrence.cause,
          })),
          testCase.name,
        ).toEqual([
          { bookingGuestId: "g1", cause: EXPECTED_CAUSE[testCase.variant] },
          { bookingGuestId: "g2", cause: EXPECTED_CAUSE[testCase.variant] },
        ]);
        review += 1;
        tally(testCase, "review");
        continue;
      }

      expect(current.value.kind, testCase.name).toBe("priced");
      if (current.value.kind !== "priced") continue;
      const plan = current.value.plan;

      expect(plan.newTotalPriceCents, testCase.name).toBe(
        before.newTotalPriceCents - withheldTotalCents,
      );
      expect(plan.newFinalPriceCents, testCase.name).toBe(
        before.newFinalPriceCents - withheldTotalCents,
      );
      expect(plan.priceDiffCents, testCase.name).toBe(
        before.priceDiffCents - withheldTotalCents,
      );
      expect(plan.futureExistingDeltaCents, testCase.name).toBe(
        before.futureExistingDeltaCents - withheldTotalCents,
      );
      expect(plan.futureActiveGuestCount, testCase.name).toBe(expectedActiveCount);

      expect(
        plan.proposedExistingGuests.map((entry) => ({
          id: entry.guest.id,
          stayStart: key(entry.stayStart),
          stayEnd: key(entry.stayEnd),
          futureStart: key(entry.futureStart),
          priceCents: entry.priceCents,
          oldFuturePriceCents: entry.oldFuturePriceCents,
          newFuturePriceCents: entry.newFuturePriceCents,
          futureDeltaCents: entry.futureDeltaCents,
          removedFromFuture: entry.removedFromFuture,
          nights: entry.nights.map(key),
          futureNights: entry.futureNights.map(key),
        })),
        testCase.name,
      ).toEqual(expectedExisting);

      expect(
        plan.capacityGuestRanges.map((range) => ({
          stayStart: key(range.stayStart),
          stayEnd: key(range.stayEnd),
          nights: range.nights.map(key),
        })),
        testCase.name,
      ).toEqual([
        ...expectedActive.map((entry) => ({
          stayStart: entry.futureStart,
          stayEnd: entry.stayEnd,
          nights: entry.futureNights,
        })),
        ...before.added.map((range) => ({
          stayStart: key(range.stayStart),
          stayEnd: key(range.stayEnd),
          nights: range.nights,
        })),
      ]);

      if (withheldTotalCents === 0) {
        identical += 1;
        tally(testCase, "identical");
        // Untouched by #2743, so the whole #2736 property still holds here: the
        // `nights` on a capacity range are the old envelope expanded, and
        // `countActiveGuestsForNight` sees the identical occupancy.
        for (const range of plan.capacityGuestRanges) {
          expect(range.nights.map(key), testCase.name).toEqual(
            eachDateOnlyInRange(range.stayStart, range.stayEnd).map(key),
          );
        }
      } else {
        corrected += 1;
        tally(testCase, "corrected");
        // The direction is the whole point: an edit can only ever cost the
        // member LESS than it did, never more.
        expect(withheldTotalCents, testCase.name).toBeGreaterThan(0);
        expect(plan.priceDiffCents, testCase.name).toBeLessThan(
          before.priceDiffCents,
        );
      }

      // #2744: the per-night amounts are new, so the legacy plan has nothing to
      // compare them against — but they are what gets written to
      // `BookingGuestNight.priceCents`, so on every one of these edits they must
      // be one integer per night that adds back to the guest's total. Anything
      // else is a phantom balance the moment Xero rebuilds its lines.
      //
      // ONE carve-out, and the `drifted` variant is what found it: a guest who
      // ends the edit holding NO nights at all — removed before their stay
      // begins — has nothing to distribute across. A guest whose rows account
      // for their total lands exactly on zero there, because the credit is all
      // of their nights at all of their own prices. A guest whose total has
      // DRIFTED from their rows keeps the drift, and that residual is neither
      // invented nor erased here: it is what the pre-#2736 arithmetic left too
      // (`priceCents` is compared against it above, case by case), and what to
      // do about a total that no longer matches its rows is #2745's decision.
      for (const entry of [
        ...plan.proposedExistingGuests,
        ...plan.proposedAddedGuests,
      ]) {
        expect(entry.perNightCents.length, testCase.name).toBe(
          entry.nights.length,
        );
        expect(
          entry.perNightCents.every((cents) => Number.isInteger(cents)),
          testCase.name,
        ).toBe(true);
        if (entry.nights.length > 0) {
          expect(
            entry.perNightCents.reduce((sum, cents) => sum + cents, 0),
            testCase.name,
          ).toBe(entry.priceCents);
        }
      }
    }

    // #3031: the row variants no longer land identically, and the shape of the
    // difference IS the claim. `rows+prices` is unchanged case for case — that
    // is what says an ordinary live booking prices exactly as it always did.
    // The three variants with nothing exact to read produce no number at all,
    // and every one of them that the pre-#2743 arithmetic would have PRICED is
    // now a review rather than an estimate: none of them lands in `identical`
    // or `corrected` on a case that was priced. Asserted per variant and not
    // only in the total, because a total can absorb a move in one variant that a
    // per-variant comparison cannot.
    const pricedVariant = byVariant.get("rows+prices");
    for (const variant of ROW_VARIANTS.slice(1)) {
      const counts = byVariant.get(variant.label);
      if (!counts || !pricedVariant) throw new Error("missing variant counts");
      // The refusals are structural and therefore variant-blind: the same edits
      // are refused for the same reason whatever the rows say.
      expect(counts.refused, variant.label).toBe(pricedVariant.refused);
      // Nothing is priced that was not exactly evidenced.
      expect(counts.corrected, variant.label).toBe(0);
      // Everything the priced variant valued, this one hands to a person.
      expect(counts.review, variant.label).toBe(
        pricedVariant.identical + pricedVariant.corrected - identicalRefusals,
      );
      // The only cases left in `identical` are the ones the LEGACY arithmetic
      // already refused, which this plan refuses identically before it ever
      // looks at the money.
      expect(counts.identical, variant.label).toBe(identicalRefusals);
    }
    // All refusals are the same edit, repeated once per row variant: the window
    // opens on the 23rd, the check-out stays on the 25th, and once the back-fill
    // stops nobody holds the 23rd or the 24th. The pre-#2743 arithmetic let that
    // save through by re-admitting and charging a guest who had gone; refusing
    // it is the corrected answer, and the message names the check-out that fits
    // who is actually there.
    expect({ identical, corrected, refused, review }).toEqual(EXPECTED_BUCKETS);
    expect(byVariant.get("rows+prices")).toEqual(
      EXPECTED_PRICED_VARIANT_BUCKETS,
    );
    expect(identical + corrected + refused + review).toBe(cases.length);
  });

  it("agrees on an added guest too, whose window this plan still owns", () => {
    const input = () =>
      planInput({
        guests: [guestFromNights(["2026-08-20", "2026-08-21", "2026-08-22"])],
        editableFrom: "2026-08-22",
        newCheckOut: "2026-08-26",
        addGuests: [
          {
            firstName: "New",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: true,
            memberId: "m-new",
            rateMembershipTypeId: MEMBER_TYPE,
            rateSource: "OWN_TYPE",
          },
        ],
      });

    const plan = pricedPlan(input());
    const before = legacyPlan(input());

    expect(plan.proposedAddedGuests[0].priceCents).toBe(before.added[0].priceCents);
    expect(plan.proposedAddedGuests[0].nights.map(key)).toEqual(before.added[0].nights);
    // Stated, because it is the deliberate NON-change: an added guest is
    // admitted for the booking's remaining future nights, contiguously, and this
    // plan still overrides any per-guest range the request carried.
    expect(plan.proposedAddedGuests[0].nights.map(key)).toEqual([
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
      "2026-08-25",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. What the fix changes.
// ---------------------------------------------------------------------------

describe("#2736 a sparse stay", () => {
  // Nights 20 and 22 — home on the 21st. Priced 5000 + 5000, both low season.
  const SPARSE = ["2026-08-20", "2026-08-22"];
  const COMPANION = ["2026-08-20", "2026-08-21", "2026-08-22"];

  it("keeps the gap when the check-out is extended, and charges only the new nights", () => {
    const plan = pricedPlan(
      planInput({
        guests: [guestFromNights(SPARSE)],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-25",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    // The 21st is still an absence; 23 and 24 are the genuinely-new nights.
    expect(entry.nights.map(key)).toEqual([
      "2026-08-20",
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
    ]);
    // Priced per night across the season boundary: 22 is low, 23 and 24 high.
    expect(entry.futureDeltaCents).toBe(HIGH + HIGH);
    expect(entry.priceCents).toBe(priceNights([...SPARSE, "2026-08-23", "2026-08-24"]));
    // Not a rate times a night count: the two added nights are the dearer ones.
    expect(entry.futureDeltaCents).not.toBe(2 * LOW);
  });

  it("does not refund the gap night when the guest is removed mid-stay", () => {
    // The money defect in its sharpest form. The guest slept on the 20th and is
    // taken off the rest of the booking on the 21st. Charging them for the night
    // they slept is the whole point; the envelope maths refunded 20 AND 21.
    const plan = pricedPlan(
      planInput({
        guests: [guestFromNights(SPARSE), guestFromNights(COMPANION, "g2")],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-23",
        removeGuestIds: ["g1"],
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.removedFromFuture).toBe(true);
    // They keep the 20th and pay for it.
    expect(entry.nights.map(key)).toEqual(["2026-08-20"]);
    expect(entry.priceCents).toBe(priceNights(["2026-08-20"]));
    expect(entry.futureDeltaCents).toBe(-priceNights(["2026-08-22"]));
    // The envelope answer was 2 x LOW off, which zeroed a guest who had stayed.
    expect(entry.priceCents).not.toBe(0);
  });

  it("does not refund the gap nights when the check-out is shortened", () => {
    const nights = ["2026-08-20", "2026-08-22", "2026-08-24"];
    const plan = pricedPlan(
      planInput({
        guests: [guestFromNights(nights)],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-23",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.nights.map(key)).toEqual(["2026-08-20", "2026-08-22"]);
    // Only the 24th is given up.
    expect(entry.futureDeltaCents).toBe(-priceNights(["2026-08-24"]));
    expect(entry.priceCents).toBe(priceNights(["2026-08-20", "2026-08-22"]));
    // The envelope answer dropped [23, 25) — the 23rd was never theirs.
    expect(entry.priceCents).not.toBe(
      priceNights(nights) - priceNights(["2026-08-23", "2026-08-24"]),
    );
  });

  it("does not claim a bed on the gap night", () => {
    const plan = pricedPlan(
      planInput({
        guests: [guestFromNights(SPARSE)],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-24",
      }),
    );

    expect(plan.capacityGuestRanges).toHaveLength(1);
    expect(plan.capacityGuestRanges[0].nights.map(key)).toEqual([
      "2026-08-22",
      "2026-08-23",
    ]);
    // The window is unchanged and still opens at editableFrom — it bounds which
    // nights are examined; the night set decides which are occupied.
    expect(key(plan.capacityGuestRanges[0].stayStart)).toBe("2026-08-21");
  });

  it("stops counting a guest whose remaining nights are all behind the edit window", () => {
    // Nights {20, 24}; the check-out is pulled back to the 22nd, so the 24th
    // goes and the 20th is all they have left — no future night at all. The
    // envelope test saw an open [21, 22) window and called them future-active.
    const plan = pricedPlan(
      planInput({
        guests: [
          guestFromNights(["2026-08-20", "2026-08-24"]),
          guestFromNights(COMPANION, "g2"),
        ],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-22",
      }),
    );

    expect(plan.proposedExistingGuests[0].futureNights).toEqual([]);
    expect(plan.futureActiveGuestCount).toBe(1);
    expect(plan.capacityGuestRanges.map((r) => r.memberId)).toEqual(["m-g2"]);
  });

  it("falls back to the envelope for a guest carrying no night rows at all", () => {
    // A legacy row, or a booking converted from a request (#2739): there is no
    // canonical set to read, so the envelope IS the answer for WHICH nights the
    // guest holds. #2736's fallback is unchanged.
    //
    // What #3031 changes is the MONEY, and only the money: those nights have no
    // stored price, so the edit is not priced at all. The night set the envelope
    // produced is still what the refusal reports - which is how this case can
    // still prove the fallback works, without an invented amount attached to it.
    const withRows = guestFromNights(["2026-08-20", "2026-08-21", "2026-08-22"]);
    const withoutRows = guestFromNights(
      ["2026-08-20", "2026-08-21", "2026-08-22"],
      "g1",
      false,
    );
    const inputFor = (guest: TestGuest) =>
      planInput({
        guests: [guest],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-25",
      });

    expect(withoutRows.nights).toBeUndefined();
    const occurrences = reviewOf(inputFor(withoutRows));
    expect(occurrences[0].cause).toBe("NO_STORED_NIGHT_PRICES");
    // The envelope expanded, night for night - the same nights the guest WITH
    // rows holds, which is the equivalence this case has always asserted.
    expect(
      occurrences[0].storedEvidence.nightPrices.map((night) => night.date),
    ).toEqual((withRows.nights ?? []).map((night) => key(night.stayDate)));
    // And the guest with rows still prices, over that same held set plus the
    // nights the extension buys.
    expect(
      pricedPlan(inputFor(withRows)).proposedExistingGuests[0].nights.map(key),
    ).toEqual([
      "2026-08-20",
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
    ]);
  });

  it("prices each night at its own season rate across a gap that spans the boundary", () => {
    // Nights {22, 24}: one low-season, one high-season, with the 23rd — the
    // dearer night — as the gap. Any answer that flattens to a single rate lands
    // on 2 x LOW or 2 x HIGH, and any answer that fills the gap lands on three
    // nights. Only per-night pricing over the real set gives LOW + HIGH.
    //
    // The companion holds every night of the booking, including the two this
    // edit leaves in the future. Since #2743 an edit no longer sells those
    // nights to a guest who is not booked for them, so a companion who went home
    // on the 22nd would leave the 23rd and 24th unoccupied and the save would be
    // refused before it could price anything.
    const nights = ["2026-08-22", "2026-08-24"];
    const plan = pricedPlan(
      planInput({
        guests: [
          guestFromNights(nights),
          guestFromNights(
            ["2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24"],
            "g2",
          ),
        ],
        editableFrom: "2026-08-23",
        newCheckOut: "2026-08-25",
        removeGuestIds: ["g1"],
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.nights.map(key)).toEqual(["2026-08-22"]);
    expect(entry.futureDeltaCents).toBe(-HIGH);
    expect(entry.priceCents).toBe(LOW);
    expect(entry.priceCents).not.toBe(2 * LOW);
    expect(entry.priceCents).not.toBe(HIGH);
  });

  it("extends from the guest's real last night when their stored envelope has drifted wider", () => {
    // A guest whose stored `stayEnd` claims more nights than their rows do. The
    // rows are canonical (INV-DATE-012), so nothing between the 22nd and the
    // booking's own check-out is theirs — the envelope merely imagined it. The
    // 960-case matrix cannot reach this, because it derives every envelope from
    // the rows the way the writer does.
    //
    // Under #2736 alone this was the ONE shape that billed MORE than the old
    // envelope arithmetic, because #2736 charged the imagined nights once
    // instead of cancelling them in both windows. #2743 removes the charge
    // altogether: those nights are not past the booking's check-out, so this
    // edit did not create them and cannot sell them. The money lands back on the
    // pre-#2736 answer — two nights — by a different and honest route.
    const drifted = {
      ...guestFromNights(["2026-08-20", "2026-08-21"]),
      // Two nights of rows, an envelope claiming five.
      stayEnd: D("2026-08-25"),
    };
    const plan = pricedPlan(
      planInput({
        guests: [drifted],
        editableFrom: "2026-08-22",
        newCheckOut: "2026-08-27",
        checkIn: "2026-08-20",
        checkOut: "2026-08-25",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    // Nothing of the old stay is left to reprice: the rows stop on the 21st.
    expect(entry.oldFuturePriceCents).toBe(0);
    // Their own two nights, then the two the extension genuinely adds past the
    // booking's 25th. The 22nd to the 24th stay absences — they always were.
    expect(entry.nights.map(key)).toEqual([
      "2026-08-20",
      "2026-08-21",
      "2026-08-25",
      "2026-08-26",
    ]);
    expect(entry.futureDeltaCents).toBe(
      priceNights(["2026-08-25", "2026-08-26"]),
    );
    // Not the five-night answer #2736 gave, and not a flat rate either: the two
    // added nights are both high-season.
    expect(entry.futureDeltaCents).not.toBe(
      priceNights([
        "2026-08-22",
        "2026-08-23",
        "2026-08-24",
        "2026-08-25",
        "2026-08-26",
      ]),
    );
    expect(entry.priceCents).toBe(
      drifted.priceCents + entry.futureDeltaCents,
    );
  });

  it("does NOT land back on the legacy answer when the drifted envelope runs past the booking's check-out", () => {
    // The other drift configuration, and the reason INV-MOD-025 states the money
    // direction with a scope rather than as a blanket. The case above has the
    // envelope ending exactly ON the booking's check-out, so #2743 stops selling
    // the imagined nights and the money lands back where the pre-#2736
    // arithmetic had it. Here the envelope claims the 30th while the booking
    // itself ends on the 27th.
    //
    // The pre-#2736 arithmetic compared an eight-night old window
    // [22, 30) against a five-night new one [22, 27) and produced a REFUND for
    // three nights the member never bought. #2736 removed that phantom refund
    // deliberately, and #2743 does not put it back — nothing here is sold, so
    // the delta is zero. Zero is ABOVE the legacy refund. So a shape does exist
    // in which the answer sits higher than the pre-#2736 one, it is drifted data
    // only, and it is the phantom refund's disappearance rather than a charge.
    // The 960-case matrix can never reach it: it derives every envelope from the
    // rows, the way the writer does.
    const driftedPastCheckOut = {
      ...guestFromNights(["2026-08-20", "2026-08-21"], "g1"),
      stayEnd: D("2026-08-30"),
    };
    const plan = pricedPlan(
      planInput({
        guests: [
          driftedPastCheckOut,
          guestFromNights(
            [
              "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21",
              "2026-08-22", "2026-08-23", "2026-08-24", "2026-08-25",
              "2026-08-26",
            ],
            "g2",
          ),
        ],
        editableFrom: "2026-08-22",
        newCheckOut: "2026-08-27",
        checkIn: "2026-08-18",
        checkOut: "2026-08-27",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    // Their rows are canonical, so nothing is added and nothing is taken away.
    expect(entry.nights.map(key)).toEqual(["2026-08-20", "2026-08-21"]);
    expect(entry.futureDeltaCents).toBe(0);
    expect(entry.priceCents).toBe(driftedPastCheckOut.priceCents);
    // And the legacy arithmetic's answer for the same edit, stated as the number
    // it is: a refund. Zero is strictly greater, which is the claim.
    const legacyDeltaCents =
      priceNights(["2026-08-22", "2026-08-23", "2026-08-24", "2026-08-25", "2026-08-26"]) -
      priceNights([
        "2026-08-22", "2026-08-23", "2026-08-24", "2026-08-25", "2026-08-26",
        "2026-08-27", "2026-08-28", "2026-08-29",
      ]);
    expect(legacyDeltaCents).toBeLessThan(0);
    expect(entry.futureDeltaCents).toBeGreaterThan(legacyDeltaCents);
  });

  it("sends a strand whose rows reach past its own stored stayEnd to review (#3031)", () => {
    // THE SECOND REVIEW RETURN, which the post-compose reconciliation check
    // raises — and which nothing reached until this case existed. It is a real
    // shape, not a defensive branch: `stayEnd` is a DERIVED envelope
    // (INV-DATE-012) and can disagree with the rows in either direction; the
    // suite already covers the envelope running WIDER than the rows, and this is
    // the other side, where the rows run past the envelope.
    //
    // Why the money then fails to reconcile, in the order the plan computes it:
    // `oldWindowNightKeys` is bounded by the guest's stored `stayEnd`, so the
    // night of the 22nd is NOT in the old-price window and is credited nowhere;
    // the proposed set keeps it, so it is charged again in the new one. The
    // guest's price therefore gains a night they already hold, while the rows
    // composed for them still sum to what they were sold. That is a
    // reconciliation failure like any other, and #3031's rule is that it goes to
    // a person rather than being smoothed over — smoothing it over is precisely
    // what the deleted even-split rewrite did.
    const rowsPastEnvelope = {
      ...guestFromNights(["2026-08-20", "2026-08-21", "2026-08-22"]),
      // One day short: the real envelope for those rows is the 23rd.
      stayEnd: D("2026-08-22"),
    };
    // PREMISE, so the fixture cannot silently stop being the shape under test:
    // the strand's own stored evidence is EXACT. Whatever this returns, it is
    // not the first gate.
    expect(
      storedSoldPriceEvidenceForGuest(rowsPastEnvelope, {
        checkIn: D("2026-08-20"),
        checkOut: D("2026-08-23"),
      }).kind,
    ).toBe("exact");

    const occurrences = reviewOf(
      planInput({
        guests: [rowsPastEnvelope],
        editableFrom: "2026-08-22",
        newCheckOut: "2026-08-24",
        checkIn: "2026-08-20",
        checkOut: "2026-08-23",
      }),
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      bookingGuestId: "g1",
      cause: "STORED_TOTAL_MISMATCH",
      // Nothing leaves the stay — the edit only extends it — so the identity
      // records the added night alone.
      surrenderedNightDates: [],
      addedNightDates: ["2026-08-23"],
    });
    // The evidence handed to the admin is the rows as they stand, unrewritten.
    expect(occurrences[0].storedEvidence).toEqual({
      guestTotalCents: 3 * LOW,
      nightPrices: [
        { date: "2026-08-20", priceCents: LOW },
        { date: "2026-08-21", priceCents: LOW },
        { date: "2026-08-22", priceCents: LOW },
      ],
    });
  });

  it("prices the SAME edit on the SAME guest once the envelope agrees with the rows", () => {
    // The control for the case above, and the reason it is not merely "any
    // fixture the planner happens to refuse": one field moves — the stored
    // `stayEnd` back onto the morning after the last row — and the identical
    // edit prices. So the refusal is about the drift and about nothing else.
    const plan = pricedPlan(
      planInput({
        guests: [guestFromNights(["2026-08-20", "2026-08-21", "2026-08-22"])],
        editableFrom: "2026-08-22",
        newCheckOut: "2026-08-24",
        checkIn: "2026-08-20",
        checkOut: "2026-08-23",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.nights.map(key)).toEqual([
      "2026-08-20",
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
    ]);
    // The three nights they already hold, unchanged, plus the one this edit
    // genuinely buys at current policy — and the rows add up to the price.
    expect(entry.perNightCents).toEqual([LOW, LOW, LOW, rateFor("2026-08-23")]);
    expect(entry.priceCents).toBe(3 * LOW + rateFor("2026-08-23"));
    expect(entry.perNightCents.reduce((a, b) => a + b, 0)).toBe(entry.priceCents);
  });

  it("keeps every cent an integer, with no float anywhere in the sum", () => {
    // INV-MONEY-001 / INV-MONEY-003. Every term here is a season rate in cents;
    // the plan only ever adds and subtracts them.
    const plan = pricedPlan(
      planInput({
        guests: [guestFromNights(SPARSE)],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-25",
      }),
    );

    for (const entry of plan.proposedExistingGuests) {
      expect(Number.isInteger(entry.priceCents)).toBe(true);
      expect(Number.isInteger(entry.futureDeltaCents)).toBe(true);
      expect(Number.isInteger(entry.oldFuturePriceCents)).toBe(true);
      expect(Number.isInteger(entry.newFuturePriceCents)).toBe(true);
    }
    expect(Number.isInteger(plan.newTotalPriceCents)).toBe(true);
    expect(Number.isInteger(plan.priceDiffCents)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. The one edit the night test newly refuses.
// ---------------------------------------------------------------------------

describe("#2736 the edit it now refuses", () => {
  it("refuses a shortened check-out that would leave nights nobody holds, and names the check-out that works", () => {
    // The whole booking is one sparse guest on nights {20, 22}. The officer pulls
    // the check-out back to the 22nd — so the 22nd is dropped, the 20th is behind
    // the edit window, and the booking would keep the night of the 21st with
    // nobody in it. The envelope test saw an open [21, 22) window and allowed it.
    //
    // The refusal is right; the message has to be the recoverable one, because a
    // check-out of the 21st is exactly what the officer meant.
    const build = () =>
      buildInProgressGuestRangePlan(
        planInput({
          guests: [guestFromNights(["2026-08-20", "2026-08-22"])],
          editableFrom: "2026-08-21",
          newCheckOut: "2026-08-22",
        }),
      );

    expect(build).toThrow(/No remaining guest is booked for a night on or after 2026-08-21/);
    expect(build).toThrow(/Set the check-out to 2026-08-21 instead/);
    // And plainly NOT the old sentence, which describes the rule rather than the
    // mistake — the booking does still have a guest.
    expect(build).not.toThrow(/at least one guest for future nights/);

    // #2743 clamps the suggestion at `editableFrom`. This case's own answer
    // already sat exactly there — the 20th plus one — so its wording is
    // byte-identical, which is the pin that the clamp changed nothing here. The
    // advice is followable: re-run with the 21st and the plan builds.
    const followTheAdvice = pricedPlan(
      planInput({
        guests: [guestFromNights(["2026-08-20", "2026-08-22"])],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-21",
      }),
    );
    expect(followTheAdvice.proposedExistingGuests[0].nights.map(key)).toEqual([
      "2026-08-20",
    ]);
  });

  it("keeps the original wording for the refusal it always made", () => {
    // Every guest taken off a booking that still has future nights. Nobody holds
    // anything, so there is no check-out to suggest — and this is the refusal the
    // pre-#2736 arithmetic made too, word for word.
    expect(() =>
      buildInProgressGuestRangePlan(
        planInput({
          guests: [
            guestFromNights(["2026-08-20", "2026-08-21"], "g1"),
            guestFromNights(["2026-08-20", "2026-08-21"], "g2"),
          ],
          editableFrom: "2026-08-21",
          newCheckOut: "2026-08-24",
          removeGuestIds: ["g1", "g2"],
        }),
      ),
    ).toThrow("Booking must have at least one guest for future nights");
  });
});

// ---------------------------------------------------------------------------
// 4. #2743 — an edit sells only the nights it creates.
//
// The booking these cases edit runs 18 Aug → 27 Aug. It is the 21st, so the
// edit window opens on the 22nd (`editableFrom`), and every case below is an
// ordinary officer save on a stay already under way.
//
// This was the frozen money shape the #2736 suite carried as an issue. It is
// answered now, so the pin is REWRITTEN into the cases below rather than
// deleted — the same treatment #2744 gets in section 5.
// ---------------------------------------------------------------------------

describe("#2743 a guest whose stay already ended", () => {
  const WHOLE_RUN = [
    "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22",
    "2026-08-23", "2026-08-24", "2026-08-25", "2026-08-26",
  ];
  const bookingOf = (guests: TestGuest[], newCheckOut: string) =>
    planInput({
      guests,
      editableFrom: "2026-08-22",
      newCheckOut,
      checkIn: "2026-08-18",
      checkOut: "2026-08-27",
    });

  it("is not re-admitted, and an edit that leaves the check-out alone costs nothing", () => {
    // The issue's worked example. The guest holds two nights, the 18th and the
    // 19th, and went home a week ago; the officer saves an edit that leaves the
    // dates alone. That used to add seven nights to their bill.
    //
    // NOT a name-only edit, which never reaches this plan: a name-only request
    // is identity-only on both routes and takes the price-preserving echo
    // (`buildIdentityOnlyPricing` on apply, a `priceDiffCents: 0` early return
    // on quote). The edits that DO land here are adding a guest, removing a
    // guest, moving the check-out, and a promo or member-link change.
    const departed = guestFromNights(["2026-08-18", "2026-08-19"], "g1");
    const plan = pricedPlan(
      bookingOf([departed, guestFromNights(WHOLE_RUN, "g2")], "2026-08-27"),
    );
    const [gone, present] = plan.proposedExistingGuests;

    expect(gone.futureDeltaCents).toBe(0);
    expect(gone.priceCents).toBe(departed.priceCents);
    expect(gone.nights.map(key)).toEqual(["2026-08-18", "2026-08-19"]);
    // No future night, so no bed is held for them and they do not count towards
    // the booking still having somebody in it.
    expect(gone.futureNights).toEqual([]);
    expect(plan.capacityGuestRanges.map((range) => range.memberId)).toEqual([
      "m-g2",
    ]);
    expect(plan.futureActiveGuestCount).toBe(1);
    // The guest who is actually there is unchanged, and the save moves no money
    // at all — which is what an edit that touches no date should cost.
    expect(present.futureDeltaCents).toBe(0);
    expect(plan.priceDiffCents).toBe(0);
  });

  it("keeps a sparse guest's gap when their remaining nights are all behind the window", () => {
    // #2736's shape and #2743's shape at once: in on the 18th, home on the 19th,
    // back for the 20th, gone since. The edit neither fills the gap nor re-admits
    // them.
    const plan = pricedPlan(
      bookingOf(
        [
          guestFromNights(["2026-08-18", "2026-08-20"], "g1"),
          guestFromNights(WHOLE_RUN, "g2"),
        ],
        "2026-08-27",
      ),
    );

    expect(plan.proposedExistingGuests[0].nights.map(key)).toEqual([
      "2026-08-18",
      "2026-08-20",
    ]);
    expect(plan.proposedExistingGuests[0].futureDeltaCents).toBe(0);
    expect(plan.priceDiffCents).toBe(0);
  });

  it("leaves a guest who runs to the booking's own check-out exactly as they were, extension and all", () => {
    // The ordinary stay, and the guest the bound would start stealing nights
    // from if it ever reached further back than the booking's check-out. Their
    // last held night is the night before it, so `heldEndExclusive` already
    // EQUALS `bookingCheckOut` and the new bound is a no-op by construction —
    // which is exactly why this case cannot fail on a revert, and why the
    // boundary it is named after needs the case below as well.
    const plan = pricedPlan(
      bookingOf([guestFromNights(WHOLE_RUN, "g1")], "2026-08-29"),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.futureDeltaCents).toBe(
      priceNights(["2026-08-27", "2026-08-28"]),
    );
    expect(entry.nights.map(key)).toEqual([...WHOLE_RUN, "2026-08-27", "2026-08-28"]);
    expect(entry.futureNights.map(key)).toEqual([
      "2026-08-22", "2026-08-23", "2026-08-24", "2026-08-25", "2026-08-26",
      "2026-08-27", "2026-08-28",
    ]);
  });

  it("gives a guest who is IN THE LODGE TONIGHT but leaving early a gap and a smaller bill too", () => {
    // The boundary the rule is really about, and the one a reader would get
    // wrong from "still here — nothing moves". This guest arrived on the 18th
    // and leaves on the 24th: their last night, the 23rd, is AFTER the window
    // opens on the 22nd, so they are unambiguously still in the lodge. But their
    // stay stops SHORT of the booking's own check-out on the 27th, so the bound
    // bites for them exactly as it does for somebody who went home a week ago.
    //
    // The officer extends the booking to the 29th. The nights of the 24th to the
    // 26th are the rest of somebody else's stay, not something this edit
    // created, so they are not sold to this guest — they get the two nights past
    // the OLD check-out and a three-night hole in front of them. Money goes DOWN
    // (the direction #2743 always moves), but it moves for a guest who is
    // present, and the bed board shows them out for three nights and back for
    // two. That is the honest consequence of the rule, and it is stated in
    // INV-MOD-025 and the changelog rather than left for a reader to discover.
    const stillHereLeavingEarly = guestFromNights(
      [
        "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22",
        "2026-08-23",
      ],
      "g1",
    );
    const plan = pricedPlan(
      bookingOf([stillHereLeavingEarly, guestFromNights(WHOLE_RUN, "g2")], "2026-08-29"),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.nights.map(key)).toEqual([
      "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22",
      "2026-08-23",
      // the gap: 24th, 25th, 26th
      "2026-08-27", "2026-08-28",
    ]);
    expect(entry.futureDeltaCents).toBe(
      priceNights(["2026-08-27", "2026-08-28"]),
    );
    // And emphatically NOT the back-filled answer, which is what this same edit
    // charged before #2743 — five nights, not two.
    expect(entry.futureDeltaCents).not.toBe(
      priceNights([
        "2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28",
      ]),
    );
    // They keep the future nights they genuinely hold, so they are still
    // future-active and still hold a bed on the 22nd and 23rd.
    expect(entry.futureNights.map(key)).toEqual([
      "2026-08-22", "2026-08-23", "2026-08-27", "2026-08-28",
    ]);
  });

  it("lets a removal leave the booking's check-out ahead of the last night anybody holds", () => {
    // The state #2743 newly makes reachable, pinned so it is visible rather than
    // discovered. Three guests: one gone home after the 19th, one there for the
    // whole run, one in for the 22nd and 23rd. The officer removes the whole-run
    // guest and touches no date.
    //
    // Before #2743 the other two were back-filled to the 26th, so somebody
    // always ran to the check-out. Now nobody does: the last night anybody holds
    // is the 23rd while `Booking.checkOut` still says the 27th. The save is
    // ACCEPTED — refusing it would refuse the ordinary "remove the guest who was
    // staying longest" edit, and the containment triggers permit it because they
    // test containment, never coverage.
    //
    // The counterpart is the second half of this case: a few days later, once
    // the 22nd and 23rd are behind the window too, the booking walks into the
    // widened refusal — which is why that refusal has to name a check-out the
    // plan accepts, and does.
    const departed = guestFromNights(["2026-08-18", "2026-08-19"], "g1");
    const shortStay = guestFromNights(["2026-08-22", "2026-08-23"], "g3");
    const plan = pricedPlan(
      planInput({
        guests: [departed, guestFromNights(WHOLE_RUN, "g2"), shortStay],
        editableFrom: "2026-08-22",
        newCheckOut: "2026-08-27",
        removeGuestIds: ["g2"],
        checkIn: "2026-08-18",
        checkOut: "2026-08-27",
      }),
    );

    expect(plan.futureActiveGuestCount).toBe(1);
    expect(plan.proposedExistingGuests[0].nights.map(key)).toEqual([
      "2026-08-18",
      "2026-08-19",
    ]);
    expect(plan.proposedExistingGuests[2].nights.map(key)).toEqual([
      "2026-08-22",
      "2026-08-23",
    ]);
    // Nobody holds the 24th, 25th or 26th, and the booking's check-out is still
    // the 27th. Neither remaining guest was back-filled to cover them.
    const everyNightHeld = plan.proposedExistingGuests
      .filter((entry) => !entry.removedFromFuture)
      .flatMap((entry) => entry.nights.map(key));
    expect(everyNightHeld).not.toContain("2026-08-24");
    expect(everyNightHeld).not.toContain("2026-08-26");

    // Later, with the window opened past the last remaining night: the same
    // booking is now refused, and the named check-out is one that works.
    const later = () =>
      buildInProgressGuestRangePlan(
        planInput({
          guests: [departed, shortStay],
          editableFrom: "2026-08-25",
          newCheckOut: "2026-08-27",
          checkIn: "2026-08-18",
          checkOut: "2026-08-27",
        }),
      );
    expect(later).toThrow(/Set the check-out to 2026-08-25 instead/);
    expect(
      pricedPlan(
        planInput({
          guests: [departed, shortStay],
          editableFrom: "2026-08-25",
          newCheckOut: "2026-08-25",
          checkIn: "2026-08-18",
          checkOut: "2026-08-27",
        }),
      ).priceDiffCents,
    ).toBe(0);
  });

  it("does not drag the capacity window back over nights this edit puts nobody on", () => {
    // `futureStart` is the PRICING anchor and reaches back to a guest's own stay
    // end, which for somebody who left a week ago is a week behind the window.
    // The capacity window must not follow it there: `checkCapacityForGuestRanges`
    // evaluates every night in `[capacityRangeStart, newCheckOut)`, so a past
    // night over capacity (#1668 admin override) or under a whole-lodge hold
    // (never admin-overridable, ADR-001 decision 5) would refuse an extension
    // that adds nobody to it.
    const departed = guestFromNights(["2026-08-18", "2026-08-19"], "g1");
    const plan = pricedPlan(
      bookingOf([departed, guestFromNights(WHOLE_RUN, "g2")], "2026-08-30"),
    );

    // Their pricing anchor is still the 20th — that is what makes the #2029
    // check-out-day night chargeable — but the window starts where the edit
    // genuinely begins.
    expect(key(plan.proposedExistingGuests[0].futureStart)).toBe("2026-08-20");
    expect(key(plan.capacityRangeStart)).toBe("2026-08-22");
    // Never later than the earliest night any included range actually occupies.
    for (const range of plan.capacityGuestRanges) {
      expect(key(range.nights[0]) >= key(plan.capacityRangeStart)).toBe(true);
    }
  });

  it("still buys the check-out-day night on a +1 extension (#2029 boundary)", () => {
    // The narrow case the reach-back exists for, and the one a bound written a
    // day too late would break. The booking runs 20 → 24 and the guest's stay
    // ends with it; today IS the 24th, so the window opens on the 25th and the
    // night of the 24th is behind it. Moving the check-out to the 25th genuinely
    // creates that night, so it is charged — the guest's stay end and the
    // booking's check-out are the same day, which is what separates this from a
    // guest who went home a week ago.
    const plan = pricedPlan(
      planInput({
        guests: [
          guestFromNights([
            "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23",
          ]),
        ],
        editableFrom: "2026-08-25",
        newCheckOut: "2026-08-25",
        checkIn: "2026-08-20",
        checkOut: "2026-08-24",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.futureDeltaCents).toBe(priceNights(["2026-08-24"]));
    expect(entry.nights.map(key)).toEqual([
      "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24",
    ]);
  });

  it("is still admitted for the nights an extension genuinely creates, which the software cannot refuse for them", () => {
    // STATED, not endorsed. Extending a booking's check-out admits every guest
    // still on it, and a guest who has gone home is still on it. Not because the
    // request cannot CARRY a per-guest end — `BatchModifyInput.guestStayRanges`
    // exists — but because this plan deliberately overrides it for every
    // existing guest and the edit panel does not offer the control on an
    // in-progress edit, so there is no honoured way to say "this one is not
    // coming back".
    //
    // What #2743 removes is the back-fill: the seven nights between their last
    // one and the old check-out. What is left is the three nights the officer
    // has just added to the booking. It is smaller, and it is recorded in
    // INV-MOD-025 rather than left to be discovered — but it is NOT itemized:
    // the quote pushes a single aggregate "Future-night date change" line
    // summing every existing guest's delta, with no per-guest and no per-night
    // breakdown, and the in-progress panel renders no per-guest night grid. So
    // the officer sees one dollar figure, not "this departed guest is being
    // charged for three nights". That is the residual, stated as what it is.
    const departed = guestFromNights(["2026-08-18", "2026-08-19"], "g1");
    const plan = pricedPlan(
      bookingOf([departed, guestFromNights(WHOLE_RUN, "g2")], "2026-08-30"),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.futureDeltaCents).toBe(
      priceNights(["2026-08-27", "2026-08-28", "2026-08-29"]),
    );
    expect(entry.nights.map(key)).toEqual([
      "2026-08-18", "2026-08-19", "2026-08-27", "2026-08-28", "2026-08-29",
    ]);
    // Emphatically NOT the whole run from their last night to the new check-out,
    // which is what it used to be.
    expect(entry.futureDeltaCents).toBeLessThan(
      priceNights([
        "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24",
        "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29",
      ]),
    );
  });

  it("refuses an edit to a booking whose guests have all gone, and names a check-out the plan will actually accept", () => {
    // The one edit #2743 newly refuses. The booking's check-out says the 27th but
    // the only guest went home on the 20th, so there is nothing left to sell the
    // remaining nights to. It used to save by charging them to the guest who had
    // left. The message is a log line (#1888 keeps it off the wire), and it names
    // the check-out that matches who is actually there.
    //
    // The named date is CLAMPED at the edit window. The morning after their last
    // night is the 20th, and a check-out of the 20th is refused by this
    // function's own first guard and by `resolveTargetDates` before it — so an
    // unclamped message would hand the officer a remedy the code rejects and
    // leave the booking editable by no route at all. Under #2736 alone the
    // suggestion always landed on `editableFrom`, so the trap only opens for
    // #2743's shape: a guest who left well before the window.
    const build = () =>
      buildInProgressGuestRangePlan(
        bookingOf(
          [guestFromNights(["2026-08-18", "2026-08-19"], "g1")],
          "2026-08-27",
        ),
      );

    expect(build).toThrow(
      /No remaining guest is booked for a night on or after 2026-08-22/,
    );
    expect(build).toThrow(/Set the check-out to 2026-08-22 instead/);
    // Emphatically NOT the unclamped answer, which is a date the very next line
    // proves nothing can save.
    expect(build).not.toThrow(/Set the check-out to 2026-08-20 instead/);
    expect(() =>
      buildInProgressGuestRangePlan(
        bookingOf(
          [guestFromNights(["2026-08-18", "2026-08-19"], "g1")],
          "2026-08-20",
        ),
      ),
    ).toThrow(/Check-out cannot move before NZ tomorrow/);

    // And the advice actually works: re-run the same edit with the check-out it
    // names and the plan builds, moving no money. This is the assertion that
    // makes the message a remedy rather than a description.
    const followTheAdvice = pricedPlan(
      bookingOf(
        [guestFromNights(["2026-08-18", "2026-08-19"], "g1")],
        "2026-08-22",
      ),
    );
    expect(followTheAdvice.priceDiffCents).toBe(0);
    expect(followTheAdvice.proposedExistingGuests[0].nights.map(key)).toEqual([
      "2026-08-18",
      "2026-08-19",
    ]);
  });

  it("keeps every cent an integer and never charges more than it used to", () => {
    // INV-MONEY-001 / INV-MONEY-003. #2743 only ever REMOVES nights from the
    // added leg, so no total can rise; the matrix above proves that over 960
    // ordinary edits and this pins the arithmetic type on the shape itself.
    const departed = guestFromNights(["2026-08-18", "2026-08-19"], "g1");
    const plan = pricedPlan(
      bookingOf([departed, guestFromNights(WHOLE_RUN, "g2")], "2026-08-30"),
    );

    for (const entry of plan.proposedExistingGuests) {
      expect(Number.isInteger(entry.priceCents)).toBe(true);
      expect(Number.isInteger(entry.futureDeltaCents)).toBe(true);
      expect(Number.isInteger(entry.newFuturePriceCents)).toBe(true);
    }
    expect(Number.isInteger(plan.newTotalPriceCents)).toBe(true);
    expect(plan.newTotalPriceCents).toBe(
      plan.proposedExistingGuests.reduce((sum, e) => sum + e.priceCents, 0),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. #2744 — a night is worth what it was SOLD for, and the rows say so.
//
// The plan used to pass no `lockedNightPrices`, so every night it touched was
// valued at today's season rate: a night given back was credited at whatever it
// would cost to buy now, and the per-night amounts written back were the guest's
// total divided by their night count. Both halves are answered here. The stored
// `BookingGuestNight.priceCents` is now honoured in BOTH pricing windows, which
// is what INV-MOD-005 has always required of every other edit path — "removing
// one returns exactly theirs" — and is why a night the guest keeps still cancels
// between the two windows instead of being re-rated.
// ---------------------------------------------------------------------------

/** A guest whose rows record what each night was actually sold for. */
function guestWhoPaid(
  paidByNight: Record<string, number>,
  id = "g1",
): TestGuest {
  const nights = Object.keys(paidByNight).sort();
  return {
    ...guestFromNights(nights, id),
    nights: nights.map((night) => ({
      stayDate: D(night),
      priceCents: paidByNight[night],
    })),
    priceCents: nights.reduce((sum, night) => sum + paidByNight[night], 0),
  };
}

describe("#2744 a night is credited back at the price it was sold for", () => {
  it("refunds a mid-stay removal at what the member paid, not today's rate", () => {
    // Three high-season nights bought at the old low rate: 3 x LOW paid, HIGH on
    // the table now. The guest sleeps the 23rd and is taken off the rest. This
    // is the shape the issue reproduced, and the numbers it reported.
    const nights = ["2026-08-23", "2026-08-24", "2026-08-25"];
    const paidCents = 3 * LOW;
    const boughtBeforeTheRise = guestWhoPaid(
      Object.fromEntries(nights.map((night) => [night, LOW])),
    );
    const plan = pricedPlan(
      planInput({
        guests: [boughtBeforeTheRise, guestFromNights(nights, "g2")],
        editableFrom: "2026-08-24",
        newCheckOut: "2026-08-26",
        removeGuestIds: ["g1"],
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    // The two nights given back are worth the LOW they were sold at — not the
    // HIGH they would cost today, which used to hand back 2 x HIGH for 2 x LOW
    // of nights.
    expect(entry.oldFuturePriceCents).toBe(2 * LOW);
    expect(entry.futureDeltaCents).toBe(-2 * LOW);
    // What is left is exactly the night they actually slept.
    expect(entry.priceCents).toBe(LOW);
    expect(entry.priceCents).toBe(paidCents - 2 * LOW);
    // The acceptance criterion in its own right: a guest who slept a night can
    // never come off the booking owing less than nothing.
    expect(entry.priceCents).toBeGreaterThanOrEqual(0);
    // And the one night they keep is written back at its real price.
    expect(entry.nights.map(key)).toEqual(["2026-08-23"]);
    expect(entry.perNightCents).toEqual([LOW]);
  });

  it("credits a shortened check-out at the sold price too, and the same way if the rate FELL", () => {
    // Same booking shape, opposite direction on the second guest: the club drops
    // its rate after the member books. Giving a night back must return what they
    // paid, which is now MORE than the night is worth today — the error runs in
    // both directions and so does the fix.
    const paidHigh = guestWhoPaid(
      { "2026-08-20": HIGH, "2026-08-21": HIGH, "2026-08-22": HIGH },
      "g1",
    );
    const plan = pricedPlan(
      planInput({
        guests: [
          paidHigh,
          guestFromNights(["2026-08-20", "2026-08-21", "2026-08-22"], "g2"),
        ],
        editableFrom: "2026-08-21",
        // Pull the check-out back one night: the 22nd is given up.
        newCheckOut: "2026-08-22",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    // The 21st is kept (same price both sides, so it cancels); the 22nd is given
    // back at the HIGH it was sold for, not the LOW it would cost now.
    expect(entry.oldFuturePriceCents).toBe(2 * HIGH);
    expect(entry.newFuturePriceCents).toBe(HIGH);
    expect(entry.futureDeltaCents).toBe(-HIGH);
    expect(entry.priceCents).toBe(2 * HIGH);
    expect(entry.perNightCents).toEqual([HIGH, HIGH]);
  });

  it("does NOT re-rate a night the guest keeps: an extension still charges only the new nights", () => {
    // The trap in fixing half one. Honouring the sold price in the old window
    // ALONE would make every extension reprice the nights already bought — the
    // exact thing INV-MOD-005 exists to prevent. Both windows get the locks, so
    // a kept night carries one price on both sides and cancels to nothing.
    const paidLow = guestWhoPaid(
      { "2026-08-23": LOW, "2026-08-24": LOW },
      "g1",
    );
    const plan = pricedPlan(
      planInput({
        guests: [paidLow],
        editableFrom: "2026-08-24",
        newCheckOut: "2026-08-27",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    // Two new nights at today's HIGH, and not a cent charged for the 24th the
    // member already owns at LOW.
    expect(entry.futureDeltaCents).toBe(2 * HIGH);
    expect(entry.priceCents).toBe(2 * LOW + 2 * HIGH);
    expect(entry.perNightCents).toEqual([LOW, LOW, HIGH, HIGH]);
  });

  it("writes each night's real rate back, not the average (the issue's worked example)", () => {
    // Nights 20 Aug + 22 Aug extended to the 25th, LOW to the 22nd and HIGH from
    // the 23rd. The plan produces four nights totalling 2 x LOW + 2 x HIGH and
    // used to write the SAME averaged amount on all four, so a later edit
    // charged the average for the 20th and credited it for the 24th.
    const sparse = guestWhoPaid(
      { "2026-08-20": LOW, "2026-08-22": LOW },
      "g1",
    );
    const plan = pricedPlan(
      planInput({
        guests: [sparse],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-25",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.nights.map(key)).toEqual([
      "2026-08-20",
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
    ]);
    expect(entry.perNightCents).toEqual([LOW, LOW, HIGH, HIGH]);
    // The average this replaced would have been one number on all four nights.
    expect(new Set(entry.perNightCents).size).toBeGreaterThan(1);
    expect(entry.perNightCents.reduce((a, b) => a + b, 0)).toBe(entry.priceCents);
  });

  it("gives an added guest each night's own rate across a season boundary", () => {
    const plan = pricedPlan(
      planInput({
        guests: [guestFromNights(["2026-08-21", "2026-08-22"], "g1")],
        editableFrom: "2026-08-22",
        newCheckOut: "2026-08-25",
        addGuests: [
          {
            firstName: "New",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: true,
            memberId: "m-new",
            rateMembershipTypeId: MEMBER_TYPE,
            rateSource: "OWN_TYPE",
          },
        ],
      }),
    );
    const added = plan.proposedAddedGuests[0];

    expect(added.nights.map(key)).toEqual([
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
    ]);
    expect(added.perNightCents).toEqual([LOW, HIGH, HIGH]);
    expect(added.priceCents).toBe(LOW + 2 * HIGH);
  });

  it("matches a stored price to its night whichever shape the row's date arrives in", () => {
    // The night set and the stored prices are keyed by the same canonical
    // helper, so a row carrying a date-only STRING still lines up with the night
    // it belongs to. If the two key derivations ever drifted apart nothing would
    // throw — the price would simply never match, and the night would quietly go
    // back to being valued at today's rate, which is the defect itself.
    const stringDated: TestGuest = {
      ...guestFromNights(["2026-08-23", "2026-08-24"], "g1"),
      nights: [
        { stayDate: "2026-08-23" as unknown as Date, priceCents: LOW },
        { stayDate: "2026-08-24" as unknown as Date, priceCents: LOW },
      ],
      priceCents: 2 * LOW,
    };
    const plan = pricedPlan(
      planInput({
        guests: [
          stringDated,
          guestFromNights(["2026-08-23", "2026-08-24"], "g2"),
        ],
        editableFrom: "2026-08-24",
        newCheckOut: "2026-08-25",
        removeGuestIds: ["g1"],
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.oldFuturePriceCents).toBe(LOW);
    expect(entry.priceCents).toBe(LOW);
    expect(entry.perNightCents).toEqual([LOW]);
  });

  it("REFUSES to value a night at today's rate when there is no sold price to recover", () => {
    // #3031, and the test that fails if the today's-rate fallback comes back.
    //
    // This case used to assert the fallback: a booking predating
    // `BookingGuestNight`, or one converted from a request, had its surrendered
    // night credited at the CURRENT season rate and its rows written back as an
    // even split of whatever total was left. Both numbers were arithmetic about
    // a stay nobody has a per-night record of, and epic #2797 prohibits both.
    //
    // The member here paid 2 x LOW and the night they are giving back is now
    // HIGH. Any answer at all - HIGH, LOW, the average, zero - would be
    // invented, so the plan produces none.
    const legacyGuest: TestGuest = {
      ...guestFromNights(["2026-08-22", "2026-08-23"], "g1", false),
      // Whatever they were charged is not recoverable per night; only the total
      // survives, and it is not today's price for those nights.
      priceCents: 2 * LOW,
    };
    const occurrences = reviewOf(
      planInput({
        guests: [
          legacyGuest,
          guestFromNights(["2026-08-22", "2026-08-23"], "g2"),
        ],
        editableFrom: "2026-08-23",
        newCheckOut: "2026-08-24",
        removeGuestIds: ["g1"],
      }),
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].bookingGuestId).toBe("g1");
    expect(occurrences[0].cause).toBe("NO_STORED_NIGHT_PRICES");
    // The night given back is named, so an admin knows what they are pricing -
    // and the envelope is still what says WHICH nights this guest holds, which
    // is the fallback #2736 kept and #3031 does not touch.
    expect(occurrences[0].surrenderedNightDates).toEqual(["2026-08-23"]);
    // The evidence is recorded as an ABSENCE, never as a zero. Zero is a real
    // sold price (a comped night) and would read as "the member paid nothing".
    expect(occurrences[0].storedEvidence.nightPrices).toEqual([
      { date: "2026-08-22", priceCents: null },
      { date: "2026-08-23", priceCents: null },
    ]);
    expect(occurrences[0].storedEvidence.guestTotalCents).toBe(2 * LOW);
  });

  it("REFUSES when the stored rows do not add up to the stored total, and writes nothing", () => {
    // #3031, and the test that fails if the even split comes back.
    //
    // Drifted data: the guest's rows say LOW + LOW, their stored total says 101
    // cents more. This used to write an even split of the whole total across
    // every night - which is the sharpest form of the defect, because that split
    // BECOMES `BookingGuestNight.priceCents` and the next edit reads it back as
    // the price the member was charged. A guess that writes itself into the
    // history is worse than a guess that is merely shown.
    const drifted: TestGuest = {
      ...guestWhoPaid({ "2026-08-20": LOW, "2026-08-22": LOW }, "g1"),
      priceCents: 2 * LOW + 101,
    };
    const occurrences = reviewOf(
      planInput({
        guests: [drifted],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-25",
      }),
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].cause).toBe("STORED_TOTAL_MISMATCH");
    // Nothing is missing - every row has a real price. The rows simply do not
    // account for the total, which is a question for a person and not for
    // arithmetic.
    expect(occurrences[0].storedEvidence.nightPrices).toEqual([
      { date: "2026-08-20", priceCents: LOW },
      { date: "2026-08-22", priceCents: LOW },
    ]);
    expect(occurrences[0].storedEvidence.guestTotalCents).toBe(2 * LOW + 101);
  });

  it("REFUSES a guest whose stored total is negative rather than spreading it", () => {
    // The negative total the pre-#2744 arithmetic could itself produce. It used
    // to be spread across the guest's nights cent by cent, so a damaged booking
    // got MORE negative rows for the next edit to read as sold prices. Nothing
    // is written now, and nothing already stored is repaired either: what to do
    // about a damaged total is an owner decision with its own audit (#2745).
    const owingLess: TestGuest = {
      ...guestWhoPaid({ "2026-08-20": LOW, "2026-08-22": LOW }, "g1"),
      priceCents: -301,
    };
    const occurrences = reviewOf(
      planInput({
        guests: [owingLess],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-23",
      }),
    );

    expect(occurrences[0].cause).toBe("STORED_TOTAL_MISMATCH");
    // A total that is not usable money is recorded as an absence, because the
    // review context refuses a negative one - and the admin needs to know that
    // the total itself is the problem.
    expect(occurrences[0].storedEvidence.guestTotalCents).toBeNull();
  });

  it("REFUSES rather than clamping, when there is nothing per night to recover", () => {
    // #3031, and the test that fails if the `refundCeilingCents` clamp comes
    // back.
    //
    // Three nights bought for 3 x LOW, no per-night rows at all, and the last
    // two are now HIGH. The old code credited 2 x HIGH - more than the club had
    // ever charged - and then clamped the result against the guest's stored
    // total so they landed on exactly zero. The clamp made the answer look safe;
    // it was still today's rate, and the amount it clamped TO was a derived
    // total rather than money anybody had taken.
    //
    // (The captured-cash caps in `booking-modify-settlement.ts` are a different
    // thing and are untouched: they cap a refund against money actually taken.)
    const nights = ["2026-08-22", "2026-08-23", "2026-08-24"];
    const noPerNightRecord: TestGuest = {
      ...guestFromNights(nights, "g1", false),
      priceCents: 3 * LOW,
    };
    const occurrences = reviewOf(
      planInput({
        guests: [noPerNightRecord, guestFromNights(nights, "g2")],
        editableFrom: "2026-08-23",
        newCheckOut: "2026-08-25",
        removeGuestIds: ["g1"],
        checkIn: "2026-08-22",
        checkOut: "2026-08-25",
      }),
    );

    // The clamped answer used to be zero, which is a real financial number and
    // is exactly what the epic forbids showing for an amount nobody has worked
    // out. There is no amount on this branch to be zero.
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].cause).toBe("NO_STORED_NIGHT_PRICES");
    expect(2 * HIGH).toBeGreaterThan(3 * LOW);
    // The WHOLE key set, not `not.toContain("priceCents")` — that assertion was
    // tautological, because no branch of this union has such a key and nothing
    // could add one under that name. Pinning the key set is what actually fails
    // if a numeric field appears on the review branch under ANY name.
    expect(Object.keys(occurrences[0]).sort()).toEqual([
      "addedNightDates",
      "bookingGuestId",
      "bookingId",
      "cause",
      "storedEvidence",
      "surrenderedNightDates",
    ]);
  });

  it("credits a guest exactly the stored price of every night they give back", () => {
    // The ordinary healthy booking, and the positive half of #3031: a guest
    // whose stored rows record what they paid is credited exactly those amounts,
    // read off the rows and never from a rate table. There is no ceiling and no
    // clamp left to interfere - the amount IS the evidence (the contiguous
    // matrix above is the other half of that guard).
    const paidHigh = guestWhoPaid(
      { "2026-08-23": HIGH, "2026-08-24": HIGH, "2026-08-25": HIGH },
      "g1",
    );
    const plan = pricedPlan(
      planInput({
        guests: [
          paidHigh,
          guestFromNights(["2026-08-23", "2026-08-24", "2026-08-25"], "g2"),
        ],
        editableFrom: "2026-08-24",
        newCheckOut: "2026-08-26",
        removeGuestIds: ["g1"],
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.oldFuturePriceCents).toBe(2 * HIGH);
    expect(entry.priceCents).toBe(HIGH);
  });

  it("leaves a guest removed before their stay began at nothing owing, and refuses a drift", () => {
    // The one shape where the per-night amounts cannot add back to the guest's
    // total, because there are no nights to add across. The `drifted` row of the
    // matrix above is what found it, so it is asserted here rather than merely
    // excepted there.
    //
    // A guest whose rows account for their total is credited all of their own
    // nights at all of their own prices, so they land on EXACTLY nothing owing.
    const wholeStay = ["2026-08-22", "2026-08-23"];
    const settled = guestWhoPaid({ "2026-08-22": LOW, "2026-08-23": LOW }, "g1");
    const plan = pricedPlan(
      planInput({
        guests: [settled, guestFromNights(wholeStay, "g2")],
        // Before their stay starts, so the whole of it is inside the window.
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-24",
        removeGuestIds: ["g1"],
        checkIn: "2026-08-21",
        checkOut: "2026-08-24",
      }),
    );
    const entry = plan.proposedExistingGuests[0];

    expect(entry.nights).toEqual([]);
    expect(entry.perNightCents).toEqual([]);
    expect(entry.priceCents).toBe(0);

    // #3031: the same guest with a stored total that has DRIFTED from their rows
    // is no longer left carrying the residual - the drift IS the reconciliation
    // failure, so the edit is not priced at all. That residual used to be
    // written out as the guest's remaining price: a real number standing for an
    // amount nobody could account for.
    const drifted: TestGuest = {
      ...settled,
      priceCents: settled.priceCents + 101,
    };
    const occurrences = reviewOf(
      planInput({
        guests: [drifted, guestFromNights(wholeStay, "g2")],
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-24",
        removeGuestIds: ["g1"],
        checkIn: "2026-08-21",
        checkOut: "2026-08-24",
      }),
    );

    expect(occurrences.map((occurrence) => occurrence.cause)).toEqual([
      "STORED_TOTAL_MISMATCH",
    ]);
    expect(occurrences[0].surrenderedNightDates).toEqual(wholeStay);
  });

  it("REFUSES a NEGATIVE stored row as a sold price, so giving a night back never charges the member", () => {
    // The rows this bug itself wrote. `BookingGuestNight.priceCents` is a bare
    // `Int` with no non-negative constraint, and the pre-#2744 even split of a
    // total driven below zero could store -3000 against a night. Honouring that
    // as a "sold price" inverts the edit: the old-price window comes out
    // negative, so the delta is POSITIVE and taking the guest OFF the booking
    // CHARGES them, on a booking an earlier defect had already damaged.
    //
    // A negative row is not a cheap night; it is a row that cannot be money. It
    // is classified exactly like an absent one, and nothing already stored is
    // rewritten - repair is #2745's audited decision, not this edit's.
    const damaged: TestGuest = {
      ...guestWhoPaid(
        {
          "2026-08-23": -3000,
          "2026-08-24": -3000,
          "2026-08-25": -3000,
        },
        "g1",
      ),
      priceCents: -9000,
    };
    const occurrences = reviewOf(
      planInput({
        guests: [
          damaged,
          guestFromNights(["2026-08-23", "2026-08-24", "2026-08-25"], "g2"),
        ],
        editableFrom: "2026-08-24",
        newCheckOut: "2026-08-26",
        removeGuestIds: ["g1"],
      }),
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].cause).toBe("NO_STORED_NIGHT_PRICES");
    // Every negative row is reported as an absence of evidence, never carried
    // forward as a number an admin might mistake for a price.
    expect(
      occurrences[0].storedEvidence.nightPrices.map(
        (night) => night.priceCents,
      ),
    ).toEqual([null, null, null]);
    expect(occurrences[0].storedEvidence.guestTotalCents).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. #2756 — the group discount reaches the nights an in-progress edit BUYS,
//    and reaches nothing else.
//
// This plan used to price one guest at a time with no group-discount config, so
// `countActiveGuestsForNight` was always looking at a one-element list and the
// party size the rule saw was always 1. A member adding a sixth person to a
// party of eight therefore got the discount if the stay started tomorrow and did
// not if it started yesterday — same club, same night, same party, and the money
// ran against the member (INV-MOD-006). The whole party is now priced in one
// pass per window, the way the guest-add route already does it.
//
// The cases below are in two halves, and the second is the one that makes the
// first safe:
//
//  - The discount applies to what the edit BUYS: an added guest's nights, and
//    the nights an extension creates. Per night, and per the party actually in
//    the lodge on that night, so an absent night does not count toward the
//    minimum.
//  - NOTHING ALREADY BOUGHT MOVES (INV-MOD-005). Not for a guest whose rows
//    record what they paid, and — the shape a naive fix breaks — not for a
//    legacy guest with no recoverable price either, whose held nights would
//    otherwise be re-valued in one window and not the other every time an edit
//    pushed the party across the minimum: an add would CREDIT the rest of the
//    party for nights they had already slept, and a removal would CHARGE them.
//
// The fixture below runs on the SCHEMA DEFAULT configuration — `summerOnly:
// true`, per `prisma/schema.prisma`, `DEFAULT_GROUP_DISCOUNT_SETTING` and the
// admin section's own default — and its seasons therefore carry a `type`, because
// that is the shape a real club is in. An earlier draft of these cases pinned
// `summerOnly: false` throughout, which passed while the fix was INERT for every
// default-configured club: `SeasonRateData.type` is optional, all five edit paths
// hand-rolled a season literal without it, and `isGroupDiscountApplicable`'s
// `season?.type === "SUMMER"` test could therefore never be satisfied. Running the
// suite on the default is what makes it able to see that. `summerOnly: false`
// survives only where that flag is itself the property under test.
// ---------------------------------------------------------------------------

const NON_MEMBER_TYPE = "type-non-member";
const GROUP_RATE_TYPE = "type-group";
/** What a member pays a night. */
const MEMBER_NIGHT = 5000;
/** What a true non-member pays a night. */
const NON_MEMBER_NIGHT = 12000;
/** The rate a qualifying group discount substitutes for a non-member. */
const GROUP_NIGHT = 8000;
const MIN_GROUP_SIZE = 6;

/**
 * One flat season carrying all three rate rows, so a discounted night and an
 * undiscounted one differ by the rate row chosen and by nothing else — no season
 * boundary in the way. The two-season fixture at the top of this file is what
 * proves per-night season pricing; this one isolates the discount.
 *
 * `type: "SUMMER"` is load-bearing, not decoration: the default configuration
 * restricts the discount to summer, so a season reaching pricing without its type
 * turns the discount off silently. Every case here that expects a discounted
 * amount fails if the field is dropped.
 */
const GROUP_SEASONS: SeasonRateData[] = [
  {
    seasonId: "s-group",
    startDate: D("2026-08-01"),
    endDate: D("2026-09-30"),
    type: "SUMMER",
    rates: [
      { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: MEMBER_NIGHT },
      {
        ageTier: "ADULT",
        membershipTypeId: NON_MEMBER_TYPE,
        pricePerNightCents: NON_MEMBER_NIGHT,
      },
      {
        ageTier: "ADULT",
        membershipTypeId: GROUP_RATE_TYPE,
        pricePerNightCents: GROUP_NIGHT,
      },
    ],
  },
];

/**
 * A club that HAS switched the group discount on, on the DEFAULT settings —
 * `summerOnly: true` (`prisma/schema.prisma`, `DEFAULT_GROUP_DISCOUNT_SETTING`,
 * and `group-discount-section.tsx`). Every case below uses this unless the case is
 * about `summerOnly` itself.
 */
const GROUP_DISCOUNT: GroupDiscountConfig = {
  enabled: true,
  minGroupSize: MIN_GROUP_SIZE,
  summerOnly: true,
  rateMembershipTypeId: GROUP_RATE_TYPE,
};

/** The same club with the summer restriction lifted — the non-default setting. */
const GROUP_DISCOUNT_ANY_SEASON: GroupDiscountConfig = {
  ...GROUP_DISCOUNT,
  summerOnly: false,
};

/** The same rates in a WINTER season, which the default configuration excludes. */
const WINTER_SEASONS: SeasonRateData[] = [
  {
    seasonId: "s-winter",
    startDate: D("2026-08-01"),
    endDate: D("2026-09-30"),
    type: "WINTER",
    rates: GROUP_SEASONS[0].rates,
  },
];

type PartyGuest = BuildInProgressGuestRangePlanInput["booking"]["guests"][number];

/**
 * One guest of a party, holding exactly `nights`.
 *
 * `soldRateCents: null` drops their `BookingGuestNight` rows entirely — a legacy
 * guest from before the rows existed, or one on a booking created by approving a
 * request, which still writes none (#2739). They have no recoverable price, so
 * their nights are valued at today's rate in both windows, which is the shape
 * INV-MOD-005 already names and the one a party-aware discount can damage.
 */
function partyGuest(args: {
  id: string;
  nights: string[];
  isMember: boolean;
  soldRateCents?: number | null;
  paidRateCents?: number;
}): PartyGuest {
  const sorted = [...args.nights].sort();
  const last = sorted[sorted.length - 1];
  const ownRate = args.isMember ? MEMBER_NIGHT : NON_MEMBER_NIGHT;
  const soldRateCents =
    args.soldRateCents === undefined ? ownRate : args.soldRateCents;
  const paidRateCents = args.paidRateCents ?? soldRateCents ?? ownRate;
  return {
    id: args.id,
    firstName: "Guest",
    lastName: args.id,
    ageTier: "ADULT",
    isMember: args.isMember,
    memberId: args.isMember ? `m-${args.id}` : null,
    rateMembershipTypeId: args.isMember ? MEMBER_TYPE : NON_MEMBER_TYPE,
    // Only a NON_MEMBER_DEFAULT guest's rate may be substituted by the discount
    // (INV-MOD-007); a member keeps their own type's rate either way.
    rateSource: args.isMember ? "OWN_TYPE" : "NON_MEMBER_DEFAULT",
    stayStart: D(sorted[0]),
    stayEnd: new Date(D(last).getTime() + 86_400_000),
    ...(soldRateCents === null
      ? {}
      : {
          nights: sorted.map((night) => ({
            stayDate: D(night),
            priceCents: soldRateCents,
          })),
        }),
    priceCents: sorted.length * paidRateCents,
  };
}

/** A non-member being added to the party by this edit. */
function addedNonMember(id: string) {
  return {
    firstName: "Added",
    lastName: id,
    ageTier: "ADULT" as const,
    isMember: false,
    memberId: null,
    rateMembershipTypeId: NON_MEMBER_TYPE,
    rateSource: "NON_MEMBER_DEFAULT" as const,
  };
}

/** The booking every case in this section edits: five nights, in progress. */
const PARTY_NIGHTS = [
  "2026-08-20",
  "2026-08-21",
  "2026-08-22",
  "2026-08-23",
  "2026-08-24",
];
const PARTY_CHECK_IN = "2026-08-20";
const PARTY_CHECK_OUT = "2026-08-25";
/** NZ tomorrow: nights 20-22 are locked, 23 and 24 are the future window. */
const PARTY_EDITABLE_FROM = "2026-08-23";

function groupPlanInput(args: {
  guests: PartyGuest[];
  newCheckOut?: string;
  addGuests?: BuildInProgressGuestRangePlanInput["addGuests"];
  removeGuestIds?: string[];
  groupDiscount?: GroupDiscountConfig;
  editableFrom?: string;
  checkIn?: string;
  checkOut?: string;
}): BuildInProgressGuestRangePlanInput {
  const totalPriceCents = args.guests.reduce((sum, g) => sum + g.priceCents, 0);
  return {
    booking: {
      id: "booking-party",
      checkIn: D(args.checkIn ?? PARTY_CHECK_IN),
      checkOut: D(args.checkOut ?? PARTY_CHECK_OUT),
      totalPriceCents,
      discountCents: 0,
      promoAdjustmentCents: 0,
      finalPriceCents: totalPriceCents,
      guests: args.guests,
    },
    editableFrom: D(args.editableFrom ?? PARTY_EDITABLE_FROM),
    newCheckOut: D(args.newCheckOut ?? PARTY_CHECK_OUT),
    seasons: GROUP_SEASONS,
    ...(args.addGuests ? { addGuests: args.addGuests } : {}),
    ...(args.removeGuestIds ? { removeGuestIds: args.removeGuestIds } : {}),
    ...(args.groupDiscount ? { groupDiscount: args.groupDiscount } : {}),
  };
}

/** `count` members holding the booking's whole run, at what they paid for it. */
function wholeRunMembers(count: number): PartyGuest[] {
  return Array.from({ length: count }, (_, index) =>
    partyGuest({ id: `m${index + 1}`, nights: PARTY_NIGHTS, isMember: true }),
  );
}

/** Contiguous runs of equally-priced nights — one Xero line each (#1163). */
function priceRuns(perNightCents: readonly number[]): Array<{
  nightCount: number;
  perNightCents: number;
  totalCents: number;
}> {
  const runs: Array<{ nightCount: number; perNightCents: number; totalCents: number }> =
    [];
  for (const cents of perNightCents) {
    const last = runs[runs.length - 1];
    if (last && last.perNightCents === cents) {
      last.nightCount += 1;
      last.totalCents += cents;
    } else {
      runs.push({ nightCount: 1, perNightCents: cents, totalCents: cents });
    }
  }
  return runs;
}

describe("#2756 the group discount on a stay already under way", () => {
  it("gives an added guest the party's discounted rate, and moves nobody else", () => {
    // Five members already in the lodge; the sixth person is added to a stay
    // that started three nights ago. The party on every night this edit buys is
    // six, which is the minimum, so those nights are discounted — exactly as
    // they would be if the same guest were added the day before check-in.
    const plan = pricedPlan(
      groupPlanInput({
        guests: wholeRunMembers(5),
        addGuests: [addedNonMember("a1")],
        groupDiscount: GROUP_DISCOUNT,
      }),
    );
    const added = plan.proposedAddedGuests[0];

    expect(added.nights.map(key)).toEqual(["2026-08-23", "2026-08-24"]);
    expect(added.perNightCents).toEqual([GROUP_NIGHT, GROUP_NIGHT]);
    expect(added.priceCents).toBe(2 * GROUP_NIGHT);
    // The pre-#2756 answer, and the whole defect: the party size the rule saw
    // was always one, so the added guest paid the undiscounted non-member rate.
    expect(added.priceCents).not.toBe(2 * NON_MEMBER_NIGHT);

    // INV-MOD-005: nobody who was already in the lodge moves by a cent.
    for (const entry of plan.proposedExistingGuests) {
      expect(entry.futureDeltaCents, entry.guest.id).toBe(0);
      expect(entry.priceCents, entry.guest.id).toBe(5 * MEMBER_NIGHT);
      expect(entry.perNightCents, entry.guest.id).toEqual(
        PARTY_NIGHTS.map(() => MEMBER_NIGHT),
      );
    }
    expect(plan.newTotalPriceCents).toBe(5 * 5 * MEMBER_NIGHT + 2 * GROUP_NIGHT);
  });

  it("charges the full rate at a club that has not switched the discount on", () => {
    // The same edit at a club with no `GroupDiscountSetting` to pass. This is the
    // majority of clubs and it must land exactly where it landed before #2756.
    const plan = pricedPlan(
      groupPlanInput({
        guests: wholeRunMembers(5),
        addGuests: [addedNonMember("a1")],
      }),
    );
    const added = plan.proposedAddedGuests[0];

    expect(added.perNightCents).toEqual([NON_MEMBER_NIGHT, NON_MEMBER_NIGHT]);
    expect(added.priceCents).toBe(2 * NON_MEMBER_NIGHT);
    for (const entry of plan.proposedExistingGuests) {
      expect(entry.futureDeltaCents, entry.guest.id).toBe(0);
      expect(entry.priceCents, entry.guest.id).toBe(5 * MEMBER_NIGHT);
    }
  });

  it("charges the full rate when the party is one short of the minimum", () => {
    // Four members plus the added guest is five, and the minimum is six. The
    // config is passed and still cannot qualify, which is what separates "the
    // config now reaches this plan" from "this plan now discounts everything".
    const plan = pricedPlan(
      groupPlanInput({
        guests: wholeRunMembers(4),
        addGuests: [addedNonMember("a1")],
        groupDiscount: GROUP_DISCOUNT,
      }),
    );

    expect(plan.proposedAddedGuests[0].priceCents).toBe(2 * NON_MEMBER_NIGHT);
  });

  it("counts the party per night, so an absent night cannot qualify", () => {
    // Five members, one of whom goes home on the 24th. With the added guest the
    // party is six on the 23rd and five on the 24th, so the first night this
    // edit buys is discounted and the second is not — INV-MOD-006's "eligibility
    // is per night and per party size on that night: a partial-stay guest's
    // absent nights do not count toward the minimum".
    const earlyDeparter = partyGuest({
      id: "m5",
      nights: PARTY_NIGHTS.slice(0, 4),
      isMember: true,
    });
    const plan = pricedPlan(
      groupPlanInput({
        guests: [...wholeRunMembers(4), earlyDeparter],
        addGuests: [addedNonMember("a1")],
        groupDiscount: GROUP_DISCOUNT,
      }),
    );
    const added = plan.proposedAddedGuests[0];

    expect(added.perNightCents).toEqual([GROUP_NIGHT, NON_MEMBER_NIGHT]);
    expect(added.priceCents).toBe(GROUP_NIGHT + NON_MEMBER_NIGHT);

    // And the early departer is not back-filled onto the 24th to make up the
    // number (#2743): they keep their own four nights and their own price.
    const departer = plan.proposedExistingGuests.find(
      (entry) => entry.guest.id === "m5",
    );
    expect(departer?.nights.map(key)).toEqual(PARTY_NIGHTS.slice(0, 4));
    expect(departer?.futureDeltaCents).toBe(0);
  });

  it("discounts the nights an extension creates and leaves the held ones at what they cost", () => {
    // A party of six, one of them a non-member who booked at 7000 a night before
    // the rate moved. The check-out moves out two nights: those two are bought
    // now, by a party of six, so they are discounted — and the five nights
    // already bought keep the price on their rows, which is what makes the
    // extension's delta exactly the nights it adds (INV-MOD-005).
    const boughtAtTheOldRate = partyGuest({
      id: "n1",
      nights: PARTY_NIGHTS,
      isMember: false,
      soldRateCents: 7000,
    });
    const plan = pricedPlan(
      groupPlanInput({
        guests: [...wholeRunMembers(5), boughtAtTheOldRate],
        newCheckOut: "2026-08-27",
        groupDiscount: GROUP_DISCOUNT,
      }),
    );
    const entry = plan.proposedExistingGuests.find(
      (candidate) => candidate.guest.id === "n1",
    );
    if (!entry) throw new Error("the non-member is missing from the plan");

    expect(entry.nights.map(key)).toEqual([
      ...PARTY_NIGHTS,
      "2026-08-25",
      "2026-08-26",
    ]);
    expect(entry.perNightCents).toEqual([
      7000,
      7000,
      7000,
      7000,
      7000,
      GROUP_NIGHT,
      GROUP_NIGHT,
    ]);
    expect(entry.futureDeltaCents).toBe(2 * GROUP_NIGHT);
    // The two answers this must not give: today's undiscounted rate for the new
    // nights (the pre-#2756 answer), and anything at all for the five nights the
    // member had already paid for.
    expect(entry.futureDeltaCents).not.toBe(2 * NON_MEMBER_NIGHT);
    expect(entry.priceCents).toBe(5 * 7000 + 2 * GROUP_NIGHT);
    expect(entry.perNightCents.slice(0, 5)).toEqual(PARTY_NIGHTS.map(() => 7000));

    // The per-night amounts are what Xero rebuilds its lines from, one line per
    // contiguous run of equally-priced nights, so every run has to multiply back
    // out to its own total (#1163, INV-MONEY-001).
    expect(priceRuns(entry.perNightCents)).toEqual([
      { nightCount: 5, perNightCents: 7000, totalCents: 35000 },
      { nightCount: 2, perNightCents: GROUP_NIGHT, totalCents: 2 * GROUP_NIGHT },
    ]);
    for (const run of priceRuns(entry.perNightCents)) {
      expect(run.perNightCents * run.nightCount).toBe(run.totalCents);
    }
  });

  it("does not move a night already bought when an add pushes the party over the minimum", () => {
    // THE SAFETY PIN, restated on evidence rather than on a fallback (#3031).
    //
    // A non-member bought five nights at 7000 - neither today's undiscounted
    // 12000 nor the discounted 8000 - and adding a guest takes the party from
    // five to six. A plan that priced the two windows against different parties
    // would value those nights at 8000 in one and 12000 in the other, handing
    // the member money back for nights they had already slept, on an edit that
    // only added somebody else.
    //
    // This case used to make the point with a guest carrying NO rows, whose
    // nights were valued at today's rate in BOTH windows and therefore cancelled
    // by accident. They cancel deliberately now: both windows read the same
    // stored integer. The second half of the case is what happened to that
    // guest.
    const boughtAtTheOldRate = partyGuest({
      id: "n1",
      nights: PARTY_NIGHTS,
      isMember: false,
      soldRateCents: 7000,
    });
    const plan = pricedPlan(
      groupPlanInput({
        guests: [...wholeRunMembers(4), boughtAtTheOldRate],
        addGuests: [addedNonMember("a1")],
        groupDiscount: GROUP_DISCOUNT,
      }),
    );
    const entry = plan.proposedExistingGuests.find(
      (candidate) => candidate.guest.id === "n1",
    );
    if (!entry) throw new Error("the non-member is missing from the plan");

    expect(entry.futureDeltaCents).toBe(0);
    expect(entry.newFuturePriceCents).toBe(entry.oldFuturePriceCents);
    expect(entry.priceCents).toBe(5 * 7000);
    expect(entry.perNightCents).toEqual(PARTY_NIGHTS.map(() => 7000));
    // While the nights the edit actually BUYS are discounted in the same plan -
    // which is the point: the discount reached the new nights without touching
    // the old ones.
    expect(plan.proposedAddedGuests[0].priceCents).toBe(2 * GROUP_NIGHT);

    // #3031: the same edit with that guest carrying no rows at all is not priced
    // - it is handed to a person. Nothing about their nights is knowable, so
    // there is no number for the party to move.
    const occurrences = reviewOf(
      groupPlanInput({
        guests: [
          ...wholeRunMembers(4),
          partyGuest({
            id: "n1",
            nights: PARTY_NIGHTS,
            isMember: false,
            soldRateCents: null,
          }),
        ],
        addGuests: [addedNonMember("a1")],
        groupDiscount: GROUP_DISCOUNT,
      }),
    );
    expect(occurrences.map((occurrence) => occurrence.bookingGuestId)).toEqual([
      "n1",
    ]);
    expect(occurrences[0].cause).toBe("NO_STORED_NIGHT_PRICES");
  });

  it("does not re-rate a remaining guest's nights when a removal drops the party below the minimum", () => {
    // The same pin in the other direction, and the worse one: a removal that
    // takes the party from six to five must not re-rate a remaining guest's
    // already-slept nights UP to the undiscounted rate. Their nights carry the
    // price they were sold at, read identically in both windows, so the
    // difference is zero whatever the party does - and it is zero because the
    // rows say so, not because two lookups of today's rate happened to agree.
    const legacy = partyGuest({
      id: "n1",
      nights: PARTY_NIGHTS,
      isMember: false,
      // #3031: their rows record the discounted price they actually bought at.
      // The pin used to be made with a guest carrying no rows, whose nights were
      // valued at today's rate in both windows and cancelled by accident.
      soldRateCents: GROUP_NIGHT,
    });
    const plan = pricedPlan(
      groupPlanInput({
        guests: [...wholeRunMembers(5), legacy],
        removeGuestIds: ["m1"],
        groupDiscount: GROUP_DISCOUNT,
      }),
    );
    const remaining = plan.proposedExistingGuests.find(
      (candidate) => candidate.guest.id === "n1",
    );
    const removed = plan.proposedExistingGuests.find(
      (candidate) => candidate.guest.id === "m1",
    );

    expect(remaining?.futureDeltaCents).toBe(0);
    expect(remaining?.priceCents).toBe(5 * GROUP_NIGHT);
    // The removed member is credited exactly what their rows say they paid.
    expect(removed?.futureDeltaCents).toBe(-2 * MEMBER_NIGHT);
    expect(removed?.priceCents).toBe(3 * MEMBER_NIGHT);
  });

  it("credits a removed guest what their rows say they paid, discount included", () => {
    // A non-member who bought at the discounted rate is taken off the last two
    // nights. Their `BookingGuestNight` rows record the discounted price, so the
    // LOCK returns exactly it — which is how INV-MOD-006's "a party dropping below
    // the minimum on removal never loses a discount it bought" is actually
    // achieved. No party has to be counted for it and no config has to be
    // consulted, which is why it holds for a club with the discount switched off
    // afterwards just as well.
    const boughtDiscounted = partyGuest({
      id: "n1",
      nights: PARTY_NIGHTS,
      isMember: false,
      soldRateCents: GROUP_NIGHT,
    });
    const plan = pricedPlan(
      groupPlanInput({
        guests: [...wholeRunMembers(5), boughtDiscounted],
        removeGuestIds: ["n1"],
        groupDiscount: GROUP_DISCOUNT,
      }),
    );
    const entry = plan.proposedExistingGuests.find(
      (candidate) => candidate.guest.id === "n1",
    );
    if (!entry) throw new Error("the discounted non-member is missing from the plan");

    expect(entry.oldFuturePriceCents).toBe(2 * GROUP_NIGHT);
    expect(entry.oldFuturePriceCents).not.toBe(2 * NON_MEMBER_NIGHT);
    expect(entry.futureDeltaCents).toBe(-2 * GROUP_NIGHT);
    expect(entry.priceCents).toBe(3 * GROUP_NIGHT);
    // Never below zero, whichever way the rates moved (#2744).
    expect(entry.priceCents).toBeGreaterThanOrEqual(0);
  });

  it("REFUSES to credit a guest with NO stored prices, at their own rate or any other", () => {
    // #3031, and the test that fails if the today's-rate credit leg comes back.
    //
    // The population the lock cannot reach: a guest with no `BookingGuestNight`
    // rows at all (a booking predating them, or one created by approving a
    // request - #2739 backfills those but cannot empty the population). There is
    // no per-night evidence of what they paid.
    //
    // The old leg credited them at their own rate type's CURRENT rate, and the
    // comment defending it argued the alternative - today's party and today's
    // config - would credit less. Both are today's price list, and this guest
    // last paid something else: 5 x 12000 is what their total says, and the club
    // may have changed its rates twice since. Neither answer is evidence, so
    // neither is produced.
    const noRows = partyGuest({
      id: "n1",
      nights: PARTY_NIGHTS,
      isMember: false,
      soldRateCents: null,
      paidRateCents: NON_MEMBER_NIGHT,
    });
    const occurrences = reviewOf(
      groupPlanInput({
        guests: [...wholeRunMembers(5), noRows],
        removeGuestIds: ["n1"],
        groupDiscount: GROUP_DISCOUNT,
      }),
    );

    expect(occurrences.map((occurrence) => occurrence.bookingGuestId)).toEqual([
      "n1",
    ]);
    expect(occurrences[0].cause).toBe("NO_STORED_NIGHT_PRICES");
    // Neither of the two amounts the old code chose between exists anywhere on
    // this result: not $240 (their own rate today), not $160 (today's party).
    expect(JSON.stringify(occurrences[0])).not.toContain(
      String(2 * NON_MEMBER_NIGHT),
    );
    expect(JSON.stringify(occurrences[0])).not.toContain(String(2 * GROUP_NIGHT));
    // What IS recorded is the evidence: which nights are leaving, and that the
    // club has no per-night record of them.
    expect(occurrences[0].surrenderedNightDates.length).toBeGreaterThan(0);
    expect(
      occurrences[0].storedEvidence.nightPrices.every(
        (night) => night.priceCents === null,
      ),
    ).toBe(true);
    expect(occurrences[0].storedEvidence.guestTotalCents).toBe(
      5 * NON_MEMBER_NIGHT,
    );
  });

  it("REFUSES a guest with no rows rather than clamping the credit to what they carry", () => {
    // #3031, and the second test that fails if `refundCeilingCents` comes back.
    //
    // A guest with no rows whose stored total is BELOW today's rate for the
    // nights they are giving back. The old code credited today's rate and then
    // clamped the result to their stored total, so they landed on exactly zero
    // and the answer looked safe. It was still a number nobody could evidence,
    // and the thing it was clamped against was a derived total rather than money
    // the club had taken.
    const cheapNoRows = partyGuest({
      id: "n1",
      nights: PARTY_NIGHTS,
      isMember: false,
      soldRateCents: null,
      paidRateCents: 3000,
    });
    const occurrences = reviewOf(
      groupPlanInput({
        guests: [...wholeRunMembers(5), cheapNoRows],
        removeGuestIds: ["n1"],
        groupDiscount: GROUP_DISCOUNT,
      }),
    );

    expect(occurrences[0].cause).toBe("NO_STORED_NIGHT_PRICES");
    // The clamped answer used to be 5 x 3000 credited and the guest left on
    // zero. Neither number exists here: the result carries the EVIDENCE and the
    // identity of the edit, and no amount field at all - which is the shape that
    // makes a fake amount unrepresentable rather than merely absent. (The stored
    // total appears under `storedEvidence`, because that is what the club has on
    // file, not what it owes.)
    expect(Object.keys(occurrences[0]).sort()).toEqual([
      "addedNightDates",
      "bookingGuestId",
      "bookingId",
      "cause",
      "storedEvidence",
      "surrenderedNightDates",
    ]);
    expect(occurrences[0].storedEvidence.guestTotalCents).toBe(5 * 3000);
  });

  it("does not discount a WINTER night on the default summer-only setting, and does with the restriction lifted", () => {
    // The setting the SCHEMA defaults to, and the one an earlier draft of this
    // suite never exercised. `isGroupDiscountApplicable` reads
    // `findSeasonForDate(night, seasons)?.type`, so with `summerOnly: true` a night
    // in a WINTER season is not discounted however large the party — and, the
    // reason this case exists, a season that reaches pricing WITHOUT its type is
    // indistinguishable from that. Every edit path used to hand-roll its
    // `SeasonRateData` and drop `type`, which made the whole discount inert for a
    // default-configured club while this suite stayed green on `summerOnly: false`.
    const winter = pricedPlan({
      ...groupPlanInput({
        guests: wholeRunMembers(5),
        addGuests: [addedNonMember("a1")],
        groupDiscount: GROUP_DISCOUNT,
      }),
      seasons: WINTER_SEASONS,
    });
    expect(winter.proposedAddedGuests[0].perNightCents).toEqual([
      NON_MEMBER_NIGHT,
      NON_MEMBER_NIGHT,
    ]);

    // The same party, the same winter night, with the summer restriction lifted.
    const anySeason = pricedPlan({
      ...groupPlanInput({
        guests: wholeRunMembers(5),
        addGuests: [addedNonMember("a1")],
        groupDiscount: GROUP_DISCOUNT_ANY_SEASON,
      }),
      seasons: WINTER_SEASONS,
    });
    expect(anySeason.proposedAddedGuests[0].perNightCents).toEqual([
      GROUP_NIGHT,
      GROUP_NIGHT,
    ]);

    // And a season carrying no `type` at all behaves as WINTER does under the
    // default: absence is not "summer", which is why the mapping has to carry it.
    const untyped = pricedPlan({
      ...groupPlanInput({
        guests: wholeRunMembers(5),
        addGuests: [addedNonMember("a1")],
        groupDiscount: GROUP_DISCOUNT,
      }),
      seasons: [{ ...GROUP_SEASONS[0], type: undefined }],
    });
    expect(untyped.proposedAddedGuests[0].perNightCents).toEqual([
      NON_MEMBER_NIGHT,
      NON_MEMBER_NIGHT,
    ]);
  });

  it("does not demand a rate for a drifted guest's own past night the floor reaches back over", () => {
    // #2029's check-out-day extension again, in the shape the floor ALONE got
    // wrong. The extension buys the night of the 22nd — inside the locked window,
    // because the booking's check-out was the 22nd and the edit window opens on the
    // 23rd — so the pass has to reach back to it. A SECOND guest's stored nights
    // have drifted past the booking's own check-out (INV-DATE-012) and claim that
    // same 22nd. Nobody reads their price for it: they are in the pass for the
    // party COUNT only. Sending it to the season table anyway is what turned an
    // edit that used to succeed into a thrown "No rate found" — here because the
    // season covering the 22nd carries no row for THEIR rate type, which needs no
    // season gap at all.
    const EARLY_NO_MEMBER_ROW: SeasonRateData[] = [
      {
        seasonId: "s-early",
        startDate: D("2026-08-01"),
        endDate: D("2026-08-22"),
        type: "SUMMER",
        // No ADULT member row: a tier/rate-type combination the covering season
        // cannot price, which is all it takes.
        rates: GROUP_SEASONS[0].rates.filter(
          (rate) => rate.membershipTypeId !== MEMBER_TYPE,
        ),
      },
      {
        seasonId: "s-late",
        startDate: D("2026-08-23"),
        endDate: D("2026-09-30"),
        type: "SUMMER",
        rates: GROUP_SEASONS[0].rates,
      },
    ];
    /** Five non-members whose stay ends on the booking's own check-out day. */
    const onCheckOutDay = Array.from({ length: 5 }, (_, index) =>
      partyGuest({
        id: `n${index + 1}`,
        nights: ["2026-08-20", "2026-08-21"],
        isMember: false,
        soldRateCents: 7000,
      }),
    );
    const driftedGuest = (soldRateCents: number | null) =>
      partyGuest({
        id: "d1",
        nights: ["2026-08-20", "2026-08-21", "2026-08-22"],
        isMember: true,
        soldRateCents,
      });
    const extendBy = (drifted: PartyGuest) =>
      groupPlanInput({
        guests: [...onCheckOutDay, drifted],
        checkIn: "2026-08-20",
        checkOut: "2026-08-22",
        editableFrom: "2026-08-23",
        newCheckOut: "2026-08-24",
        groupDiscount: GROUP_DISCOUNT,
      });
    const extendWithSeasons = (drifted: PartyGuest) => ({
      ...extendBy(drifted),
      seasons: EARLY_NO_MEMBER_ROW,
    });

    // #3031: with NO stored price for the drifted night, the edit is not priced
    // at all. It used to go through by valuing that guest's whole stay at
    // today's rates, and the case was written to show the COST of that being
    // bounded to one night's party count. There is no cost to bound now, because
    // there is no valuation - and the season with no member rate row is never
    // consulted either, so the old "No rate found" throw stays gone.
    const occurrences = reviewOf(extendWithSeasons(driftedGuest(null)));
    // #3166: the five on-check-out-day strands are recorded TOO, and that is a
    // defect fix rather than noise. This edit extends the booking's check-out,
    // so each of them gains 2026-08-22 and 2026-08-23 — nights the parked plan
    // writes NULL against a frozen stored total. A strand that reconciled
    // exactly before the edit is therefore PARTIAL_STORED_NIGHT_PRICES after it
    // and unpriceable for ever, with $70 a night owed on each of five guests and
    // — before this — nothing anywhere recording that they had ever been exact.
    // `BookingModification.previousData` keeps booking-level totals only.
    expect(occurrences.map((occurrence) => occurrence.bookingGuestId)).toEqual([
      "d1",
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
    ]);
    expect(occurrences[0].cause).toBe("NO_STORED_NIGHT_PRICES");
    expect(occurrences.slice(1).map((occurrence) => occurrence.cause)).toEqual(
      Array(5).fill("COUNTERPART_STRAND_UNREADABLE"),
    );
    // Their real per-night prices travel with them, which is the whole point:
    // this is the only copy of them that survives the edit.
    expect(occurrences[1].storedEvidence.nightPrices).toEqual([
      { date: "2026-08-20", priceCents: 7000 },
      { date: "2026-08-21", priceCents: 7000 },
    ]);
    expect(occurrences[1].addedNightDates).toEqual([
      "2026-08-22",
      "2026-08-23",
    ]);

    // With a stored price for it, the same night joins the count without any season
    // lookup — a lock short-circuits the rate — so the party is six on the 22nd and
    // both bought nights are discounted.
    const locked = pricedPlan(extendWithSeasons(driftedGuest(7000)));
    for (const entry of locked.proposedExistingGuests.slice(0, 5)) {
      expect(entry.perNightCents.slice(-2), entry.guest.id).toEqual([
        GROUP_NIGHT,
        GROUP_NIGHT,
      ]);
    }
  });

  it("discounts the check-out-day night an extension buys inside the locked window", () => {
    // #2029's shape, with a discount on it. The booking's check-out is the 22nd
    // and the edit window opens on the 23rd, so extending to the 24th buys the
    // party the night of the 22nd — a night INSIDE the locked window that no
    // guest holds yet. It has to be priced by the party that will be in the
    // lodge on it, which means the pricing pass has to reach back below the edit
    // window to cover it: if it did not, the night would be missing from the pass
    // and the plan would throw rather than quietly hand it out.
    const party = Array.from({ length: MIN_GROUP_SIZE }, (_, index) =>
      partyGuest({
        id: `n${index + 1}`,
        nights: ["2026-08-20", "2026-08-21"],
        isMember: false,
        soldRateCents: 7000,
      }),
    );
    const plan = pricedPlan(
      groupPlanInput({
        guests: party,
        checkIn: "2026-08-20",
        checkOut: "2026-08-22",
        editableFrom: "2026-08-23",
        newCheckOut: "2026-08-24",
        groupDiscount: GROUP_DISCOUNT,
      }),
    );

    for (const entry of plan.proposedExistingGuests) {
      expect(entry.nights.map(key), entry.guest.id).toEqual([
        "2026-08-20",
        "2026-08-21",
        "2026-08-22",
        "2026-08-23",
      ]);
      // Two nights already bought at 7000, two bought now by a party of six.
      expect(entry.perNightCents, entry.guest.id).toEqual([
        7000,
        7000,
        GROUP_NIGHT,
        GROUP_NIGHT,
      ]);
      expect(entry.futureDeltaCents, entry.guest.id).toBe(2 * GROUP_NIGHT);
      expect(entry.futureDeltaCents, entry.guest.id).not.toBe(
        2 * NON_MEMBER_NIGHT,
      );
    }
  });

  it("asks for no rate for a night nobody is repricing, however far back a guest's stay reaches", () => {
    // The other edge of the same floor. Pricing the party in one pass means
    // deciding which nights go INTO the pass, and handing each guest their whole
    // proposed night list would make this plan demand a season rate for nights it
    // is not repricing — so an edit to a stay whose earlier nights sit outside
    // every active season, or whose rate row has since been removed, would start
    // failing. A guest who went home a week ago makes that difference a week wide,
    // because their pricing anchor reaches back to their own stay end even though
    // #2743 lets them buy nothing before the booking's old check-out.
    //
    // Here the only season starts on the 23rd, the day the edit window opens.
    // Every night before it is unpriceable, and the edit must still go through.
    const LATE_SEASON: SeasonRateData[] = [
      {
        seasonId: "s-late",
        startDate: D("2026-08-23"),
        endDate: D("2026-09-30"),
        type: "SUMMER",
        rates: GROUP_SEASONS[0].rates,
      },
    ];
    const departedAWeekAgo = partyGuest({
      id: "m1",
      nights: ["2026-08-16", "2026-08-17"],
      isMember: true,
    });
    const stillHere = Array.from({ length: 5 }, (_, index) =>
      partyGuest({
        id: `n${index + 1}`,
        nights: [
          "2026-08-20",
          "2026-08-21",
          "2026-08-22",
          "2026-08-23",
          "2026-08-24",
          "2026-08-25",
        ],
        isMember: false,
        // #3031: what they were sold, on their rows. The case used to give them
        // no rows at all, which is now the unpriceable state rather than the
        // today's-rate one - and the property under test here is about which
        // nights reach the SEASON TABLE, not about missing evidence.
        soldRateCents: NON_MEMBER_NIGHT,
      }),
    );
    const plan = pricedPlan({
      ...groupPlanInput({
        guests: [departedAWeekAgo, ...stillHere],
        checkIn: "2026-08-16",
        checkOut: "2026-08-26",
        editableFrom: "2026-08-23",
        newCheckOut: "2026-08-28",
        groupDiscount: GROUP_DISCOUNT,
      }),
      seasons: LATE_SEASON,
    });

    // The extension buys the 26th and the 27th for all six of them, so those two
    // nights are a party of six and are discounted; the three nights the five are
    // already holding are a party of five, and are not.
    for (const entry of plan.proposedExistingGuests.slice(1)) {
      expect(entry.futureDeltaCents, entry.guest.id).toBe(2 * GROUP_NIGHT);
      expect(entry.priceCents, entry.guest.id).toBe(
        6 * NON_MEMBER_NIGHT + 2 * GROUP_NIGHT,
      );
      // #3031: the amounts written back are the stored price of every night
      // they keep and the engine's price for the two the extension buys - never
      // a split of the total. Three of the retained nights sit in no season at
      // all, which is exactly why they must come off the rows.
      expect(entry.perNightCents, entry.guest.id).toEqual([
        ...Array.from({ length: 6 }, () => NON_MEMBER_NIGHT),
        GROUP_NIGHT,
        GROUP_NIGHT,
      ]);
    }
    // And the guest who went home a week ago buys only what the extension
    // creates, at their own rate, with their two unpriceable nights untouched.
    const departed = plan.proposedExistingGuests[0];
    expect(departed.nights.map(key)).toEqual([
      "2026-08-16",
      "2026-08-17",
      "2026-08-26",
      "2026-08-27",
    ]);
    expect(departed.perNightCents).toEqual([
      MEMBER_NIGHT,
      MEMBER_NIGHT,
      MEMBER_NIGHT,
      MEMBER_NIGHT,
    ]);
    expect(departed.futureDeltaCents).toBe(2 * MEMBER_NIGHT);
  });

  it("keeps every amount an integer that sums back to the guest's price", () => {
    const plans = [
      pricedPlan(
        groupPlanInput({
          guests: wholeRunMembers(5),
          addGuests: [addedNonMember("a1")],
          groupDiscount: GROUP_DISCOUNT,
        }),
      ),
      pricedPlan(
        groupPlanInput({
          guests: [
            ...wholeRunMembers(5),
            partyGuest({
              id: "n1",
              nights: PARTY_NIGHTS,
              isMember: false,
              soldRateCents: 7001,
            }),
          ],
          newCheckOut: "2026-08-27",
          groupDiscount: GROUP_DISCOUNT,
        }),
      ),
    ];

    for (const plan of plans) {
      for (const entry of [
        ...plan.proposedExistingGuests,
        ...plan.proposedAddedGuests,
      ]) {
        expect(entry.perNightCents.every(Number.isInteger)).toBe(true);
        expect(entry.perNightCents).toHaveLength(entry.nights.length);
        expect(entry.perNightCents.reduce((sum, cents) => sum + cents, 0)).toBe(
          entry.priceCents,
        );
        expect(Number.isInteger(entry.priceCents)).toBe(true);
      }
      expect(Number.isInteger(plan.newTotalPriceCents)).toBe(true);
      expect(plan.newTotalPriceCents).toBe(
        [...plan.proposedExistingGuests, ...plan.proposedAddedGuests].reduce(
          (sum, entry) => sum + entry.priceCents,
          0,
        ),
      );
    }
  });
});
