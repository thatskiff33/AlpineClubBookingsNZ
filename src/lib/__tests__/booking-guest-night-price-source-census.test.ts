import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { stripCommentsAndStrings } from "@/lib/__tests__/support/strip-comments";

const SRC = resolve(process.cwd(), "src");

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
  return files;
}

function relativeSource(file: string): string {
  return relative(SRC, file).split("\\").join("/");
}

const EXPECTED_SOURCE_ASSIGNMENTS = new Map<string, number>([
  ["lib/booking-create-guests.ts", 1],
  ["app/api/bookings/[id]/guests/route.ts", 2],
  ["lib/booking-request-shared.ts", 3],
  ["lib/waitlist.ts", 1],
  ["lib/booking-modify-plan.ts", 4],
  ["lib/booking-date-modification-service.ts", 6],
  ["lib/booking-request.ts", 3],
  ["lib/stored-night-price-repair-store.ts", 2],
]);

describe("INV-MONEY-028 BookingGuestNight writer census", () => {
  it("knows every direct model writer and every nested night-create builder", () => {
    const directWriters: string[] = [];
    const nestedWriters: string[] = [];
    for (const file of sourceFiles()) {
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      if (/bookingGuestNight\s*\.\s*(create|createMany|update|updateMany)\b/.test(code)) {
        directWriters.push(relativeSource(file));
      }
      if (/\bnights\s*:\s*\{\s*create\s*:/.test(code)) {
        nestedWriters.push(relativeSource(file));
      }
    }

    expect(directWriters.sort()).toEqual(
      [
        "lib/booking-date-modification-service.ts",
        "lib/booking-modify-plan.ts",
        "lib/booking-request.ts",
        "lib/stored-night-price-repair-store.ts",
        "lib/waitlist.ts",
      ].sort(),
    );
    expect(nestedWriters.sort()).toEqual(
      [
        "app/api/bookings/[id]/guests/route.ts",
        "lib/booking-create-guests.ts",
        "lib/booking-request-shared.ts",
      ].sort(),
    );
  });

  it("requires an explicit source at every reviewed writer and propagation boundary", () => {
    for (const [file, expected] of EXPECTED_SOURCE_ASSIGNMENTS) {
      const code = stripCommentsAndStrings(
        readFileSync(join(SRC, file), "utf8"),
      );
      const count = [...code.matchAll(/\bpriceSource\s*:/g)].length;
      expect(
        count,
        `INV-MONEY-028: ${file} has ${count} explicit priceSource assignments/selects; expected ${expected}. Re-census every BookingGuestNight write before changing this pin.`,
      ).toBe(expected);
    }
  });
});
