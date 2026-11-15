import { BookingRequestStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { toMyWholeLodgeRequestStatus } from "@/lib/member-whole-lodge-requests";
import { toSubjectAccessBookingRequest } from "@/lib/subject-access-export-sections";

/**
 * A whole-lodge request in the subject access file (owner decision,
 * 15 Nov 2026, #4915): the member-facing status "My requests" shows (#2263),
 * never an officer-side state, and none of the request's price fields. Both
 * the member's download and the Full Admin report take their rows from this
 * one mapper, so the two files cannot differ here.
 */
const PRICE_FIELDS = ["indicativePriceCents", "priceCents", "acceptedPriceCents"] as const;

const MEMBER = "member-1";

function row(
  status: BookingRequestStatus,
  exclusivityRequested: boolean,
  requestedByMemberId: string | null = MEMBER,
) {
  return {
    type: (requestedByMemberId ? "GENERAL" : "SCHOOL") as "GENERAL" | "SCHOOL",
    status,
    exclusivityRequested,
    requestedByMemberId,
    contactEmail: "member@example.invalid",
    checkIn: new Date(Date.UTC(2026, 7, 10)),
    checkOut: new Date(Date.UTC(2026, 7, 12)),
    indicativePriceCents: 91_111,
    priceCents: 92_222,
    acceptedPriceCents: 93_333,
    declineReason: null,
    createdAt: new Date(Date.UTC(2026, 6, 1)),
  };
}

describe("a whole-lodge request in the subject access file", () => {
  it.each([
    [BookingRequestStatus.PRICED, "pending"],
    [BookingRequestStatus.QUOTED, "pending"],
    [BookingRequestStatus.QUERY_PENDING, "pending"],
  ] as const)("exports the officer-side status %s as the member-facing word %s", (status, word) => {
    expect(toSubjectAccessBookingRequest(row(status, true)).status).toBe(word);
  });

  it("uses the 'My requests' mapping for every status, so no officer-side value leaves", () => {
    for (const status of Object.values(BookingRequestStatus)) {
      expect(toSubjectAccessBookingRequest(row(status, true)).status).toBe(toMyWholeLodgeRequestStatus(status));
    }
  });

  it("carries none of the request's price fields, by key or by value", () => {
    for (const status of Object.values(BookingRequestStatus)) {
      const exported = toSubjectAccessBookingRequest(row(status, true));
      const text = JSON.stringify(exported);
      for (const field of PRICE_FIELDS) expect(exported).not.toHaveProperty(field);
      for (const value of ["91111", "92222", "93333"]) expect(text).not.toContain(value);
    }
  });

  it("keeps the dates as NZ date-only lodge nights and marks the row as whole-lodge", () => {
    expect(toSubjectAccessBookingRequest(row(BookingRequestStatus.PRICED, true))).toMatchObject({
      wholeLodge: true,
      checkIn: "2026-08-10",
      checkOut: "2026-08-12",
    });
  });

  it("never carries the requesting member's id", () => {
    expect(toSubjectAccessBookingRequest(row(BookingRequestStatus.PRICED, true))).not.toHaveProperty("requestedByMemberId");
    expect(toSubjectAccessBookingRequest(row(BookingRequestStatus.QUOTED, false))).not.toHaveProperty("requestedByMemberId");
  });

  it("leaves a school's whole-lodge request, which 'My requests' never lists, with its quoted status and prices", () => {
    expect(toSubjectAccessBookingRequest(row(BookingRequestStatus.QUOTE_SENT, true, null))).toMatchObject({
      wholeLodge: true,
      status: BookingRequestStatus.QUOTE_SENT,
      priceCents: 92_222,
      acceptedPriceCents: 93_333,
    });
  });

  it("leaves a request that is not whole-lodge with its stored status and prices", () => {
    expect(toSubjectAccessBookingRequest(row(BookingRequestStatus.QUOTED, false))).toMatchObject({
      wholeLodge: false,
      status: BookingRequestStatus.QUOTED,
      indicativePriceCents: 91_111,
      priceCents: 92_222,
      acceptedPriceCents: 93_333,
    });
  });
});
