import "server-only";

import type { MembershipFeeBillingBasis, SubscriptionStatus } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { sendMembershipPaymentRecordedEmail } from "@/lib/email/membership";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { enqueueHostingCoverageReevaluationForMember } from "@/lib/adult-member-hosting-review";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";

/**
 * E14 (#1944): audited manual mark-paid / mark-unpaid for a member subscription,
 * for clubs that do not use the Xero invoicing pipeline (or one-off cash
 * payments). This NEVER calls Xero and NEVER creates or voids an invoice — it
 * only writes the local MemberSubscription status plus provenance columns and an
 * audit-log entry recording the acting admin.
 *
 * Marking paid sets status = PAID with provenance (manuallyMarkedPaidAt / by /
 * note). A manually marked-paid member is then paid-up everywhere the app keys
 * off status === "PAID" (booking, nomination, member subscription status).
 *
 * Semantics (#1944 owner decision): manual mark-paid exists for cash payments
 * where NO Xero invoice exists. A subscription that carries a Xero invoice link
 * must be settled in Xero (record the payment against the invoice), so
 * direction "paid" is rejected with 409 when xeroInvoiceId is set, and a
 * NOT_REQUIRED row has nothing to pay so it is rejected too.
 *
 * Marking unpaid (reversal) is only permitted on a row this feature marked paid;
 * it restores the appropriate unpaid status — UNPAID when a Xero invoice link
 * still exists (the invoice is outstanding), NOT_INVOICED otherwise — and clears
 * the provenance columns.
 *
 * Both writes are status-fenced (conditional updateMany, 409 when no row
 * matches) so two admins clicking concurrently — or a Xero sync landing between
 * read and write — can never double-apply or clobber each other.
 *
 * #2260: marking paid now offers the club's standard "email the member or not"
 * choice. The choice is REQUIRED on the paid path (a discriminated union, so
 * omitting it is a compile error) and recorded in the audit entry either way.
 * Marking unpaid emails nobody — there is no reversal notice — so the union
 * forbids passing the flag at all on that path.
 */
export class ManualSubscriptionPaymentError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ManualSubscriptionPaymentError";
    this.status = status;
  }
}

export const MANUAL_PAYMENT_NOTE_MAX = 500;

export type ManualPaymentDirection = "paid" | "unpaid";

export type ManualSubscriptionPaymentResult = {
  id: string;
  memberId: string;
  seasonYear: number;
  status: SubscriptionStatus;
  direction: ManualPaymentDirection;
  /**
   * The admin's email decision as recorded in the audit log. Always false on
   * the unpaid path (no reversal notice exists). This is the DECISION, not a
   * delivery receipt — read `receipt` for what became of it.
   */
  memberNotified: boolean;
  /**
   * What actually became of the receipt, so no caller can turn a decision into
   * a claim that the member was emailed:
   *   not_requested — the admin declined it, or this was a reversal
   *   queued        — handed to the mailer for delivery (not proof of arrival)
   *   not_delivered — the mailer suppressed it, the address was a club-internal
   *                   placeholder, or the send failed outright
   */
  receipt: ManualPaymentReceiptOutcome;
};

export type ManualPaymentReceiptOutcome =
  | "not_requested"
  | "queued"
  | "not_delivered";

/**
 * Discriminated on `direction` so the "email the member or not" choice cannot
 * be left implicit: marking paid must state `notifyMember`, and marking unpaid
 * cannot pass it at all (nothing is ever emailed on a reversal).
 */
export type ApplyManualSubscriptionPaymentInput =
  | {
      subscriptionId: string;
      direction: "paid";
      note?: string | null;
      actingMemberId: string;
      notifyMember: boolean;
    }
  | {
      subscriptionId: string;
      direction: "unpaid";
      note?: string | null;
      actingMemberId: string;
      notifyMember?: never;
    };

