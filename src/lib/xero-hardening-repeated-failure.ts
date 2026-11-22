// Repeated Xero failure alerting: notifies admins when the same correlation key
// fails repeatedly inside the rolling window, at most once per key per window.
// Extracted verbatim from xero-hardening.ts (#1208 item 5). Import xero
// source modules directly, never the @/lib/xero facade (#1208).
import type { XeroSyncOperation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { sendAdminXeroRepeatedFailureAlert } from "@/lib/email";
import {
  ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  claimAlertCooldown,
  deferAlertCooldown,
  releaseAlertCooldown,
} from "@/lib/alert-cooldown";
import {
  adminAlertSendOutcome,
  type AdminAlertSendResult,
} from "@/lib/email/admin-alert-send-result";
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
    status a raised alert's row can have. After the send it is settled by the
    shared reading of the result (`adminAlertSendOutcome`) and the house rule
    in `alert-cooldown.ts` (#3635 F1):
    - sent, queued for the retry cron, or undelivered (BOUNCED, or withheld on
      a copy as `SKIPPED_NON_PRODUCTION`): kept for the window;
    - nobody could receive it (`skipped-by-policy`, `no-recipients`): held for
      `ALERT_NOBODY_ELIGIBLE_RETRY_MS`, as `sendAdminAlertOnceEver` holds it,
      then the next qualifying failure tries again (with the default 24-hour
      window the hold and the window are the same day). The sender reads the
      policy and the audience before its live Xero read, so each such attempt
      costs no Xero call;
    - the send threw: given back, so the next qualifying failure retries.

    A STATED LIMIT: a copy whose send threw before its mail log row existed
    is counted by `sendAdminAlertTo` as queued for retry, so when every copy
    fails that way the outcome reads `queued-for-retry`, the claim is kept,
    nobody has the alert and nothing replays it until the window ends.

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
    await releaseAlertCooldown({ key, claimedAt: now }).catch((err) =>
      logger.error(
        { err, correlationKey: operation.correlationKey },
        "Failed to release the repeated Xero failure alert claim"
      )
    );
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
  // After #5448, which tells a copy that failed before its row existed apart
  // (`failedBeforeLogged`), that case should be deferred for a day here too.
  const outcome = adminAlertSendOutcome(result);
  if (outcome === "skipped-by-policy" || outcome === "no-recipients") {
    await deferAlertCooldown({
      key,
      claimedAt: now,
      windowMs,
      retryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
    }).catch((err) =>
      logger.error(
        { err, correlationKey: operation.correlationKey, outcome },
        "Failed to defer the repeated Xero failure alert claim"
      )
    );
  }
  return { triggered: true, failureCount };
}
