import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  AuditCategoryError,
  buildMemberAuditLogWhere,
  buildStructuredAuditLogCreateArgs,
  classifyAuditRetention,
  createAuditLog,
  createStructuredAuditLog,
  getAuditRetentionExpiresAt,
  logAudit,
  sanitizeAuditMetadata,
} from "@/lib/audit";
import { AUDIT_CATEGORIES, type AuditCategory } from "@/lib/audit-categories";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { redactSensitiveJson } from "@/lib/redact-sensitive-json";

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

  it("gives a minimal createAuditLog call a category, a retention class and an expiry", async () => {
    /*
      This test used to assert the OPPOSITE, and the change is the point (#2581).

      It was called "keeps legacy createAuditLog calls compatible" and it pinned
      the shape a category-less writer emitted: six fields, no `category`, no
      `retentionClass` and no `expiresAt`. That shape is the defect the issue was
      filed about — a row no AI Diagnostics correlation tool can return, and one
      `pruneExpiredAuditLogs` can never reach, because every branch of its
      predicate carries `expiresAt: { lt: now }` and NULL is not less than
      anything. Kept forever, readable by nobody.

      It is no longer reachable: `category` is required, so the old call does not
      compile, and the retention derivation it used to skip is unconditional.
    */
    const db = auditDb();

    await createAuditLog(
      {
        action: "legacy.action",
        memberId: "actor-member",
        targetId: "target-id",
        details: "Legacy details",
        ipAddress: "203.0.113.10",
        category: "account",
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
        category: "account",
        retentionClass: "critical",
        expiresAt: new Date("2033-01-01T00:00:00.000Z"),
      },
    });
  });

  it("sanitizes legacy audit detail strings before persistence", async () => {
    const db = auditDb();

    await createAuditLog(
      {
        action: "legacy.secret",
        details:
          "Retry failed for cardNumber=4242 4242 4242 4242 and token=live-token",
        category: "payment",
      },
      db as never
    );

    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        details:
          "Retry failed for cardNumber=[REDACTED] and token=[REDACTED]",
      }),
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

  // #2269 second review. A handful of audit rows exist BECAUSE the metadata is
  // the record — Restore Default deletes a club's email wording with one click
  // and no undo, and the audit row is the only copy left. The 1000-character
  // clip turned a measured 1748-character body into 1014 characters ending
  // "[TRUNCATED]", which is not a copy of anything. Archive mode relaxes size
  // and nothing else.
  describe("archive mode", () => {
    it("keeps a long value whole instead of clipping it at 1000 characters", () => {
      const wording = "x".repeat(1748);
      const sanitized = sanitizeAuditMetadata(
        { deletedOverride: { bodyText: wording } },
        { archiveText: { maxStringLength: 10_000 } }
      ) as { deletedOverride: { bodyText: string } };

      expect(sanitized.deletedOverride.bodyText).toBe(wording);
    });

    it("changes nothing for a caller that does not ask for it", () => {
      const sanitized = sanitizeAuditMetadata({
        deletedOverride: { bodyText: "x".repeat(1748) },
      }) as { deletedOverride: { bodyText: string } };

      expect(sanitized.deletedOverride.bodyText).toContain("[TRUNCATED]");
      expect(sanitized.deletedOverride.bodyText.length).toBeLessThan(1_100);
    });

    it("still redacts secrets, card numbers and sensitive keys", () => {
      const sanitized = sanitizeAuditMetadata(
        {
          apiKey: `${"a".repeat(1200)} sk_live_ABCDEF1234567890`,
          card: { number: "4242424242424242" },
          note: `${"n".repeat(1200)} 4242 4242 4242 4242`,
          password: "secret",
        },
        { archiveText: { maxStringLength: 10_000 } }
      ) as Record<string, unknown>;

      expect(sanitized.apiKey).toBe("[REDACTED]");
      expect(sanitized.card).toBe("[REDACTED]");
      expect(sanitized.password).toBe("[REDACTED]");
      expect(String(sanitized.note)).toContain("[REDACTED_CARD]");
    });

    it("still clips a value that runs past the archive length it was given", () => {
      const sanitized = sanitizeAuditMetadata(
        { bodyText: "x".repeat(12_000) },
        { archiveText: { maxStringLength: 10_000 } }
      ) as { bodyText: string };

      expect(sanitized.bodyText).toContain("[TRUNCATED]");
    });

    it("gives the JSON envelope matching headroom so it cannot collapse to a stub", () => {
      // A value that is mostly newlines doubles under JSON escaping. Without
      // the extra headroom the whole object becomes {_truncated: true, …},
      // which loses more than the clipping it was meant to avoid.
      const wording = "a\n".repeat(5_000);
      const sanitized = sanitizeAuditMetadata(
        { bodyText: wording },
        { archiveText: { maxStringLength: 10_000 } }
      ) as { bodyText?: string; _truncated?: boolean };

      expect(sanitized._truncated).toBeUndefined();
      expect(sanitized.bodyText).toBe(wording);
    });
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

  // This shape IS the member-boundary predicate `INV-PRIV-012` states, so keep the
  // two in step (#2755 review). Three of the four legs fire only when
  // `subjectMemberId` is NULL, which is why "does the writer pass a subject
  // member?" is the wrong question to ask about a re-classification: the two
  // `member.bulk-*` writers pass no subject at all and still reach the member
  // through the `targetId` leg. Delete or narrow a leg here and the invariant's
  // predicate has to change with it.
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

  // INV-PRIV-011 (#2683). The two key lists deliberately differ, and this pins
  // the difference in both directions at once: the log/Sentry redactor strips
  // first name, last name AND street address, while the admin-action audit
  // writer keeps all three, because an evidence record that cannot say who stops
  // being evidence (owner decision, 10 Aug 2026). It fails if a later change
  // makes the two lists "consistent" in either direction — adding person fields
  // to audit.ts's sensitive keys, or dropping them from the log redactor's
  // denylist so they become visible everywhere.
  it("keeps name and street address in an audit row while the log redactor strips them", () => {
    const person = {
      firstName: "Jane",
      lastName: "Doe",
      streetAddressLine1: "12 Example Street",
    };

    expect(sanitizeAuditMetadata(person)).toEqual({
      firstName: "Jane",
      lastName: "Doe",
      streetAddressLine1: "12 Example Street",
    });

    expect(redactSensitiveJson(person)).toEqual({
      firstName: "[REDACTED]",
      lastName: "[REDACTED]",
      streetAddressLine1: "[REDACTED]",
    });
  });
});