/**
 * The amount to print on the member's receipt, or null to omit the line.
 *
 * The frozen charge snapshot carries the CHARGE's total, which is only this
 * member's own fee when the charge is about this member alone. Two independent
 * conditions have to hold, and both are allow-list shaped so anything
 * unfamiliar degrades to the omission branch (which the receipt already
 * handles) rather than to a wrong figure:
 *
 *  - `billingBasis === "PER_MEMBER"`. An allow-list, not a "not PER_FAMILY"
 *    deny-list: a basis added to the enum later must not start printing shared
 *    totals just because nobody remembered this file. NO_INVOICE is excluded
 *    here as well as by the zero check below.
 *  - Exactly one coverage row on the charge. The basis says what the amount
 *    MEANS; the fan-out says what it actually paid for. Counting rows rather
 *    than active rows on purpose — releasing a family member's claim (#2147)
 *    must not make a family total start looking like a personal one.
 *
 * …and a zero total is never printed: a no-invoice fee is nothing to receipt,
 * and "$0.00 recorded" reads as a bug to the member either way.
 */
function receiptAmountCents(
  charge:
    | {
        chargedAmountCents: number;
        billingBasis: MembershipFeeBillingBasis;
        _count: { coverage: number };
      }
    | undefined,
): number | null {
  if (!charge) return null;
  if (charge.billingBasis !== "PER_MEMBER") return null;
  if (charge._count.coverage !== 1) return null;
  return charge.chargedAmountCents > 0 ? charge.chargedAmountCents : null;
}

