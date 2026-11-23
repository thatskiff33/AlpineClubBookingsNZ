import type {
  AgeTier,
  MembershipTypeSubscriptionBehavior,
  Prisma,
  SubscriptionStatus,
} from "@prisma/client";

import type { AgeTierSettingData } from "@/lib/policies/age-tier";
import {
  ADMIN_LIST_LIABILITY_SIDE,
  liabilityRuleFor,
  resolveMemberSubscriptionLiability,
  type SubscriptionLiabilitySettings,
} from "@/lib/policies/subscription";
import {
  isInSubscriptionBillingPopulation,
  SUBSCRIPTION_BILLING_POPULATION_WHERE,
} from "@/lib/subscription-billing-population";

/**
 * A season row nothing has billed, paid, covered or marked: the creation seed's
 * or the annual-fee sweep's `NOT_REQUIRED` default. Only such a row may be
 * rewritten when its member turns out to owe a subscription — a paid, invoiced,
 * actively charge/family-covered (`releasedAt` null, the #2147 "already billed"
 * rule; this includes a `NO_INVOICE` fee's claim) or manually-marked row is real
 * billing state. Asserted in each writer's `WHERE`, so a concurrent writer that
 * moves the row after a read still cannot be clobbered.
 * {@link isUntouchedNotRequiredRow} is the same test over a row already read
 * with {@link SEASON_ROW_STATE_SELECT}.
 */
export const UNTOUCHED_NOT_REQUIRED_ROW = {
  status: "NOT_REQUIRED",
  xeroInvoiceId: null,
  manuallyMarkedPaidAt: null,
  // #2179: re-asserted relationally — a NO_INVOICE billing confirm creates an
  // ACTIVE coverage claim while leaving the row NOT_REQUIRED, so the scalar
  // guards alone cannot exclude a claim that landed after a read.
  chargeCoverage: { none: { releasedAt: null } },
} as const satisfies Prisma.MemberSubscriptionWhereInput;

/**
 * The season-row columns {@link isUntouchedNotRequiredRow} reads. Only an
 * ACTIVE claim (`releasedAt` null) counts: a released claim's invoice was
 * voided, which makes the member billable again.
 */
export const SEASON_ROW_STATE_SELECT = {
  status: true,
  xeroInvoiceId: true,
  manuallyMarkedPaidAt: true,
  chargeCoverage: {
    where: { releasedAt: UNTOUCHED_NOT_REQUIRED_ROW.chargeCoverage.none.releasedAt },
    take: 1,
    select: { id: true },
  },
} as const satisfies Prisma.MemberSubscriptionSelect;

/** A season row read with {@link SEASON_ROW_STATE_SELECT}. */
export interface SeasonRowState {
  status: SubscriptionStatus;
  xeroInvoiceId: string | null;
  manuallyMarkedPaidAt: Date | null;
  chargeCoverage: ReadonlyArray<unknown>;
}

/** {@link UNTOUCHED_NOT_REQUIRED_ROW} over a row already read. */
export function isUntouchedNotRequiredRow(
  row: SeasonRowState | null | undefined,
): boolean {
  return (
    !!row &&
    row.status === UNTOUCHED_NOT_REQUIRED_ROW.status &&
    row.xeroInvoiceId === UNTOUCHED_NOT_REQUIRED_ROW.xeroInvoiceId &&
    row.manuallyMarkedPaidAt === UNTOUCHED_NOT_REQUIRED_ROW.manuallyMarkedPaidAt &&
    // A row read without the claim select fails safe: treated as touched.
    Array.isArray(row.chargeCoverage) &&
    row.chargeCoverage.length === 0
  );
}

/**
 * The row note the admin members list, its CSV export and the subscriptions
 * list show (#5190, owner decision 22 Nov 2026,
 * https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/5190#issuecomment-7070827526).
 * The owner's suggested "the billing run will invoice this member" is not used
 * (#5190 review): billing can treat a member as owing and still send no
 * invoice (a no-invoice fee, a family billed through another member, a type
 * with no fee row), so the note says only what the shared rule decides.
 */
export const NOT_REQUIRED_ROW_BILLING_NOTE =
  "Marked not required, but billing treats this member as owing";

