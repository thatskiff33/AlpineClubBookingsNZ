import { describe, expect, it } from "vitest";

import { bookingOwner } from "@/lib/booking-owner";

import { editDoorBooking } from "./support/edit-door-booking";

// #4925 review: the fixture's default member must agree with the booking's
// member id, or a test that overrides one of them reads an owner who is two
// different people depending on whether it asks `memberId` or `member.id`.
describe("editDoorBooking fixture owner", () => {
  it("gives a booking whose member row matches its member id by default", () => {
    const booking = editDoorBooking();
    expect(booking.memberId).toBe("member_1");
    expect(booking.member?.id).toBe(booking.memberId);
  });

  it("follows an overridden member id", () => {
    const booking = editDoorBooking({ memberId: "m1" });
    expect(booking.memberId).toBe("m1");
    expect(booking.member?.id).toBe("m1");
  });

  it("gives no member row to a booking with no member id, so the organisation owns it", () => {
    const booking = editDoorBooking({
      memberId: null,
      organisationId: "org_1",
      organisation: { name: "Tokoroa School", email: "office@school.example.test" },
    });
    expect(booking.member).toBeNull();
    expect(bookingOwner(booking).memberId).toBeNull();
    expect(bookingOwner(booking).member.firstName).toBe("Tokoroa School");
  });

  it("lets a test state its own member row", () => {
    const own = editDoorBooking().member;
    const booking = editDoorBooking({ memberId: "m2", member: own });
    expect(booking.memberId).toBe("m2");
    expect(booking.member).toBe(own);
  });
});