export async function applyManualSubscriptionPayment(
  input: ApplyManualSubscriptionPaymentInput,
): Promise<ManualSubscriptionPaymentResult> {
  const trimmedNote = input.note?.trim() ? input.note.trim() : null;
  const note = trimmedNote ? trimmedNote.slice(0, MANUAL_PAYMENT_NOTE_MAX) : null;
  const notifyMember = input.direction === "paid" && input.notifyMember;

  // #3123 / INV-LOCK-004 — the club's day, resolved before the transaction
  // opens. `enqueueHostingCoverageReevaluationForMember` takes a `Member` row
  // lock and then bounds its fan-out on `checkOut >= today`, so it cannot
  // resolve the club's persisted timezone itself: that read is a
  // `clubTimeSettings.findUnique` and would take a second pooled connection
  // under the lock.
  const clubTodayForFanout = await clubTodayDateOnlyInstant();

  // The write commits first; the member email is dispatched afterwards, never
  // inside the transaction (no provider call inside a database transaction).
  const { result, recipient } = await prisma.$transaction(async (tx) => {
    const subscription = await tx.memberSubscription.findUnique({
      where: { id: input.subscriptionId },
      select: {
        id: true,
        memberId: true,
        seasonYear: true,
        status: true,
        xeroInvoiceId: true,
        manuallyMarkedPaidAt: true,
        member: { select: { firstName: true, email: true } },
        // #2260: a manual payment is cash the app never saw, so any figure on
        // the receipt has to come from a frozen snapshot — the season's ACTIVE
        // coverage claim (releasedAt IS NULL) — never from a guess.
        //
        // `chargedAmountCents` is the CHARGE's total, not this member's share.
        // A PER_FAMILY charge covers every family member's subscription with
        // one amount, so printing it here would tell one member the whole
        // family's fee was recorded against them ("nothing further to pay")
        // while their relatives' subscriptions are still unpaid. So the basis
        // and the coverage fan-out are read too, and the amount is printed only
        // when the snapshot is unambiguously about this one subscription.
        chargeCoverage: {
          where: { releasedAt: null },
          select: {
            charge: {
              select: {
                chargedAmountCents: true,
                billingBasis: true,
                _count: { select: { coverage: true } },
              },
            },
          },
          take: 1,
        },
      },
    });
    if (!subscription) {
      throw new ManualSubscriptionPaymentError("Subscription not found", 404);
    }

    if (input.direction === "paid") {
      // Never overwrite a PAID status the Xero pipeline (or a prior manual
      // action) already owns.
      if (subscription.status === "PAID") {
        throw new ManualSubscriptionPaymentError(
          "This subscription is already marked paid.",
          409,
        );
      }
      // Owner-decided semantics (#1944): manual mark-paid is for cash payments
      // where no Xero invoice exists. Once an invoice links, Xero owns the
      // money state — recording the payment here would leave the invoice
      // outstanding in Xero and the two systems permanently disagreeing.
      if (subscription.xeroInvoiceId) {
        throw new ManualSubscriptionPaymentError(
          "This subscription has an outstanding Xero invoice — record the payment against the invoice in Xero instead.",
          409,
        );
      }
      // A NOT_REQUIRED row has nothing to pay, and marking it paid would lose
      // the policy-derived status with no way to restore it on reversal.
      if (subscription.status === "NOT_REQUIRED") {
        throw new ManualSubscriptionPaymentError(
          "This subscription is not required for this member — there is nothing to mark paid.",
          409,
        );
      }
      const now = new Date();
      // Status-fenced write: re-assert every guard inside the WHERE so a
      // concurrent second click, manual mark-paid, or Xero sync between the
      // read above and this write cannot double-apply or clobber (F4).
      const fenced = await tx.memberSubscription.updateMany({
        where: {
          id: subscription.id,
          status: { notIn: ["PAID", "NOT_REQUIRED"] },
          xeroInvoiceId: null,
          manuallyMarkedPaidAt: null,
        },
        data: {
          status: "PAID",
          paidAt: now,
          manuallyMarkedPaidAt: now,
          manuallyMarkedPaidByMemberId: input.actingMemberId,
          manualPaymentNote: note,
        },
      });
      if (fenced.count === 0) {
        throw new ManualSubscriptionPaymentError(
          "This subscription changed while you were marking it paid — refresh and try again.",
          409,
        );
      }
      const updated = await tx.memberSubscription.findUniqueOrThrow({
        where: { id: subscription.id },
        select: { id: true, memberId: true, seasonYear: true, status: true },
      });
      await createAuditLog(
        {
          action: "membership-subscription.manual-payment.mark-paid",
          memberId: input.actingMemberId,
          actorMemberId: input.actingMemberId,
          subjectMemberId: subscription.memberId,
          targetId: subscription.id,
          entityType: "MemberSubscription",
          entityId: subscription.id,
          category: "payment",
          severity: "important",
          outcome: "success",
          summary: "Membership subscription manually marked paid",
          details: note,
          metadata: {
            subscriptionId: subscription.id,
            memberId: subscription.memberId,
            seasonYear: subscription.seasonYear,
            previousStatus: subscription.status,
            hasXeroInvoiceLink: Boolean(subscription.xeroInvoiceId),
            // #2260 honesty rule: the admin's email choice is an explicit
            // per-action decision, so record it BOTH ways — a reader of the log
            // must be able to tell "chose not to email" from "the feature never
            // offered a choice", which an only-on-decline record cannot express.
            notifyMember,
          },
        },
        tx,
      );
      await enqueueHostingCoverageReevaluationForMember(
        subscription.memberId,
        tx,
        clubTodayForFanout,
        {
          cause: "SYSTEM_CHANGE",
          actorMemberId: input.actingMemberId,
        },
      );
      // The receipt needs the amount and the recipient read before commit;
      // the send itself happens after the transaction returns.
      const amountCents = receiptAmountCents(
        subscription.chargeCoverage?.[0]?.charge,
      );
      return {
        result: {
          ...updated,
          direction: "paid" as const,
          memberNotified: notifyMember,
        },
        recipient:
          subscription.member?.email
            ? {
                email: subscription.member.email,
                firstName: subscription.member.firstName,
                seasonYear: subscription.seasonYear,
                // The receipt states the moment the payment was recorded — the
                // same timestamp written to manuallyMarkedPaidAt/paidAt, not a
                // second clock read after the transaction.
                recordedAt: now,
                amountCents,
              }
            : null,
      };
    }

    // direction === "unpaid": reversal, only on a row this feature marked paid.
    if (!subscription.manuallyMarkedPaidAt) {
      throw new ManualSubscriptionPaymentError(
        "Only a manually marked-paid subscription can be reversed here.",
        409,
      );
    }
    const restoredStatus: SubscriptionStatus = subscription.xeroInvoiceId
      ? "UNPAID"
      : "NOT_INVOICED";
    // Status-fenced write (F4): only a row still carrying manual provenance can
    // be reversed, so a concurrent reversal / Xero sync that already cleared it
    // 409s instead of silently re-applying.
    const fenced = await tx.memberSubscription.updateMany({
      where: {
        id: subscription.id,
        manuallyMarkedPaidAt: { not: null },
      },
      data: {
        status: restoredStatus,
        paidAt: null,
        manuallyMarkedPaidAt: null,
        manuallyMarkedPaidByMemberId: null,
        manualPaymentNote: null,
      },
    });
    if (fenced.count === 0) {
      throw new ManualSubscriptionPaymentError(
        "This subscription changed while you were reversing the manual payment — refresh and try again.",
        409,
      );
    }
    const updated = await tx.memberSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
      select: { id: true, memberId: true, seasonYear: true, status: true },
    });
    await createAuditLog(
      {
        action: "membership-subscription.manual-payment.mark-unpaid",
        memberId: input.actingMemberId,
        actorMemberId: input.actingMemberId,
        subjectMemberId: subscription.memberId,
        targetId: subscription.id,
        entityType: "MemberSubscription",
        entityId: subscription.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: "Manual membership subscription payment reversed",
        details: note,
        metadata: {
          subscriptionId: subscription.id,
          memberId: subscription.memberId,
          seasonYear: subscription.seasonYear,
          previousStatus: subscription.status,
          restoredStatus,
          hasXeroInvoiceLink: Boolean(subscription.xeroInvoiceId),
          // #2260: a reversal never emails the member — there is no
          // "your payment was un-recorded" notice, and inventing one would be
          // worse than silence. Recorded under its OWN key so a raw metadata
          // render cannot be misread as an admin having declined the choice on
          // the paid path: here no choice was ever offered.
          notifyMemberOffered: false,
        },
      },
      tx,
    );
    await enqueueHostingCoverageReevaluationForMember(
      subscription.memberId,
      tx,
      clubTodayForFanout,
      {
        cause: "SYSTEM_CHANGE",
        actorMemberId: input.actingMemberId,
      },
    );
    return {
      result: {
        ...updated,
        direction: "unpaid" as const,
        memberNotified: false,
      },
      recipient: null,
    };
  });

  await settleHostingCoverageAfterCommit({ limit: 50 });

  // #2260: dispatched only on the paid path, and only when the admin chose it.
  // A send failure must never undo or 500 the committed money state — but it
  // must never be swallowed either, or the admin is told a receipt went out
  // when nothing did. Every branch that ends without a queued send says so,
  // both in the log and in the returned `receipt`.
  let receipt: ManualPaymentReceiptOutcome = "not_requested";
  if (notifyMember) {
    if (!recipient) {
      // Member.email is non-nullable, so this is the "should not happen" arm —
      // it must still be audible rather than a wordless skip.
      logger.warn(
        { subscriptionId: input.subscriptionId },
        "Manual subscription payment: a receipt was requested but the member has no address to send it to",
      );
      receipt = "not_delivered";
    } else {
      try {
        const outcome = await sendMembershipPaymentRecordedEmail({
          email: recipient.email,
          firstName: recipient.firstName,
          seasonYear: recipient.seasonYear,
          amountCents: recipient.amountCents,
          recordedAt: recipient.recordedAt,
        });
        // "sent" means the mailer accepted and dispatched it. Anything else —
        // a suppression, a club-internal placeholder address — means the member
        // will not read this, and the admin has to hear that.
        receipt = outcome.status === "sent" ? "queued" : "not_delivered";
        if (receipt === "not_delivered") {
          logger.warn(
            {
              subscriptionId: input.subscriptionId,
              outcome: outcome.status,
            },
            "Manual subscription payment recorded, but the member receipt was not sent",
          );
        }
      } catch (error) {
        logger.error(
          { err: error, subscriptionId: input.subscriptionId },
          "Manual subscription payment recorded, but the member receipt failed to send",
        );
        receipt = "not_delivered";
      }
    }
  }

  return { ...result, receipt };
}
