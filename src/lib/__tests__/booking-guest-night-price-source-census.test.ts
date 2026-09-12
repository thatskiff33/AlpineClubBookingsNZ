import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoveredWriterSiteCounts,
  scanSource,
} from "@/lib/__tests__/support/booking-guest-night-writer-scan";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

const REPO = process.cwd();

const REQUIRED_WRITER_SHAPES = new Map<string, RegExp[]>([
  [
    "e2e/setup/seed-second-lodge.ts",
    [/bookingGuestNight\.create\([\s\S]*?data:\s*\{[\s\S]*?priceSource:\s*"SOLD"/],
  ],
  [
    "prisma/demo-seed.ts",
    [/bookingGuestNight\.create\([\s\S]*?data:\s*\{[\s\S]*?priceSource:\s*"SOLD"/],
  ],
  [
    "src/app/api/bookings/[id]/guests/route.ts",
    [/nights:\s*\{\s*create:\s*\(priced\.nightDates[\s\S]*?priceSource:\s*"SOLD"/],
  ],
  [
    "src/lib/booking-create-guests.ts",
    [/nights:\s*\{\s*create:\s*nightDates\.map[\s\S]*?priceSource:\s*"SOLD"/],
  ],
  [
    "src/lib/booking-date-modification-service.ts",
    [
      /bookingGuestNight\.createMany\([\s\S]*?priceSource:\s*requiredNightPriceSourceToWrite\(/,
      /bookingGuestNight\.createMany\([\s\S]*?priceSource:\s*night\.priceSource/,
    ],
  ],
  [
    "src/lib/booking-modify-plan.ts",
    [
      /bookingGuestNight\.createMany\([\s\S]*?priceSource:\s*nightPriceSourceToWrite\(bg,\s*k,\s*stayDate\)/,
    ],
  ],
  [
    "src/lib/booking-request.ts",
    [
      /nightRows\.push\([\s\S]*?priceSource:\s*night\.priceSource[\s\S]*?bookingGuestNight\.createMany\(\{\s*data:\s*nightRows\s*\}\)/,
      /const replacementNights[\s\S]*?priceSource:\s*night\.priceSource[\s\S]*?bookingGuestNight\.createMany\(\{\s*data:\s*replacementNights\s*\}\)/,
    ],
  ],
  [
    "src/lib/booking-request-shared.ts",
    [
      /buildApprovalGuestNights[\s\S]*?priceSource:\s*"SOLD"[\s\S]*?priceSource:\s*"EVEN_SPLIT"/,
      /toPipelineGuestCreateData[\s\S]*?nights:\s*\{\s*create:\s*\[\.\.\.nights\]\s*\}/,
    ],
  ],
  [
    "src/lib/stored-night-price-repair-store.ts",
    [
      /bookingGuestNight\.updateMany\([\s\S]*?priceSource:\s*"OFFICER_PRICED"/,
      /bookingGuestNight\.create\([\s\S]*?priceSource:\s*"OFFICER_PRICED"/,
    ],
  ],
  [
    "src/lib/waitlist.ts",
    [
      /repricedNightRows[\s\S]*?priceSource:\s*"SOLD"[\s\S]*?bookingGuestNight\.createMany\(\{\s*data:\s*repricedNightRows\[index\]/,
    ],
  ],
]);

const REQUIRED_WRITER_SITE_COUNTS = new Map<
  string,
  { direct: number; nested: number }
>([
  ["e2e/setup/seed-second-lodge.ts", { direct: 1, nested: 0 }],
  ["prisma/demo-seed.ts", { direct: 1, nested: 0 }],
  ["src/app/api/bookings/[id]/guests/route.ts", { direct: 0, nested: 1 }],
  ["src/lib/booking-create-guests.ts", { direct: 0, nested: 1 }],
  ["src/lib/booking-date-modification-service.ts", { direct: 2, nested: 0 }],
  ["src/lib/booking-modify-plan.ts", { direct: 1, nested: 0 }],
  ["src/lib/booking-request.ts", { direct: 2, nested: 0 }],
  ["src/lib/booking-request-shared.ts", { direct: 0, nested: 1 }],
  ["src/lib/stored-night-price-repair-store.ts", { direct: 2, nested: 0 }],
  ["src/lib/waitlist.ts", { direct: 1, nested: 0 }],
]);

const DISCOVERED_WRITER_SITE_COUNTS = discoveredWriterSiteCounts();

describe("INV-MONEY-028 BookingGuestNight writer census", () => {
  it("knows every direct and nested writer site, including repeats in one file", () => {
    expect(
      [...DISCOVERED_WRITER_SITE_COUNTS]
        .map(([file, { direct, nested }]) => [file, { direct, nested }] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    ).toEqual(
      [...REQUIRED_WRITER_SITE_COUNTS].sort(([a], [b]) => a.localeCompare(b)),
    );
  });

  it("rejects aliased delegates and runtime raw-SQL writes that evade the direct census", () => {
    const unsupported = [...DISCOVERED_WRITER_SITE_COUNTS]
      .filter(([, scan]) => scan.aliasedDelegates > 0 || scan.rawSqlWrites > 0)
      .map(([file, { aliasedDelegates, rawSqlWrites }]) => ({
        file,
        aliasedDelegates,
        rawSqlWrites,
      }));
    expect(
      unsupported,
      "INV-MONEY-028: BookingGuestNight writers must remain directly discoverable Prisma calls with reviewed provenance payloads.",
    ).toEqual([]);
  });

  it("mutation-proves the alias and raw-SQL escape routes are rejected", () => {
    expect(
      scanSource(
        "aliased-mutant.ts",
        "const nights = tx.bookingGuestNight; await nights.create({ data: { priceCents: 1 } });",
      ).aliasedDelegates,
    ).toBe(1);
    expect(
      scanSource(
        "forwarded-mutant.ts",
        'await writeNights(tx["bookingGuestNight"]);',
      ).aliasedDelegates,
    ).toBe(1);
    expect(
      scanSource(
        "destructured-mutant.ts",
        "const { bookingGuestNight: nights } = tx; await nights.create({ data: { priceCents: 1 } });",
      ).aliasedDelegates,
    ).toBe(1);
    expect(
      scanSource(
        "raw-sql-mutant.ts",
        'await tx.$executeRawUnsafe(`INSERT INTO "BookingGuestNight" ("priceCents") VALUES (1)`);',
      ).rawSqlWrites,
    ).toBe(1);
  });

  it("binds every discovered writer to its reviewed provenance payload", () => {
    const discoveredWriters = new Set(DISCOVERED_WRITER_SITE_COUNTS.keys());
    expect([...REQUIRED_WRITER_SHAPES.keys()].sort()).toEqual(
      [...discoveredWriters].sort(),
    );

    for (const [file, shapes] of REQUIRED_WRITER_SHAPES) {
      const code = stripComments(readFileSync(join(REPO, file), "utf8"));
      for (const shape of shapes) {
        expect(
          code,
          `INV-MONEY-028: ${file} no longer carries provenance through its reviewed write shape (${shape}).`,
        ).toMatch(shape);
      }
    }
  });
});
