import addClubTimeSettings from "./20260822010000_add_club_time_settings";
import addHutLeaderAssignmentSource from "./20260820020000_add_hut_leader_assignment_source";
import addMemberEmailInheritanceChoice from "./20260813010000_add_member_email_inheritance_choice";
import backfillBedAllocationAuditCategory from "./20260810020000_backfill_bed_allocation_audit_category";
import backfillBookingRequestGuestNights from "./20260810010000_backfill_booking_request_guest_nights";
import clearStarterFooterAffiliations from "./20260802140000_clear_starter_footer_affiliations";
import clearWaldvogelLodgeAddress from "./20260802110000_clear_waldvogel_lodge_address";
import contractSubscriptionLockoutDropEnabled from "./20260803010000_contract_subscription_lockout_drop_enabled";
import repairLocalMidnightDatesOfBirth from "./20260814010000_repair_local_midnight_dates_of_birth";
import updateStarterHomeGuestCopy from "./20260802150000_update_starter_home_guest_copy";
import type { DataMigrationVerification } from "./types";

/**
 * The registry of data-migration verification fixtures (#2418).
 *
 * `src/lib/__tests__/data-migration-verification.realdb.test.ts` executes
 * everything listed here against a real PostgreSQL: it replays every earlier
 * migration, seeds each case's pre-state, runs the real `migration.sql`, and
 * asserts the rows — then re-runs each case against deliberately broken copies
 * of the migration to prove the assertions have teeth.
 *
 * A fixture that is NOT listed here never runs, which is coverage that does not
 * exist. `scripts/check-data-migration-verification.sh` fails on an unregistered
 * fixture for that reason, and fails on a data-rewriting migration that ships no
 * fixture at all.
 *
 * Listed oldest migration first — the runner replays the migration chain once,
 * in order, and advances through it.
 */
export const DATA_MIGRATION_VERIFICATIONS: DataMigrationVerification[] = [
  clearWaldvogelLodgeAddress,
  clearStarterFooterAffiliations,
  updateStarterHomeGuestCopy,
  contractSubscriptionLockoutDropEnabled,
  backfillBookingRequestGuestNights,
  backfillBedAllocationAuditCategory,
  addMemberEmailInheritanceChoice,
  repairLocalMidnightDatesOfBirth,
  addHutLeaderAssignmentSource,
  addClubTimeSettings,
];
