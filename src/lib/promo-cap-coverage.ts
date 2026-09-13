import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type { PromoCapCoverage } from "@/lib/promo";

type CoverageClient = typeof prisma | Prisma.TransactionClient;

/**
 * What a member is told when a booking edit runs a promotion past its usage cap
 * (#2390). Everyone already benefiting keeps the discount; the people the code
 * no longer reaches are priced normally — and they are named, at the moment of
 * the edit, rather than discovered later on an invoice.
 */
export interface PromoCoverageNotice {
  promoCode: string;
  coveredNames: string[];
  /**
   * The covered people who already had the discount before this edit — the only
   * ones the sentence may describe that way. `coveredNames` minus these are
   * people this edit newly brought under the code.
   */
  retainedNames: string[];
  excludedNames: string[];
  message: string;
}

/**
 * "Ann", "Ann and Bob", "Ann, Bob and Cal" — the way a person would say it.
 */
export function joinNames(names: string[]): string {
  if (names.length === 0) return "";
  const [firstName] = names;
  if (names.length === 1 && firstName) return firstName;
  const lastName = names[names.length - 1];
  if (!lastName) return "";
  return `${names.slice(0, -1).join(", ")} and ${lastName}`;
}

/**
 * The one sentence every surface uses.
 *
 * Written once, deliberately, because the edit preview, the saved edit's
 * response, the booking-modified email and the booking's own history timeline
 * all show it — and a partial promotion is exactly the case where four
 * separately-worded messages drift into telling four different stories.
 *
 * It says the three things the owner decision asks for: who is covered, who is
 * not, and that the price on screen already reflects it.
 */
export function promoCapCoverageMessage(input: {
  promoCode: string;
  /** Covered, and already had the discount before this edit. */
  keptNames: string[];
  /** Covered, but brought under the code by this edit. */
  addedNames: string[];
  excludedNames: string[];
}): string {
  const { promoCode, keptNames, addedNames, excludedNames } = input;
  const kept = joinNames(keptNames);
  const added = joinNames(addedNames);
  const excluded = joinNames(excludedNames);
  const isAre = excludedNames.length === 1 ? "is" : "are";

  // The two groups are named apart because "who already had it" is a claim
  // about the past: saying it of somebody this very edit added is simply false,
  // and a member who spots that stops trusting the rest of the sentence.
  const coverageClauses: string[] = [];
  if (kept) coverageClauses.push(`it stays with ${kept}, who already had it`);
  if (added) coverageClauses.push(`${kept ? "it also covers" : "it covers"} ${added}`);
  if (coverageClauses.length === 0) {
    coverageClauses.push("it stays with everyone who already had it");
  }

  return (
    `Promo code ${promoCode} has reached its limit, so ${coverageClauses.join(", and ")}, ` +
    `and does not extend to ${excluded} — ${excluded} ${isAre} priced at the ` +
    `normal rate. The total shown already includes this.`
  );
}

/**
 * Turn the member ids a reprice left out into the sentence above.
 *
 * Names come from the `Member` rows, because a promotion's beneficiaries are
 * members: an unassigned code benefits the booker, and an assigned code
 * benefits its linked member guests. Reading them here rather than threading
 * names through five call sites is what keeps every surface on identical
 * wording.
 *
 * Returns `null` when nobody was left out, so callers can treat "is there
 * anything to say?" as a single check. A member whose row cannot be read is
 * skipped rather than named as "undefined"; if that empties the excluded list
 * the notice is dropped, since a message that names nobody is worse than none.
 */
export async function describePromoCapCoverage(
  db: CoverageClient,
  input: { promoCode: string; capCoverage: PromoCapCoverage | undefined }
): Promise<PromoCoverageNotice | null> {
  const { promoCode, capCoverage } = input;
  if (!capCoverage || capCoverage.excludedMemberIds.length === 0) return null;

  const memberIds = [
    ...new Set([...capCoverage.coveredMemberIds, ...capCoverage.excludedMemberIds]),
  ];
  const members = await db.member.findMany({
    where: { id: { in: memberIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  const nameById = new Map(
    members.map((member) => [
      member.id,
      `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim(),
    ])
  );
  const namesFor = (ids: string[]) =>
    ids.map((id) => nameById.get(id) ?? "").filter((name) => name.length > 0);

  const retained = new Set(capCoverage.retainedMemberIds);
  const coveredNames = namesFor(capCoverage.coveredMemberIds);
  const retainedNames = namesFor(
    capCoverage.coveredMemberIds.filter((id) => retained.has(id))
  );
  const addedNames = namesFor(
    capCoverage.coveredMemberIds.filter((id) => !retained.has(id))
  );
  const excludedNames = namesFor(capCoverage.excludedMemberIds);
  if (excludedNames.length === 0) return null;

  return {
    promoCode,
    coveredNames,
    retainedNames,
    excludedNames,
    message: promoCapCoverageMessage({
      promoCode,
      keptNames: retainedNames,
      addedNames,
      excludedNames,
    }),
  };
}
