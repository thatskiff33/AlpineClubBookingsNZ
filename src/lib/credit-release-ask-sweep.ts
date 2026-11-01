import "server-only";

import { CreditType } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { closeCreditReleaseAsksPaidInXero, type CreditReleaseCloseResult } from "@/lib/credit-release-ask-close";
import { recordCreditReleasePayments, type CreditReleasePaymentRunResult } from "@/lib/credit-release-xero-payment";
import logger from "@/lib/logger";
import { createAdditionalPaymentIntentRecoveryOnce } from "@/lib/payment-recovery";
import {
  buildCreditReleaseAskRecoveryIdempotencyKey,
  buildCreditReleaseAskStripeIdempotencyKey,
} from "@/lib/credit-release-ask-keys";
import { prisma } from "@/lib/prisma";

/**
 * THE CREDIT-RELEASE SWEEP (#4253, `INV-ADDPAY-045`): one pass of the payments
 * cron's sixth task, three steps in the order a request lives.
 *
 * 1. ENQUEUE. Every release row `convergeCreditNoteSpentOutsideApp` wrote
 *    (`outsideSpendConvergedAt`, a positive `BOOKING_APPLIED` row) that has no
 *    recovery row yet gets one, under the key that names the release
 *    (`buildCreditReleaseAskRecoveryIdempotencyKey`). The row is the durable
 *    "this release has been looked at": whatever the runner decides - ask, or close
 *    with nothing owed - the release is never looked at twice. The row freezes the
 *    release's figure only; the runner re-derives what is owed from the ledger.
 *    A release younger than the settle window is left, so the converge's caller has
 *    finished re-planning the allocation before the booking is asked for money.
 * 2. RECORD. A captured request's card payment is recorded in Xero against the
 *    booking's own invoice (`recordCreditReleasePayments`).
 * 3. CLOSE. A request Xero shows paid is closed (`closeCreditReleaseAsksPaidInXero`).
 *
 * A fourth, separately switched step is the BACKLOG (release 2, D4): releases written before the
 * writer switch was turned on, asked for in small audited batches (`runCreditReleaseBacklog`).
 *
 * The steps are independent and each is error-isolated: one failing never stops
 * the next, and the sweep throws after all have run so the cron's own row shows it.
 */
export const CREDIT_RELEASE_SETTLE_WINDOW_MS = 2 * 60 * 1000;

/**
 * THE WRITER'S SWITCH, OFF UNTIL SOMEONE TURNS IT ON (blue/green, two releases;
 * `docs/BLUE_GREEN_MIGRATION_POLICY.md`). Enqueueing is the only step that makes new
 * rows an older colour could pick up. A colour that does not know the key family
 * would replay such a row as an ordinary edit's, so the first release ships the
 * runner, the recorder and the closer with the producer idle; once the previous
 * colour has drained, an operator turns it on. A row in `XeroSyncCursor` (string-keyed,
 * so no migration), read live, so it takes effect on the next pass with no deploy and
 * no restart, and setting `enabled` to anything but `true` turns it off again. Only
 * the enqueue is switched: a request already raised is always carried to its end.
 *
 * THE ROW'S CREATION TIME IS THE FLOOR. Only releases written after the row was created are
 * looked at by the writer: the backlog of earlier ones is the owner-decided run (#4253, D4) behind
 * its own switch (below), and turning the writer on must not start it. Turning the switch off and on
 * again keeps the floor; delete the row to move it.
 */
const SWITCH_KEY = { resourceType: "CREDIT_RELEASE_ASK", scope: "WRITER" } as const;

export async function creditReleaseAskWriterSince(
  db: Pick<typeof prisma, "xeroSyncCursor"> = prisma,
): Promise<Date | null> {
  const row = await db.xeroSyncCursor.findUnique({
    where: { resourceType_scope: SWITCH_KEY },
    select: { metadata: true, createdAt: true },
  });
  const metadata = row?.metadata;
  const enabled =
    metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).enabled === true;
  return enabled && row ? row.createdAt : null;
}

/**
 * THE BACKLOG'S SWITCH (#4253 release 2, D4, `INV-ADDPAY-050`), a second `XeroSyncCursor` row, also off until set.
 * `enabled: true` lets each pass raise requests for releases written BEFORE the writer's floor,
 * oldest first, at most `perRun` of them (default 5, never over 25), and only while the writer
 * is itself on (the backlog rows are the same key family, so the same blue/green rule holds).
 *
 * It is the owner's "after a live re-check that the amount is still owed", operated by a person:
 * each request goes through the runner, which re-reads the ledger and what Xero shows due on the
 * booking's invoice and CLOSES WITH AN AUDIT when nothing is still owed, so a release already
 * settled in Xero by hand is never asked for again. Every batch writes one audit row naming the
 * releases it took, and every release leaves its own `raised` or `not_raised` row. Setting
 * `enabled` to anything but `true` stops it between batches; requests already raised go on to
 * their end. A release is looked at once (the recovery row is the record), so letting it run
 * to the end is idempotent.
 */
const BACKLOG_SWITCH_KEY = { resourceType: "CREDIT_RELEASE_ASK", scope: "BACKLOG" } as const;
export const CREDIT_RELEASE_BACKLOG_DEFAULT_PER_RUN = 5;
export const CREDIT_RELEASE_BACKLOG_MAX_PER_RUN = 25;

