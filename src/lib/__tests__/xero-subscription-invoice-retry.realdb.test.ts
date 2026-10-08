/**
 * Real-PostgreSQL proof of the membership subscription invoice retry (#3971,
 * `INV-INT-026`).
 *
 * Every subscription invoice failed because the stored payload's `chargeId`
 * was blanked by the persisting redactor. The fix reads the charge from the
 * row's `localId`, and Xero Operations Retry sends the FAILED row back to the
 * outbox. That retry is a claim: a status-guarded `UPDATE` of the same row,
 * keeping its correlation key, so the partial unique index on ACTIVE
 * correlation keys refuses it while another attempt for the charge is live. A
 * double can only imitate both; this file runs them against the migrated
 * schema:
 *
 *   - a row stored before the fix comes back PENDING as its bare queue type,
 *     same row and key, and the outbox reads its charge from `localId`;
 *   - two retries of one row at once requeue it exactly once;
 *   - a live attempt for the same charge makes the retry a 409 (the real
 *     index, not a mocked P2002), and the FAILED row is left as it was;
 *   - a charge that already has its Xero invoice is refused before any write.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-3971-` fixtures.
 *
 * To run directly against a throwaway scratch database:
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/xero-subscription-invoice-retry.realdb.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const RACE_TEST_TIMEOUT_MS = 30_000;

const MEMBER_ID = "race-3971-member";
const CHARGE_ID = "race-3971-charge";
const FAILED_OPERATION_ID = "race-3971-op-failed";
const LIVE_OPERATION_ID = "race-3971-op-live";
const CORRELATION_KEY = `membership-charge:${CHARGE_ID}:invoice-and-email:v1`;
const QUEUE_TYPE = "MEMBERSHIP_SUBSCRIPTION_INVOICE";

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeSubscriptionRetryRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Subscription invoice retry proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run subscription invoice retry proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Subscription invoice retry proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Subscription invoice retry proof DB name must contain 'concurrency_race_1881'.");
  }
}

describe("subscription invoice retry race DB safety guard (#3971)", () => {
  it("accepts only a dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeSubscriptionRetryRaceDbUrl("postgresql://u:p@127.0.0.1:55442/concurrency_race_1881"),
    ).not.toThrow();
  });

  it.each([
    "postgresql://u:p@db.example.org:55442/concurrency_race_1881",
    "postgresql://u:p@127.0.0.1:5432/concurrency_race_1881",
    "postgresql://u:p@127.0.0.1:55442/app",
    "not-a-url",
  ])("rejects unsafe target %s", (url) => {
    expect(() => assertSafeSubscriptionRetryRaceDbUrl(url)).toThrow();
  });
});

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let retry: typeof import("@/lib/xero-operation-retry");
let payloads: typeof import("@/lib/xero-operation-outbox-payload");

(RUN ? describe : describe.skip)(
  "membership subscription invoice retry — real PostgreSQL (#3971)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    async function clearFixtures() {
      await prisma.xeroSyncOperation.deleteMany({
        where: { OR: [{ localId: CHARGE_ID }, { correlationKey: CORRELATION_KEY }] },
      });
      await prisma.membershipSubscriptionCharge.deleteMany({ where: { id: CHARGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    async function seedCharge(overrides: { xeroInvoiceId?: string; xeroInvoiceNumber?: string } = {}) {
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: "race-3971@example.invalid",
          passwordHash: "not-a-real-password",
          firstName: "Retry",
          lastName: "Member",
          ageTier: "ADULT",
        },
      });
      await prisma.membershipSubscriptionCharge.create({
        data: {
          id: CHARGE_ID,
          idempotencyKey: "race-3971-charge-key",
          seasonYear: 2026,
          source: "NEW_MEMBER_APPROVAL",
          status: "QUEUED",
          membershipTypeId: "race-3971-type",
          membershipTypeKey: "race-3971-type",
          membershipTypeName: "Race 3971",
          billingBasis: "PER_MEMBER",
          prorationRule: "NONE",
          annualAmountCents: 12000,
          chargedAmountCents: 12000,
          coveredMonths: 12,
          decisionDate: new Date("2026-06-01T00:00:00.000Z"),
          coverageStart: new Date("2026-04-01T00:00:00.000Z"),
          coverageEnd: new Date("2027-03-31T00:00:00.000Z"),
          recipientMemberId: MEMBER_ID,
          recipientName: "Retry Member",
          recipientEmail: "race-3971@example.invalid",
          dueDays: 20,
          xeroAccountCode: "203",
          invoiceReference: "MEMSUB-RACE-3971",
          lastErrorCode: "XERO_FAILED",
          lastErrorMessage: "Membership subscription charge not found: [REDACTED]",
          ...overrides,
        },
      });
    }

    /** The row as a pre-fix deployment stored it: FAILED, chargeId blanked. */
    async function seedFailedPreFixOperation() {
      await prisma.xeroSyncOperation.create({
        data: {
          id: FAILED_OPERATION_ID,
          direction: "OUTBOUND",
          entityType: "INVOICE",
          operationType: "CREATE",
          localModel: "MembershipSubscriptionCharge",
          localId: CHARGE_ID,
          status: "FAILED",
          idempotencyKey: CORRELATION_KEY,
          correlationKey: CORRELATION_KEY,
          queueType: QUEUE_TYPE,
          requestPayload: { queueType: QUEUE_TYPE, chargeId: "[REDACTED]" },
          lastErrorMessage: "Membership subscription charge not found: [REDACTED]",
          completedAt: new Date(),
        },
      });
    }

    beforeAll(async () => {
      assertSafeSubscriptionRetryRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      retry = await import("@/lib/xero-operation-retry");
      payloads = await import("@/lib/xero-operation-outbox-payload");
      await clearFixtures();
    });

    beforeEach(async () => {
      await clearFixtures();
    });

    afterAll(async () => {
      if (prisma) await clearFixtures();
    });

    it("requeues a pre-fix FAILED row as its bare queue type, same row and key, and the outbox reads the charge from localId", async () => {
      await seedCharge();
      await seedFailedPreFixOperation();

      await expect(retry.retryXeroSyncOperation(FAILED_OPERATION_ID, CLUB_FORMAT_TEST)).resolves.toEqual({
        message: "Queued the membership subscription invoice for retry.",
      });

      const row = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: FAILED_OPERATION_ID } });
      expect(row).toMatchObject({
        status: "PENDING",
        correlationKey: CORRELATION_KEY,
        queueType: QUEUE_TYPE,
        requestPayload: { queueType: QUEUE_TYPE },
        startedAt: null,
        completedAt: null,
        lastErrorMessage: null,
      });
      // What the outbox worker will read once it claims the row.
      expect(payloads.readQueuedOutboxPayload(row.requestPayload)).toEqual({ queueType: QUEUE_TYPE });
      expect(payloads.subscriptionInvoiceChargeId(row)).toBe(CHARGE_ID);
      expect(await prisma.xeroSyncOperation.count({ where: { correlationKey: CORRELATION_KEY } })).toBe(1);
    });

    it("requeues one FAILED row exactly once when two retries race", async () => {
      await seedCharge();
      await seedFailedPreFixOperation();

      const outcomes = await Promise.allSettled([
        retry.retryXeroSyncOperation(FAILED_OPERATION_ID, CLUB_FORMAT_TEST),
        retry.retryXeroSyncOperation(FAILED_OPERATION_ID, CLUB_FORMAT_TEST),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const refused = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      expect(refused).toHaveLength(1);
      expect(refused[0].reason).toMatchObject({ status: 409 });
      const row = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: FAILED_OPERATION_ID } });
      expect(row.status).toBe("PENDING");
    });

    it("answers 409 through the real active-correlation-key index while another attempt for the charge is live", async () => {
      await seedCharge();
      await seedFailedPreFixOperation();
      await prisma.xeroSyncOperation.create({
        data: {
          id: LIVE_OPERATION_ID,
          direction: "OUTBOUND",
          entityType: "INVOICE",
          operationType: "CREATE",
          localModel: "MembershipSubscriptionCharge",
          localId: CHARGE_ID,
          status: "PENDING",
          idempotencyKey: CORRELATION_KEY,
          correlationKey: CORRELATION_KEY,
          queueType: QUEUE_TYPE,
          requestPayload: { queueType: QUEUE_TYPE },
        },
      });

      await expect(
        retry.retryXeroSyncOperation(FAILED_OPERATION_ID, CLUB_FORMAT_TEST),
      ).rejects.toMatchObject({ status: 409 });

      const failed = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: FAILED_OPERATION_ID } });
      expect(failed.status).toBe("FAILED");
      expect(failed.requestPayload).toEqual({ queueType: QUEUE_TYPE, chargeId: "[REDACTED]" });
    });

    it("refuses a charge that already has its Xero invoice, before any write", async () => {
      await seedCharge({ xeroInvoiceId: "race-3971-invoice", xeroInvoiceNumber: "INV-3971" });
      await seedFailedPreFixOperation();

      await expect(
        retry.retryXeroSyncOperation(FAILED_OPERATION_ID, CLUB_FORMAT_TEST),
      ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("INV-3971") });

      const row = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: FAILED_OPERATION_ID } });
      expect(row.status).toBe("FAILED");
    });
  },
);
