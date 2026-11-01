import type { OtherLodgeDateField, OtherLodgeRateField } from "@/lib/other-lodges";

/**
 * The ONE map from an Other lodge's rate and date columns to the season and
 * age tier they hold (#77), read by the editor's labels and by the Fees-page
 * fill (`other-lodge-fees-sync.ts`), so the two cannot disagree. The age
 * groups are the club's age tiers by their built-in names (owner, 16 Oct
 * 2026): each club fills a group from its own tier, whatever ages and label it
 * has given that tier. The `Under5`, `5To11` and `12To17` column names predate
 * this and are kept, so the stored data and the central server's API stay as
 * they were. No `server-only`: the editor reads it.
 */

export type OtherLodgeSeason = "WINTER" | "SUMMER";
export type OtherLodgeRateTier = "INFANT" | "CHILD" | "YOUTH" | "ADULT";

export const OTHER_LODGE_SEASON_LABELS: Record<OtherLodgeSeason, "Winter" | "Summer"> = {
  WINTER: "Winter",
  SUMMER: "Summer",
};

export const OTHER_LODGE_TIER_LABELS = {
  INFANT: "Infant",
  CHILD: "Child",
  YOUTH: "Youth",
  ADULT: "Adult",
} as const satisfies Record<OtherLodgeRateTier, string>;

export const OTHER_LODGE_RATE_TIERS: Record<OtherLodgeRateField, { season: OtherLodgeSeason; tier: OtherLodgeRateTier }> = {
  winterRateUnder5Cents: { season: "WINTER", tier: "INFANT" },
  winterRate5To11Cents: { season: "WINTER", tier: "CHILD" },
  winterRate12To17Cents: { season: "WINTER", tier: "YOUTH" },
  winterRateAdultCents: { season: "WINTER", tier: "ADULT" },
  summerRateUnder5Cents: { season: "SUMMER", tier: "INFANT" },
  summerRate5To11Cents: { season: "SUMMER", tier: "CHILD" },
  summerRate12To17Cents: { season: "SUMMER", tier: "YOUTH" },
  summerRateAdultCents: { season: "SUMMER", tier: "ADULT" },
};

/** Each season's start and end columns (#75). */
export const OTHER_LODGE_SEASON_DATES: Record<OtherLodgeSeason, { start: OtherLodgeDateField; end: OtherLodgeDateField }> = {
  WINTER: { start: "winterSeasonStart", end: "winterSeasonEnd" },
  SUMMER: { start: "summerSeasonStart", end: "summerSeasonEnd" },
};

/** "Winter rate, Adult": a rate column in words (the editor's cell name, the audit record). */
export function otherLodgeRateLabel(field: OtherLodgeRateField): string {
  const { season, tier } = OTHER_LODGE_RATE_TIERS[field];
  return `${OTHER_LODGE_SEASON_LABELS[season]} rate, ${OTHER_LODGE_TIER_LABELS[tier]}`;
}

/** "Winter season end date": a date column in words. */
export function otherLodgeDateLabel(field: OtherLodgeDateField): string {
  const [season] = Object.entries(OTHER_LODGE_SEASON_DATES).find(([, c]) => c.start === field || c.end === field) ?? ["WINTER"];
  const end = OTHER_LODGE_SEASON_DATES[season as OtherLodgeSeason].end === field;
  return `${OTHER_LODGE_SEASON_LABELS[season as OtherLodgeSeason]} season ${end ? "end" : "start"} date`;
}
