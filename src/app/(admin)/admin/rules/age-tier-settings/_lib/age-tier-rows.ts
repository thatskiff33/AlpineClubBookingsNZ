import type { AgeTier } from "@prisma/client";

/** The age-tier editor's row shape, built-in defaults and read normaliser. */
export type AgeTierRow = {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  subscriptionRequiredForBooking: boolean;
  familyGroupRequestCreateMemberAllowed: boolean;
  sortOrder: number;
};

export const DEFAULT_SETTINGS: AgeTierRow[] = [
  {
    tier: "INFANT",
    minAge: 0,
    maxAge: 4,
    label: "Infant (under 5)",
    subscriptionRequiredForBooking: false,
    familyGroupRequestCreateMemberAllowed: true,
    sortOrder: 0,
  },
  {
    tier: "CHILD",
    minAge: 5,
    maxAge: 9,
    label: "Child (5-9)",
    subscriptionRequiredForBooking: false,
    familyGroupRequestCreateMemberAllowed: true,
    sortOrder: 1,
  },
  {
    tier: "YOUTH",
    minAge: 10,
    maxAge: 17,
    label: "Youth (10-17)",
    subscriptionRequiredForBooking: true,
    familyGroupRequestCreateMemberAllowed: false,
    sortOrder: 2,
  },
  {
    tier: "ADULT",
    minAge: 18,
    maxAge: null,
    label: "Adult (18+)",
    subscriptionRequiredForBooking: true,
    familyGroupRequestCreateMemberAllowed: false,
    sortOrder: 3,
  },
];

export function normalizeAgeTierRows(rows: AgeTierRow[]): AgeTierRow[] {
  return rows.map((row) => ({
    ...row,
    subscriptionRequiredForBooking: row.subscriptionRequiredForBooking ?? true,
    familyGroupRequestCreateMemberAllowed:
      row.familyGroupRequestCreateMemberAllowed ?? false,
  }));
}
