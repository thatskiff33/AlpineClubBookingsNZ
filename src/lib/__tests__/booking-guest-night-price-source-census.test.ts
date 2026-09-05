import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  stripComments,
  stripCommentsAndStrings,
} from "@/lib/__tests__/support/strip-comments";

const REPO = process.cwd();
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

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full);
      } else if (
        EXECUTABLE_EXTENSION.test(entry.name) &&
        !TEST_FILE.test(entry.name)
      ) {
        files.push(full);
      }
    }
  };
  walk(REPO);
  return files;
}

function relativeSource(file: string): string {
  return relative(REPO, file).split("\\").join("/");
}

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

  it("binds every discovered writer to its reviewed provenance payload", () => {
    const discoveredWriters = new Set<string>();
    for (const file of sourceFiles()) {
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      if (
        /bookingGuestNight\s*\.\s*(create|createMany|update|updateMany|upsert)\b/.test(
          code,
        ) ||
        /\bnights\s*:\s*\{\s*create\s*:/.test(code)
      ) {
        discoveredWriters.add(relativeSource(file));
      }
    }
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