/**
 * The MANDATORY-CATEGORY contract (#2581, child 2's third part).
 *
 * The type is the first line of defence and the census contract test is the
 * third. This describes the second: the runtime assertion at the write
 * boundary, which is the one that still holds when a caller reaches the helper
 * through a cast, from untyped JavaScript, or by forwarding a category read out
 * of a stored row.
 *
 * WHAT EACH TEST WOULD CATCH, since "it throws on a bad value" is not by itself
 * worth a test file:
 *
 *  - deleting `assertCanonicalAuditCategory` from ONE of the two builders — the
 *    four-boundary test fails, naming the boundary, because a writer that
 *    reaches the structured builder is covered by a different call than one that
 *    reaches the params builder;
 *  - narrowing the check to `typeof category === "string"` — the "invented
 *    value" cases fail, which are the exact two values (`membership`, `auth`)
 *    that reached production through the old `(string & {})` escape;
 *  - making `logAudit` await or rethrow — the fire-and-forget test fails;
 *  - swallowing the throw inside `createAuditLog` so the audit failure stops
 *    aborting its transaction — the rollback test fails;
 *  - restoring the `params.retentionClass || params.category || params.severity`
 *    gate — the "no boundary can emit the kept-forever shape" test fails.
 */
describe("mandatory audit category (#2581)", () => {
  const CANONICAL: readonly AuditCategory[] = AUDIT_CATEGORIES;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses an omitted category at BOTH layers, type and runtime", async () => {
    const db = auditDb();

    await expect(
      createAuditLog(
        // @ts-expect-error - `category` is required. This line is the type-layer
        // assertion, and it fails CI in BOTH directions: revert the mandate and
        // the error disappears, which makes this an UNUSED @ts-expect-error,
        // which `tsc` reports as an error of its own. There is no edit to
        // `audit.ts` that leaves this file compiling and the mandate gone.
        { action: "contract.omitted", details: "no category supplied" },
        db as never,
      ),
    ).rejects.toThrow(AuditCategoryError);

    // And the runtime layer independently, because a `ts-expect-error` proves
    // only what the compiler thinks. Types are erased; a JavaScript caller, a
    // cast or a forwarded stored value reaches this same helper with nothing
    // checked. Nothing was written.
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("accepts every canonical category, and derives a retention class for each", async () => {
    for (const category of CANONICAL) {
      const db = auditDb();

      await createAuditLog(
        { action: `contract.${category}`, category },
        db as never,
      );

      const data = db.auditLog.create.mock.calls[0][0].data;
      expect(data.category, `category ${category} was not persisted`).toBe(
        category,
      );
      expect(
        data.retentionClass,
        `category ${category} derived no retention class`,
      ).toBeTruthy();
      expect(data.expiresAt, `category ${category} derived no expiry`).toBeInstanceOf(
        Date,
      );
    }
  });

  it("rejects a value the closed taxonomy does not contain, at all four boundaries", async () => {
    // `membership` and `auth` are not hypothetical: both reached production
    // through the old `| (string & {})` escape and produced rows that no reader
    // could filter for. `undefined` and `null` are the omission cases.
    const rejected = ["membership", "auth", "Booking", "", undefined, null];

    for (const bad of rejected) {
      const db = auditDb();

      await expect(
        createAuditLog(
          { action: "contract.bad", category: bad as never },
          db as never,
        ),
        `createAuditLog accepted ${JSON.stringify(bad)}`,
      ).rejects.toThrow(AuditCategoryError);

      await expect(
        createStructuredAuditLog(
          { action: "contract.bad", category: bad as never },
          db as never,
        ),
        `createStructuredAuditLog accepted ${JSON.stringify(bad)}`,
      ).rejects.toThrow(AuditCategoryError);

      expect(() =>
        buildStructuredAuditLogCreateArgs({
          action: "contract.bad",
          category: bad as never,
        }),
      ).toThrow(AuditCategoryError);

      // Nothing reached the database on any of the three.
      expect(db.auditLog.create).not.toHaveBeenCalled();
    }
  });

  it("names the action in the error, so a log line identifies the writer", async () => {
    const db = auditDb();

    await expect(
      createAuditLog(
        { action: "subscription.reconciled", category: "membership" as never },
        db as never,
      ),
    ).rejects.toThrow(/subscription\.reconciled/);
  });

  it("keeps logAudit fire-and-forget: it neither throws nor writes, and it logs", async () => {
    // The fourth boundary. `logAudit` is used by many sites that must not be able
    // to break the business operation they are recording, so the assertion has
    // to surface as a log line rather than as a throw.
    expect(() =>
      logAudit({ action: "contract.fire", category: "nope" as never }),
    ).not.toThrow();

    await Promise.resolve();
    await Promise.resolve();

    expect(vi.mocked(prisma.auditLog.create)).not.toHaveBeenCalled();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(AuditCategoryError) }),
      "Failed to write audit log",
    );
  });

  it("rolls a transaction back rather than committing a change it cannot record", async () => {
    // The behaviour that must NOT change: an audit failure inside a transaction
    // already aborts it, so the row and the change it describes commit together.
    // A bad category is now one more way to fail, handled identically.
    const tx = { auditLog: { create: vi.fn().mockResolvedValue({}) } };
    const outcome: string[] = [];

    const runTransaction = async (fn: () => Promise<void>) => {
      try {
        await fn();
        outcome.push("committed");
      } catch (err) {
        outcome.push("rolled back");
        throw err;
      }
    };

    await expect(
      runTransaction(async () => {
        await createAuditLog(
          { action: "member.dependent.link", category: "famly" as never },
          tx as never,
        );
      }),
    ).rejects.toThrow(AuditCategoryError);

    expect(outcome).toEqual(["rolled back"]);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("leaves no boundary able to emit the kept-forever shape", async () => {
    // `retentionClass = NULL, expiresAt = NULL` is what all 82 uncategorised
    // writers produced, and it is unreachable now for any value the boundary
    // accepts — the derivation is no longer gated.
    for (const category of CANONICAL) {
      const db = auditDb();
      await createAuditLog({ action: "contract.keep", category }, db as never);
      const data = db.auditLog.create.mock.calls[0][0].data;
      expect(data.retentionClass).not.toBeUndefined();
      expect(data.expiresAt).not.toBeUndefined();
    }
  });

  it("still honours the deliberate keep-forever escape hatch", () => {
    // `expiresAt: null` is the owner's to use on a deletion-decision row. Making
    // the category mandatory must not have taken it away.
    const db = auditDb();

    void createAuditLog(
      {
        action: "member.deletion_approved",
        category: "privacy",
        expiresAt: null,
      },
      db as never,
    );

    const data = db.auditLog.create.mock.calls[0][0].data;
    expect(data.retentionClass).toBe("critical");
    expect(data.expiresAt).toBeUndefined();
  });
});
