import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { stripCommentsAndStrings } from "@/lib/__tests__/support/strip-comments";

const REPO = process.cwd();
const SRC = resolve(REPO, "src");
const EXECUTABLE_WRITER_FILES = [
  resolve(REPO, "prisma/demo-seed.ts"),
  resolve(REPO, "e2e/setup/seed-second-lodge.ts"),
];

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(SRC);
  return [...files, ...EXECUTABLE_WRITER_FILES];
}

function relativeSource(file: string): string {
  return relative(REPO, file).split("\\").join("/");
}

const EXPECTED_SOURCE_ASSIGNMENTS = new Map<string, number>([
  ["src/lib/booking-create-guests.ts", 1],
  ["src/app/api/bookings/[id]/guests/route.ts", 2],
  ["src/lib/booking-request-shared.ts", 3],
  ["src/lib/waitlist.ts", 1],
  ["src/lib/booking-modify-plan.ts", 4],
  ["src/lib/booking-date-modification-service.ts", 6],
  ["src/lib/booking-request.ts", 3],
  ["src/lib/stored-night-price-repair-store.ts", 2],
  ["prisma/demo-seed.ts", 1],
  ["e2e/setup/seed-second-lodge.ts", 1],
]);

const REQUIRED_WRITER_SHAPES = new Map<string, RegExp[]>([
  [
    "src/lib/booking-modify-plan.ts",
    [
      /perNightPriceSources:\s*ReadonlyArray<BookingGuestNightPriceSource>/,
      /priceSource:\s*nightPriceSourceToWrite\(bg,\s*k,\s*stayDate\)/,
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
      /buildApprovalGuestNights[\s\S]*?priceSource:\s*"SOLD"/,
      /buildApprovalGuestNights[\s\S]*?priceSource:\s*"EVEN_SPLIT"/,
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
    "prisma/demo-seed.ts",
    [/bookingGuestNight\.create\([\s\S]*?priceSource:\s*"SOLD"/],
  ],
  [
    "e2e/setup/seed-second-lodge.ts",
    [/bookingGuestNight\.create\([\s\S]*?priceSource:\s*"SOLD"/],
  ],
]);

describe("INV-MONEY-028 BookingGuestNight writer census", () => {
  it("knows every direct model writer and every nested night-create builder", () => {
    const directWriters: string[] = [];
    const nestedWriters: string[] = [];
    for (const file of sourceFiles()) {
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      if (/bookingGuestNight\s*\.\s*(create|createMany|update|updateMany|upsert)\b/.test(code)) {
        directWriters.push(relativeSource(file));
      }
      if (/\bnights\s*:\s*\{\s*create\s*:/.test(code)) {
        nestedWriters.push(relativeSource(file));
      }
    }

    expect(directWriters.sort()).toEqual(
      [
        "prisma/demo-seed.ts",
        "e2e/setup/seed-second-lodge.ts",
        "src/lib/booking-date-modification-service.ts",
        "src/lib/booking-modify-plan.ts",
        "src/lib/booking-request.ts",
        "src/lib/stored-night-price-repair-store.ts",
        "src/lib/waitlist.ts",
      ].sort(),
    );
    expect(nestedWriters.sort()).toEqual(
      [
        "src/app/api/bookings/[id]/guests/route.ts",
        "src/lib/booking-create-guests.ts",
        "src/lib/booking-request-shared.ts",
      ].sort(),
    );
  });

  it("requires an explicit source at every reviewed writer and propagation boundary", () => {
    for (const [file, expected] of EXPECTED_SOURCE_ASSIGNMENTS) {
      const code = stripCommentsAndStrings(
        readFileSync(join(REPO, file), "utf8"),
      );
      const count = [...code.matchAll(/\bpriceSource\s*:/g)].length;
      expect(
        count,
        `INV-MONEY-028: ${file} has ${count} explicit priceSource assignments/selects; expected ${expected}. Re-census every BookingGuestNight write before changing this pin.`,
      ).toBe(expected);
    }
  });

  it("pins provenance to the executable write payloads and required propagation vector", () => {
    for (const [file, shapes] of REQUIRED_WRITER_SHAPES) {
      const code = readFileSync(join(REPO, file), "utf8");
      for (const shape of shapes) {
        expect(
          code,
          `INV-MONEY-028: ${file} no longer carries provenance through its reviewed write shape (${shape}).`,
        ).toMatch(shape);
      }
    }
  });
});
