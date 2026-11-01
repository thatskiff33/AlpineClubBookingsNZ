import "server-only";
import type { AgeTier } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { resolveLocalLodgeForCentralId } from "@/lib/central-lodge-link";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { formatDateOnly } from "@/lib/date-only";
import logger from "@/lib/logger";
import { NON_MEMBER_RATE_HOLDER_KEY } from "@/lib/membership-type-rate-coverage";
import {
  OTHER_LODGE_RATE_TIERS,
  OTHER_LODGE_SEASON_DATES,
  otherLodgeDateLabel,
  otherLodgeRateLabel,
  type OtherLodgeSeason,
} from "@/lib/other-lodge-rate-tiers";
import { seasonDatesProblem } from "@/lib/other-lodge-seasons";
import {
  OTHER_LODGE_BOUNDS,
  OTHER_LODGE_DATE_FIELDS,
  OTHER_LODGE_RATE_FIELDS,
  type OtherLodgeDateField,
  type OtherLodgeRateField,
  type OwnedOtherLodges,
} from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";
import { loadServerNzSettings } from "@/lib/servernz-settings";
import { formatCentsPlain } from "@/lib/utils";

/**
 * This club's own Other lodge, filled from its Fees page (#77, owner decisions
 * 16 Oct 2026). The **Non-Member** membership type's nightly rates on
 * **Admin → Fees** become the lodge's eight non-member rates, and the seasons
 * those rates belong to become its season start and end dates, so what other
 * clubs see on the Alpine Central Server follows the Fees page by itself.
 *
 *  - WHICH SEASON: for winter and for summer, the lodge's active season of that
 *    type that contains today, else the next one to start, else the one that
 *    ended last (so a finished winter keeps showing until next winter is
 *    entered; the dates repeat yearly anyway).
 *  - WHICH RATE: each age group is the club's age tier of the same built-in
 *    name (`OTHER_LODGE_RATE_TIERS`), so it takes the Non-Member rate for that
 *    tier, else the type's flat rate (a type without age groups), the same
 *    fallback booking prices use (`matchSeasonRate`).
 *  - WHICH ROWS: only this club's own lodges, through the Central lodge link
 *    (#62), and only those whose "from the Fees page" switch is on. A lodge
 *    the Fees page gives no Non-Member rate at all is left as it is, rather
 *    than cleared (`no-rates`).
 *  - WHEN: after a season is added, changed or removed (Fees and Seasons
 *    pages), on every save of the lodge while the switch is on, and at the
 *    start of every Other lodges upload (a season ending, or a configuration
 *    import, is picked up there). A row is written only when something
 *    changed, which moves its `updatedAt` so the next upload carries it, and
 *    each write is audited with the values before and after.
 */

export interface FeesSeason {
  type: OtherLodgeSeason;
  startDate: Date;
  endDate: Date;
  rates: ReadonlyArray<{ membershipTypeId: string; ageTier: AgeTier | null; pricePerNightCents: number }>;
}

export type FeesDerivedData = Record<OtherLodgeRateField, number | null> & Record<OtherLodgeDateField, Date | null>;

/** Why a lodge whose switch is on was not filled. */
export type FeesFillProblem = "no-local-lodge" | "no-non-member-type" | "no-rates" | "rate-too-high" | "failed";

export const FEES_FILL_PROBLEM_TEXT: Record<FeesFillProblem, string> = {
  "no-local-lodge":
    "Not filled: this lodge is not linked to one of this site's lodges yet, so there is no Fees page to fill it from. Set its Central lodge link on the lodge's settings, or turn this off.",
  "no-non-member-type": "Not filled: this site has no Non-Member membership type, so the Fees page has no non-member rates.",
  "no-rates":
    "Not filled: the Fees page has no Non-Member rates for this lodge's seasons yet, so the rates and dates below are the last ones saved.",
  "rate-too-high": `Not filled: a Non-Member rate on the Fees page is over $${formatCentsPlain(OTHER_LODGE_BOUNDS.rateCentsMax)}, more than the central server takes.`,
  failed: "Not filled: the last attempt failed. It is tried again on the next save and before the next upload.",
};

const SEASONS: readonly OtherLodgeSeason[] = ["WINTER", "SUMMER"];

/** The season of a type that contains `today`, else the next to start, else the last to end, else null. */
function seasonFor(seasons: ReadonlyArray<FeesSeason>, type: OtherLodgeSeason, today: Date): FeesSeason | null {
  const ofType = seasons.filter((s) => s.type === type);
  const current = ofType.find((s) => s.startDate <= today && today <= s.endDate);
  if (current) return current;
  const next = ofType
    .filter((s) => s.startDate > today)
    .sort((a, b) => a.startDate.getTime() - b.startDate.getTime())[0];
  if (next) return next;
  return [...ofType].sort((a, b) => b.endDate.getTime() - a.endDate.getTime())[0] ?? null;
}

