import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

/**
 * #3276 (INV-MONEY-029): the census that keeps the night adjustment build-up
 * single-homed and every promotion writer paired with it.
 *
 * Extends the stage-1 pattern in `booking-guest-night-price-source-census.test.ts`
 * (INV-MONEY-028), which pins who may write a night row. This one pins:
 *
 *  1. ONE WRITER. Only `src/lib/night-adjustment-write.ts` writes
 *     `BookingGuestNightAdjustment` rows or `BookingGuestNight.adjustmentsState`.
 *     Every night writer leaves the column at its default, exactly as the old
 *     colour does, so a night can become RECORDED only through the module that
 *     also puts its rows in place.
 *  2. EVERY PROMOTION WRITER IS PAIRED, in the right order. Each site that
 *     writes a redemption (`redeemPromoCode`, `replacePromoRedemptionAllocations`,
 *     `recalculateBookingPromo`, `applyPromoCodeChanges`) is followed in the
 *     same file by `recordBookingNightAdjustments`, and where the promotion is
 *     written BEFORE the night rows (the batch path, the waitlist reprice) the
 *     record comes after the last night write.
 *  3. THE MECHANICAL REWRITES CARRY ROWS FORWARD. The admin date shift and the
 *     batch path's non-engine branches snapshot before the rewrite and restore
 *     after it.
 *  4. THE WRITERS THAT LEAVE UNKNOWN ARE NAMED. Request approval (an officer's
 *     total, an even split), the officer price repair, the seeds and the nested
 *     guest-create helper (recorded by its callers) do not reach for the
 *     recorder, by design.
 *
 * `npm run test:related` cannot select this file — it reads the tree from disk —
 * so it is CI-caught by design, like the stage-1 census.
 */

const REPO = process.cwd();
const MODULE = "src/lib/night-adjustment-write.ts";
const SKIPPED_DIRECTORIES = new Set([
  ".artifacts",
  ".git",
  ".next",
  "__tests__",
  "coverage",
  "migration-verification",
  "migrations",
  "node_modules",
]);
const EXECUTABLE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$/;

const STATE_WRITE = /\badjustmentsState\s*:/;
const ROW_WRITE =
  /bookingGuestNightAdjustment\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
const RAW_SQL_WRITE =
  /\b(?:INSERT\s+INTO|UPDATE|MERGE\s+INTO|DELETE\s+FROM)\b[\s\S]{0,500}["'`](?:BookingGuestNightAdjustment|adjustmentsState)["'`]/i;

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full);
      } else if (EXECUTABLE_EXTENSION.test(entry.name) && !TEST_FILE.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(REPO);
  return files;
}

function rel(file: string): string {
  return relative(REPO, file).split("\\").join("/");
}

function read(file: string): string {
  return stripComments(readFileSync(join(REPO, file), "utf8"));
}

