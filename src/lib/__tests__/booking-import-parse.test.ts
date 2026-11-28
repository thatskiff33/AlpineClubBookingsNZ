import { AgeTier } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  BOOKING_IMPORT_PART_PAID_REFUSAL,
  parseBookingImportCsv,
  type ParsedImportBooking,
} from "@/lib/booking-import/parse";
import { inferBookingImportColumnMapping } from "@/lib/booking-import/columns";
import { memberImportIdentityKey } from "@/lib/member-import-identity";

const HEADER =
  "Booking Ref,Owner Email,Owner First Name,Owner Last Name,Guest Type,Guest Email,Guest First Name,Guest Last Name,Age Group,Check In,Check Out,Amount Paid";

function row(fields: Partial<Record<string, string>> = {}) {
  const values = {
    ref: "B1",
    ownerEmail: "ann@example.test",
    ownerFirst: "Ann",
    ownerLast: "Owner",
    type: "Member",
    guestEmail: "ann@example.test",
    guestFirst: "Ann",
    guestLast: "Owner",
    age: "",
    checkIn: "2026-08-10",
    checkOut: "2026-08-12",
    amount: "100.00",
    ...fields,
  };
  return [
    values.ref,
    values.ownerEmail,
    values.ownerFirst,
    values.ownerLast,
    values.type,
    values.guestEmail,
    values.guestFirst,
    values.guestLast,
    values.age,
    values.checkIn,
    values.checkOut,
    values.amount,
  ].join(",");
}

function parseBookings(lines: string[], header = HEADER): ParsedImportBooking[] {
  const result = parseBookingImportCsv([header, ...lines].join("\n"));
  if (!result.ok) throw new Error(result.error);
  return result.bookings;
}

describe("memberImportIdentityKey", () => {
  it("matches email case-insensitively and names by normalised spelling", () => {
    expect(
      memberImportIdentityKey({
        email: " Ann@Example.TEST ",
        firstName: "  ann ",
        lastName: "OWNER",
      }),
    ).toBe(
      memberImportIdentityKey({
        email: "ann@example.test",
        firstName: "Ann",
        lastName: "Owner",
      }),
    );
    expect(
      memberImportIdentityKey({ email: "ann@example.test", firstName: "Ann", lastName: "Other" }),
    ).not.toBe(
      memberImportIdentityKey({ email: "ann@example.test", firstName: "Ann", lastName: "Owner" }),
    );
  });
});

