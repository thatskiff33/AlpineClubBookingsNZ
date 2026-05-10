import { describe, expect, it } from "vitest";
import {
  buildAuditDrilldownLinks,
  buildAuditMemberScopeWhere,
  inferAuditCategoryFromAction,
} from "@/lib/audit-query";

describe("audit query helpers", () => {
  it("builds precise member scope filters", () => {
    expect(buildAuditMemberScopeWhere("member-1", "actor")).toEqual({
      OR: [{ actorMemberId: "member-1" }, { memberId: "member-1" }],
    });

    expect(buildAuditMemberScopeWhere("member-1", "subject")).toEqual({
      OR: [
        { subjectMemberId: "member-1" },
        {
          AND: [
            { subjectMemberId: null },
            { entityType: "Member" },
            { entityId: "member-1" },
          ],
        },
        { AND: [{ subjectMemberId: null }, { targetId: "member-1" }] },
      ],
    });
  });

  it("infers system category only after known domains are checked", () => {
    expect(inferAuditCategoryFromAction("booking.payment.confirmed")).toBe(
      "booking"
    );
    expect(inferAuditCategoryFromAction("XERO_FORCE_SYNC_INVOICE")).toBe(
      "payment"
    );
    expect(inferAuditCategoryFromAction("unknown.internal.job")).toBe("system");
  });

  it("builds useful admin drilldown links without duplicates", () => {
    const links = buildAuditDrilldownLinks({
      action: "booking.payment.confirmed",
      targetId: "booking-1",
      subjectMemberId: "member-1",
      entityType: "Booking",
      entityId: "booking-1",
      metadata: { bookingId: "booking-1", paymentId: "payment-1" },
    });

    expect(links).toEqual([
      expect.objectContaining({
        label: "Open member",
        href: "/admin/members/member-1",
        primary: true,
      }),
      expect.objectContaining({
        label: "Open booking",
        href: "/bookings/booking-1",
      }),
      expect.objectContaining({
        label: "Payment activity",
        href: "/admin/xero/records/Payment/payment-1",
      }),
    ]);
  });

  it("falls back to the right admin section for non-entity actions", () => {
    expect(
      buildAuditDrilldownLinks({
        action: "BULK_COMMUNICATION_SENT",
        targetId: null,
        subjectMemberId: null,
        entityType: null,
        entityId: null,
        metadata: null,
      })
    ).toEqual([
      expect.objectContaining({
        label: "Open communications",
        href: "/admin/communications",
      }),
    ]);
  });
});
