import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #5289 review: a settlement marker is a `BookingEvent` of type CANCELLED that
 * cancels nothing (`SETTLEMENT_MARKERS`), and a bank-transfer settle can write
 * one after the booking's real cancellation. A reader that takes the booking's
 * NEWEST cancellation event for its frozen figures must leave markers out
 * (`NOT_A_SETTLEMENT_MARKER_WHERE`), or it reads a marker's snapshot as the
 * cancellation's. A reader that loads every cancellation event and tells them
 * apart in code (`isManualSettlementMarkerEvent`) is not this shape.
 */
const SRC_DIR = path.resolve(__dirname, "../..");

const CANCELLED = String.raw`type: (?:BookingEventType\.CANCELLED|"CANCELLED")`;
/** `bookingEvent.findFirst({ where: { ..., type: CANCELLED, ... } ...` with a flat where-clause. */
const NEWEST_BY_FIND_FIRST = new RegExp(String.raw`bookingEvent\.findFirst\(\{\s*where: \{[^{}]*${CANCELLED}[^{}]*\}`, "g");
/** A booking's `events` relation narrowed to its cancellations and cut to one row. */
const NEWEST_BY_RELATION = new RegExp(String.raw`events: \{\s*where: \{[^{}]*${CANCELLED}[^{}]*\},[^\n]*\n\s*orderBy: [^\n]*\n\s*take: 1`, "g");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("readers of a booking's newest cancellation event (#5289 review)", () => {
  it("MUTATION: each leaves settlement markers out of the one event it reads", () => {
    const readers: string[] = [];
    const unguarded: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const text = readFileSync(file, "utf8");
      const reads = [...text.matchAll(NEWEST_BY_FIND_FIRST), ...text.matchAll(NEWEST_BY_RELATION)].map((match) => match[0]);
      if (reads.length === 0) continue;
      const rel = path.relative(path.resolve(SRC_DIR, ".."), file).split(path.sep).join("/");
      readers.push(rel);
      if (reads.some((read) => !read.includes("...NOT_A_SETTLEMENT_MARKER_WHERE"))) unguarded.push(rel);
    }
    expect(unguarded).toEqual([]);
    // The shapes above still find the readers they were written for.
    expect(readers.sort()).toEqual([
      "src/lib/booking-ledger-back-post.ts",
      "src/lib/booking-ledger-projection-census-store.ts",
      "src/lib/edit-financial-review-account-credit.ts",
      "src/lib/edit-financial-review-cancel-netting.ts",
      "src/lib/group-settlement-mirror-hand-back.ts",
    ]);
  });
});
