import {
  hasAccessRole,
  isOrganisationMember,
  resolveAccessRoleTokens,
  type AccessRoleInput,
} from "@/lib/access-roles";

/**
 * Who sees the member side of work parties (#5148): the Work Parties
 * dashboard card, the `/dashboard/work-parties/[id]` page and API, its "Join Work
 * Party" button, and a work party's Events Calendar entries (owner decision,
 * 20 Nov 2026, applied by `whereVisibleCalendarEvent`). The ONE rule all of
 * them use (INV-SSOT).
 *
 * MEMBERS ONLY (owner decision 7, fork triyder/AlpineClubBookingsNZ#118). That is narrower than the Events
 * calendar's `canViewCalendarEvents`, which only shuts out organisation
 * accounts, so this is its own helper rather than a reuse of that one.
 *
 * "Member" is the rule the booking-create route already uses to decide whether
 * an account books under member rules: the account holds the `USER` access
 * role (`isMember` in `src/app/api/bookings/route.ts`). That leaves out
 * non-member logins (`NON_MEMBER`, which confers no role), lodge kiosk and
 * admin-only accounts, and any login without club membership. Organisation
 * accounts (the `ORG` role or the legacy `SCHOOL` role) are refused explicitly
 * through `isOrganisationMember`, the shared organisation classification (the
 * same composition `canViewCalendarEvents` uses), so the rule
 * still holds for a record that somehow carries both. A login-disabled account
 * is refused outright, as every privilege gate does (#3603).
 */
export function canViewWorkParties(
  user: AccessRoleInput & { canLogin: boolean },
): boolean {
  return (
    user.canLogin === true &&
    hasAccessRole(user, "USER") &&
    !isOrganisationMember({
      accessRoleTokens: resolveAccessRoleTokens(user),
      legacyRole: typeof user.role === "string" ? user.role : null,
    })
  );
}
