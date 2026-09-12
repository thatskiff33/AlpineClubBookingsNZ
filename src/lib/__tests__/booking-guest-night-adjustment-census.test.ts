import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoveredWriterSiteCounts,
  relativeSource,
  sourceFiles,
} from "@/lib/__tests__/support/booking-guest-night-writer-scan";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

/**
 * #3276 (INV-MONEY-029): the census that keeps the night adjustment build-up
 * single-homed and every promotion writer paired with it.
 *
 * Extends the stage-1 census (`booking-guest-night-price-source-census.test.ts`,
 * INV-MONEY-028), which pins who may write a night row, and reads the SAME
 * AST discovery of night writers from the shared scanner. This one pins:
 *
 *  1. ONE WRITER OF AMOUNTS. Only `src/lib/night-adjustment-write.ts` creates
 *     `BookingGuestNightAdjustment` rows or puts an amount on one. The member
 *     merge (`member-merge.ts`) reaches the table through a string delegate
 *     name to MOVE or DELETE rows with their allocation, never to invent one;
 *     it is the acknowledged indirect writer and the only file allowed to name
 *     that delegate outside the module. Nothing stores a validity flag anywhere
 *     (validity is derived — owner decision, 10 Sep 2026).
 *  2. EVERY PROMOTION WRITER IS PAIRED, in the right order. Each site that
 *     writes a redemption (`redeemPromoCode`, `replacePromoRedemptionAllocations`,
 *     `recalculateBookingPromo`, `applyPromoCodeChanges`) is followed in the
 *     same file by `recordBookingNightAdjustments`, after the last night write,
 *     and — for the waitlist reprice — outside its degrade-instead-of-rollback
 *     path.
 *  3. THE REDEMPTION ITSELF HAS ONE WRITER. Direct Prisma writes to
 *     `PromoRedemption`, `PromoRedemptionAllocation` and
 *     `PromoRedemptionGuestTarget` live in `src/lib/promo.ts` only, so a
 *     promotion cannot be written by a path the pairing above never sees.
 *  4. EVERY DISCOVERED NIGHT WRITER HAS DECLARED ITSELF: it is a paired
 *     promotion writer, or it is named below with the reason it records
 *     nothing. A new night writer fails this census until it says which.
 *
 * `npm run test:related` cannot select this file — it reads the tree from disk —
 * so it is CI-caught by design, like the stage-1 census.
 */

const REPO = process.cwd();
const MODULE = "src/lib/night-adjustment-write.ts";

const ROW_WRITE =
  /bookingGuestNightAdjustment\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