/**
 * Whether a list row gets {@link NOT_REQUIRED_ROW_BILLING_NOTE}: the member is
 * in the billing population (active, not archived:
 * `isInSubscriptionBillingPopulation`), has a saved `NOT_REQUIRED` season row
 * that nothing has billed, paid, covered or marked, and the shared liability
 * rule on the lists' side (`ADMIN_LIST_LIABILITY_SIDE`, billing) says they owe.
 * The list shows the row's "Not required"; billing ignores the row.
 *
 * Choosing a rule removes the note for the current season only: under the
 * chosen rule the member either stops owing, or the liability clear-up
 * (`clearStaleNotRequiredRows`, the same row test and billing-side rule, run
 * for the current season) flips their row to `NOT_INVOICED`. A row of another
 * season keeps the note, because billing still treats that member as owing.
 * A covered, invoiced, paid or marked row never gets the note.
 */
export function hasNotRequiredRowBillingNote(input: {
  subscriptionBehavior: MembershipTypeSubscriptionBehavior | null | undefined;
  member: {
    dateOfBirth: Date | null;
    ageTier: AgeTier;
    active: boolean;
    archivedAt: Date | string | null;
  };
  seasonRow: SeasonRowState | null | undefined;
  seasonYear: number;
  ageTierSettings: AgeTierSettingData[];
  liabilitySettings: SubscriptionLiabilitySettings;
}): boolean {
  if (!isInSubscriptionBillingPopulation(input.member)) return false;
  if (!isUntouchedNotRequiredRow(input.seasonRow)) return false;
  return resolveMemberSubscriptionLiability({
    subscriptionBehavior: input.subscriptionBehavior,
    member: input.member,
    seasonRowStatus: input.seasonRow?.status,
    seasonYear: input.seasonYear,
    rule: liabilityRuleFor(ADMIN_LIST_LIABILITY_SIDE, input.liabilitySettings),
    ageTierSettings: input.ageTierSettings,
  }).owes;
}

/** {@link hasNotRequiredRowBillingNote} as the note text, or null. */
export function notRequiredRowBillingNote(
  input: Parameters<typeof hasNotRequiredRowBillingNote>[0],
): string | null {
  return hasNotRequiredRowBillingNote(input) ? NOT_REQUIRED_ROW_BILLING_NOTE : null;
}

/**
 * The status a noted row shows (#5190 review, owner decision 22 Nov 2026: the
 * lists follow billing, so a noted member "changes from Not required to
 * owing"). Billing ignores the saved row and has sent no invoice, so the row
 * reads as billing sees it: not invoiced. The list filters and counts use this
 * same status ({@link listSubscriptionStatus},
 * {@link notRequiredRowBillingNoteWhere}), so a filter matches what the row
 * shows (#2149).
 */
export const NOT_REQUIRED_ROW_BILLING_STATUS =
  "NOT_INVOICED" as const satisfies SubscriptionStatus;

/**
 * The one status the admin members list, its CSV export and the subscriptions
 * list show for a member this season: "Not required" when the lists' rule
 * exempts them, {@link NOT_REQUIRED_ROW_BILLING_STATUS} for a noted row, else
 * the saved row's status (null with no row).
 */
export function listSubscriptionStatus(input: {
  notRequired: boolean;
  seasonRowStatus: SubscriptionStatus | null | undefined;
  billingNote: string | null;
}): SubscriptionStatus | null {
  if (input.notRequired) return "NOT_REQUIRED";
  if (input.billingNote !== null) return NOT_REQUIRED_ROW_BILLING_STATUS;
  return input.seasonRowStatus ?? null;
}

/**
 * The SQL form of {@link hasNotRequiredRowBillingNote}: in the billing
 * population, an untouched `NOT_REQUIRED` row this season, and not exempt by
 * the lists' rule. `notRequiredConditions` is
 * `subscriptionNotRequiredMemberConditions` for the same season and settings.
 */
export function notRequiredRowBillingNoteWhere(input: {
  seasonYear: number;
  notRequiredConditions: Prisma.MemberWhereInput[];
}): Prisma.MemberWhereInput {
  return {
    AND: [
      SUBSCRIPTION_BILLING_POPULATION_WHERE,
      {
        subscriptions: {
          some: { seasonYear: input.seasonYear, ...UNTOUCHED_NOT_REQUIRED_ROW },
        },
      },
      { NOT: { OR: input.notRequiredConditions } },
    ],
  };
}
