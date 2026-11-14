import type { Prisma, PrismaClient, PrivacyRetentionSettings } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { realElapsedMs } from "./helpers/clock";
import { backendPid } from "./support/race-lock-waits";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const NOW = new Date("2026-07-01T00:00:00.000Z");
const PREFIX = "race-4457-";
const id = (suffix: string) => `${PREFIX}${suffix}`;
let db: PrismaClient;
let previousSettings: PrivacyRetentionSettings | null;
let preview: typeof import("@/lib/privacy-retention").getPrivacyRetentionPreview;
let prune: typeof import("@/lib/privacy-retention-jobs").runPersonalDataPruneJob;
let anonymise: typeof import("@/lib/privacy-retention-jobs").runFormerMemberAnonymisationJob;

// Real application queries, transactions, advisory locks, row fences and
// foreign keys. No provider calls and no fake database predicates.
(RUN ? describe : describe.skip)("privacy retention in PostgreSQL (#4457)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(URL, "Privacy retention");
    process.env.DATABASE_URL = URL;
    ({ prisma: db } = await import("@/lib/prisma"));
    ({ getPrivacyRetentionPreview: preview } = await import("@/lib/privacy-retention"));
    ({ runPersonalDataPruneJob: prune, runFormerMemberAnonymisationJob: anonymise } = await import("@/lib/privacy-retention-jobs"));
    previousSettings = await db.privacyRetentionSettings.findUnique({ where: { id: "default" } });
    const { DEFAULT_PRIVACY_RETENTION_SETTINGS } = await import("@/lib/privacy-retention-shared");
    await db.privacyRetentionSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ...DEFAULT_PRIVACY_RETENTION_SETTINGS },
      update: { ...DEFAULT_PRIVACY_RETENTION_SETTINGS, pruneStartedAt: null, anonymiseStartedAt: null },
    });
    for (const [suffix, createdAt] of [
      ["email-old", "2024-06-30"], ["email-boundary", "2024-07-01"], ["email-inside", "2024-07-02"],
    ]) {
      await db.emailLog.create({ data: {
        id: id(suffix!), to: "retention@example.invalid", subject: "Fixture", templateName: "fixture", createdAt: new Date(createdAt!),
      } });
    }
    for (const [suffix, reviewedAt, status] of [
      ["application-old", "2025-06-30", "REJECTED"],
      ["application-boundary", "2025-07-01", "REJECTED"],
      ["application-inside", "2025-07-02", "REJECTED"],
      ["application-approved", "2020-01-01", "APPROVED"],
    ] as const) {
      await db.memberApplication.create({ data: {
        id: id(suffix), applicantFirstName: "Fixture", applicantLastName: "Applicant",
        applicantEmail: `${suffix}@example.invalid`, nominator1Email: "one@example.invalid", nominator2Email: "two@example.invalid",
        status, reviewedAt: new Date(reviewedAt), createdAt: new Date("2020-01-01"),
      } });
    }
    for (const [suffix, leavingDate] of [
      ["member-old", "2019-06-30"], ["member-boundary", "2019-07-01"],
      ["member-inside", "2019-07-02"], ["member-undated", null], ["member-blocked", "2019-06-30"],
      ["member-unpaid-addition", "2019-06-30"],
    ] as const) {
      await db.member.create({ data: {
        id: id(suffix), firstName: "Former", lastName: "Fixture", email: `${suffix}@example.invalid`,
        passwordHash: "not-a-password", active: false, leavingDate: leavingDate ? new Date(leavingDate) : null,
        xeroContactId: id(`contact-${suffix}`), comments: "Private notes", phoneNumber: "1234567",
        streetAddressLine1: "Fixture address", dateOfBirth: new Date("1970-01-01"),
      } });
    }
    // A completed stay and settled payment must survive profile erasure.
    await db.booking.create({ data: {
      id: id("booking-settled"), memberId: id("member-old"), status: "COMPLETED",
      checkIn: new Date("2018-01-01"), checkOut: new Date("2018-01-02"), totalPriceCents: 1000, finalPriceCents: 1000,
      payment: { create: { id: id("payment"), amountCents: 1000, status: "SUCCEEDED", xeroInvoiceId: id("invoice") } },
    } });
    await db.booking.create({ data: {
      id: id("booking-open"), memberId: id("member-blocked"), status: "CONFIRMED",
      checkIn: new Date("2026-08-01"), checkOut: new Date("2026-08-02"), totalPriceCents: 0, finalPriceCents: 0,
    } });
    await db.booking.create({ data: {
      id: id("booking-addition"), memberId: id("member-unpaid-addition"), status: "COMPLETED",
      checkIn: new Date("2018-01-01"), checkOut: new Date("2018-01-02"), totalPriceCents: 1000, finalPriceCents: 2000,
      payment: { create: {
        id: id("payment-addition"), amountCents: 1000, status: "SUCCEEDED",
        additionalAmountCents: 1000, additionalPaymentStatus: null,
      } },
    } });
  }, 30_000);

  afterAll(async () => {
    if (!db) return;
    try {
      await db.auditLog.deleteMany({ where: { entityId: { startsWith: PREFIX } } });
      await db.payment.deleteMany({ where: { id: { in: [id("payment"), id("payment-addition")] } } });
      await db.refundRequest.deleteMany({ where: { id: { startsWith: PREFIX } } });
      await db.memberCredit.deleteMany({ where: { memberId: { startsWith: PREFIX } } });
      await db.familyGroup.deleteMany({ where: { id: { startsWith: PREFIX } } });
      await db.booking.deleteMany({ where: { id: { startsWith: PREFIX } } });
      await db.member.deleteMany({ where: { id: { startsWith: PREFIX } } });
      await db.memberApplication.deleteMany({ where: { id: { startsWith: PREFIX } } });
      await db.emailLog.deleteMany({ where: { id: { startsWith: PREFIX } } });
    } finally {
      if (previousSettings) {
        await db.privacyRetentionSettings.upsert({ where: { id: "default" }, create: previousSettings, update: previousSettings });
      } else {
        await db.privacyRetentionSettings.deleteMany({ where: { id: "default" } });
      }
    }
  });

  it("previews candidates with both switches off, including undated and blocked members", async () => {
    const result = await preview({ db, now: NOW });
    // Refuse to run the club-wide jobs over another suite's forgotten fixtures.
    expect(result.emailLogs.rows.map(row => row.id)).toEqual([id("email-old")]);
    expect(result.rejectedApplications.rows.map(row => row.id)).toEqual([id("application-old")]);
    expect(result.formerMembers.rows.map(row => row.id)).toEqual([id("member-old")]);
    expect(result.undatedMembers.rows).toEqual([{ id: id("member-undated"), date: null }]);
    expect(result.blockedMembers.rows).toEqual([
      { id: id("member-blocked"), date: new Date("2019-06-30"), reasons: ["open booking or booking money"] },
      { id: id("member-unpaid-addition"), date: new Date("2019-06-30"), reasons: ["open booking or booking money"] },
    ]);
    expect(await prune({ db, now: NOW })).toMatchObject({ skipped: "disabled", deletedEmailLogs: 0, deletedApplications: 0 });
    expect(await anonymise({ db, now: NOW })).toMatchObject({ skipped: "disabled", anonymised: 0 });
    expect(await db.member.findUnique({ where: { id: id("member-old") } })).toMatchObject({ firstName: "Former", deletedAt: null });
  });

  it("deletes exactly the previewed rows, keeping exact boundaries and one day inside", async () => {
    const before = await preview({ db, now: NOW });
    await db.privacyRetentionSettings.update({ where: { id: "default" }, data: { pruneLogsAndApplicationsEnabled: true } });
    expect(await prune({ db, now: NOW })).toMatchObject({ deletedEmailLogs: before.emailLogs.count, deletedApplications: before.rejectedApplications.count });
    expect(await db.emailLog.findMany({ where: { id: { startsWith: PREFIX } }, select: { id: true }, orderBy: { id: "asc" } }))
      .toEqual([{ id: id("email-boundary") }, { id: id("email-inside") }]);
    expect(await db.memberApplication.findMany({ where: { id: { startsWith: PREFIX } }, select: { id: true }, orderBy: { id: "asc" } }))
      .toEqual(["application-approved", "application-boundary", "application-inside"].map(suffix => ({ id: id(suffix) })));
    expect(await prune({ db, now: NOW })).toMatchObject({ deletedEmailLogs: 0, deletedApplications: 0 });
  });

  it("anonymises exactly the previewed departure, preserving financial identities and undated profiles", async () => {
    const before = await preview({ db, now: NOW });
    await db.privacyRetentionSettings.update({ where: { id: "default" }, data: { anonymiseMembersEnabled: true } });
    expect(await anonymise({ db, now: NOW })).toMatchObject({ anonymised: before.formerMembers.count, blocked: 2 });
    expect(await db.member.findUnique({ where: { id: id("member-old") } })).toMatchObject({
      id: id("member-old"), firstName: "Deleted", lastName: "Member", deletedAt: NOW,
      xeroContactId: id("contact-member-old"), comments: null, phoneNumber: null, streetAddressLine1: null, dateOfBirth: null,
    });
    expect(await db.payment.findUnique({ where: { id: id("payment") }, include: { booking: true } })).toMatchObject({
      id: id("payment"), amountCents: 1000, status: "SUCCEEDED", xeroInvoiceId: id("invoice"),
      booking: { id: id("booking-settled"), memberId: id("member-old"), finalPriceCents: 1000 },
    });
    for (const suffix of ["member-boundary", "member-inside", "member-undated", "member-blocked", "member-unpaid-addition"]) {
      expect(await db.member.findUnique({ where: { id: id(suffix) } })).toMatchObject({ firstName: "Former", deletedAt: null });
    }
    expect((await preview({ db, now: NOW })).undatedMembers.rows).toEqual(before.undatedMembers.rows);
    expect(await anonymise({ db, now: NOW })).toMatchObject({ anonymised: 0, blocked: 2 });
    expect(await db.auditLog.count({ where: { entityId: id("member-old"), action: "privacy.retention.member_anonymised" } })).toBe(1);
  });

  it.each(["credit", "family", "refund"] as const)(
    "preserves a former member when a %s blocker commits while anonymisation waits (#4920)",
    async (kind) => {
      const memberId = id(`race-${kind}`);
      await db.member.create({ data: {
        id: memberId, firstName: "Former", lastName: "Race", active: false,
        email: `${kind}@example.invalid`, passwordHash: "keep-this-hash", leavingDate: new Date("2018-01-01"),
      } });
      if (kind === "refund") await db.booking.create({ data: {
        id: id("race-refund-booking"), memberId, status: "COMPLETED",
        checkIn: new Date("2018-01-01"), checkOut: new Date("2018-01-02"), totalPriceCents: 0, finalPriceCents: 0,
      } });
      await db.privacyRetentionSettings.update({ where: { id: "default" }, data: { anonymiseMembersEnabled: true } });
      const before = await db.member.findUniqueOrThrow({ where: { id: memberId } });
      let release!: () => void;
      let ready!: (pid: number) => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const held = new Promise<number>(resolve => { ready = resolve; });
      const writer = db.$transaction(async (tx: Prisma.TransactionClient) => {
        if (kind === "credit") {
          const { lockMemberCreditLedger } = await import("@/lib/member-credit");
          await lockMemberCreditLedger(memberId, tx);
          await tx.memberCredit.create({ data: { memberId, amountCents: 4000, type: "ADMIN_ADJUSTMENT", description: "Race fixture" } });
        } else if (kind === "family") {
          const { acquireMemberLifecycleLocks } = await import("@/lib/member-lifecycle-lock");
          await acquireMemberLifecycleLocks(tx, [memberId]);
          await tx.familyGroup.create({ data: { id: id("race-family-group"), memberships: { create: { memberId } } } });
        } else {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
          await tx.refundRequest.create({ data: { id: id("race-refund"), memberId, bookingId: id("race-refund-booking"), reason: "Race fixture", status: "PENDING" } });
        }
        ready(await backendPid(tx));
        await gate;
      }, { timeout: 20_000 });
      // Observe setup failure immediately rather than waiting forever for ready.
      const writerPid = await Promise.race([held, writer.then(() => { throw new Error("writer exited before barrier"); })]);
      const job = anonymise({ db, now: NOW });
      // Attach a handler immediately: a broken job must not leak a rejection
      // while the observer is still checking the lock barrier.
      void job.catch(() => {});
      try {
        const started = process.hrtime.bigint();
        for (;;) {
          const waiters = await db.$queryRaw<Array<{ pid: number }>>`
            SELECT pid FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND ${writerPid} = ANY(pg_blocking_pids(pid))`;
          if (waiters.length) break;
          if (realElapsedMs(started) > 8_000) throw new Error(`Anonymisation never waited for the ${kind} writer`);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      } finally {
        release();
        await writer;
      }
      const result = await job;
      expect(result.anonymised).toBe(0);
      expect(result.blocked).toBeGreaterThan(0);
      const after = await db.member.findUniqueOrThrow({ where: { id: memberId } });
      expect(after).toMatchObject({ email: before.email, passwordHash: before.passwordHash, deletedAt: before.deletedAt });
      expect(await db.auditLog.count({ where: { entityId: memberId, action: "privacy.retention.member_anonymised" } })).toBe(0);
    }, 30_000,
  );

});