export async function creditReleaseBacklogPerRun(
  db: Pick<typeof prisma, "xeroSyncCursor"> = prisma,
): Promise<number | null> {
  const row = await db.xeroSyncCursor.findUnique({
    where: { resourceType_scope: BACKLOG_SWITCH_KEY },
    select: { metadata: true },
  });
  const metadata = row?.metadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const settings = metadata as Record<string, unknown>;
  if (settings.enabled !== true) return null;
  const perRun = settings.perRun;
  if (typeof perRun !== "number" || !Number.isInteger(perRun) || perRun < 1) {
    return CREDIT_RELEASE_BACKLOG_DEFAULT_PER_RUN;
  }
  return Math.min(perRun, CREDIT_RELEASE_BACKLOG_MAX_PER_RUN);
}

export type CreditReleaseSweepResult = {
  enqueued: number;
  backlogEnqueued: number;
  payments: CreditReleasePaymentRunResult | null;
  closes: CreditReleaseCloseResult | null;
};

export async function enqueueCreditReleaseAsks(
  options: {
    limit?: number;
    now?: Date;
    /** Only releases written at or after this. */
    since?: Date;
    /** Only releases written before this (the backlog's ceiling: the writer's floor). */
    before?: Date;
    /** Called with each release THIS call raised a request for, in order. */
    onEnqueued?: (releaseId: string) => void;
  },
): Promise<number> {
  const now = options.now ?? new Date();
  const releases = await prisma.memberCredit.findMany({
    where: {
      type: CreditType.BOOKING_APPLIED,
      outsideSpendConvergedAt: { not: null },
      amountCents: { gt: 0 },
      appliedToBookingId: { not: null },
      createdAt: {
        ...(options.since ? { gte: options.since } : {}),
        lt: new Date(
          Math.min(
            now.getTime() - CREDIT_RELEASE_SETTLE_WINDOW_MS,
            options.before ? options.before.getTime() : Number.POSITIVE_INFINITY,
          ),
        ),
      },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, amountCents: true, appliedToBookingId: true },
  });
  if (releases.length === 0) return 0;
  const existing = await prisma.paymentRecoveryOperation.findMany({
    where: { idempotencyKey: { in: releases.map((release) => buildCreditReleaseAskRecoveryIdempotencyKey(release.id)) } },
    select: { idempotencyKey: true },
  });
  const seen = new Set(existing.map((row) => row.idempotencyKey));
  let enqueued = 0;
  for (const release of releases) {
    if (enqueued >= (options.limit ?? 25)) break;
    const idempotencyKey = buildCreditReleaseAskRecoveryIdempotencyKey(release.id);
    if (seen.has(idempotencyKey)) continue;
    const payment = await prisma.payment.findFirst({
      where: { bookingId: release.appliedToBookingId as string },
      select: { id: true },
    });
    if (!payment) {
      logger.warn({ releaseId: release.id }, "A credit release names a booking with no payment; no request raised");
      continue;
    }
    const created = await createAdditionalPaymentIntentRecoveryOnce({
      bookingId: release.appliedToBookingId as string,
      paymentId: payment.id,
      idempotencyKey,
      amountCents: release.amountCents,
      stripeIdempotencyKey: buildCreditReleaseAskStripeIdempotencyKey(release.id),
      // No supplementary invoice, ever: the money rides on the booking's own invoice.
      hadIssuedXeroInvoice: false,
    });
    // Another pass (the cron leader and a manual run overlapping) raised it first: not this
    // run's, so neither counted nor named in this run's batch row.
    if (!created) continue;
    enqueued += 1;
    options.onEnqueued?.(release.id);
  }
  return enqueued;
}

/**
 * One batch of the backlog: needs BOTH switches. Returns how many releases it raised a request
 * for, and writes the batch's audit row when that is more than none.
 */
export async function runCreditReleaseBacklog(): Promise<number> {
  const writerSince = await creditReleaseAskWriterSince();
  if (!writerSince) return 0;
  const perRun = await creditReleaseBacklogPerRun();
  if (!perRun) return 0;
  const releaseIds: string[] = [];
  let enqueued = 0;
  try {
    enqueued = await enqueueCreditReleaseAsks({
      limit: perRun,
      before: writerSince,
      onEnqueued: (id) => releaseIds.push(id),
    });
  } finally {
    // Names whatever was taken, even when the enqueue failed part-way: a release already queued is
    // never taken again, so its only batch row is this one.
    if (releaseIds.length > 0) {
      await createAuditLog({
        action: "payment.credit_release_ask.backlog_batch_taken",
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: "A batch of earlier credit releases was taken up for a re-check and, where still owed, a card payment request",
        metadata: { releaseIds, perRun, before: writerSince.toISOString() },
      });
    }
  }
  return enqueued;
}

export async function runCreditReleaseAskSweep(): Promise<CreditReleaseSweepResult> {
  const result: CreditReleaseSweepResult = { enqueued: 0, backlogEnqueued: 0, payments: null, closes: null };
  const failures: unknown[] = [];
  const step = async <T>(name: string, work: () => Promise<T>): Promise<T | null> => {
    try {
      return await work();
    } catch (err) {
      logger.error({ err, step: name }, "A credit-release sweep step failed; the next step still runs");
      failures.push(err);
      return null;
    }
  };
  result.enqueued =
    (await step("enqueue", async () => {
      const since = await creditReleaseAskWriterSince();
      return since ? enqueueCreditReleaseAsks({ since }) : 0;
    })) ?? 0;
  result.backlogEnqueued = (await step("backlog", () => runCreditReleaseBacklog())) ?? 0;
  result.payments = await step("record", () => recordCreditReleasePayments());
  result.closes = await step("close", () => closeCreditReleaseAsksPaidInXero());
  if (failures.length > 0) {
    throw new Error(`${failures.length} credit-release sweep step(s) failed; see the application logs`);
  }
  return result;
}
