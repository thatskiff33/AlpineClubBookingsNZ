/**
 * The stale payment-recovery-queue alert: officers hear once per shared
 * cooldown window when a claimable recovery row has waited past the threshold,
 * so a stalled cron is noticed. Moved verbatim out of `payment-recovery.ts`
 * (#4755, the file's hard size ceiling, #5145); its one caller is
 * `processPaymentRecoveryOperations` there.
 */
import { PaymentRecoveryOperationStatus, PaymentRecoveryOperationType } from "@prisma/client";
import { claimAlertCooldown } from "@/lib/alert-cooldown";
import { bookingOwner } from "@/lib/booking-owner";
import type { ClubFormat } from "@/lib/club-format";
import { loadPersistedClubFormatSettings } from "@/lib/club-format-settings";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { PAYMENT_RECOVERY_CLAIMABLE_LATER_WHERE } from "@/lib/payment-recovery-constants";
import { prisma } from "@/lib/prisma";

const PAYMENT_RECOVERY_STALE_ALERT_THRESHOLD_MS = 30 * 60 * 1000;
const PAYMENT_RECOVERY_STALE_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
// #1211: shared AlertCooldown key that all instances contend on so the stale
// payment-recovery-queue alert fires at most once per cooldown window across
// the whole fleet, not once per process.
const STALE_PAYMENT_RECOVERY_ALERT_COOLDOWN_KEY = "payment-recovery:stale-queue";

// #3567: card charges are not a stalled cron while card payments are off (the
// admin banner says so), nor within this window of the club format last changing:
// charges that waited out a refusal are old, and the next run claims them.
export async function alertStalePaymentRecoveryQueueIfNeeded(format: ClubFormat, chargesRefused: boolean) {
  const now = new Date();
  const staleThreshold = new Date(
    now.getTime() - PAYMENT_RECOVERY_STALE_ALERT_THRESHOLD_MS,
  );
  const formatChangedAt = chargesRefused ? null : (await loadPersistedClubFormatSettings())?.updatedAt;
  const quietCharges = chargesRefused || (formatChangedAt != null && formatChangedAt > staleThreshold);
  const oldest = await prisma.paymentRecoveryOperation.findFirst({
    where: {
      status: PaymentRecoveryOperationStatus.PENDING,
      createdAt: { lt: staleThreshold },
      ...PAYMENT_RECOVERY_CLAIMABLE_LATER_WHERE, // #4104: a dead row is not a stalled cron
      ...(quietCharges ? { type: { not: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT } } : {}),
    },
    orderBy: { createdAt: "asc" },
    // #3369: the owner may be an Organisation; bookingOwner() reads both.
    include: { booking: { include: { member: true, organisation: { select: { name: true, email: true } } } } },
  });
  if (!oldest) return;

  // Shared cross-instance cooldown: atomically CLAIM the window before sending
  // so N instances raise at most one alert per
  // PAYMENT_RECOVERY_STALE_ALERT_COOLDOWN_MS (not one per instance). The
  // claim-before-send pattern was extracted verbatim to @/lib/alert-cooldown
  // under #2262 so the manual-settlement conflict alert can share it.
  const holdsClaim = await claimAlertCooldown({
    key: STALE_PAYMENT_RECOVERY_ALERT_COOLDOWN_KEY,
    windowMs: PAYMENT_RECOVERY_STALE_ALERT_COOLDOWN_MS,
    now,
  });
  if (!holdsClaim) return;
  // We hold the claim → send exactly once cross-instance. The provider call is
  // claim-first and outside any DB transaction; the tiny residual double-send
  // window (two instances reading between claim attempts) is bounded and this
  // is a noise-only alert.
  await sendAdminPaymentFailureAlert({
    memberName:
      oldest.booking && bookingOwner(oldest.booking).member
      ? `${bookingOwner(oldest.booking).member.firstName} ${bookingOwner(oldest.booking).member.lastName}`
      : "Unknown member",
    checkIn: oldest.booking?.checkIn ?? null,
    checkOut: oldest.booking?.checkOut ?? null,
    amountCents: oldest.amountCents,
    errorMessage:
      "Stripe payment recovery queue is stalled. Confirm the cron leader's 15-minute payments cycle is running (payment-recovery on admin cron health).",
    paymentIntentId: oldest.paymentIntentId,
  }, format).catch((alertError) =>
    logger.error(
      { err: alertError, operationId: oldest.id },
      "Failed to send stale payment recovery queue alert",
    ),
  );
}