/** The tier's rate, else the type's flat rate, else null. */
function rateFor(season: FeesSeason, membershipTypeId: string, tier: AgeTier): number | null {
  let flat: number | null = null;
  for (const rate of season.rates) {
    if (rate.membershipTypeId !== membershipTypeId) continue;
    if (rate.ageTier === tier) return rate.pricePerNightCents;
    if (rate.ageTier === null) flat = rate.pricePerNightCents;
  }
  return flat;
}

function datesAsText(data: FeesDerivedData) {
  return Object.fromEntries(OTHER_LODGE_DATE_FIELDS.map((f) => [f, data[f] ? formatDateOnly(data[f]) : null]));
}

/**
 * The rates and season dates a lodge's Fees page gives (pure). `seasons` are
 * the lodge's ACTIVE seasons; `today` is the club's calendar day as a
 * date-only instant.
 */
export function feesDerivedOtherLodgeData(
  seasons: ReadonlyArray<FeesSeason>,
  nonMemberTypeId: string,
  today: Date,
): FeesDerivedData {
  const chosen = { WINTER: seasonFor(seasons, "WINTER", today), SUMMER: seasonFor(seasons, "SUMMER", today) };
  const data = {} as FeesDerivedData;
  for (const field of OTHER_LODGE_RATE_FIELDS) {
    const { season, tier } = OTHER_LODGE_RATE_TIERS[field];
    const s = chosen[season];
    data[field] = s ? rateFor(s, nonMemberTypeId, tier) : null;
  }
  for (const type of SEASONS) {
    data[OTHER_LODGE_SEASON_DATES[type].start] = chosen[type]?.startDate ?? null;
    data[OTHER_LODGE_SEASON_DATES[type].end] = chosen[type]?.endDate ?? null;
  }
  // Two chosen seasons that would share a day as yearly dates (a summer not
  // entered yet, so next year's is chosen, overlapping this winter, say)
  // cannot both be shared. The one starting later gives up its dates first;
  // if that is not enough, neither is shared. The rates still are.
  if (seasonDatesProblem(datesAsText(data))) {
    const later = SEASONS.filter((t) => chosen[t]).sort(
      (a, b) => chosen[b]!.startDate.getTime() - chosen[a]!.startDate.getTime(),
    )[0];
    for (const type of later ? [later] : SEASONS) {
      data[OTHER_LODGE_SEASON_DATES[type].start] = null;
      data[OTHER_LODGE_SEASON_DATES[type].end] = null;
    }
    if (seasonDatesProblem(datesAsText(data))) {
      for (const field of OTHER_LODGE_DATE_FIELDS) data[field] = null;
    }
  }
  return data;
}

const FIELDS = [...OTHER_LODGE_RATE_FIELDS, ...OTHER_LODGE_DATE_FIELDS];
type FieldValue = number | Date | null;

function same(a: FieldValue, b: FieldValue): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  return a === b;
}

function shown(value: FieldValue): string {
  if (value === null) return "blank";
  return value instanceof Date ? formatDateOnly(value) : `$${formatCentsPlain(value)}`;
}

function fieldLabel(field: (typeof FIELDS)[number]): string {
  return (OTHER_LODGE_RATE_FIELDS as readonly string[]).includes(field)
    ? otherLodgeRateLabel(field as OtherLodgeRateField)
    : otherLodgeDateLabel(field as OtherLodgeDateField);
}

type FillPlan = { problem: FeesFillProblem } | { problem: null; data: FeesDerivedData };

/** What the Fees page gives one owned central lodge, or why it gives nothing. */
async function planFill(centralId: string, owned: OwnedOtherLodges, nonMemberTypeId: string | null, today: Date): Promise<FillPlan> {
  if (!nonMemberTypeId) return { problem: "no-non-member-type" };
  const lodgeId = await resolveLocalLodgeForCentralId(centralId, owned);
  if (!lodgeId) return { problem: "no-local-lodge" };
  const seasons = await prisma.season.findMany({
    where: { lodgeId, active: true },
    select: { type: true, startDate: true, endDate: true, membershipTypeRates: true },
  });
  const data = feesDerivedOtherLodgeData(
    seasons.map((s) => ({ ...s, rates: s.membershipTypeRates })),
    nonMemberTypeId,
    today,
  );
  const rates = OTHER_LODGE_RATE_FIELDS.map((f) => data[f]);
  if (rates.every((r) => r === null)) return { problem: "no-rates" };
  if (rates.some((r) => r !== null && r > OTHER_LODGE_BOUNDS.rateCentsMax)) return { problem: "rate-too-high" };
  return { problem: null, data };
}

