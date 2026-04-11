import { describe, expect, it } from "vitest";
import {
  canModifyBookingStatus,
  usesActiveBookingLifecycle,
} from "@/lib/booking-modify-permissions";

describe("booking modify permissions", () => {
  it("allows members to modify only active booking lifecycle statuses", () => {
    expect(canModifyBookingStatus("PENDING", "MEMBER")).toBe(true);
    expect(canModifyBookingStatus("CONFIRMED", "MEMBER")).toBe(true);
    expect(canModifyBookingStatus("PAID", "MEMBER")).toBe(true);
    expect(canModifyBookingStatus("DRAFT", "MEMBER")).toBe(false);
    expect(canModifyBookingStatus("WAITLISTED", "MEMBER")).toBe(false);
  });

  it("allows admins to modify the additional future-booking statuses from phase 1", () => {
    expect(canModifyBookingStatus("DRAFT", "ADMIN")).toBe(true);
    expect(canModifyBookingStatus("WAITLISTED", "ADMIN")).toBe(true);
    expect(canModifyBookingStatus("WAITLIST_OFFERED", "ADMIN")).toBe(true);
    expect(canModifyBookingStatus("BUMPED", "ADMIN")).toBe(true);
    expect(canModifyBookingStatus("CANCELLED", "ADMIN")).toBe(false);
    expect(canModifyBookingStatus("COMPLETED", "ADMIN")).toBe(false);
  });

  it("marks only active booking states for the full capacity/payment lifecycle", () => {
    expect(usesActiveBookingLifecycle("PENDING")).toBe(true);
    expect(usesActiveBookingLifecycle("CONFIRMED")).toBe(true);
    expect(usesActiveBookingLifecycle("PAID")).toBe(true);
    expect(usesActiveBookingLifecycle("DRAFT")).toBe(false);
    expect(usesActiveBookingLifecycle("WAITLISTED")).toBe(false);
  });
});
