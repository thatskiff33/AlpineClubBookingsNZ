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
import { xeroLineTax, type XeroTaxRendering } from "./xero-tax-rendering";
import type { XeroTaxCategoryKey } from "./xero-tax-categories";
import { OPENING_CREDITS_MAPPING_KEY } from "./xero-account-mapping-keys";
import type { ResolvedAccountMappingWithFallback } from "./xero-mappings";

/**
 * The Xero mappings a minted remainder note's lines can post to (#2717).
 *
 * Three: discretionary goodwill the club chose to bear, a member's own money
 * being handed back, and credit brought across from a club's old system with an
 * opening-credit import (#4988). `INV-INT-021` registers all three keys; the
 * other two fall back to `hutFeeRefunds` while unset.
 */
export type MintSliceMappingKey =
  | "goodwillWriteOffs"
  | "hutFeeRefunds"
  | typeof OPENING_CREDITS_MAPPING_KEY;

/**
 * The order minted lines are emitted in. Fixed and independent of ledger order,
 * so the recorded request payload and every replay of it agree.
 */
const MINT_SLICE_MAPPING_KEY_ORDER: readonly MintSliceMappingKey[] = [
  "hutFeeRefunds",
  OPENING_CREDITS_MAPPING_KEY,
  "goodwillWriteOffs",
];

/**
 * Which Xero mapping ONE noteless slice posts to (#2717; owner, 10 Aug 2026).
 *
 * A noteless legacy `ADMIN_ADJUSTMENT` is the discretionary case this mint
 * still covers. A grant approved after #4431 already carries its own note, so
 * spend allocates that note and this function is not asked. Revenue stays at
 * what was billed and the legacy grant shows as its own EXPENSE line.
 *
 * EVERY OTHER TYPE IS THE MEMBER'S OWN MONEY and stays on `hutFeeRefunds`,
 * which is exactly where it went before #2717:
 *  - `CANCELLATION_REFUND` — including the #1547 restore of credit whose
 *    funding note a prior cancel consumed. That row is permanently noteless
 *    (`stampCancellationCreditXeroNote` stamps the credit a note names, else
 *    three literal descriptions, and "Credit restored from cancelled booking …"
 *    is neither), so
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
 *
 * AN OPENING CREDIT HAS ITS OWN MAPPING (#4988, `INV-PAY-162`; owner,
 * 16 Nov 2026). It is stored as an `ADMIN_ADJUSTMENT` row, but it restates a
 * balance the club already owed the member under its old system, not goodwill
 * the club chose to grant, so the lot's `openingCredit` flag, not its type,
 * decides. It posts to `openingCredits`, which a club that already carries the
 * old credit in Xero points at that liability account. While that mapping is
 * unset it resolves to `hutFeeRefunds` verbatim (`INV-INT-021`), so the line is
 * coded exactly as it was before the mapping existed.
 */
export function mintSliceMappingKey(slice: {
  creditType: CreditType;
  openingCredit: boolean;
}): MintSliceMappingKey {
  if (slice.openingCredit) return OPENING_CREDITS_MAPPING_KEY;
  return slice.creditType === CreditType.ADMIN_ADJUSTMENT
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
  slices: readonly { creditType: CreditType; openingCredit: boolean; amountCents: number }[],
): PlannedMintGroup[] {
  const totals = new Map<MintSliceMappingKey, number>();
  for (const slice of slices) {
    const key = mintSliceMappingKey(slice);
    totals.set(key, (totals.get(key) ?? 0) + slice.amountCents);
  }
  return MINT_SLICE_MAPPING_KEY_ORDER.filter(
    (key) => (totals.get(key) ?? 0) > 0,
  ).map((mappingKey) => ({ mappingKey, amountCents: totals.get(mappingKey)! }));
}

/**
 * The tax category a minted line carries when it is NOT sales tax on income
 * (#4988; owner, 17 Nov 2026). One today: Exempt, on the share the club's own
 * Opening Credits mapping codes.
 */
type MintLineTaxCategory = Extract<XeroTaxCategoryKey, "EXEMPT">;

/**
 * The account and item coding ONE minted line carries, before it becomes a
 * `LineItem`. Two shares that resolve to the same coding are merged, which is
 * what keeps an unconfigured club's note byte-identical to the pre-#2717 one.
 */
export interface MintLineCoding {
  accountCode?: string;
  itemCode?: string;
  amountCents: number;
  /**
   * Absent on every line but one: the line is sales tax on income and takes
   * the note's own treatment, as it always has. Set by `codeMintLine` alone.
   */
  taxCategory?: MintLineTaxCategory;
}

/**
 * Apply the pre-#2717 line-coding rule to one resolved mapping. Unchanged,
 * operand for operand: the default "200" is left OFF the line when an item code
 * carries the account and the club never chose a code of its own, so Xero takes
 * the account from the item exactly as it did before.
 *
 * THE EXEMPT LINE (#4988; owner decisions of 17 Nov 2026, `INV-PAY-162`). A
 * share is in the Exempt tax category when, and only when, the Opening Credits
 * mapping ITSELF supplied its account: the club set that mapping, so the line
 * is the spent opening credit coded to the club's liability account. While the
 * mapping is unset the share resolves through its `hutFeeRefunds` fallback
 * (`sourceKey` is then `hutFeeRefunds`), carries no category, and is coded and
 * taxed exactly as it was before the mapping existed. No other key is ever the
 * source of an Exempt line.
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
  if (mapping.sourceKey === OPENING_CREDITS_MAPPING_KEY) {
    coding.taxCategory = "EXEMPT";
  }
  return coding;
}

/**
 * Turn the coded shares into the note's line items, merging any two whose
 * coding is identical. That merge is what makes an unset `goodwillWriteOffs` or
 * `openingCredits` a no-op: each share resolves to the hut-fee-refund mapping
 * and collapses back into the single line an upgrading club has always had.
 *
 * The tax category is part of the coding (#4988): an Exempt share is never
 * folded into an income line, even where the two name the same account, because
 * the merged line could carry only one of the two tax types.
 */
export function mintLineItems(
  codings: readonly MintLineCoding[],
  description: string,
  /** The note's tax treatment (#4632), resolved from its anchor by the caller. */
  taxRendering: XeroTaxRendering,
  /**
   * The Exempt line's tax field (#4988), from `resolveXeroCategoryLineTax` for
   * the same anchor. The sender resolves it only when a coding is Exempt, and
   * before any provider write.
   */
  exemptLineTax?: { taxType?: string },
): LineItem[] {
  const merged: MintLineCoding[] = [];
  for (const coding of codings) {
    const existing = merged.find(
      (candidate) =>
        candidate.accountCode === coding.accountCode &&
        candidate.itemCode === coding.itemCode &&
        candidate.taxCategory === coding.taxCategory,
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
      ...mintLineTax(coding, taxRendering, exemptLineTax),
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

/**
 * The tax field one minted line spreads in. An income line takes the note's
 * treatment, exactly as before #4988. An Exempt line takes the field its sender
 * resolved; one that was never resolved is refused here rather than sent under
 * the income code.
 */
function mintLineTax(
  coding: MintLineCoding,
  taxRendering: XeroTaxRendering,
  exemptLineTax: { taxType?: string } | undefined,
): { taxType?: string } {
  if (coding.taxCategory === undefined) return xeroLineTax(taxRendering);
  if (exemptLineTax === undefined) {
    throw new Error(
      "A minted line in the Exempt tax category was given no resolved tax; it is never sent under the income code.",
    );
  }
  return exemptLineTax;
}
