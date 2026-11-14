import { describe, expect, it, vi } from "vitest";

// The pure helpers under test never reach the database.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { memberImportIdentityKey } from "@/lib/member-import-identity";
import { resolveImportBooking } from "@/lib/booking-import/resolve";
import { parseBookingImportCsv, type ParsedImportBooking } from "@/lib/booking-import/parse";
import {
  bookingImportBatchKey,
  bookingImportPlanDigest,
  joinBookingImportRefusals,
  type BookingImportRowPlan,
} from "@/lib/booking-import/plan";

const HEADER =
  "Booking Ref,Owner Email,Owner First Name,Owner Last Name,Guest Type,Guest Email,Guest First Name,Guest Last Name,Age Group,Check In,Check Out,Amount Paid";

function bookings(lines: string[]): ParsedImportBooking[] {
  const result = parseBookingImportCsv([HEADER, ...lines].join("\n"));
  if (!result.ok) throw new Error(result.error);
  return result.bookings;
}

const LINE = "B1,ann@example.test,Ann,Owner,Member,ann@example.test,Ann,Owner,,2026-08-10,2026-08-12,100.00";

function rowPlan(overrides: Partial<BookingImportRowPlan> = {}): BookingImportRowPlan {
  return {
    bookingRef: "B1",
    firstLineNumber: 2,
    outcome: "IMPORT",
    alreadyImported: false,
    refusals: [],
    checkIn: "2026-08-10",
    checkOut: "2026-08-12",
    amountCents: 10_000,
    guestCount: 1,
    guestNightCount: 2,
    appRateCents: null,
    appRateDifferenceCents: null,
    nights: [],
    overCapacityNights: [],
    ...overrides,
  };
}

describe("bookingImportBatchKey", () => {
  it("is the same for the same content however the identities are spelled", () => {
    const respelled = "B1,ANN@Example.test, ann ,OWNER,Member,Ann@example.test,ANN,owner,,2026-08-10,2026-08-12,100";
    expect(bookingImportBatchKey("lodge-1", bookings([LINE]))).toBe(
      bookingImportBatchKey("lodge-1", bookings([respelled])),
    );
  });

  it("differs by lodge, amount and dates", () => {
    const key = bookingImportBatchKey("lodge-1", bookings([LINE]));
    expect(bookingImportBatchKey("lodge-2", bookings([LINE]))).not.toBe(key);
    expect(bookingImportBatchKey("lodge-1", bookings([LINE.replace("100.00", "100.01")]))).not.toBe(key);
    expect(bookingImportBatchKey("lodge-1", bookings([LINE.replace("2026-08-12", "2026-08-13")]))).not.toBe(key);
  });
});

describe("bookingImportPlanDigest", () => {
  it("binds guest-night demand, file content, prices, outcomes and refusal text", () => {
    const digest = bookingImportPlanDigest("lodge-1", [rowPlan()], "file-key", []);
    expect(bookingImportPlanDigest("lodge-1", [rowPlan({ nights: [{ night: "2026-08-10", beds: 1 }] })], "file-key", [])).not.toBe(digest);
    expect(bookingImportPlanDigest("lodge-1", [rowPlan()], "changed-file", [])).not.toBe(digest);
    expect(bookingImportPlanDigest("lodge-1", [rowPlan({ appRateCents: 500 })], "file-key", [])).not.toBe(digest);
    const refused = rowPlan({ outcome: "REFUSED", refusals: [{ code: "OVER_CAPACITY", message: "full" }] });
    expect(bookingImportPlanDigest("lodge-1", [refused], "file-key", [])).not.toBe(digest);
    expect(
      bookingImportPlanDigest("lodge-1", [{ ...refused, refusals: [{ code: "OVER_CAPACITY", message: "fuller" }] }], "file-key", []),
    ).not.toBe(bookingImportPlanDigest("lodge-1", [refused], "file-key", []));
  });
});

describe("joinBookingImportRefusals", () => {
  it("stores one reason per line", () => {
    expect(
      joinBookingImportRefusals([
        { code: "HOSTING", message: "a" },
        { code: "SUPERVISION", message: "b" },
      ]),
    ).toBe("a\nb");
  });
});

describe("resolveImportBooking", () => {
  const context = { lodge: { id: "lodge-1", name: "Test Lodge", slug: "test", active: true }, activeLodgeCount: 1 };
  const person = { id: "member-1", ageTier: "ADULT" as const, active: true, cancelledAt: null, archivedAt: null };
  const key = memberImportIdentityKey({ email: "ann@example.test", firstName: "Ann", lastName: "Owner" });

  it("refuses an unknown or ambiguous identity instead of guessing a member", () => {
    const booking = bookings([LINE])[0]!;
    expect(resolveImportBooking(booking, context, new Map()).refusals.map((r) => r.code)).toEqual(["MEMBER", "MEMBER"]);
    const members = new Map([[key, [person, { ...person, id: "member-2" }]]]);
    expect(resolveImportBooking(booking, context, members).refusals.every((r) => r.message.includes("more than one"))).toBe(true);
  });

  it("refuses inactive members and closed or unspecified lodges", () => {
    const booking = bookings([LINE])[0]!;
    const members = new Map([[key, [{ ...person, active: false }]]]);
    expect(resolveImportBooking(booking, context, members).resolved).toBeNull();
    const current = new Map([[key, [person]]]);
    expect(resolveImportBooking(booking, { ...context, activeLodgeCount: 2 }, current).refusals[0]?.code).toBe("LODGE");
    expect(resolveImportBooking(booking, { ...context, lodge: { ...context.lodge, active: false } }, current).refusals[0]?.code).toBe("LODGE");
  });
});
