// Repeated Xero failure alerting: notifies admins when the same correlation key
// fails repeatedly inside the rolling window, at most once per key per window.
// Extracted verbatim from xero-hardening.ts (#1208 item 5). Import xero
// source modules directly, never the @/lib/xero facade (#1208).
import type { XeroSyncOperation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { sendAdminXeroRepeatedFailureAlert } from "@/lib/email";
import { claimAlertCooldown, releaseAlertCooldown } from "@/lib/alert-cooldown";
import type { AdminAlertSendResult } from "@/lib/email/admin-alert-send-result";
import { buildXeroObjectUrl } from "@/lib/xero-links";
import { buildLocalAdminUrl } from "@/lib/xero-record-links";
import {
  DEFAULT_REPEATED_FAILURE_THRESHOLD,
  XERO_REQUEUE_OPERATION_TYPE,
  getRepeatedFailureWindowStart,
} from "./xero-hardening-shared";

const DEFAULT_REPEATED_FAILURE_WINDOW_HOURS = 24;

type FailureAlertOperation = Pick<
  XeroSyncOperation,
  | "id"
  | "correlationKey"
  | "entityType"
  | "operationType"
  | "localModel"
  | "localId"
  | "lastErrorMessage"
  | "xeroObjectType"
  | "xeroObjectId"
  | "xeroObjectUrl"
>;

function getRepeatedFailureAlertSubject(correlationKey: string) {
  return `Repeated Xero Failure: ${correlationKey}`;
}

/** The `AlertCooldown` key holding one correlation key's alert window (#5407 item 29). */
export function repeatedFailureAlertCooldownKey(correlationKey: string) {
  return `xero-repeated-failure:${correlationKey}`;
}

export async function maybeNotifyXeroRepeatedFailure(
  operation: FailureAlertOperation,
  options?: {
    threshold?: number;
    windowHours?: number;
  }
): Promise<{ triggered: boolean; failureCount: number }> {
  if (!operation.correlationKey || operation.operationType === XERO_REQUEUE_OPERATION_TYPE) {
    return { triggered: false, failureCount: 0 };
  }

  const threshold = options?.threshold ?? DEFAULT_REPEATED_FAILURE_THRESHOLD;
  const windowHours = options?.windowHours ?? DEFAULT_REPEATED_FAILURE_WINDOW_HOURS;
  const now = new Date();
  const windowStart = getRepeatedFailureWindowStart(now, windowHours);

  const failureCount = await prisma.xeroSyncOperation.count({
    where: {
      correlationKey: operation.correlationKey,
      operationType: {
        not: XERO_REQUEUE_OPERATION_TYPE,
      },
      status: {
        in: ["FAILED", "PARTIAL"],
      },
      // #3635 (`INV-INT-025`): a failure an officer resolved in Xero is done;
      // the reconciliation report leaves it out of the same count.
      manuallyResolvedAt: null,
      createdAt: {
        gte: windowStart,
      },
    },
  });

  if (failureCount < threshold) {
    return { triggered: false, failureCount };
  }

  const subject = getRepeatedFailureAlertSubject(operation.correlationKey);
  /*
    ONE ALERT PER CORRELATION KEY PER WINDOW, held by an `AlertCooldown` claim
    keyed on the correlation key (#5407 item 29).

    It used to look for an earlier `EmailLog` row by this built-in subject. The
    log stores the subject actually sent, and a club that saves its own subject
    on this template replaces the built-in one, so the earlier alert was never
    found and the alert went out on every qualifying failure. The key here is
    built from the correlation key alone, which no club setting can change.

    The claim asks "has this alert already been RAISED", not "did it arrive"
    (#3035 review), the same question the old lookup answered by listing every
    status a raised alert's row can have. It is kept whenever the send reached
    a recipient's mail log at all: sent, queued, FAILED (this template keeps its
    body, so the email retry cron replays the row), BOUNCED or withheld on a
    copy (`SKIPPED_NON_PRODUCTION`). It is given back, so the next qualifying
    failure tries again, exactly where the old lookup found no row: the
    delivery policy skipped the alert, no admin is opted in, or the send threw.

    Claim first and send after, outside any transaction (`alert-cooldown.ts`),
    so two instances failing the same key at once raise one alert.
  */
  const key = repeatedFailureAlertCooldownKey(operation.correlationKey);
  const windowMs = now.getTime() - windowStart.getTime();
  let claimed: boolean;
  try {
    claimed = await claimAlertCooldown({ key, windowMs, now });
  } catch (error) {
    // The write may have committed before the throw: give back this call's
    // own stamp so the next failure can alert, then fail as the read did.
    await releaseAlertCooldown({ key, claimedAt: now }).catch(() => undefined);
    throw error;
  }
  if (!claimed) {
    return { triggered: false, failureCount };
  }

  const releaseClaim = () =>
    releaseAlertCooldown({ key, claimedAt: now }).catch((err) =>
      logger.error(
        { err, correlationKey: operation.correlationKey },
        "Failed to release the repeated Xero failure alert claim"
      )
    );
  let result: AdminAlertSendResult;
  try {
    result = await sendAdminXeroRepeatedFailureAlert({
      subject,
      correlationKey: operation.correlationKey,
      failureCount,
      windowHours,
      entityType: operation.entityType,
      operationType: operation.operationType,
      localModel: operation.localModel ?? null,
      localId: operation.localId ?? null,
      localUrl: buildLocalAdminUrl(operation.localModel, operation.localId),
      xeroObjectUrl:
        operation.xeroObjectUrl ??
        (operation.xeroObjectType && operation.xeroObjectId
          ? buildXeroObjectUrl(operation.xeroObjectType, operation.xeroObjectId)
          : null),
      latestErrorMessage: operation.lastErrorMessage ?? null,
      timestamp: now,
    });
  } catch (error) {
    await releaseClaim();
    logger.error(
      {
        err: error,
        correlationKey: operation.correlationKey,
        operationId: operation.id,
      },
      "Failed to send repeated Xero failure alert"
    );
    return { triggered: false, failureCount };
  }
  if (!result.deliveryAllowed || result.recipients === 0) {
    // No mail log row was written, so nothing records the alert as raised.
    await releaseClaim();
  }
  return { triggered: true, failureCount };
}
