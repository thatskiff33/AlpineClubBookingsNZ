/**
 * The group-settlement invoice email fence (#4919), split from
 * `xero-group-settlement-invoices.ts`, which raises and binds the combined
 * invoice and then hands it here to be emailed under `lock(1)`.
 *
 * The bound on the one provider call held inside that lock lives in
 * `xero-invoice-email.ts` (`XERO_IN_LOCK_EMAIL_BUDGET`,
 * `XERO_EMAIL_FENCE_TRANSACTION_OPTIONS`, `XERO_EMAIL_FENCE_LATEST_SEND_MS`).
 */

import { GroupBookingStatus } from "@prisma/client";
import { prisma } from "./prisma";
import { isTransactionContention } from "@/lib/prisma-errors";
import { bookingOwner } from "@/lib/booking-owner";
import logger from "@/lib/logger";
import {
  recordWithheldBookingEmail,
  XERO_GROUP_SETTLEMENT_INVOICE_EMAIL_TEMPLATE,
} from "@/lib/booking-email-suppression";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  sanitizeForJson,
} from "@/lib/xero-sync";
import type { getAuthenticatedXeroClient } from "./xero-api-client";
import {
  isDeferrableInLockEmailError,
  reassertXeroInvoiceEmailPolicy,
  resolveXeroInvoiceEmailPolicy,
  sendXeroInvoiceEmail,
  XERO_EMAIL_FENCE_LATEST_SEND_MS,
  XERO_EMAIL_FENCE_TRANSACTION_OPTIONS,
  XERO_IN_LOCK_EMAIL_BUDGET,
  type XeroInvoiceEmailPolicy,
} from "@/lib/xero-invoice-email";
import { enqueueXeroGroupSettlementInvoiceVoidOperation } from "@/lib/xero-group-settlement-void-outbox";
import { isGroupSettlementBoundToInvoice } from "@/lib/group-settlement-invoice-binding";
import { voidCancelledGroupSettlementInvoice } from "./xero-group-settlement-invoice-voids";
import { GroupSettlementInvoiceEmailDeferredError } from "@/lib/xero-applied-credit-operation-serialization";
import {
  deferredGroupInvoiceEmailPayload,
  GROUP_SETTLEMENT_INVOICE_EMAIL_DEFERRED_CAUSE,
} from "@/lib/xero-group-settlement-invoice-outbox";
import { ownRunningClaim, type XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";

type XeroClient = Awaited<ReturnType<typeof getAuthenticatedXeroClient>>["xero"];

/**
 * Xero API usage rows the send records, collected on the global client and
 * written only after the fence has released its connection and `lock(1)`. Each
 * phase hands the same list on; none of them runs these inside the fence.
 */
type HeldUsageWrites = Array<() => Promise<void>>;

/**
 * What the email fence learned, written as it happens (#4919) and read by every
 * phase after it. It is one object passed by reference, not values returned,
 * because the fence writes some of it before its transaction commits: a commit
 * that fails afterwards must still find what the fence knew.
 */
interface GroupInvoiceEmailOutcome {
  responseBody: unknown;
  error: unknown;
  accepted: boolean;
  // #4919: why the email is owed, set inside the fence, so a commit that fails
  // afterwards still records the debt (nothing was written that must persist).
  deferredError: unknown;
  // #2258: set when the organiser's "No emails" switch withheld the invoice
  // email. Recorded on the sync operation so the skip is never silent.
  withheldByNoEmails: boolean;
  // Recorded from what the GATE did, never from the policy alone (#3035
  // review) — see `resolveXeroInvoiceEmailPolicy` on why two withhold reasons
  // must never both claim one event.
  withheldForEnvironment: boolean;
}

/**
 * The email fence, for a bound invoice's first email and for a re-drive of one
 * that was owed (#4919). `redrivable` is true for an outbox claim: an owed
 * email then marks the row and returns it to PENDING. Without one, the row
 * completes PARTIAL with the deferred cause for an operator to retry.
 *
 * Its phases, in order: resolve the environment policy outside any lock; run
 * the fence ({@link runGroupInvoiceEmailFence}, the one transaction, under
 * `lock(1)`); act on what the fence decided once its commit has released the
 * lock ({@link actOnGroupInvoiceEmailGate}); then write usage rows, re-check the
 * claim for an owed email and record the outcome
 * ({@link recordGroupInvoiceEmailOutcome}).
 */
export async function finishGroupSettlementInvoiceEmail(params: {
  settlementId: string;
  createdInvoice: { invoiceID: string; invoiceNumber?: string | null };
  response: { body: unknown };
  xero: XeroClient;
  tenantId: string;
  operationClaim: XeroOperationClaim;
  redrivable: boolean;
}): Promise<string | null> {
  const { settlementId, createdInvoice, response, operationClaim } = params;
  // Email the invoice so the organiser can pay it by bank transfer. This is the
  // one deliberately provider-spanning lifecycle fence in this workflow, and
  // its bound is enforced, not assumed (#4919, `INV-INT-003`): ONE emailInvoice
  // attempt, zero in-lock retries (so no rate-limit sleep inside the lock), a
  // 3 s client deadline, and an explicit 10 s transaction timeout that counts
  // the wait for lock(1). The send starts only while the deadline plus a 2 s
  // commit margin still fits inside that timeout, so lock(1) is held for the
  // in-lock reads plus at most 3 s and is released by this transaction's own
  // commit, never by Prisma expiring it. Without the fence, cancellation could
  // commit after the last DB check but before Xero accepted the email,
  // producing a payable email after a durable CANCELLED state. If cancellation
  // won first, the replayable VOID is queued in the same tx and the email is
  // suppressed. If the email won first, cancellation waits and then commits its
  // own durable VOID debt; no HTTP attempt can start after a cancellation
  // commits. A deadline, a 429, a 408/5xx, a provider cooldown, a late start or
  // a lock wait that outlasts the timeout leaves the email OWED:
  // the outbox asks again later through this same fence, with the same
  // idempotency key, so a request Xero did receive is not sent twice.
  const outcome: GroupInvoiceEmailOutcome = {
    responseBody: null,
    error: null,
    accepted: false,
    deferredError: null,
    withheldByNoEmails: false,
    withheldForEnvironment: false,
  };
  // Usage rows are written on the global client; held until the fence ends.
  const usageTasks: HeldUsageWrites = [];
  const invoiceEmailIdempotencyKey = buildXeroIdempotencyKey(
    "group-settlement",
    settlementId,
    "invoice-email",
    createdInvoice.invoiceID,
    "v1"
  );
  // Environment-safety boundary (#3035; INV-CONFIG-004), resolved OUT HERE so a
  // copy does nothing further and no lock is taken on its behalf. #3071: it is
  // RE-PROVED inside the lock before the send — `reassertXeroInvoiceEmailPolicy`.
  const invoiceEmailPolicy = await resolveXeroInvoiceEmailPolicy();
  try {
    const emailGate = await runGroupInvoiceEmailFence({
      settlementId,
      createdInvoice,
      xero: params.xero,
      tenantId: params.tenantId,
      invoiceEmailPolicy,
      invoiceEmailIdempotencyKey,
      usageTasks,
      outcome,
    });
    const closed = await actOnGroupInvoiceEmailGate({
      settlementId,
      createdInvoice,
      response,
      operationClaim,
      emailGate,
      outcome,
    });
    if (closed) return null;
    outcome.responseBody = emailGate.responseBody;
  } catch (error) {
    // #4919: a commit that fails after Xero accepted the email cannot turn it
    // into a failed send, and one after a deferral leaves the email owed.
    // Contention (P2028/P2034) before Xero accepted it is a late start too: the
    // wait for lock(1) or a pooled connection outlasted the fence's timeout, so
    // the email is owed, not failed. The re-drive reuses the idempotency key.
    if (
      !outcome.accepted &&
      !outcome.deferredError &&
      !outcome.error &&
      isTransactionContention(error)
    ) {
      outcome.deferredError = error;
    } else if (!outcome.accepted && !outcome.deferredError) {
      outcome.error = error;
    }
    logger.warn(
      { err: error, settlementId, invoiceId: createdInvoice.invoiceID },
      outcome.accepted
        ? "Xero accepted the group settlement invoice email, but the fence's commit failed afterwards"
        : "Created Xero group settlement invoice but failed to email it to the organiser"
    );
  }

  return recordGroupInvoiceEmailOutcome({
    settlementId,
    createdInvoice,
    response,
    operationClaim,
    redrivable: params.redrivable,
    usageTasks,
    outcome,
  });
}

/**
 * The fence itself (#4919): the one transaction, taking `lock(1)` first, that
 * re-reads the settlement, queues the VOID for a group cancelled meanwhile,
 * re-proves the environment policy on the transaction client and makes the one
 * bounded `emailInvoice` call. Nothing else runs in it: the audit row, the
 * logs, the provider VOID and the completion all wait for its commit. It
 * answers what it decided, and writes what it learned into `outcome` as it
 * learns it, so a commit that fails afterwards still finds it.
 */
async function runGroupInvoiceEmailFence(params: {
  settlementId: string;
  createdInvoice: { invoiceID: string; invoiceNumber?: string | null };
  xero: XeroClient;
  tenantId: string;
  invoiceEmailPolicy: XeroInvoiceEmailPolicy;
  invoiceEmailIdempotencyKey: string;
  usageTasks: HeldUsageWrites;
  outcome: GroupInvoiceEmailOutcome;
}) {
  const {
    settlementId,
    createdInvoice,
    xero,
    tenantId,
    invoiceEmailPolicy,
    invoiceEmailIdempotencyKey,
    usageTasks,
    outcome,
  } = params;
  return prisma.$transaction(async (tx) => {
    const fenceStartedAt = performance.now();
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const fresh = await tx.groupBookingSettlement.findUnique({
      where: { id: settlementId },
      select: {
        source: true,
        status: true,
        xeroInvoiceId: true,
        groupBooking: {
          select: {
            status: true,
            organiserBookingId: true,
            // #2258: the "No emails" switch on the ORGANISER'S booking.
            organiserBooking: {
              select: {
                noEmails: true,
                member: { select: { email: true } },
                // #3369: the owner may be an Organisation; bookingOwner() reads both.
                organisation: { select: { name: true, email: true } },
              },
            },
          },
        },
      },
    });
    if (!fresh) {
      throw new Error(`Group settlement not found: ${settlementId}`);
    }
    if (fresh.groupBooking.status === GroupBookingStatus.CANCELLED) {
      await enqueueXeroGroupSettlementInvoiceVoidOperation(settlementId, {
        store: tx,
      });
      return {
        cancelled: true,
        abandoned: false,
        responseBody: null,
        withheld: false,
        environmentPolicy: null,
        organiserBookingId: null as string | null,
        organiserEmail: null as string | null,
      };
    }
    // #3642: released meanwhile. The reaper already retired this invoice
    // (pointer cleared, VOID queued in the same commit): just don't email.
    if (
      !isGroupSettlementBoundToInvoice(fresh) ||
      fresh.xeroInvoiceId !== createdInvoice.invoiceID
    ) {
      return {
        cancelled: false,
        abandoned: true,
        responseBody: null,
        withheld: false,
        environmentPolicy: null,
        organiserBookingId: null as string | null,
        organiserEmail: null as string | null,
      };
    }
    // #2258 (owner decision D10). SEMANTICS, because a settlement invoice is
    // not attributable to one booking: this ONE combined invoice covers the
    // organiser plus every joiner, and it is addressed to and paid by the
    // ORGANISER. It is therefore gated on the organiser's own booking —
    // `groupBooking.organiserBookingId` — and on nothing else. A joiner who
    // has "No emails" set on their child booking does NOT suppress the
    // organiser's invoice (it is not their message, and suppressing it would
    // stop the organiser being billed); conversely, when the organiser's
    // booking has it set, the invoice is not emailed to anyone. The joiner's
    // own group emails (join settled / released / cancelled) are separately
    // gated on each joiner's child booking.
    //
    // The read happens inside this advisory-locked transaction, immediately
    // before the provider call, so a switch flipped concurrently cannot
    // interleave. If the read throws, the surrounding try/catch records an
    // outcome.error and NO email is sent — fail closed by construction.
    // Only the EMAILING is withheld: the invoice is already raised in Xero.
    if (fresh.groupBooking.organiserBooking.noEmails) {
      return {
        cancelled: false,
        abandoned: false,
        responseBody: null,
        withheld: true,
        environmentPolicy: null,
        organiserBookingId: fresh.groupBooking
          .organiserBookingId as string | null,
        organiserEmail: bookingOwner(fresh.groupBooking.organiserBooking).member
          .email as string | null,
      };
    }
    // #3035: the club's own switch above is checked FIRST, so it stays
    // recorded as the club's decision on a copy. No withheld-email audit row
    // for this branch — that row asserts an administrator set the switch.
    const freshPolicy =
      await reassertXeroInvoiceEmailPolicy(invoiceEmailPolicy, tx);
    if (freshPolicy.kind !== "allow") {
      // Record from THIS answer, not the outer one (the helper says why).
      return {
        cancelled: false,
        abandoned: false,
        responseBody: null,
        withheld: false,
        environmentPolicy: freshPolicy,
        organiserBookingId: null as string | null,
        organiserEmail: null as string | null,
      };
    }
    const notSent = {
      cancelled: false,
      abandoned: false,
      responseBody: null,
      withheld: false,
      environmentPolicy: null,
      organiserBookingId: null as string | null,
      organiserEmail: null as string | null,
    };
    // #4919: too much of the timeout went on waiting for the lock, so the
    // deadline and the commit might not fit. Owed, not attempted.
    if (performance.now() - fenceStartedAt > XERO_EMAIL_FENCE_LATEST_SEND_MS) {
      outcome.deferredError = new Error(
        "The wait for the booking lock left too little time to ask Xero to email the invoice; it was not asked"
      );
      return notSent;
    }
    let emailResponse;
    try {
      emailResponse = await sendXeroInvoiceEmail({
        ...XERO_IN_LOCK_EMAIL_BUDGET,
        usageTasks,
        clearance: freshPolicy.clearance,
        xero,
        tenantId,
        invoiceId: createdInvoice.invoiceID,
        idempotencyKey: invoiceEmailIdempotencyKey,
        workflow: "createXeroInvoiceForGroupSettlement",
        context: `emailInvoice(group settlement ${settlementId})`,
      });
    } catch (error) {
      // Returned, not thrown: the fence wrote nothing, and its own commit
      // releases lock(1) at once. No sleep and no retry happen in here.
      if (isDeferrableInLockEmailError(error)) outcome.deferredError = error;
      else outcome.error = error;
      return notSent;
    }
    outcome.accepted = true;
    outcome.responseBody = emailResponse.body;
    return { ...notSent, responseBody: emailResponse.body };
  },
    // INV-LOCK-006 exception: a provider call runs inside this lock(1) fence, so
    // its timeout is sized to the Xero email deadline (`xero-invoice-email.ts`)
    // and a hold past it defers the email (#4919); maxWait matches the budget.
    XERO_EMAIL_FENCE_TRANSACTION_OPTIONS,
  );
}

/**
 * What happens once the fence has committed and released `lock(1)` (#4919):
 * the "No emails" audit row and log, the environment policy's log, and, for an
 * invoice the fence found abandoned or its group cancelled, closing the
 * operation. Answers true when it closed the operation, so nothing is recorded
 * after it. It runs inside the caller's try, so a throw here is recorded as the
 * email's failure exactly as before the split.
 */
async function actOnGroupInvoiceEmailGate(params: {
  settlementId: string;
  createdInvoice: { invoiceID: string; invoiceNumber?: string | null };
  response: { body: unknown };
  operationClaim: XeroOperationClaim;
  emailGate: Awaited<ReturnType<typeof runGroupInvoiceEmailFence>>;
  outcome: GroupInvoiceEmailOutcome;
}): Promise<boolean> {
  const { settlementId, createdInvoice, response, operationClaim, emailGate, outcome } = params;
  outcome.withheldByNoEmails = emailGate.withheld;
  // Mutually exclusive by construction, and narrowed to the confirmed-copy
  // case exactly as the booking path is: an UNKNOWN role is an ERROR below.
  outcome.withheldForEnvironment =
    emailGate.environmentPolicy?.kind === "withhold" &&
    emailGate.environmentPolicy.suppressedForNonProduction;
  if (
    emailGate.withheld &&
    emailGate.organiserBookingId &&
    emailGate.organiserEmail
  ) {
    // Audit row outside the advisory-locked transaction so the lock is held
    // for the provider fence only (the same reason the emailInvoice call is
    // the sole non-DB work inside it).
    await recordWithheldBookingEmail({
      bookingId: emailGate.organiserBookingId,
      templateName: XERO_GROUP_SETTLEMENT_INVOICE_EMAIL_TEMPLATE,
      subject: `Xero group settlement invoice ${
        createdInvoice.invoiceNumber ?? createdInvoice.invoiceID ?? "(unnumbered)"
      } for your group booking`,
      to: emailGate.organiserEmail,
      detail:
        "Withheld: the organiser's booking has the \"No emails\" switch turned on. The combined group settlement invoice exists in Xero but was not emailed.",
    });
    logger.warn(
      {
        settlementId,
        invoiceId: createdInvoice.invoiceID,
        organiserBookingId: emailGate.organiserBookingId,
      },
      'Skipped the Xero group settlement invoice email for an organiser booking with "No emails" turned on'
    );
  }
  if (emailGate.environmentPolicy?.kind === "withhold") {
    const withheld = emailGate.environmentPolicy;
    const context = { settlementId, invoiceId: createdInvoice.invoiceID };
    if (withheld.error) {
      outcome.error = withheld.error;
      logger.error(context, withheld.logMessage);
    } else {
      logger.info(context, withheld.logMessage);
    }
  }
  if (emailGate.abandoned) {
    // #3642: never emailed. Whoever retired it (the reaper, or a
    // replacement) queued its VOID and deactivated the link written above.
    await completeXeroSyncOperation(operationClaim, {
      status: "SUCCEEDED",
      responsePayload: {
        invoice: response.body,
        abandonedBeforeInvoiceEmail: true,
        invoiceEmailSuppressed: true,
      },
      xeroObjectType: "INVOICE",
      xeroObjectId: createdInvoice.invoiceID,
      xeroObjectNumber: createdInvoice.invoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(createdInvoice.invoiceID),
    });
    return true;
  }
  if (emailGate.cancelled) {
    await voidCancelledGroupSettlementInvoice({
      settlementId: settlementId,
      invoiceId: createdInvoice.invoiceID,
      invoiceNumber: createdInvoice.invoiceNumber ?? null,
      syncOperation: operationClaim,
      createResponse: response.body,
    });
    return true;
  }
  return false;
}

/**
 * The fence's outcome, recorded once its connection and lock are released
 * (#4919): the usage rows, then, for an owed email on an outbox claim, the
 * marker written only while this run still owns the claim and the row handed
 * back to PENDING; otherwise the operation's completion.
 */
async function recordGroupInvoiceEmailOutcome(params: {
  settlementId: string;
  createdInvoice: { invoiceID: string; invoiceNumber?: string | null };
  response: { body: unknown };
  operationClaim: XeroOperationClaim;
  redrivable: boolean;
  usageTasks: HeldUsageWrites;
  outcome: GroupInvoiceEmailOutcome;
}): Promise<string | null> {
  const { settlementId, createdInvoice, response, operationClaim, usageTasks, outcome } = params;
  // Usage writes run only after the fence releases its connection and lock.
  const usageResults = await Promise.allSettled(usageTasks.map((persist) => persist()));
  for (const result of usageResults) {
    if (result.status === "rejected") {
      logger.warn({ err: result.reason, settlementId }, "Failed to record Xero API usage for the group settlement invoice email");
    }
  }

  if (outcome.deferredError) {
    logger.warn(
      { err: outcome.deferredError, settlementId, invoiceId: createdInvoice.invoiceID },
      "Did not get the group settlement invoice emailed inside the booking lock; the email is owed"
    );
    if (params.redrivable) {
      // The marker survives the return to PENDING and the next claim, and is
      // what sends the re-drive into the email fence rather than closing it.
      await prisma.xeroSyncOperation.updateMany({
        where: { id: operationClaim.id, ...ownRunningClaim(operationClaim) },
        data: {
          responsePayload: sanitizeForJson(
            deferredGroupInvoiceEmailPayload(response.body, outcome.deferredError)
          ),
        },
      });
      throw new GroupSettlementInvoiceEmailDeferredError(settlementId, createdInvoice.invoiceID);
    }
  }

  await completeXeroSyncOperation(operationClaim, {
    status: outcome.error || outcome.deferredError ? "PARTIAL" : "SUCCEEDED",
    responsePayload: {
      invoice: response.body,
      invoiceEmail: outcome.responseBody,
      // #4919: no "email" in either key, or the stored row reads [REDACTED].
      invoiceSendAccepted: outcome.accepted,
      deferredInvoiceSend: outcome.deferredError
        ? GROUP_SETTLEMENT_INVOICE_EMAIL_DEFERRED_CAUSE
        : null,
      invoiceEmailError: outcome.error ?? outcome.deferredError,
      invoiceEmailWithheldByNoEmails: outcome.withheldByNoEmails,
      // #3035: a THIRD, distinct reason nothing was emailed — a confirmed
      // copy. Never conflated with the switch above or a provider failure.
      invoiceEmailWithheldForEnvironment: outcome.withheldForEnvironment,
    },
    xeroObjectType: "INVOICE",
    xeroObjectId: createdInvoice.invoiceID,
    xeroObjectNumber: createdInvoice.invoiceNumber ?? null,
    xeroObjectUrl: buildXeroInvoiceUrl(createdInvoice.invoiceID),
  });

  return createdInvoice.invoiceID;
}
