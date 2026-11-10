import { BackLink } from "@/components/admin/back-link";
import { adminLink, getAdminPage } from "@/lib/admin-hubs";
import { Card, CardContent } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  ADMIN_NOTIFICATION_PREFERENCE_SELECT,
  adminNotificationKeysForMember,
  canViewAdminNotificationRoster,
  isAdminNotificationRecipient,
  resolveEffectiveAdminNotificationPreferences,
} from "@/lib/admin-notification-preferences";
import {
  ADMIN_CAPABLE_MEMBER_WHERE,
  MEMBER_ACCESS_ROLE_SELECT,
} from "@/lib/access-role-definitions";
import {
  ACCESS_ROLE_LABELS,
  isAccessRole,
  isPrivilegedAccessRole,
} from "@/lib/access-roles";
import { AdminNotificationSettings } from "../notifications/notifications-settings";

/**
 * Every admin-portal user, not just Full Admins (#2548, owner decision
 * 2 Aug 2026). Scoped officers and holders of definition-backed custom roles
 * used to be invisible here — the grid queried the legacy `role: "ADMIN"`
 * scalar, which every scoped and custom role collapses to `USER` under — so
 * they could not be subscribed to anything even by hand. Candidates are read
 * with their joined role definitions and filtered through the permission
 * matrix, which is also what decides the alert categories each of them can
 * hold.
 */
async function getAdminNotificationRecipients() {
  const members = await prisma.member.findMany({
    where: ADMIN_CAPABLE_MEMBER_WHERE,
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }, { email: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      canLogin: true,
      accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
      notificationPreference: {
        select: ADMIN_NOTIFICATION_PREFERENCE_SELECT,
      },
    },
  });

  return members.filter(isAdminNotificationRecipient).map((member) => ({
    id: member.id,
    name: `${member.firstName} ${member.lastName}`.trim(),
    email: member.email,
    // Privileged rows only. Every ordinary member carries a plain `USER`
    // classification row and the access-role picker lets an admin leave it
    // ticked alongside a scoped role, so an unfiltered list reads
    // "User, Booking Officer" — and this label exists precisely to explain
    // which roles decide the greyed-out categories. `role: null` is a
    // definition-backed custom role, which is always privileged.
    roleLabels: member.accessRoles
      .filter(
        (assignment) =>
          assignment.role == null || isPrivilegedAccessRole(assignment.role),
      )
      .map(
        (assignment) =>
          assignment.roleDefinition?.label ??
          (isAccessRole(assignment.role)
            ? ACCESS_ROLE_LABELS[assignment.role]
            : null),
      )
      .filter((label): label is string => Boolean(label)),
    availableKeys: adminNotificationKeysForMember(member),
    preferences: resolveEffectiveAdminNotificationPreferences(
      member,
      member.notificationPreference,
    ),
  }));
}

export default async function NotificationRecipientsPage() {
  const session = await auth();
  // The admin layout admits on the route's own `support: view`, but the roster
  // is member identity data (#2548, review finding 1) — see
  // canViewAdminNotificationRoster for the gate and why it is this one. A
  // visitor who clears the layout but not this check gets an explanation, never
  // a crash, and the database is not queried at all.
  const canViewRoster = session?.user
    ? canViewAdminNotificationRoster(session.user)
    : false;

  return (
    <div className="space-y-8">
      <div>
        <BackLink {...adminLink("notifications")} />
        <h1 className="mt-2 text-2xl font-bold text-foreground">
          {getAdminPage("notification-recipients").label}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose which system alerts each admin user receives. Every admin user
          is listed — Full Admins and scoped officers alike. An admin can only
          be sent the alerts for the areas their role can edit, so a Booking
          Officer starts with the booking alerts switched on and the finance and
          membership ones greyed out. Alerts outside an admin&apos;s areas cannot
          be switched on here at all: widen their access role to widen the alerts
          they receive. Changes save automatically.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          {canViewRoster ? (
            <AdminNotificationSettings
              initialAdmins={await getAdminNotificationRecipients()}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              This page lists every admin user&apos;s name, email address and
              access role, so it needs Membership view access or Support &amp;
              System edit access as well. Ask a full admin to widen your access
              role, or to make the change for you.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