describe("parseBookingImportCsv", () => {
  it("retains refused beds so sold stays still reconcile by night", () => {
    const [booking] = parseBookings([`${row()},50,2026-08-01`], `${HEADER},Balance Owing,Balance Due Date`);
    expect(booking?.refusals).toContain(BOOKING_IMPORT_PART_PAID_REFUSAL);
    expect(booking?.nightDemand).toEqual([
      { night: "2026-08-10", beds: 1 },
      { night: "2026-08-11", beds: 1 },
    ]);
  });

  it("refuses totals exceeding the stored integer-cent range", () => {
    const result = parseBookingImportCsv([HEADER, row({ amount: "21474836.47" }), row({ amount: "1" })].join("\n"));
    expect(result.ok).toBe(false);
  });

  it("refuses a mistyped distant departure without expanding its nights", () => {
    const [booking] = parseBookings([row(), row({ checkIn: "2999-08-10", checkOut: "2999-08-12", amount: "1" })]);
    expect(booking?.refusals.join(" ")).toContain("envelope");
  });

  it("groups rows by Booking Ref in file order", () => {
    const bookings = parseBookings([
      row({ ref: "B1" }),
      row({ ref: "B2", amount: "50" }),
      row({ ref: "B1", type: "Non-member", guestEmail: "", guestFirst: "Kid", age: "Child" }),
    ]);
    expect(bookings.map((booking) => booking.bookingRef)).toEqual(["B1", "B2"]);
    const [first] = bookings;
    expect(first?.refusals).toEqual([]);
    expect(first?.lineCount).toBe(2);
    expect(first?.firstLineNumber).toBe(2);
    expect(first?.guests.map((guest) => guest.lineNumber)).toEqual([2, 4]);
    expect(first?.guests[1]).toMatchObject({
      isMember: false,
      ageTier: AgeTier.CHILD,
      identity: { email: "", firstName: "Kid", lastName: "Owner" },
    });
  });

  it("reads per-guest amounts and totals them", () => {
    const [booking] = parseBookings([
      row({ amount: "1200.50" }),
      row({ type: "Guest", guestEmail: "", guestFirst: "Bob", age: "adult", amount: "99.5" }),
    ]);
    expect(booking?.amountMode).toBe("PER_GUEST");
    expect(booking?.guests.map((guest) => guest.amountCents)).toEqual([120050, 9950]);
    expect(booking?.totalCents).toBe(130_000);
    expect(booking?.guestNightCount).toBe(4);
  });

  it.each(["1,2", "$100", "10.001", "-1"])("refuses malformed dollars %s through the shared money reader", (amount) => {
    const [booking] = parseBookings([row({ amount: `"${amount}"` })]);
    expect(booking?.refusals.join(" ")).toContain("not a dollar amount");
  });

  it("splits a first-row booking total across guest-nights", () => {
    const [booking] = parseBookings([
      row({ amount: "100.00" }),
      row({
        type: "Non-member",
        guestEmail: "",
        guestFirst: "Bob",
        age: "Adult",
        checkIn: "2026-08-10",
        checkOut: "2026-08-11",
        amount: "",
      }),
    ]);
    expect(booking?.amountMode).toBe("BOOKING_TOTAL");
    // 3 guest-nights: 3334 + 3333 for the two-night guest, 3333 for the other.
    expect(booking?.guests.map((guest) => guest.amountCents)).toEqual([6667, 3333]);
    expect(booking?.totalCents).toBe(10_000);
    expect(booking?.checkIn).toBe("2026-08-10");
    expect(booking?.checkOut).toBe("2026-08-12");
  });

  it("refuses a mix of filled and blank amounts, and a blank first amount", () => {
    const [mixed] = parseBookings([
      row(),
      row({ type: "Guest", guestEmail: "", guestFirst: "B", age: "Adult", amount: "" }),
      row({ type: "Guest", guestEmail: "", guestFirst: "C", age: "Adult", amount: "10" }),
    ]);
    expect(mixed?.refusals).toContain(
      "Amount Paid must be on every guest row or on the first row only, not a mix",
    );
    expect(mixed?.guests).toEqual([]);

    const [blank] = parseBookings([row({ amount: "" })]);
    expect(blank?.refusals).toEqual(["Amount Paid is missing on line 2"]);

    const [malformed] = parseBookings([row({ amount: "ten" })]);
    expect(malformed?.refusals[0]).toMatch(/not a dollar amount/);
  });

  it("reads dates in the chosen format and cross-checks Nights", () => {
    const header = `${HEADER},Nights`;
    const text = [header, `${row({ checkIn: "10/08/2026", checkOut: "13/08/2026" })},3`].join(
      "\n",
    );
    const result = parseBookingImportCsv(text, { dateFormat: "dd/MM/yyyy" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bookings[0]?.guests[0]).toMatchObject({
      checkIn: "2026-08-10",
      checkOut: "2026-08-13",
      nights: 3,
    });

    const [wrongNights] = parseBookings([`${row()},5`], header);
    expect(wrongNights?.refusals).toEqual(["Nights on line 2 does not match the dates, which give 2"]);

    const [backwards] = parseBookings([row({ checkIn: "2026-08-12", checkOut: "2026-08-12" })]);
    expect(backwards?.refusals[0]).toMatch(/Check Out must be after Check In/);

    const [badDate] = parseBookings([row({ checkIn: "10/08/2026" })]);
    expect(badDate?.refusals[0]).toBe("Check In on line 2 must match yyyy-MM-dd");

    const [tooLong] = parseBookings([row({ checkOut: "2027-08-12" })]);
    expect(tooLong?.refusals[0]).toMatch(/longer than 366 nights/);
  });

  it("refuses a part-paid booking", () => {
    const header = `${HEADER},Balance Owing`;
    const [booking] = parseBookings([`${row()},40.00`], header);
    expect(booking?.refusals).toEqual([BOOKING_IMPORT_PART_PAID_REFUSAL]);
    expect(booking?.guests).toEqual([]);
    expect(booking?.totalCents).toBe(10_000);
  });

  it("refuses rows that disagree on the owner or name a bad guest", () => {
    const [booking] = parseBookings([
      row(),
      row({ ownerFirst: "Anne", type: "Visitor" }),
      row({ type: "Non-member", guestEmail: "", age: "Teen" }),
      row({ type: "Member", guestEmail: "" }),
    ]);
    expect(booking?.refusals).toEqual([
      "Owner First Name differs between the booking's rows",
      "Guest Type on line 3 must be Member or Non-member",
      "Age Group on line 4 must be Adult, Youth, Child or Infant for a non-member",
      "A member guest needs a Guest Email (line 5)",
    ]);
  });

  it("refuses the whole file for structural faults", () => {
    expect(parseBookingImportCsv("Booking Ref\nB1")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Missing columns: Owner Email/),
    });
    expect(parseBookingImportCsv([HEADER, row({ ref: "" })].join("\n"))).toEqual({
      ok: false,
      error: "Every row needs a Booking Ref",
      lineNumber: 2,
    });
    expect(parseBookingImportCsv(`${HEADER},Booking Ref\n${row()},B1`)).toEqual({
      ok: false,
      error: 'The column "Booking Ref" appears twice',
    });
    expect(parseBookingImportCsv([HEADER, row({ ref: "R".repeat(101) })].join("\n"))).toEqual({
      ok: false,
      error: "A Booking Ref is longer than 100 characters",
      lineNumber: 2,
    });
    const tooMany = [HEADER, ...Array.from({ length: 501 }, () => row())].join("\n");
    expect(parseBookingImportCsv(tooMany)).toMatchObject({ ok: false });
  });
});

