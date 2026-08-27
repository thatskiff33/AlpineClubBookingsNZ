import { describe, expect, it } from "vitest";
import { parseAdminAuditLogQuery } from "@/lib/audit-admin-query";
import { requireClubTimeZone } from "@/lib/club-time";
import {
  buildAuditDrilldownLinks,
  buildAuditMemberScopeWhere,
  getAuditTimelinePage,
  inferAuditCategoryFromAction,
} from "@/lib/audit-query";

/**
 * The club's persisted timezone, supplied rather than read (#3123): the audit
 * date filters bound `AuditLog.createdAt`, a real instant column, so their
 * boundaries are the club's. That the value comes from the PERSISTED setting
 * rather than `APP_TIME_ZONE` is pinned in
 * `audit-admin-query-club-time-authority.test.ts`.
 */
const CLUB_ZONE = requireClubTimeZone("Pacific/Auckland");

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

  it("parses admin audit filters into a Prisma where clause", () => {
    const result = parseAdminAuditLogQuery(
      new URLSearchParams({
        action: "LOGIN",
        category: "security",
        memberId: "member-1",
        memberScope: "subject",
        from: "2026-04-01",
        to: "2026-04-30",
        outcome: "success",
        severity: "critical",
        entityType: "Member",
        q: " req-1 ",
        page: "2",
        pageSize: "50",
      }),
      CLUB_ZONE,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.page).toBe(2);
    expect(result.data.pageSize).toBe(50);
    expect(result.data.eventType).toBe("LOGIN");
    expect(result.data.filters).toEqual({
      eventType: "LOGIN",
      category: "security",
      memberId: "member-1",
      memberScope: "subject",
      from: "2026-04-01",
      to: "2026-04-30",
      outcome: "success",
      severity: "critical",
      entityType: "Member",
      q: "req-1",
    });
    expect(result.data.where.AND).toEqual(
      expect.arrayContaining([
        { action: "LOGIN" },
        expect.objectContaining({
          OR: expect.arrayContaining([{ category: "security" }]),
        }),
        expect.objectContaining({
          OR: expect.arrayContaining([{ subjectMemberId: "member-1" }]),
        }),
        {
          createdAt: {
            gte: new Date("2026-03-31T11:00:00.000Z"),
            // #3123 made the upper bound HALF-OPEN. `lte` against the last
            // millisecond of the day and `lt` against the next midnight differ
            // only below the millisecond — and Postgres keeps microseconds, so
            // the inclusive form could drop a row written in the day's final
            // millisecond.
            lt: new Date("2026-04-30T12:00:00.000Z"),
          },
        },
        { outcome: "success" },
        { severity: "critical" },
        { entityType: "Member" },
        expect.objectContaining({
          OR: expect.arrayContaining([
            { requestId: { contains: "req-1", mode: "insensitive" } },
          ]),
        }),
      ]),
    );
  });

  it("renders synthetic system: actors as System, not Unknown member", async () => {
    // The boot-time config bootstrap (#1988) audits with the synthetic actor
    // id "system:config-bootstrap", which is not a Member row. The admin
    // timeline must label it "System"; a genuinely dangling member id keeps
    // the "Unknown member" fallback.
    const baseLog = {
      id: "log-1",
      targetId: null,
      details: null,
      ipAddress: null,
      createdAt: new Date("2026-07-18T00:00:00.000Z"),
      actorMemberId: null,
      subjectMemberId: null,
      entityType: null,
      entityId: null,
      category: "system",
      severity: "critical",
      outcome: "success",
      summary: "Auto-imported configuration bundle on boot",
      metadata: null,
      requestId: null,
      userAgent: null,
      retentionClass: null,
    };
    const logs = [
      {
        ...baseLog,
        id: "log-1",
        action: "configuration.bootstrap_imported",
        memberId: "system:config-bootstrap",
      },
      {
        ...baseLog,
        id: "log-2",
        action: "member.updated",
        memberId: "member-deleted-long-ago",
      },
    ];
    const db = {
      auditLog: {
        findMany: async () => logs,
        count: async () => logs.length,
      },
      member: {
        findMany: async () => [],
      },
    };

    const page = await getAuditTimelinePage({
      db: db as never,
      where: {},
      page: 1,
      pageSize: 10,
      category: "all",
      audience: "admin",
    });

    expect(page.data[0].actorDisplayName).toBe("System");
    expect(page.data[0].actor).toBeNull();
    expect(page.data[1].actorDisplayName).toBe("Unknown member");
  });

  it("rejects invalid admin audit filter values", () => {
    expect(
      parseAdminAuditLogQuery(
        new URLSearchParams({ category: "unknown" }),
        CLUB_ZONE,
      ),
    ).toEqual({ success: false, details: undefined });

    const oversizedPage = parseAdminAuditLogQuery(
      new URLSearchParams({ pageSize: "101" }),
      CLUB_ZONE,
    );
    expect(oversizedPage.success).toBe(false);
    if (oversizedPage.success) return;
    expect(oversizedPage.details?.fieldErrors.pageSize).toBeDefined();
  });
});