async function nonMemberTypeId(): Promise<string | null> {
  const type = await prisma.membershipType.findUnique({ where: { key: NON_MEMBER_RATE_HOLDER_KEY }, select: { id: true } });
  return type?.id ?? null;
}

export interface FeesFillResult {
  otherLodgeId: string;
  name: string;
  /** null: filled, or already matched. */
  problem: FeesFillProblem | null;
  changed: boolean;
}

/**
 * Fill each of this club's own Other lodges whose switch is on from its Fees
 * page, one lodge at a time (one failing does not stop the next). Never throws
 * to its caller: a failure is logged, reported as `failed`, and the next run
 * tries again. `actorMemberId` is the administrator whose save triggered it.
 */
export async function syncOwnOtherLodgesFromFees(trigger: string, actorMemberId?: string): Promise<FeesFillResult[]> {
  const results: FeesFillResult[] = [];
  try {
    const owned = (await loadServerNzSettings()).otherLodgesOwnedLodges;
    if (!owned || owned.length === 0) return [];
    const typeId = await nonMemberTypeId();
    const today = await clubTodayDateOnlyInstant();
    for (const central of owned) {
      const row = await prisma.otherLodge.findUnique({
        where: { centralId: central.id },
        select: { id: true, name: true, hiddenAt: true, ratesFromFees: true, updatedAt: true, ...Object.fromEntries(FIELDS.map((f) => [f, true])) },
      });
      if (!row || row.hiddenAt || !row.ratesFromFees) continue;
      try {
        const plan = await planFill(central.id, owned, typeId, today);
        if (plan.problem) {
          results.push({ otherLodgeId: row.id, name: row.name, problem: plan.problem, changed: false });
          continue;
        }
        const stored = row as unknown as Record<string, FieldValue>;
        const fields = FIELDS.filter((f) => !same(stored[f] ?? null, plan.data[f]));
        if (fields.length === 0) {
          results.push({ otherLodgeId: row.id, name: row.name, problem: null, changed: false });
          continue;
        }
        // Guarded on the row as read: an administrator turning the switch off
        // (or any other save) in the meantime wins, and this run leaves it.
        // `updatedAt` moves (Prisma's @updatedAt), so the next upload sends it.
        const { count } = await prisma.otherLodge.updateMany({
          where: { id: row.id, updatedAt: row.updatedAt, ratesFromFees: true, hiddenAt: null },
          data: Object.fromEntries(fields.map((f) => [f, plan.data[f]])),
        });
        if (count === 0) continue;
        await createAuditLog({
          action: "OTHER_LODGE_RATES_FROM_FEES",
          category: "lodge",
          severity: "info",
          outcome: "success",
          memberId: actorMemberId ?? null,
          entityType: "OtherLodge",
          entityId: row.id,
          summary: `Non-member rates and season dates updated from the Fees page: ${row.name}`,
          details: `${fields.map((f) => `${fieldLabel(f)}: ${shown(stored[f] ?? null)} to ${shown(plan.data[f])}`).join("; ")} (${trigger})`,
        });
        results.push({ otherLodgeId: row.id, name: row.name, problem: null, changed: true });
      } catch (error) {
        logger.warn({ err: error, trigger, otherLodgeId: row.id }, "Could not update this club's Other lodge from the Fees page");
        results.push({ otherLodgeId: row.id, name: row.name, problem: "failed", changed: false });
      }
    }
  } catch (error) {
    logger.warn({ err: error, trigger }, "Could not update this club's Other lodges from the Fees page");
  }
  return results;
}

/**
 * Why the Fees page cannot fill this owned lodge now, in words for its editor,
 * or null when it can (or the switch is off). Read-only: the admin list shows
 * it beside the switch.
 */
export async function otherLodgeFeesProblem(
  lodge: { centralId: string | null; ratesFromFees: boolean },
  owned: OwnedOtherLodges,
): Promise<string | null> {
  if (!lodge.ratesFromFees || !lodge.centralId || !owned) return null;
  try {
    const plan = await planFill(lodge.centralId, owned, await nonMemberTypeId(), await clubTodayDateOnlyInstant());
    return plan.problem ? FEES_FILL_PROBLEM_TEXT[plan.problem] : null;
  } catch {
    return FEES_FILL_PROBLEM_TEXT.failed;
  }
}
