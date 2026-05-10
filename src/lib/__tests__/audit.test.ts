import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildMemberAuditLogWhere,
  classifyAuditRetention,
  createAuditLog,
  createStructuredAuditLog,
  getAuditRetentionExpiresAt,
  sanitizeAuditMetadata,
} from "@/lib/audit";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
  },
}));

function auditDb() {
  return {
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
}

describe("audit helper", () => {
  const sensitivePaymentMetadataKey = [
    "paymentIntent",
    "Client",
    "Secret",
  ].join("");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps legacy createAuditLog calls compatible", async () => {
    const db = auditDb();

    await createAuditLog(
      {
        action: "legacy.action",
        memberId: "actor-member",
        targetId: "target-id",
        details: "Legacy details",
        ipAddress: "203.0.113.10",
      },
      db as never
    );

    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: "legacy.action",
        memberId: "actor-member",
        targetId: "target-id",
        details: "Legacy details",
        ipAddress: "203.0.113.10",
        actorMemberId: "actor-member",
      },
    });
  });

  it("maps structured audit events onto actor, subject, entity, and retention fields", async () => {
    const db = auditDb();

    await createStructuredAuditLog(
      {
        action: "booking.payment.succeeded",
        actor: { memberId: "actor-member" },
        subject: { memberId: "subject-member" },
        entity: { type: "Payment", id: "payment-1" },
        category: "payment",
        severity: "critical",
        summary: "Payment succeeded",
        metadata: {
          amountCents: 12345,
          [sensitivePaymentMetadataKey]: "redacted payment credential fixture",
        },
        request: {
          id: "req-1",
          ipAddress: "203.0.113.20",
          userAgent: "Unit Test",
        },
      },
      db as never
    );

    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "booking.payment.succeeded",
        memberId: "actor-member",
        targetId: "subject-member",
        actorMemberId: "actor-member",
        subjectMemberId: "subject-member",
        entityType: "Payment",
        entityId: "payment-1",
        category: "payment",
        severity: "critical",
        outcome: "success",
        summary: "Payment succeeded",
        requestId: "req-1",
        ipAddress: "203.0.113.20",
        userAgent: "Unit Test",
        retentionClass: "critical",
        expiresAt: new Date("2033-01-01T00:00:00.000Z"),
      }),
    });

    const data = db.auditLog.create.mock.calls[0][0].data;
    expect(data.metadata).toEqual({
      amountCents: 12345,
      [sensitivePaymentMetadataKey]: "[REDACTED]",
    });
  });

  it("sanitizes metadata secrets, raw bodies, card data, and long HTML", () => {
    const sanitized = sanitizeAuditMetadata({
      password: "secret",
      passwordHash: "hash",
      resetToken: "reset",
      verificationToken: "verify",
      nominationToken: "nominate",
      sessionToken: "session",
      authSecret: "auth-secret",
      rawBody: { password: "nested" },
      card: { number: "4242424242424242", cvc: "123" },
      safe: {
        changedFields: ["email"],
        note: "safe note",
      },
      emailContent: `<html><body>${"hello".repeat(150)}</body></html>`,
      longText: "x".repeat(1200),
    }) as Record<string, unknown>;

    expect(sanitized.password).toBe("[REDACTED]");
    expect(sanitized.passwordHash).toBe("[REDACTED]");
    expect(sanitized.resetToken).toBe("[REDACTED]");
    expect(sanitized.verificationToken).toBe("[REDACTED]");
    expect(sanitized.nominationToken).toBe("[REDACTED]");
    expect(sanitized.sessionToken).toBe("[REDACTED]");
    expect(sanitized.authSecret).toBe("[REDACTED]");
    expect(sanitized.rawBody).toBe("[REDACTED]");
    expect(sanitized.card).toBe("[REDACTED]");
    expect(sanitized.safe).toEqual({
      changedFields: ["email"],
      note: "safe note",
    });
    expect(sanitized.emailContent).toBe("[REDACTED_LONG_HTML]");
    expect(String(sanitized.longText)).toContain("[TRUNCATED]");
  });

  it("classifies retention and calculates expiry dates", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");

    expect(
      classifyAuditRetention({
        action: "admin.member.view",
        category: "admin",
      })
    ).toBe("sensitive_access");
    expect(
      classifyAuditRetention({
        action: "booking.confirmed",
        category: "booking",
      })
    ).toBe("critical");
    expect(
      classifyAuditRetention({
        action: "request.debug",
        category: "system",
        retentionClass: "diagnostic_high_volume",
      })
    ).toBe("diagnostic_high_volume");

    expect(getAuditRetentionExpiresAt("critical", from)).toEqual(
      new Date("2033-01-01T00:00:00.000Z")
    );
    expect(getAuditRetentionExpiresAt("sensitive_access", from)).toEqual(
      new Date("2028-01-01T00:00:00.000Z")
    );
    expect(getAuditRetentionExpiresAt("diagnostic_high_volume", from)).toEqual(
      new Date("2026-04-01T00:00:00.000Z")
    );
  });

  it("builds a member history where condition for structured and legacy rows", () => {
    expect(buildMemberAuditLogWhere("member-1")).toEqual({
      OR: [
        { subjectMemberId: "member-1" },
        { AND: [{ subjectMemberId: null }, { actorMemberId: "member-1" }] },
        { AND: [{ subjectMemberId: null }, { memberId: "member-1" }] },
        { AND: [{ subjectMemberId: null }, { targetId: "member-1" }] },
      ],
    });
  });
});
