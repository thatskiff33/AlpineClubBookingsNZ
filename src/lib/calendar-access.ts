import { prisma } from "@/lib/prisma";
import {
  hasAdminAreaAccess,
  type AdminPermissionInput,
} from "@/lib/admin-permissions";
import { isOrganisationAccount } from "@/lib/organisation-account";

/**
 * Write access to the club events calendar (#calendar).
 *
 * Access is deliberately ASYMMETRIC — CREATE is broader than EDIT/DELETE — and
 * the server, not the UI, is the authority (see docs/guides/calendar.md → "Who
 * can do what"):
 *
 * - **Create** (`canManageCalendarEvents`): **Full Admins** (merged permission
 *   matrix grants `lodge:edit`) OR **committee members** — any member holding at
 *   least one ACTIVE `CommitteeAssignment` under an ACTIVE `CommitteeRole`.
 *   Committee assignment normally grants NO app privileges (it is public contact
 *   metadata, see CONFIGURATION.md → Committee Settings); letting committee
 *   members *add* events is the one deliberate exception, so they can post
 *   meetings without being made Full Admins.
 * - **Edit / delete** (`canEditCalendarEvents`): **Full Admins only**
 *   (`lodge:edit`). Committee members are create-only: they may NOT edit or
 *   delete events — not even their own, and never another admin's series. This
 *   is why edit/delete gates on the admin leg alone and does not consult the
 *   committee table.
 *
 * - **View** (`canViewCalendarEvents`): everyone who can log in EXCEPT
 *   organisation ("ORG") accounts, which are excluded from the calendar
 *   entirely (#2241) — see that function.
 *
 * Everyone else who can log in is read-only. The gate is enforced server-side in
 * every calendar write route. The UI mirrors CREATE authority into `canManage`
 * so ordinary members never see the create/join controls; edit/delete controls
 * live only on /admin/calendar, which is itself lodge-area gated, so a
 * committee-only member (all-none admin matrix) never renders them.
 */

/**
 * READ access to the club events calendar (#2241).
 *
 * Organisation ("ORG") accounts are excluded. An organisation is a school,
 * scout group, or similar body with a self-service login for its own bookings —
 * it is not a club member, sits outside every membership rule
 * (`isOrganisationMember` in `src/lib/access-roles.ts`), and has no business
 * seeing the club's internal meeting and working-bee schedule. Everyone else
 * who can log in still reads the calendar.
 *
 * This is the single predicate every calendar entry point consults: the member
 * page, the admin page, the list API, and — through the two write gates below —
 * create, edit, delete, and join. Keeping it in one place is what stops an
 * organisation account slipping through a surface someone adds later; in
 * particular an ORG account that also held an active committee assignment would
 * otherwise have passed the CREATE gate.
 *
 * The check is over what the caller supplies. `session.user` always carries
 * both `accessRoles` and the legacy `role` claim, so the real call sites decide
 * correctly; an input with neither (a bare `{ id, adminPermissionMatrix }` in a
 * unit test) is simply not an organisation.
 */
export function canViewCalendarEvents(input: AdminPermissionInput): boolean {
  return !isOrganisationAccount(input);
}

export async function isActiveCommitteeMember(
  memberId: string,
): Promise<boolean> {
  const assignment = await prisma.committeeAssignment.findFirst({
    where: {
      memberId,
      isActive: true,
      committeeRole: { isActive: true },
    },
    select: { id: true },
  });
  return assignment !== null;
}

/** Admin-side leg of the calendar write gate: lodge-area edit. */
export function hasCalendarManageViaAdmin(input: AdminPermissionInput): boolean {
  return hasAdminAreaAccess(input, { area: "lodge", level: "edit" });
}

/**
 * True when this member may CREATE calendar events — a Full Admin with
 * `lodge:edit`, OR an active committee member. Reads the committee table only
 * when the admin leg does not already grant access. Also drives the UI
 * `canManage` flag (create + join-meeting affordances).
 *
 * NOTE: this is the CREATE gate, not edit/delete. For editing or deleting an
 * existing event use {@link canEditCalendarEvents} — committee members are
 * create-only and must never pass the edit/delete gate.
 */
export async function canManageCalendarEvents(
  input: AdminPermissionInput & { id: string },
): Promise<boolean> {
  // An account that may not SEE the calendar may not write to it either (#2241).
  // First, so an organisation account never reaches the committee lookup.
  if (!canViewCalendarEvents(input)) return false;
  if (hasCalendarManageViaAdmin(input)) return true;
  return isActiveCommitteeMember(input.id);
}

/**
 * True when this member may EDIT or DELETE an existing calendar event — Full
 * Admins with `lodge:edit` ONLY. Committee members are create-only per
 * docs/guides/calendar.md, so this deliberately does NOT consult the committee
 * table: a committee member (or any non-admin) is denied. Synchronous — the
 * decision needs no database read.
 */
export function canEditCalendarEvents(input: AdminPermissionInput): boolean {
  // Same rule as the create gate: no view, no write (#2241).
  return canViewCalendarEvents(input) && hasCalendarManageViaAdmin(input);
}
