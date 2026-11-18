// The mark-paid audit row's metadata readers, moved verbatim from
// `payment-reconciliation.ts` to keep that file under its size ceiling (#5145).
import type { Prisma } from "@prisma/client";

/**
 * Read `clearedCreditElectionCents` back off a mark-paid audit row's metadata.
 *
 * Defensive on purpose: `metadata` is free-form JSON, and rows written before
 * this key existed (or by a future writer that drops it) must read as "nothing
 * was cleared" rather than throw or restore a nonsense figure. Only a positive
 * integer counts — money stays in integer cents, and a zero or negative
 * "election" is not one.
 */
export function readClearedCreditElectionCents(
  metadata: Prisma.JsonValue | null | undefined
): number | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const raw = (metadata as Prisma.JsonObject).clearedCreditElectionCents;
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0
    ? raw
    : null;
}

/**
 * #2397 — read back what a mark-paid audit row says it settled of the booking's
 * outstanding extra, so the REVERSAL can put it back exactly as it was.
 *
 * Defensive for the same reason as the credit-election reader above: `metadata`
 * is free-form JSON, and every row written before this key existed must read as
 * "this settle covered no extra" rather than throw. Returns null in that case;
 * `previousStatus` is deliberately allowed to BE null, because a legacy delta
 * with no recorded status is a real state the reversal has to restore
 * faithfully.
 */
export function readSettledAdditionalPayment(
  metadata: Prisma.JsonValue | null | undefined
): { amountCents: number; previousStatus: string | null } | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const object = metadata as Prisma.JsonObject;
  const amountCents = object.settledAdditionalAmountCents;
  if (
    typeof amountCents !== "number" ||
    !Number.isInteger(amountCents) ||
    amountCents <= 0
  ) {
    return null;
  }
  const previousStatus = object.previousAdditionalPaymentStatus;
  return {
    amountCents,
    previousStatus: typeof previousStatus === "string" ? previousStatus : null,
  };
}