const RAW_SQL_WRITE =
  /\b(?:INSERT\s+INTO|UPDATE|MERGE\s+INTO|DELETE\s+FROM)\b[\s\S]{0,500}["'`]BookingGuestNightAdjustment["'`]/i;
const REDEMPTION_WRITE =
  /promoRedemption(?:Allocation|GuestTarget)?\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
const REDEMPTION_RAW_SQL_WRITE =
  /\b(?:INSERT\s+INTO|UPDATE|MERGE\s+INTO|DELETE\s+FROM)\b[\s\S]{0,500}["'`]PromoRedemption(?:Allocation|GuestTarget)?["'`]/i;
/**
 * The member merge reaches Prisma delegates by NAME (`delegates[args.delegate]`),
 * which no property-access scan can see. So the delegate names themselves are
 * censused: outside the writer module and `promo.ts`, a string literal naming
 * one of these delegates may appear only in the merge — the acknowledged
 * indirect writer, which moves or deletes rows and never invents an amount.
 */
const INDIRECT_WRITER = "src/lib/member-merge.ts";
const DELEGATE_NAME_LITERAL =
  /["'](?:bookingGuestNightAdjustment|promoRedemption|promoRedemptionAllocation|promoRedemptionGuestTarget)["']/;

function read(file: string): string {
  return stripComments(readFileSync(join(REPO, file), "utf8"));
}

/**
 * Every occurrence of `writer` in `code` is followed, before the next
 * occurrence of `writer`, by `record`. The mutant proof below feeds it a site
 * with the pairing dropped.
 */
export function everyWriteIsFollowedBy(code: string, writer: RegExp, record: RegExp): boolean {
  const writerGlobal = new RegExp(writer.source, "g");
  const sites: number[] = [];
  for (let m = writerGlobal.exec(code); m; m = writerGlobal.exec(code)) sites.push(m.index);
  if (sites.length === 0) return false;
  return sites.every((start, i) => {
    const end = i + 1 < sites.length ? sites[i + 1] : code.length;
    return record.test(code.slice(start, end));
  });
}

function firstIndex(code: string, pattern: RegExp): number {
  const m = pattern.exec(code);
  return m ? m.index : -1;
}

/** `a` appears in `code`, and its FIRST occurrence sits before the first `b`. */
function precedes(code: string, a: RegExp, b: RegExp): boolean {
  const ia = firstIndex(code, a);
  const ib = firstIndex(code, b);
  return ia >= 0 && ib >= 0 && ia < ib;
}

const RECORD = /\brecordBookingNightAdjustments\(/;
const SNAPSHOT = /\bsnapshotBookingNightAdjustments\(/;
const RESTORE = /\brestoreBookingNightAdjustments\(/;

/** The files that write a promotion, and the shape each must carry. */
const PROMO_WRITERS: Record<string, (code: string) => void> = {
  "src/lib/booking-create.ts": (code) => {
    // Three creates redeem a promotion; every one records afterwards, and the
    // split child (which can carry none) records its empty build-up too.
    expect(everyWriteIsFollowedBy(code, /\bawait redeemPromoCode\(/, RECORD)).toBe(true);
    expect(code.match(/\brecordBookingNightAdjustments\(/g)).toHaveLength(4);
  },
  "src/app/api/bookings/[id]/guests/route.ts": (code) => {
    expect(everyWriteIsFollowedBy(code, /\bawait replacePromoRedemptionAllocations\(/, RECORD)).toBe(true);
    // The nested night write precedes the record; the targets come off the
    // bundled discount; a PARKED add records nothing.
    expect(precedes(code, /nights:\s*\{\s*create:/, RECORD)).toBe(true);
    expect(code).toMatch(/adjustmentTargets = promoResult\.adjustmentTargets/);
    expect(code).toMatch(/if \(!parked\) \{\s*await recordBookingNightAdjustments\(/);
  },
  "src/lib/booking-date-modification-service.ts": (code) => {
    expect(everyWriteIsFollowedBy(code, /\bawait replacePromoRedemptionAllocations\(/, RECORD)).toBe(true);
    expect(precedes(code, /bookingGuestNight\.createMany\(/, RECORD)).toBe(true);
    expect(code).toMatch(/adjustmentTargets = promoResult\.adjustmentTargets/);
    expect(code).toMatch(/if \(!parked\) \{\s*await recordBookingNightAdjustments\(/);
    // The admin shift snapshots before translating the rows and restores after,
    // shifted by the same delta.
    expect(precedes(code, SNAPSHOT, /for \(const entry of translatedGuests\)/)).toBe(true);
    expect(precedes(code, /for \(const entry of translatedGuests\)/, RESTORE)).toBe(true);
    expect(code).toMatch(/restoreBookingNightAdjustments\(tx, \{[\s\S]{0,200}shiftDays: deltaDays/);
  },
  "src/lib/booking-guest-removal-service.ts": (code) => {
    expect(everyWriteIsFollowedBy(code, /\bpromoResult = await recalculateBookingPromo\(/, RECORD)).toBe(true);
    // recalculateBookingPromo hands the bundled build-up back to its callers.
    expect(code).toMatch(/adjustmentTargets = discount\.adjustmentTargets/);
    expect(code).toMatch(/return \{\s*newDiscountCents,[\s\S]{0,300}adjustmentTargets,\s*\}/);
  },
  "src/lib/booking-review-price-rebase.ts": (code) => {
    // Settling a review re-runs the promotion over the strands' stored nights;
    // the repair wrote those rows before this, so the record follows directly.
    expect(everyWriteIsFollowedBy(code, /\bawait recalculateBookingPromo\(/, RECORD)).toBe(true);
    expect(precedes(code, RECORD, /store\.booking\.updateMany\(/)).toBe(true);
  },
  "src/lib/waitlist.ts": (code) => {
    // Promotion first, then nights, then the totals — all inside the
    // degrade-to-snapshot try — and the record AFTER the catch, so a refusal
    // fails the sweep transaction instead of committing a half-reprice (C1).
    expect(precedes(code, /\bawait recalculateBookingPromo\(/, /bookingGuestNight\.createMany\(/)).toBe(true);
    expect(precedes(code, /bookingGuestNight\.createMany\(/, RECORD)).toBe(true);
    expect(
      precedes(
        code,
        /\} catch \(err\) \{\s*logger\.error\(\s*\{ err, bookingId: candidate\.id \},\s*"Failed to reprice waitlisted booking/,
        RECORD,
      ),
    ).toBe(true);
    expect(code).toMatch(/targets: repriced\.adjustmentTargets,/);
  },
  "src/lib/booking-modify-plan.ts": (code) => {
    // applyPromoCodeChanges reports the build-up only on the arm where the
    // engine ran; the union on PromoChangeResult makes the other arm carry none.
    expect(code).toMatch(/promoEngineRan: true,\s*adjustmentTargets,/);
    expect(code).toMatch(/promoEngineRan: false,\s*\};/);
    expect(code.match(/adjustmentTargets = promoResult\.adjustmentTargets/g)).toHaveLength(2);
  },
  "src/lib/booking-batch-modification-service.ts": (code) => {
    // THE ORDERING HAZARD: the promotion is written before the night rows are
    // rewritten, so the record must come after `applyGuestChanges`.
    expect(precedes(code, /\bawait applyPromoCodeChanges\(/, /\bawait applyGuestChanges\(/)).toBe(true);
    expect(precedes(code, /\bawait applyGuestChanges\(/, RECORD)).toBe(true);
    expect(code).toMatch(/if \(promo\.promoEngineRan\) \{[\s\S]{0,400}recordBookingNightAdjustments\(/);
    // Non-engine priced branches carry the stored rows across.
    expect(precedes(code, SNAPSHOT, /\bawait applyGuestChanges\(/)).toBe(true);
    expect(precedes(code, /\bawait applyGuestChanges\(/, RESTORE)).toBe(true);
    expect(code).toMatch(/promoEngineRan: false as const,\s*\}\s*:\s*await applyPromoCodeChanges\(/);
  },
};

/**
 * Night writers that record no build-up, by design, and why. A file that the
 * shared scanner discovers as a night writer must appear here or in
 * `PROMO_WRITERS`; a reader derives these bookings' build-up from their rows
 * (absent rows on a promoted booking read as not known).
 */
const NIGHT_WRITERS_WITHOUT_PROMOTION = new Map<string, string>([
  ["src/lib/booking-request.ts", "request conversion: an officer's total or an even split, no promotion"],
  ["src/lib/booking-request-shared.ts", "approval night vector: SOLD or EVEN_SPLIT, no promotion"],
  [
    "src/lib/stored-night-price-repair-store.ts",
    "an officer prices a night; the settle re-base that follows records the engine's figure over it",
  ],
  ["src/lib/booking-create-guests.ts", "nested create helper; its callers in booking-create.ts record"],
  ["e2e/setup/seed-second-lodge.ts", "test seed"],
  ["prisma/demo-seed.ts", "demo seed"],
]);

/** Every file allowed to import the writer module, and why. */
const MODULE_IMPORTERS = new Set([
  ...Object.keys(PROMO_WRITERS),
  // Type-only: the build-up travels through the application result.
  "src/lib/promo.ts",
  "src/lib/booking-create-promo.ts",
  // #3277 Stage 3 named readers. Their exact call shapes are pinned by
  // booking-money-build-up-reader-census.test.ts.
  "src/lib/booking-credit-election.ts",
  "src/lib/xero-booking-invoices.ts",
]);

const SOURCE = sourceFiles();
// Computed at module load, as the stage-1 census does: the AST walk over the
// whole tree takes seconds under a parallel run, which is longer than one
// test's budget, and its result is the same for every assertion below.
const DISCOVERED_NIGHT_WRITERS = [...discoveredWriterSiteCounts().keys()].sort();

describe("INV-MONEY-029 night adjustment build-up census", () => {
  it("has exactly one writer of BookingGuestNightAdjustment amounts, one acknowledged indirect mover, and no stored validity flag anywhere", () => {
    const offenders: string[] = [];
    const delegateNamers: string[] = [];
    for (const file of SOURCE) {
      const relative = relativeSource(file);
      if (relative === MODULE) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (ROW_WRITE.test(code) || RAW_SQL_WRITE.test(code)) offenders.push(relative);
      if (relative !== "src/lib/promo.ts" && DELEGATE_NAME_LITERAL.test(code)) delegateNamers.push(relative);
    }
    expect(
      offenders,
      `INV-MONEY-029: only ${MODULE} may write adjustment rows directly.`,
    ).toEqual([]);
    // The indirect route: a delegate reached by name. Only the merge may, and it
    // must still be doing so (the control), and it must never put an amount on a
    // row — its only data write is the beneficiary move.
    expect(
      delegateNamers.sort(),
      "INV-MONEY-029: a file names an adjustment or promotion delegate as a string; only the member merge may reach these tables indirectly.",
    ).toEqual([INDIRECT_WRITER]);
    const merge = read(INDIRECT_WRITER);
    expect(merge).toMatch(/delegate: "bookingGuestNightAdjustment"/);
    expect(merge).not.toMatch(/amountCents/);
    // Validity is derived by summing rows (owner decision, 10 Sep 2026). A flag
    // column would be a second statement of that fact that a draining colour or
    // a rollback could leave false; the schema must not grow one back.
    expect(readFileSync(join(REPO, "prisma/schema.prisma"), "utf8")).not.toMatch(/adjustmentsState/);
    const writerModule = read(MODULE);
    expect(writerModule).toMatch(/export function deriveNightAdjustmentState\(/);
    expect(writerModule).not.toMatch(/adjustmentsState/);
  });

  it("pairs every promotion writer with the recorder, in the order the night rows allow", () => {
    for (const [file, check] of Object.entries(PROMO_WRITERS)) {
      const code = read(file);
      try {
        check(code);
      } catch (error) {
        throw new Error(
          `INV-MONEY-029: ${file} no longer records the promotion build-up through its reviewed shape.\n${String(error)}`,
        );
      }
    }
  });

  it("finds no promotion writer outside the paired set", () => {
    const writers = new Set<string>();
    const WRITER_CALL =
      /\b(?:await redeemPromoCode|await replacePromoRedemptionAllocations|await recalculateBookingPromo|await applyPromoCodeChanges)\(/;
    for (const file of SOURCE) {
      const relative = relativeSource(file);
      if (relative === "src/lib/promo.ts") continue;
      if (WRITER_CALL.test(stripComments(readFileSync(file, "utf8")))) writers.add(relative);
    }
    expect(
      [...writers].sort(),
      "INV-MONEY-029: a new promotion writer must be added to PROMO_WRITERS with its recording shape.",
    ).toEqual(Object.keys(PROMO_WRITERS).sort());
  });

  it("keeps every direct PromoRedemption / allocation / guest-target write inside src/lib/promo.ts", () => {
    // A seed is not a runtime path: no member is charged by it and no recorder
    // can pair with it. Named so a second seed, or a runtime file, still fails.
    const SEEDS = new Set(["prisma/demo-seed.ts"]);
    const offenders: string[] = [];
    for (const file of SOURCE) {
      const relative = relativeSource(file);
      if (relative === "src/lib/promo.ts" || SEEDS.has(relative)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (REDEMPTION_WRITE.test(code) || REDEMPTION_RAW_SQL_WRITE.test(code)) offenders.push(relative);
    }
    expect(
      offenders,
      "INV-MONEY-029: a promotion written outside promo.ts bypasses the four helpers the pairing census watches.",
    ).toEqual([]);
    // The one indirect route is the member merge, which moves or drops
    // allocation rows by delegate NAME (censused above) and writes no amount.
    expect(read(INDIRECT_WRITER)).toMatch(/delegate: "promoRedemptionAllocation"/);
    for (const seed of SEEDS) {
      expect(read(seed), `${seed} is listed as a seed that writes a promotion; it no longer does`).toMatch(REDEMPTION_WRITE);
    }
    // The control: promo.ts really is where those writes live.
    expect(read("src/lib/promo.ts")).toMatch(REDEMPTION_WRITE);
  });

  it("requires every discovered night writer to say how it records — paired, or exempt with a reason", () => {
    const discovered = DISCOVERED_NIGHT_WRITERS;
    const declared = new Set([...Object.keys(PROMO_WRITERS), ...NIGHT_WRITERS_WITHOUT_PROMOTION.keys()]);
    const undeclared = discovered.filter((file) => !declared.has(file));
    expect(
      undeclared,
      "INV-MONEY-029: a night writer must either pair with recordBookingNightAdjustments (PROMO_WRITERS) or be listed in NIGHT_WRITERS_WITHOUT_PROMOTION with the reason it records nothing.",
    ).toEqual([]);
    // Nothing is both, and every exemption still names a real file that really
    // does not record.
    for (const [file, reason] of NIGHT_WRITERS_WITHOUT_PROMOTION) {
      expect(file in PROMO_WRITERS, `${file} cannot be both paired and exempt`).toBe(false);
      expect(existsSync(join(REPO, file)), `${file} (${reason}) is not on disk`).toBe(true);
      expect(read(file), `INV-MONEY-029: ${file} (${reason}) must not record a build-up`).not.toMatch(RECORD);
    }
    // The control for the discovery itself: the shared scanner does find writers.
    expect(discovered.length).toBeGreaterThanOrEqual(8);
  });

  it("allows the module to be imported only by paired writers, type carriers, and named readers", () => {
    const importers: string[] = [];
    for (const file of SOURCE) {
      const relative = relativeSource(file);
      if (relative === MODULE) continue;
      if (/from "@\/lib\/night-adjustment-write"/.test(readFileSync(file, "utf8"))) importers.push(relative);
    }
    expect(importers.sort()).toEqual([...MODULE_IMPORTERS].sort());
  });

  it("mutation-proves the pairing helper rejects a site whose record was dropped", () => {
    const paired =
      "await redeemPromoCode(tx); await recordBookingNightAdjustments(tx); await redeemPromoCode(tx); await recordBookingNightAdjustments(tx);";
    const dropped = "await redeemPromoCode(tx); await recordBookingNightAdjustments(tx); await redeemPromoCode(tx);";
    const reordered = "await recordBookingNightAdjustments(tx); await redeemPromoCode(tx);";
    expect(everyWriteIsFollowedBy(paired, /\bawait redeemPromoCode\(/, RECORD)).toBe(true);
    expect(everyWriteIsFollowedBy(dropped, /\bawait redeemPromoCode\(/, RECORD)).toBe(false);
    expect(everyWriteIsFollowedBy(reordered, /\bawait redeemPromoCode\(/, RECORD)).toBe(false);
    expect(everyWriteIsFollowedBy("", /\bawait redeemPromoCode\(/, RECORD)).toBe(false);
  });
});
