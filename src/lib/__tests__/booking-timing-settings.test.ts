import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #4932: the three booking timings a club may set, read from BookingDefaults.

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { bookingDefaults: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

import { getBookingTimingSettings } from "@/lib/booking-timing-settings";
import { policySchema } from "@/lib/booking-policy-cancellation-schema";
import { BOOKING_TIMING_KEYS } from "@/lib/booking-timings";
import {
  BOOKING_TIMING_DAYS_MAX,
  BOOKING_TIMING_DAYS_MIN,
  DEFAULT_BOOKING_DEFAULTS,
} from "@/config/club-settings-defaults";

const TIMING_FIELDS = [
  "preArrivalReminderDays",
  "additionalPaymentReminderDays",
  "policyExceptionHoldDays",
] as const;

beforeEach(() => {
  findUnique.mockReset();
});

describe("getBookingTimingSettings", () => {
  it("gives a club that never saved the row the shipped three, three and seven days", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getBookingTimingSettings()).toEqual({
      preArrivalReminderDays: 3,
      additionalPaymentReminderDays: 3,
      policyExceptionHoldDays: 7,
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "default" },
      select: {
        preArrivalReminderDays: true,
        additionalPaymentReminderDays: true,
        policyExceptionHoldDays: true,
      },
    });
  });

  it("returns each value the club saved", async () => {
    findUnique.mockResolvedValue({
      preArrivalReminderDays: 5,
      additionalPaymentReminderDays: 1,
      policyExceptionHoldDays: 14,
    });
    expect(await getBookingTimingSettings()).toEqual({
      preArrivalReminderDays: 5,
      additionalPaymentReminderDays: 1,
      policyExceptionHoldDays: 14,
    });
  });
});

describe("the timing defaults have one source (INV-SSOT)", () => {
  const schema = readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8");
  const model = schema.match(/model BookingDefaults \{[\s\S]*?\n\}/)?.[0] ?? "";
  const migration = readFileSync(
    path.join(
      process.cwd(),
      "prisma",
      "migrations",
      "20261220020000_add_booking_timing_settings",
      "migration.sql",
    ),
    "utf8",
  );

  it.each(TIMING_FIELDS)("%s: the schema default is DEFAULT_BOOKING_DEFAULTS'", (field) => {
    const declared = model.match(new RegExp(`\\n\\s*${field}\\s+Int\\s+@default\\((\\d+)\\)`));
    expect(declared, `${field} is missing from model BookingDefaults`).not.toBeNull();
    expect(Number(declared![1])).toBe(DEFAULT_BOOKING_DEFAULTS[field]);
  });

  it.each(TIMING_FIELDS)("%s: the database CHECK carries the admin bound", (field) => {
    expect(migration).toContain(
      `"${field}" BETWEEN ${BOOKING_TIMING_DAYS_MIN} AND ${BOOKING_TIMING_DAYS_MAX}`,
    );
  });
});

// The three timing keys are listed in four places that cannot all be derived
// from BOOKING_TIMING_KEYS: the reader's select, the route's request schema,
// its club-wide-only guard and the admin form's rows. This walks every key in
// BOOKING_TIMING_KEYS through the two server-side ones, so a fourth timing
// added to the keys alone fails here until each place knows it (INV-SSOT).
describe("every timing key is wired into each place that lists it", () => {
  const BASE = { rules: [{ daysBeforeStay: 7, refundPercentage: 100 }] };

  it("the reader selects exactly the timing keys", async () => {
    findUnique.mockResolvedValue(null);
    await getBookingTimingSettings();
    const { select } = findUnique.mock.calls[0][0] as { select: Record<string, boolean> };
    expect(Object.keys(select).sort()).toEqual([...BOOKING_TIMING_KEYS].sort());
    expect(Object.values(select).every((picked) => picked === true)).toBe(true);
  });

  it.each(BOOKING_TIMING_KEYS)("%s: the request schema bounds it", (key) => {
    expect(policySchema.safeParse({ ...BASE, [key]: BOOKING_TIMING_DAYS_MIN }).success).toBe(true);
    expect(policySchema.safeParse({ ...BASE, [key]: BOOKING_TIMING_DAYS_MAX }).success).toBe(true);
    expect(policySchema.safeParse({ ...BASE, [key]: BOOKING_TIMING_DAYS_MIN - 1 }).success).toBe(false);
    expect(policySchema.safeParse({ ...BASE, [key]: BOOKING_TIMING_DAYS_MAX + 1 }).success).toBe(false);
    expect(policySchema.safeParse({ ...BASE, [key]: 2.5 }).success).toBe(false);
  });

  it.each(BOOKING_TIMING_KEYS)("%s: a lodge override that carries it is refused", (key) => {
    const result = policySchema.safeParse({
      ...BASE,
      lodgeId: "lodge-1",
      [key]: BOOKING_TIMING_DAYS_MIN,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain(key);
  });
});
