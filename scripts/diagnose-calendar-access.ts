/**
 * Diagnose why a member can (or cannot) see and manage calendar events.
 *
 *   npm run calendar:diagnose-access -- someone@example.com
 *
 * Prints the exact inputs to the calendar gates (src/lib/calendar-access.ts):
 * the club's `eventsCalendar` module flag, the view gate (organisation accounts
 * are excluded), the member's merged admin-permission matrix (lodge level),
 * their active committee assignments, and the resulting canManage decision — so
 * a "why does this normal user see Edit/Delete?" or "why does this one account
 * get Not Found?" question has a definitive answer.
 *
 * The three legs must be reported in the order the app applies them (#2241):
 * module off hides the calendar from everyone, the view gate then removes
 * organisation accounts, and only then do the write gates run.
 */
import { prisma } from "@/lib/prisma";
import { getAdminPermissionMatrix } from "@/lib/admin-permissions";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import {
  canViewCalendarEvents,
  hasCalendarManageViaAdmin,
  isActiveCommitteeMember,
} from "@/lib/calendar-access";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

async function main() {
  const email = process.argv[2]?.toLowerCase().trim();
  if (!email) {
    console.error("Usage: npm run calendar:diagnose-access -- <email>");
    process.exit(1);
  }

  const member = await prisma.member.findFirst({
    where: { email },
    select: {
      id: true,
      email: true,
      role: true,
      canLogin: true,
      accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
    },
  });

  if (!member) {
    console.error(`No member found with email ${email}`);
    process.exit(1);
  }

  const modules = await loadEffectiveModuleFlags();
  const moduleOn = modules.eventsCalendar;
  const canView = canViewCalendarEvents(member);
  const matrix = getAdminPermissionMatrix(member);
  const viaAdmin = hasCalendarManageViaAdmin(member);
  const committee = await isActiveCommitteeMember(member.id);

  const assignments = await prisma.committeeAssignment.findMany({
    where: { memberId: member.id },
    select: {
      isActive: true,
      committeeRole: { select: { name: true, isActive: true } },
    },
  });

  console.log("\n=== Calendar access diagnosis ===");
  console.log("member.id           :", member.id);
  console.log("email               :", member.email);
  console.log("legacy role         :", member.role);
  console.log("canLogin            :", member.canLogin);
  console.log(
    "enum access roles   :",
    member.accessRoles.map((r) => r.role).join(", ") || "(none)",
  );
  console.log("permission matrix   :", matrix);
  console.log("lodge level         :", matrix.lodge);
  console.log("committee assignments:", assignments.length ? assignments : "(none)");
  // Mirror src/lib/calendar-access.ts exactly: the view gate short-circuits both
  // write gates, and the module switch sits in front of all three (#2241).
  const canCreate = canView && (viaAdmin || committee);
  const canEditDelete = canView && viaAdmin;

  console.log("\n--- gate legs ---");
  console.log("eventsCalendar module (Admin > Modules):", moduleOn);
  console.log("canViewCalendarEvents (not an org)     :", canView);
  console.log("hasCalendarManageViaAdmin (lodge:edit) :", viaAdmin);
  console.log("isActiveCommitteeMember                :", committee);
  // Each verdict is the EFFECTIVE outcome — the module switch ANDed with the
  // named gate — because that is the question an operator is actually asking.
  // The gate functions themselves do not consider the module; the route and
  // page gates in front of them do.
  console.log(
    "\n>>> SEE the calendar   (module + canViewCalendarEvents) =",
    moduleOn && canView,
    moduleOn && canView ? "(CAN see)" : "(gets Not Found)",
  );
  console.log(
    ">>> CREATE an event    (module + canManageCalendarEvents) =",
    moduleOn && canCreate,
    moduleOn && canCreate ? "(CAN create)" : "(cannot create)",
  );
  console.log(
    ">>> EDIT/DELETE events (module + canEditCalendarEvents) =",
    moduleOn && canEditDelete,
    moduleOn && canEditDelete ? "(CAN edit/delete)" : "(cannot edit/delete)",
  );
  console.log(
    !moduleOn
      ? "\nReason: the Events calendar module is OFF for this club, so /calendar,\n" +
        "/admin/calendar and the calendar API return Not Found for EVERYONE and\n" +
        "the dashboard Events card is hidden. Turn it on at Admin > Modules.\n" +
        "The per-member legs printed above are what would apply once it is back\n" +
        "on."
      : !canView
        ? "\nReason: this is an ORGANISATION account (ORG access role or the legacy\n" +
          "SCHOOL role), which is excluded from the calendar entirely — no Events\n" +
          "card, Not Found on both calendar pages and the events list, and no\n" +
          "create/edit/delete even with a committee assignment or lodge:edit.\n" +
          "Working as designed; if they should be a member, change their user\n" +
          "type on Admin > Members > [member] (see docs/guides/calendar.md)."
        : viaAdmin
          ? "\nReason: an access role grants lodge:edit (Full Admin / Booking Officer)\n" +
            "— full create, edit, and delete."
          : committee
            ? "\nReason: an active committee assignment under an active role\n" +
              "— create-only. Committee members cannot edit or delete events; only\n" +
              "lodge-edit admins can (see docs/guides/calendar.md)."
            : "\nThis member is read-only. If they still see New event / Edit / Delete,\n" +
              "the app is serving a stale build or a stale session — restart the\n" +
              "server and re-login.",
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