describe("the officer's column mapping (#5005 child C)", () => {
  // The old system's own headers, in another order, with one extra column.
  const OLD_HEADER =
    "Ref,Paid,Leaving,Arriving,Age,Guest Last,Guest First,Guest Mail,Kind,Owner Last,Owner First,Owner Mail,Branch";
  const OLD_ROW = "B1,100.00,2026-08-12,2026-08-10,,Owner,Ann,ann@example.test,Member,Owner,Ann,ann@example.test,North";
  const MAPPING = {
    bookingRef: 0, amountPaid: 1, checkOut: 2, checkIn: 3, ageGroup: 4, guestLastName: 5, guestFirstName: 6,
    guestEmail: 7, guestType: 8, ownerLastName: 9, ownerFirstName: 10, ownerEmail: 11,
  } as const;

  it("reads a file whose headers the import does not know, through the mapping, as it reads the standard file", () => {
    const mapped = parseBookingImportCsv([OLD_HEADER, OLD_ROW].join("\n"), { columnMapping: MAPPING });
    if (!mapped.ok) throw new Error(mapped.error);
    expect(mapped.bookings).toEqual(parseBookings([row()]));
    // Without the mapping the same file is missing every required column.
    expect(parseBookingImportCsv([OLD_HEADER, OLD_ROW].join("\n"))).toMatchObject({ ok: false, error: expect.stringMatching(/^Missing columns: Booking Ref, /) });
  });

  it("refuses a mapping to a column the file lacks, one column mapped twice, or a required column left out", () => {
    const text = [OLD_HEADER, OLD_ROW].join("\n");
    expect(parseBookingImportCsv(text, { columnMapping: { ...MAPPING, notes: 13 } })).toEqual({ ok: false, error: '"Notes" is mapped to a column the file does not have' });
    expect(parseBookingImportCsv(text, { columnMapping: { ...MAPPING, notes: 0 } })).toEqual({ ok: false, error: 'One file column is mapped to both "Booking Ref" and "Notes"' });
    expect(parseBookingImportCsv(text, { columnMapping: { ...MAPPING, amountPaid: null } })).toEqual({ ok: false, error: "Missing column: Amount Paid" });
  });

  it("proposes the mapping the headers name, first column first", () => {
    expect(inferBookingImportColumnMapping(["booking ref", "Notes", "Check In", "notes"])).toEqual({ bookingRef: 0, notes: 1, checkIn: 2 });
  });
});
