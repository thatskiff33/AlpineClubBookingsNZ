import { NextResponse } from "next/server";

import logger from "@/lib/logger";
import { isTransactionContention } from "@/lib/prisma-errors";

/**
 * The HTTP answer to a transaction that ran out of its lock(1) budget
 * (`INV-LOCK-006`) or lost a write conflict: Prisma's P2028 / P2034, judged by
 * `isTransactionContention`. Prisma rolls such a transaction back, so the
 * honest answer is a retryable 503 with `Retry-After`, not a 500 or the 400 of
 * a generic fallback. The raw Prisma message stays in the log only (#1888).
 *
 * Interactive routes use this; crons, webhooks and outbox workers do not - they
 * rethrow so their own retry contract runs.
 */
export const TRANSACTION_CONTENDED_CODE = "TRANSACTION_CONTENDED";
export const TRANSACTION_CONTENDED_RETRY_AFTER_SECONDS = 2;

/** For an operation whose one transaction is all it writes: nothing was saved. */
export const TRANSACTION_CONTENDED_MESSAGE =
  "The booking system is busy right now. Nothing was saved, so please try again in a moment.";

/**
 * For an operation that commits in more than one step, where an earlier step
 * may already have landed: the user checks before retrying rather than being
 * told nothing changed.
 */
export const TRANSACTION_CONTENDED_STATUS_CHECK_MESSAGE =
  "The booking system is busy right now and this step could not finish. Please check the current status, then try again in a moment if it is still needed.";

export interface TransactionContendedOptions {
  /** Defaults to {@link TRANSACTION_CONTENDED_MESSAGE}. */
  readonly message?: string;
  /** Defaults to {@link TRANSACTION_CONTENDED_CODE}. */
  readonly code?: string;
  /** Extra fields for the log line, such as the booking id. */
  readonly context?: Readonly<Record<string, unknown>>;
}

/**
 * The 503 for `error` when it is transaction contention, otherwise `null` so
 * the caller's own handling runs unchanged.
 */
export function transactionContendedResponse(
  error: unknown,
  logMessage: string,
  options: TransactionContendedOptions = {},
): NextResponse | null {
  if (!isTransactionContention(error)) return null;
  logger.warn({ err: error, ...options.context }, logMessage);
  return NextResponse.json(
    {
      error: options.message ?? TRANSACTION_CONTENDED_MESSAGE,
      code: options.code ?? TRANSACTION_CONTENDED_CODE,
    },
    {
      status: 503,
      headers: { "Retry-After": String(TRANSACTION_CONTENDED_RETRY_AFTER_SECONDS) },
    },
  );
}
