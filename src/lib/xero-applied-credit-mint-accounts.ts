/**
 * Where a minted applied-credit remainder note's money lands (#2717).
 *
 * The engine in `xero-applied-credit-allocation.ts` mints ONE credit note for
 * the credit lots that have no floating Xero note of their own. This module is
 * the accounting POLICY that note's lines follow — which Xero mapping each
 * share posts to, and how a share becomes a coded line — kept apart from the
 * orchestration because it is a rule a treasurer can be shown, with no Prisma,
 * no provider client and no outbox in it.
 *
 * The rule the owner settled on 10 Aug 2026 is in `mintSliceMappingKey`.
 */
import { CreditType } from "@prisma/client";
import type { LineItem } from "xero-node";
import type { ResolvedAccountMappingWithFallback } from "./xero-mappings";

/**
 * The Xero mappings a minted remainder note's lines can post to (#2717).
 *
 * Two, and only two: discretionary goodwill the club chose to bear, and a
 * member's own money being handed back. `INV-INT-021` registers both keys.
 */
export type MintSliceMappingKey = "goodwillWriteOffs" | "hutFeeRefunds";

/**
 * The order minted lines are emitted in. Fixed and independent of ledger order,
 * so the recorded request payload and every replay of it agree.
 */
const MINT_SLICE_MAPPING_KEY_ORDER: readonly MintSliceMappingKey[] = [
  "hutFeeRefunds",
  "goodwillWriteOffs",
];

/**
 * Which Xero mapping ONE noteless slice posts to (#2717; owner, 10 Aug 2026).
 *
 * `ADMIN_ADJUSTMENT` is the discretionary case and the only one the owner's
 * decision is about: a club chose to grant credit it was never owed, so revenue
 * stays at what was billed and the grant shows as its own EXPENSE line.
 *
 * EVERY OTHER TYPE IS THE MEMBER'S OWN MONEY and stays on `hutFeeRefunds`,
 * which is exactly where it went before #2717:
 *  - `CANCELLATION_REFUND` — including the #1547 restore of credit whose
 *    funding note a prior cancel consumed. That row is permanently noteless
 *    (`backfillCancellationCreditXeroNote` matches three literal descriptions
 *    and "Credit restored from cancelled booking …" is not one of them), so
 *    keying off "has it got a note yet?" would book it as goodwill for ever;
 *  - `BOOKING_MODIFICATION_REFUND` — a downward reprice, likewise not goodwill;
 *  - `BOOKING_APPLIED` — a positive row here is the #1887 clamp's offset, which
 *    reverses an application rather than granting anything.
 *
 * The third population the note-based test could not distinguish is an ordinary
 * cancellation or modification refund read during the window BEFORE its note
 * arrives from the outbox worker. Keying on the type instead of the note makes
 * that window irrelevant: where the money lands no longer depends on worker
 * latency.
 */
export function mintSliceMappingKey(
  creditType: CreditType,
): MintSliceMappingKey {
  return creditType === CreditType.ADMIN_ADJUSTMENT
    ? "goodwillWriteOffs"
    : "hutFeeRefunds";
}

/** One mapping's share of a minted remainder note. */
export interface PlannedMintGroup {
  mappingKey: MintSliceMappingKey;
  amountCents: number;
}

/**
 * Split the minted remainder into per-mapping shares (#2717).
 *
 * Conservation is by construction: every slice lands in exactly one group and
 * the groups sum to `mintTotalCents`, so the note's total, its allocation
 * against the invoice and its idempotency key are all unchanged by the split.
 * Empty groups are dropped, so the common single-population case yields exactly
 * one group and one line — as it always did.
 */
export function planMintGroups(
  slices: readonly { creditType: CreditType; amountCents: number }[],
): PlannedMintGroup[] {
  const totals = new Map<MintSliceMappingKey, number>();
  for (const slice of slices) {
    const key = mintSliceMappingKey(slice.creditType);
    totals.set(key, (totals.get(key) ?? 0) + slice.amountCents);
  }
  return MINT_SLICE_MAPPING_KEY_ORDER.filter(
    (key) => (totals.get(key) ?? 0) > 0,
  ).map((mappingKey) => ({ mappingKey, amountCents: totals.get(mappingKey)! }));
}

/**
 * The account and item coding ONE minted line carries, before it becomes a
 * `LineItem`. Two shares that resolve to the same coding are merged, which is
 * what keeps an unconfigured club's note byte-identical to the pre-#2717 one.
 */
export interface MintLineCoding {
  accountCode?: string;
  itemCode?: string;
  amountCents: number;
}

/**
 * Apply the pre-#2717 line-coding rule to one resolved mapping. Unchanged,
 * operand for operand: the default "200" is left OFF the line when an item code
 * carries the account and the club never chose a code of its own, so Xero takes
 * the account from the item exactly as it did before.
 */
export function codeMintLine(
  mapping: ResolvedAccountMappingWithFallback,
  amountCents: number,
): MintLineCoding {
  const accountCode = mapping.code ?? "200";
  const coding: MintLineCoding = { amountCents };
  if (mapping.itemCode) {
    coding.itemCode = mapping.itemCode;
  }
  if (
    !mapping.itemCode ||
    accountCode !== "200" ||
    mapping.codeExplicitlyConfigured
  ) {
    coding.accountCode = accountCode;
  }
  return coding;
}

/**
 * Turn the coded shares into the note's line items, merging any two whose
 * coding is identical. That merge is what makes an unset `goodwillWriteOffs` a
 * no-op: both shares resolve to the hut-fee-refund mapping and collapse back
 * into the single line an upgrading club has always had.
 */
export function mintLineItems(
  codings: readonly MintLineCoding[],
  description: string,
): LineItem[] {
  const merged: MintLineCoding[] = [];
  for (const coding of codings) {
    const existing = merged.find(
      (candidate) =>
        candidate.accountCode === coding.accountCode &&
        candidate.itemCode === coding.itemCode,
    );
    if (existing) {
      existing.amountCents += coding.amountCents;
    } else {
      merged.push({ ...coding });
    }
  }
  return merged.map((coding) => {
    const lineItem: LineItem = {
      description,
      quantity: 1,
      unitAmount: coding.amountCents / 100,
      taxType: "OUTPUT2",
    };
    if (coding.itemCode) {
      lineItem.itemCode = coding.itemCode;
    }
    if (coding.accountCode) {
      lineItem.accountCode = coding.accountCode;
    }
    return lineItem;
  });
}
