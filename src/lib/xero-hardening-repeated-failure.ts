// Repeated Xero failure alerting: notifies admins when the same correlation key
// fails repeatedly inside the rolling window, at most once per key per window.
// Extracted verbatim from xero-hardening.ts (#1208 item 5). Import xero
// source modules directly, never the @/lib/xero facade (#1208).
import type { XeroSyncOperation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { sendAdminXeroRepeatedFailureAlert } from "@/lib/email";
import { sendAdminAlertOncePerWindow } from "@/lib/admin-alert-window";
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

  // Narrowed here: the send below runs in a closure, where the guard above does not reach.
  const correlationKey = operation.correlationKey;
  const subject = getRepeatedFailureAlertSubject(correlationKey);
  /*
    ONE ALERT PER CORRELATION KEY PER WINDOW, held by an `AlertCooldown` claim
    keyed on the correlation key (#5407 item 29), through the shared windowed
    sequence (`sendAdminAlertOncePerWindow`, which states how the claim is
    kept, held for a day, given back or rethrown).

    It used to look for an earlier `EmailLog` row by this built-in subject. The
    log stores the subject actually sent, and a club that saves its own subject
    on this template replaces the built-in one, so the earlier alert was never
    found and the alert went out on every qualifying failure. The key here is
    built from the correlation key alone, which no club setting can change.

    With the default 24-hour window the day's hold for an alert nobody could
    receive and the window are the same day. The sender reads the policy and
    the audience before its live Xero read, so a switched-off alert costs no
    Xero call.
  */
  const attempt = await sendAdminAlertOncePerWindow({
    key: repeatedFailureAlertCooldownKey(operation.correlationKey),
    windowMs: now.getTime() - windowStart.getTime(),
    now,
    label: "repeated Xero failure alert",
    context: { correlationKey: operation.correlationKey },
    raiseAlert: () =>
      sendAdminXeroRepeatedFailureAlert({
        subject,
        correlationKey,
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
      }),
  });
  if (!attempt.raised && attempt.reason === "send-threw") {
    logger.error(
      {
        err: attempt.error,
        correlationKey: operation.correlationKey,
        operationId: operation.id,
      },
      "Failed to send repeated Xero failure alert"
    );
  }
  return { triggered: attempt.raised, failureCount };
}