/**
 * Every occurrence of `writer` in `code` is followed, before the next
 * occurrence of `writer`, by `record`. Exported-for-test shape: the mutant
 * proof below feeds it a site with the pairing dropped.
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
    // The nested night write precedes the record.
    expect(precedes(code, /nights:\s*\{\s*create:/, RECORD)).toBe(true);
    // A PARKED add records nothing.
    expect(code).toMatch(/if \(!parked\) \{\s*await recordBookingNightAdjustments\(/);
  },
  "src/lib/booking-date-modification-service.ts": (code) => {
    expect(everyWriteIsFollowedBy(code, /\bawait replacePromoRedemptionAllocations\(/, RECORD)).toBe(true);
    // The date change's night rewrite precedes its record, and a parked one skips it.
    expect(precedes(code, /bookingGuestNight\.createMany\(/, RECORD)).toBe(true);
    expect(code).toMatch(/if \(!parked\) \{\s*await recordBookingNightAdjustments\(/);
    // The admin shift snapshots before translating the rows and restores after,
    // shifted by the same delta.
    expect(precedes(code, SNAPSHOT, /for \(const entry of translatedGuests\)/)).toBe(true);
    expect(precedes(code, /for \(const entry of translatedGuests\)/, RESTORE)).toBe(true);
    expect(code).toMatch(/restoreBookingNightAdjustments\(tx, \{[\s\S]{0,200}shiftDays: deltaDays/);
  },
  "src/lib/booking-guest-removal-service.ts": (code) => {
    expect(everyWriteIsFollowedBy(code, /\bpromoResult = await recalculateBookingPromo\(/, RECORD)).toBe(true);
    // recalculateBookingPromo itself hands the build-up back to its callers.
    expect(code).toMatch(/adjustmentTargets = requiredAdjustmentTargets\(application\)/);
    expect(code).toMatch(/return \{\s*newDiscountCents,[\s\S]{0,300}adjustmentTargets,\s*discount,\s*\}/);
  },
  "src/lib/booking-review-price-rebase.ts": (code) => {
    // Settling a review re-runs the promotion over the strands' stored nights;
    // the repair wrote those rows before this, so the record follows directly.
    expect(everyWriteIsFollowedBy(code, /\bawait recalculateBookingPromo\(/, RECORD)).toBe(true);
    expect(precedes(code, RECORD, /store\.booking\.updateMany\(/)).toBe(true);
  },
  "src/lib/waitlist.ts": (code) => {
    // Promotion first, then nights, then the record, then the booking totals.
    expect(precedes(code, /\bawait recalculateBookingPromo\(/, /bookingGuestNight\.createMany\(/)).toBe(true);
    expect(precedes(code, /bookingGuestNight\.createMany\(/, RECORD)).toBe(true);
    expect(precedes(code, RECORD, /await tx\.booking\.update\(\{\s*where: \{ id: candidate\.id \}/)).toBe(true);
    // And the pure reconciliation runs before the first night write, because
    // this function degrades instead of rolling back.
    expect(precedes(code, /\breconcilePromoAdjustmentTargets\(/, /bookingGuestNight\.deleteMany\(/)).toBe(true);
  },
  "src/lib/booking-modify-plan.ts": (code) => {
    // applyPromoCodeChanges reports the build-up on every branch: null when
    // the engine did not run, the targets when it did.
    expect(code).toMatch(/promoEngineRan: false,\s*adjustmentTargets: null,/);
    expect(code).toMatch(/promoEngineRan: true,\s*adjustmentTargets,/);
    expect(code.match(/adjustmentTargets = requiredAdjustmentTargets\(application\)/g)).toHaveLength(2);
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
    expect(code).toMatch(/adjustmentTargets: null,\s*\}\s*:\s*await applyPromoCodeChanges\(/);
  },
};

/** Night writers that leave adjustmentsState UNKNOWN by design. */
const UNKNOWN_LEAVING_NIGHT_WRITERS = new Map<string, string>([
  ["src/lib/booking-request.ts", "request conversion: an officer's total or an even split, no promotion"],
  ["src/lib/booking-request-shared.ts", "approval night vector: SOLD or EVEN_SPLIT, no promotion"],
  ["src/lib/stored-night-price-repair-store.ts", "officer-priced rows are not known to any promotion engine run"],
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
]);

const SOURCE = sourceFiles();

describe("INV-MONEY-029 night adjustment build-up census", () => {
  it("has exactly one writer of BookingGuestNightAdjustment rows and of adjustmentsState", () => {
    const offenders: string[] = [];
    for (const file of SOURCE) {
      const relative = rel(file);
      if (relative === MODULE) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (STATE_WRITE.test(code) || ROW_WRITE.test(code) || RAW_SQL_WRITE.test(code)) {
        offenders.push(relative);
      }
    }
    expect(
      offenders,
      `INV-MONEY-029: only ${MODULE} may write adjustment rows or adjustmentsState; a night becomes RECORDED only once its rows are in place.`,
    ).toEqual([]);
    const module = read(MODULE);
    expect(module).toMatch(/adjustmentsState: "RECORDED"/);
    expect(module).not.toMatch(/adjustmentsState: "UNKNOWN"/);
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
      const relative = rel(file);
      if (relative === "src/lib/promo.ts") continue;
      if (WRITER_CALL.test(stripComments(readFileSync(file, "utf8")))) writers.add(relative);
    }
    expect(
      [...writers].sort(),
      "INV-MONEY-029: a new promotion writer must be added to PROMO_WRITERS with its recording shape.",
    ).toEqual(Object.keys(PROMO_WRITERS).sort());
  });

  it("names the night writers that leave UNKNOWN, and none of them records", () => {
    for (const [file, reason] of UNKNOWN_LEAVING_NIGHT_WRITERS) {
      const code = read(file);
      expect(code, `INV-MONEY-029: ${file} (${reason}) must not record a build-up`).not.toMatch(RECORD);
    }
  });

  it("allows the writer module to be imported only by the paired writers and the two type-only carriers", () => {
    const importers: string[] = [];
    for (const file of SOURCE) {
      const relative = rel(file);
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
