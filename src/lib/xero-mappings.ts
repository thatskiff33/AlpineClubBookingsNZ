/**
 * Xero Reference Mappings
 *
 * Resolves Xero account codes and item codes from configured DB tables, with
 * legacy fallbacks. Also categorises entrance fees and produces stable
 * idempotency keys for entrance-fee invoices.
 */

import { EntranceFeeCategory, type AgeTier, type Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { buildXeroIdempotencyKey } from "@/lib/xero-sync";
import { getEffectiveJoiningFee } from "@/lib/authoritative-fees";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import {
  JOINING_FEE_EXEMPT_MESSAGE,
  resolveMemberJoiningFeeClassification,
} from "@/lib/joining-fee";

export interface EntranceFeeContext {
  category: EntranceFeeCategory;
  feeMapping: {
    itemCode: string | null;
    amountCents: number | null;
  };
  description?: string | null;
  /**
   * Organisations/schools (the NOT_APPLICABLE age tier) are exempt from
   * joining fees — owner decision, 2026-07-07 (#1440 follow-up). Both
   * invoice paths skip (never bill) when this is set, even when an explicit
   * amount override is supplied.
   */
  exempt?: boolean;
  /**
   * The resolved membership type x age tier the amount was keyed by (#1931,
   * E5). Carried for correlation-key derivation and diagnostics; absent on the
   * exempt/unresolved paths.
   */
  membershipTypeId?: string | null;
  ageTier?: AgeTier | null;
}

// Re-exported under the legacy name for importers not yet swept to the new
// symbol; the message copy now says "joining fees".
export const ENTRANCE_FEE_EXEMPT_MESSAGE = JOINING_FEE_EXEMPT_MESSAGE;

/** Default fallbacks if no DB record exists or code is null */
const ACCOUNT_MAPPING_DEFAULTS: Record<string, string | null> = {
  hutFeesIncome: "200",
  hutFeeRefunds: "200",
  stripeBankAccount: "606",
  stripeFees: null,
  subscriptionIncome: "203",
  membershipCancellationCredit: "203",
};

export type ResolvedAccountMapping = {
  code: string | null;
  itemCode: string | null;
  codeExplicitlyConfigured: boolean;
};

export async function getResolvedAccountMapping(
  key: string,
  store: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ResolvedAccountMapping> {
  try {
    const mapping = await store.xeroAccountMapping.findUnique({
      where: { key },
      select: { code: true, itemCode: true },
    });
    return {
      code: mapping?.code ?? ACCOUNT_MAPPING_DEFAULTS[key] ?? null,
      itemCode: mapping?.itemCode ?? null,
      codeExplicitlyConfigured: mapping?.code != null,
    };
  } catch {
    return {
      code: ACCOUNT_MAPPING_DEFAULTS[key] ?? null,
      itemCode: null,
      codeExplicitlyConfigured: false,
    };
  }
}

/**
 * Read a Xero account code from the DB, falling back to the hard-coded default.
 * Returns null for unconfigured optional mappings (e.g. stripeFees).
 */
export async function getAccountMapping(key: string): Promise<string | null> {
  const mapping = await getResolvedAccountMapping(key);
  return mapping.code;
}

/**
 * Get the Xero Item Code for a given mapping key.
 * Returns null if not configured.
 */
async function getItemCodeMapping(key: string): Promise<string | null> {
  const mapping = await getResolvedAccountMapping(key);
  return mapping.itemCode;
}

/**
 * The full set of Xero item codes that mark an invoice line as a membership
 * subscription when fee-schedule look-through is enabled (#2109). It is the
 * distinct non-null `MembershipAnnualFeeComponent.xeroItemCode` values (every
 * historical fee row contributes — prior seasons were billed under retired fee
 * rows) UNION the single configured `subscriptionIncome.itemCode`, sorted for a
 * stable preview. Closed-loop invariant: because billing stamps exactly those
 * component codes onto each invoice line, this detection set is a superset of
 * every code the billing pipeline can stamp.
 *
 * The single `subscriptionIncome.itemCode` is always folded in so the flat
 * "fallback item code" stays in the matching set even when no fee row carries
 * an item code. Safe-fallback error style mirrors `getResolvedAccountMapping`:
 * a read failure degrades to whatever the mapping lookup could still resolve
 * rather than throwing into the caller's Xero round-trip.
 */
export async function getSubscriptionItemCodes(
  store: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string[]> {
  const codes = new Set<string>();
  try {
    const rows = await store.membershipAnnualFeeComponent.findMany({
      where: { xeroItemCode: { not: null } },
      select: { xeroItemCode: true },
      distinct: ["xeroItemCode"],
    });
    for (const row of rows) {
      if (row.xeroItemCode) codes.add(row.xeroItemCode);
    }
  } catch {
    // Fee-schedule read failed: fall back to whatever the single mapping resolves
    // below so the flat item code still participates in matching.
  }
  const mapping = await getResolvedAccountMapping("subscriptionIncome", store);
  if (mapping.itemCode) codes.add(mapping.itemCode);
  return Array.from(codes).sort();
}

/**
 * The distinct non-null Xero item codes configured for NON-subscription fees —
 * hut-fee income, hut fees, joining fees, and promo codes (#2109). Used by the
 * settings preview
 * to warn when a fee-schedule subscription code also identifies one of these,
 * which would let an unpaid hut/promo invoice masquerade as a subscription in
 * the widened (union) detection set. Best-effort: a read failure yields an empty
 * set (no warning) rather than blocking the settings read.
 */
export async function getNonSubscriptionFeeItemCodes(
  store: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string[]> {
  const codes = new Set<string>();
  try {
    const [itemCodeRows, accountMappingRows, promoRows] = await Promise.all([
      store.xeroItemCodeMapping.findMany({
        where: { itemCode: { not: null } },
        select: { itemCode: true },
        distinct: ["itemCode"],
      }),
      store.xeroAccountMapping.findMany({
        where: {
          key: {
            in: [
              "hutFeeItem",
              "hutFeeRefundItem",
              "entranceFeeItem",
              "hutFeesIncome",
            ],
          },
          itemCode: { not: null },
        },
        select: { itemCode: true },
      }),
      store.promoCode.findMany({
        where: { xeroItemCode: { not: null } },
        select: { xeroItemCode: true },
        distinct: ["xeroItemCode"],
      }),
    ]);
    for (const row of itemCodeRows) if (row.itemCode) codes.add(row.itemCode);
    for (const row of accountMappingRows)
      if (row.itemCode) codes.add(row.itemCode);
    for (const row of promoRows)
      if (row.xeroItemCode) codes.add(row.xeroItemCode);
  } catch {
    // Best-effort overlap detection only; degrade to no warning on read failure.
  }
  return Array.from(codes).sort();
}

// Resolver for hut-fee Xero item codes keyed by membership type (#1930, E4).
// `byKey` is `${membershipTypeId}_${seasonType}_${ageTier|"FLAT"}` ->
// itemCode. A guest's code is resolved from its BookingGuest.rateMembershipType
// snapshot; a NULL snapshot (pre-refactor booking) falls back
// isMember -> FULL/NON_MEMBER, which — because the backfill fanned the old
// isMember=true code to FULL and isMember=false code to NON_MEMBER — yields the
// same code the legacy `${ageTier}_${seasonType}_${isMember}` key did.
export interface HutFeeItemCodeResolver {
  byKey: Map<string, string>;
  fullTypeId: string | null;
  nonMemberTypeId: string | null;
  legacyItemCode: string | null;
  // Count of membership-type-keyed rows found, for `.size > 0`-style guards
  // that decide whether to attach any per-guest item code at all.
  size: number;
}

function hutFeeItemCodeKey(
  membershipTypeId: string,
  seasonType: string,
  ageTier: string | null,
): string {
  return `${membershipTypeId}_${seasonType}_${ageTier ?? "FLAT"}`;
}

/**
 * Build the hut-fee item-code resolver keyed by membership type (#1930, E4).
 * Reads the membership-type-keyed HUT_FEE rows (membershipTypeId set); a truly
 * empty table falls back to the legacy flat `hutFeeItem`.
 */
export async function getHutFeeItemCodeMap(): Promise<HutFeeItemCodeResolver> {
  const byKey = new Map<string, string>();

  const [rows, builtInTypes, legacyItemCode] = await Promise.all([
    // Blue/green runtime-prep (#2130): name ONLY the columns this mapper reads.
    // This stopped the deployed client SELECTing XeroItemCodeMapping.isMember one
    // release BEFORE the #2130 STEP 2 contract migration dropped that legacy key
    // column; keep the select narrow regardless. The loop below
    // consumes exactly these four fields, so return values are unchanged.
    prisma.xeroItemCodeMapping.findMany({
      where: { category: "HUT_FEE" },
      select: {
        membershipTypeId: true,
        seasonType: true,
        ageTier: true,
        itemCode: true,
      },
    }),
    prisma.membershipType.findMany({
      where: { key: { in: ["FULL", "NON_MEMBER"] } },
      select: { id: true, key: true },
    }),
    getItemCodeMapping("hutFeeItem"),
  ]);

  for (const row of rows) {
    if (row.membershipTypeId && row.seasonType && row.itemCode) {
      byKey.set(
        hutFeeItemCodeKey(row.membershipTypeId, row.seasonType, row.ageTier),
        row.itemCode,
      );
    }
  }

  const typeIdByKey = new Map(builtInTypes.map((t) => [t.key, t.id]));
  return {
    byKey,
    fullTypeId: typeIdByKey.get("FULL") ?? null,
    nonMemberTypeId: typeIdByKey.get("NON_MEMBER") ?? null,
    legacyItemCode: legacyItemCode ?? null,
    size: byKey.size,
  };
}

/**
 * Whether the hut-fee resolver is configured at all: it carries membership-type
 * keyed rows OR the legacy flat `hutFeeItem` code. Mirrors main's
 * `hutFeeItemCodeMap.size > 0` guard (the legacy map was pre-filled from
 * `hutFeeItem` when the keyed table was empty), so callers fall back to the
 * single `hutFeesIncome` item code exactly when main did (#1930, E4).
 */
export function isHutFeeResolverConfigured(
  resolver: HutFeeItemCodeResolver,
): boolean {
  return resolver.byKey.size > 0 || resolver.legacyItemCode != null;
}

/**
 * Resolve one guest's hut-fee Xero item code (#1930, E4). Prefers the guest's
 * rateMembershipType snapshot; a NULL snapshot falls back isMember ->
 * FULL/NON_MEMBER. Within a type, prefers the exact age-tier row then the flat
 * (FLAT) row.
 *
 * Fallback semantics are byte-identical to main's boolean-keyed map:
 *   - keyed rows exist, lookup misses -> null (the line stays account-coded;
 *     the legacy `hutFeeItem` is NOT consulted once keyed rows exist),
 *   - keyed table EMPTY (genuine legacy-only install) -> the flat `hutFeeItem`
 *     (main pre-filled every key with it),
 *   - no seasonType -> null; the caller falls back to the single
 *     `hutFeesIncome` item code (never `hutFeeItem`), matching main's
 *     `(map && seasonType) ? ... : itemCode` precedence.
 */
export function resolveHutFeeItemCode(
  resolver: HutFeeItemCodeResolver,
  guest: {
    ageTier: string;
    isMember: boolean;
    rateMembershipTypeId?: string | null;
  },
  seasonType: string | null | undefined,
): string | null {
  if (!seasonType) return null;
  if (resolver.byKey.size === 0) return resolver.legacyItemCode;
  const typeId =
    guest.rateMembershipTypeId ??
    (guest.isMember ? resolver.fullTypeId : resolver.nonMemberTypeId);
  if (!typeId) return null;
  return (
    resolver.byKey.get(hutFeeItemCodeKey(typeId, seasonType, guest.ageTier)) ??
    resolver.byKey.get(hutFeeItemCodeKey(typeId, seasonType, null)) ??
    null
  );
}

/**
 * The member / non-member words on a guest's hut-fee invoice line (#2543).
 *
 * DRIVEN OFF THE RATE SNAPSHOT, not off `BookingGuest.isMember`, so the line's
 * NARRATION agrees with the item code the line is coded to — `resolveHutFeeItemCode`
 * above keys on exactly the same field, which is why the two live side by side.
 *
 * The case that forced this: under `NON_MEMBER_PRICING` a member with an unpaid
 * season subscription is priced at the built-in NON_MEMBER rate and coded to the
 * NON_MEMBER hut-fee item, while `isMember` stays true (it is load-bearing
 * elsewhere, so #2543 deliberately does not move it). The line therefore read
 * "(ADULT, Member)" at the non-member amount inside the non-member item — a
 * treasurer reconciling member against non-member hut-fee income sees a Member
 * line sitting in the non-member account, and the member receiving the invoice
 * sees the same contradiction. Owner decision, 2 Aug 2026: Xero narrates "a normal
 * non-member line (honest)".
 *
 * KNOWN AND ACCEPTED CONSEQUENCE, stated rather than discovered later: this also
 * flips the pre-existing `TYPE_POLICY_FORCED` class — a member whose membership
 * TYPE forces the non-member rate — from ", Member" to ", Non-member". There is no
 * persisted marker distinguishing the two reasons for pricing on NON_MEMBER rows,
 * so per-class narration is not implementable from a stored row; and the new
 * wording is the honest one for that class too, since its line has always been
 * coded to the non-member item at the non-member amount. It is narration only: no
 * amount, item code, account code or idempotency key changes.
 *
 * FALLS BACK TO `isMember` when the guest has no snapshot (a pre-#1930 booking) or
 * the club has no built-in NON_MEMBER type resolved, which keeps every legacy line
 * byte-identical.
 */
export function describeGuestRateMembershipLabel(
  resolver: HutFeeItemCodeResolver | null | undefined,
  guest: { isMember: boolean; rateMembershipTypeId?: string | null },
): "Member" | "Non-member" {
  if (guest.rateMembershipTypeId && resolver?.nonMemberTypeId) {
    return guest.rateMembershipTypeId === resolver.nonMemberTypeId
      ? "Non-member"
      : "Member";
  }
  return guest.isMember ? "Member" : "Non-member";
}

/**
 * Get the Xero item code for a joining-fee category. The item code still keys
 * on the (retained) entranceFeeCategory column — the migration re-keyed those
 * rows to category "JOINING_FEE" and carried the item codes forward
 * byte-identically. Amounts no longer come from here; they resolve from the
 * JoiningFee schedule (see getJoiningFeeContext).
 */
async function getJoiningFeeItemCode(
  category: EntranceFeeCategory
): Promise<string | null> {
  const row = await prisma.xeroItemCodeMapping.findFirst({
    where: { category: "JOINING_FEE", entranceFeeCategory: category },
    select: { itemCode: true },
  });
  if (row?.itemCode) return row.itemCode;
  return getItemCodeMapping("entranceFeeItem");
}

/**
 * Resolve the joining-fee context for a member (#1931, E5): the display
 * category (Adult | Family | Youth | Child, type-driven for Family), the
 * authoritative amount from the JoiningFee schedule keyed by the member's
 * membership type x age tier, and the Xero item code. Organisations/schools
 * (N/A age tier) are exempt before any type/amount lookup. A type with no fee
 * rows resolves a null amount, which both invoice paths turn into a graceful
 * "no joining fee configured" skip. Accepts an optional transaction client
 * (#1886) so approval resolves fees for rows created inside the open tx.
 */
export async function getEntranceFeeContext(
  memberId: string,
  store: Prisma.TransactionClient | typeof prisma = prisma,
  /**
   * Threaded straight through to `resolveMemberJoiningFeeClassification`, which
   * REQUIRES it whenever `store` is a transaction client — see its docblock for
   * why (#2870): a zone read there sits on the global client under the approval
   * path's advisory locks, and the season selects an immutable invoice's amount.
   */
  seasonYear?: number,
  /**
   * The day the JoiningFee schedule's effective window is evaluated on.
   *
   * REQUIRED WHENEVER `store` IS NOT THE GLOBAL CLIENT, on exactly the same
   * concurrency rule as `seasonYear` above and enforced the same way (#3123).
   * Omitted with the global client — a read-only or post-commit path — the
   * club's persisted zone is read here, which is correct and costs nothing
   * under no contention. Before #3123 this was not a parameter at all and
   * `getEffectiveJoiningFee` defaulted it from the ENVIRONMENT's zone, so a
   * club configured behind its container's zone billed a joining fee from a
   * schedule row that had not taken effect yet.
   */
  asOf?: Date
): Promise<EntranceFeeContext> {
  if (store !== prisma && asOf === undefined) {
    throw new Error(
      "getEntranceFeeContext needs an explicit asOf when it is given a " +
        "transaction client: resolving the club's timezone here would read " +
        "ClubTimeSettings on the global client while that transaction holds the " +
        "application and member-lifecycle advisory locks, and the day it produces " +
        "selects the JoiningFee schedule row whose amount lands on an immutable " +
        "invoice.",
    );
  }
  const classification = await resolveMemberJoiningFeeClassification(
    memberId,
    store,
    seasonYear
  );

  if (classification.exempt) {
    // Exempt: no fee mapping is looked up and callers must not bill, even
    // with an explicit amount override.
    return {
      category: "ADULT",
      feeMapping: { itemCode: null, amountCents: null },
      exempt: true,
    };
  }

  const category = classification.category;
  const amountCents = classification.membershipTypeId
    ? (
        await getEffectiveJoiningFee(
          { membershipTypeId: classification.membershipTypeId, ageTier: classification.ageTier },
          asOf ??
            dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest())),
          store,
        )
      ).amountCents
    : null;
  const itemCode = await getJoiningFeeItemCode(category);

  return {
    category,
    feeMapping: { itemCode, amountCents },
    membershipTypeId: classification.membershipTypeId,
    ageTier: classification.ageTier,
  };
}

// Outbox correlation/dedupe key (#1931, E5): moves to v2 for the re-keyed
// joining-fee model. Keyed by member + derived category + amount — within a
// member the category+amount uniquely identifies the charge, and cross-member
// collisions are impossible (memberId is in the key). Kept DISTINCT from the
// member-scoped mint key below, which is the true anti-double-mint guard and
// stays at v1 so it keeps matching pre-rename mints.
export function buildEntranceFeeInvoiceIdempotencyKey(
  memberId: string,
  category: EntranceFeeCategory,
  amountCents: number
) {
  return buildXeroIdempotencyKey(
    "member",
    memberId,
    "joining-fee-invoice",
    category,
    amountCents,
    "v2"
  );
}

// F21 (#1886): the Xero `createInvoices` idempotency key for the entrance-fee
// mint is member-scoped ONLY — it deliberately omits amount and category so
// that two operations racing for the same member (e.g. a re-enqueue carrying a
// different amount override or a reclassified category, which produce distinct
// correlation keys and therefore both slip past the enqueue-time dedupe)
// converge on ONE Xero invoice instead of minting two. This mirrors the
// member-scoped contact idempotency key in `findOrCreateXeroContact` (F7,
// #1355), which is the codebase's established way to serialise concurrent
// provider creates WITHOUT holding a DB lock across a Xero call. An entrance
// fee is a one-time per-member charge, so a member-only key matches the
// domain. Kept distinct from the amount-scoped correlation key above, which
// still governs outbox-operation dedupe semantics.
export function buildEntranceFeeInvoiceMintIdempotencyKey(memberId: string) {
  return buildXeroIdempotencyKey(
    "member",
    memberId,
    "entrance-fee-invoice",
    "mint",
    "v1"
  );
}
