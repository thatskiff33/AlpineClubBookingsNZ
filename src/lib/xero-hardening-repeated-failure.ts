// Repeated Xero failure alerting: notifies admins when the same correlation key
// fails repeatedly inside the rolling window, deduplicated against recent
// alerts. Extracted verbatim from xero-hardening.ts (#1208 item 5). Import xero
// source modules directly, never the @/lib/xero facade (#1208).
import type { XeroSyncOperation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { sendAdminXeroRepeatedFailureAlert } from "@/lib/email";
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
    THE DEDUP ASKS "HAS THIS ALERT ALREADY BEEN RAISED", not "did it arrive"
    (#3035 review).

    It used to look for `QUEUED`/`SENT` only, which was every outcome that
    existed when it was written. Since #3035 the environment-safety boundary
    lands this alert as `SKIPPED_NON_PRODUCTION` on a copy and as `FAILED` on an
    installation nobody has declared — so on those installations the dedup
    matched nothing, every qualifying operation re-attempted the alert, and each
    attempt wrote another counted withheld row. Bounded by the per-correlation-key
    threshold rather than a storm, but it inflates the very count that tells a
    live club wrongly declared a copy from an idle one.

    `FAILED` is included and that is not a lost alert: this template is NOT in
    `NON_RETRYABLE_EMAIL_LOG_TEMPLATES`, so its body is retained and the email
    retry cron replays the row. Re-raising a second alert alongside a replay would
    just double it. `BOUNCED` is included for the plainer reason — the alert was
    raised and the admin mailbox is the problem, which re-raising cannot fix.
    Listing the statuses that mean "already raised" rather than "arrived" is what
    makes this stable against the next status somebody adds.
  */
  const recentAlert = await prisma.emailLog.findFirst({
    where: {
      templateName: "admin-xero-repeated-failure",
      subject,
      createdAt: {
        gte: windowStart,
      },
      status: {
        in: [
          "QUEUED",
          "SENT",
          "FAILED",
          "BOUNCED",
          "SKIPPED_NON_PRODUCTION",
          "SKIPPED_NO_EMAILS",
        ],
      },
    },
  });

  if (recentAlert) {
    return { triggered: false, failureCount };
  }

  try {
    await sendAdminXeroRepeatedFailureAlert({
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
    return { triggered: true, failureCount };
  } catch (error) {
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
}
