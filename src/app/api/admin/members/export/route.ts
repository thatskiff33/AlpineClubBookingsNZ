import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { clubSeasonYear } from "@/lib/financial-year";
import { AgeTier } from "@prisma/client";
import logger from "@/lib/logger";
import { getAgeTierSettings } from "@/lib/age-tier";
import { formatGenderLabel, formatTitleLabel } from "@/lib/member-enums";
import { loadMemberFieldsFlags } from "@/lib/member-fields-settings";
import { createAuditLog } from "@/lib/audit";
import {
  NON_MEMBER_ROLE_VALUES,
  OPERATIONAL_ROLE_VALUES,
  isRole,
} from "@/lib/member-roles";
import {
  effectiveSubscriptionBehavior,
  isSubscriptionNotRequiredForMembershipType,
} from "@/lib/membership-types";
import { UNASSIGNED_MEMBERSHIP_TYPE_VALUE } from "@/lib/membership-type-filter";
import { fixedClubClock } from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { formatDateOnly } from "@/lib/date-only";
import { escapeCsvCell } from "@/lib/csv";

const AGE_TIER_VALUES = Object.values(AgeTier);
const SUBSCRIPTION_STATUS_FILTERS = [
  "PAID",
  "UNPAID",
  "OVERDUE",
  "NOT_INVOICED",
] as const;
const MEMBER_LIFECYCLE_STATUS_FILTERS = [
  "active",
  "inactive",
  "cancelled",
  "archived",
  "all",
] as const;

// RFC 4180 CSV cell escaping (with formula-injection guard) lives in the shared
// `@/lib/csv` helper so the client-side exports and this route can never drift.
// This thin alias keeps the local call sites below unchanged.
const csvEscape = escapeCsvCell;

/**
 * GET /api/admin/members/export
 * Export members as CSV. Accepts same filter params as list endpoint.
 * SECURITY: Does NOT include passwordHash, tokens, or sensitive fields.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const flags = await loadMemberFieldsFlags();
  // The club's own temporal API, bound to the PERSISTED club timezone (CT-4,
  // #2870; INV-CONFIG-002) rather than the container's environment.
  const club = await clubTime();
  const sp = req.nextUrl.searchParams;
  const q = sp.get("q") || undefined;
  const now = new Date();
  // The season the CLUB is in at `now`, from its persisted zone rather than the
  // container's month (CT-4, #2870). `now` is pinned so the whole export is one
  // moment's answer.
  const currentSeasonYear = clubSeasonYear(club.zone, fixedClubClock(now));
  const ageTierSettings = await getAgeTierSettings();
  const notRequiredAgeTiers = new Set(
    ageTierSettings
      .filter((setting) => setting.subscriptionRequiredForBooking === false)
      .map((setting) => setting.tier),
  );
  // #2149: mirror the members-list filter exactly — membership type is the
  // authority. Exempt when the assigned season type is NOT_REQUIRED, or (no
  // assignment) the role's default built-in type is NOT_REQUIRED. See
  // admin-members-service for the full rationale.
  const notRequiredSubscriptionConditions = [
    {
      AND: [
        {
          seasonalMembershipAssignments: {
            none: { seasonYear: currentSeasonYear },
          },
        },
        { role: { in: [...OPERATIONAL_ROLE_VALUES, ...NON_MEMBER_ROLE_VALUES] } },
      ],
    },
    {
      seasonalMembershipAssignments: {
        some: {
          seasonYear: currentSeasonYear,
          membershipType: { subscriptionBehavior: "NOT_REQUIRED" },
        },
      },
    },
    // #2041/#2149: mirror the members-list filter and the displayed flag's
    // row-dominance branch. A BASED_ON_AGE_TIER assignment with a NOT_REQUIRED
    // current-season row is exempt even when the age tier is liable
    // (mid-season tier promotion). See admin-members-service for the full
    // rationale on why the assignment gate is required.
    {
      seasonalMembershipAssignments: {
        some: {
          seasonYear: currentSeasonYear,
          membershipType: { subscriptionBehavior: "BASED_ON_AGE_TIER" },
        },
      },
      subscriptions: {
        some: { seasonYear: currentSeasonYear, status: "NOT_REQUIRED" },
      },
    },
    ...(notRequiredAgeTiers.size > 0
      ? [{ ageTier: { in: Array.from(notRequiredAgeTiers) } }]
      : []),
  ];

  // Build where clause (same logic as list endpoint)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};
  const andConditions: Record<string, unknown>[] = [];

  if (q) {
    andConditions.push({
      OR: [
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ],
    });
  }

  const roleFilter = sp.get("role");
  if (isRole(roleFilter)) {
    andConditions.push({ role: roleFilter });
  }

  const lifecycleStatusFilter = sp.get("lifecycleStatus");
  const lifecycleStatus =
    lifecycleStatusFilter &&
    (MEMBER_LIFECYCLE_STATUS_FILTERS as readonly string[]).includes(
      lifecycleStatusFilter,
    )
      ? lifecycleStatusFilter
      : null;
  const includeArchived = sp.get("includeArchived") === "true";

  if (lifecycleStatus === "archived") {
    where.archivedAt = { not: null };
  } else if (lifecycleStatus !== "all" && !includeArchived) {
    where.archivedAt = null;
  }

  if (lifecycleStatus === "active") {
    andConditions.push({ active: true }, { cancelledAt: null });
  } else if (lifecycleStatus === "inactive") {
    andConditions.push({ active: false }, { cancelledAt: null });
  } else if (lifecycleStatus === "cancelled") {
    andConditions.push({ cancelledAt: { not: null } });
  }

  const activeFilter = sp.get("active");
  if (!lifecycleStatus) {
    if (activeFilter === "true") {
      andConditions.push({ active: true });
    } else if (activeFilter === "false") {
      andConditions.push({ active: false });
    }
  }

  const ageTierFilter = sp.get("ageTier");
  if (ageTierFilter && AGE_TIER_VALUES.includes(ageTierFilter as AgeTier)) {
    andConditions.push({ ageTier: ageTierFilter });
  }

  // Membership type filter — mirror the list endpoint so an exported CSV
  // matches the filtered on-screen roster (#1445). "UNASSIGNED" → no
  // current-season assignment; any other value is a MembershipType id.
  const membershipTypeFilter = sp.get("membershipType");
  if (membershipTypeFilter === UNASSIGNED_MEMBERSHIP_TYPE_VALUE) {
    andConditions.push({
      seasonalMembershipAssignments: {
        none: { seasonYear: currentSeasonYear },
      },
    });
  } else if (membershipTypeFilter) {
    andConditions.push({
      seasonalMembershipAssignments: {
        some: {
          seasonYear: currentSeasonYear,
          membershipTypeId: membershipTypeFilter,
        },
      },
    });
  }

  const xeroLinkedFilter = sp.get("xeroLinked");
  if (xeroLinkedFilter === "true") {
    andConditions.push({ xeroContactId: { not: null } });
  } else if (xeroLinkedFilter === "false") {
    andConditions.push({ xeroContactId: null });
  }

  const financeAccessFilter = sp.get("financeAccess");
  if (
    financeAccessFilter &&
    ["NONE", "VIEWER", "MANAGER"].includes(financeAccessFilter)
  ) {
    andConditions.push({ financeAccessLevel: financeAccessFilter });
  }

  const activePendingInviteFilter = {
    used: false,
    expiresAt: { gt: now },
  };
  const inviteStatusFilter = sp.get("inviteStatus");
  if (inviteStatusFilter === "invite") {
    andConditions.push(
      { canLogin: true },
      { passwordChangedAt: null },
      { lastLoginAt: null },
      { passwordResetTokens: { none: activePendingInviteFilter } },
    );
  } else if (inviteStatusFilter === "resend-invite") {
    andConditions.push(
      { canLogin: true },
      { passwordChangedAt: null },
      { lastLoginAt: null },
      { passwordResetTokens: { some: activePendingInviteFilter } },
    );
  } else if (inviteStatusFilter === "reset-password") {
    andConditions.push(
      { canLogin: true },
      {
        OR: [
          { passwordChangedAt: { not: null } },
          { lastLoginAt: { not: null } },
        ],
      },
    );
  }

  const subscriptionFilter = sp.get("subscription");
  if (subscriptionFilter === "NOT_REQUIRED") {
    andConditions.push({ OR: notRequiredSubscriptionConditions });
  } else if (subscriptionFilter === "NONE") {
    // #2149: no blanket role exclusion — see admin-members-service.
    andConditions.push(
      { NOT: { OR: notRequiredSubscriptionConditions } },
      {
        subscriptions: { none: { seasonYear: currentSeasonYear } },
      },
    );
  } else if (
    subscriptionFilter &&
    (SUBSCRIPTION_STATUS_FILTERS as readonly string[]).includes(
      subscriptionFilter,
    )
  ) {
    andConditions.push(
      { NOT: { OR: notRequiredSubscriptionConditions } },
      {
        subscriptions: {
          some: { seasonYear: currentSeasonYear, status: subscriptionFilter },
        },
      },
    );
  }

  const familyGroupFilter = sp.get("familyGroup");
  if (familyGroupFilter === "none") {
    andConditions.push({ familyGroupMemberships: { none: {} } });
  } else if (familyGroupFilter === "any") {
    andConditions.push({ familyGroupMemberships: { some: {} } });
  } else if (familyGroupFilter && familyGroupFilter !== "all") {
    andConditions.push({
      familyGroupMemberships: { some: { familyGroupId: familyGroupFilter } },
    });
  }

  if (andConditions.length > 0) {
    where.AND = andConditions;
  }

  try {
    const members = await prisma.member.findMany({
      where,
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      select: {
        title: true,
        firstName: true,
        lastName: true,
        gender: true,
        occupation: true,
        email: true,
        phoneCountryCode: true,
        phoneAreaCode: true,
        phoneNumber: true,
        dateOfBirth: true,
        role: true,
        financeAccessLevel: true,
        ageTier: true,
        active: true,
        cancelledAt: true,
        archivedAt: true,
        xeroContactId: true,
        createdAt: true,
        streetAddressLine1: true,
        streetAddressLine2: true,
        streetCity: true,
        streetRegion: true,
        streetCountry: true,
        streetPostalCode: true,
        lifeMemberDate: true,
        comments: true,
        subscriptions: {
          where: { seasonYear: currentSeasonYear },
          select: { status: true },
          take: 1,
        },
        seasonalMembershipAssignments: {
          where: { seasonYear: currentSeasonYear },
          select: {
            membershipType: {
              select: { subscriptionBehavior: true },
            },
          },
          take: 1,
        },
      },
    });

    // Column descriptors. Optional fields gated by club settings are filtered
    // out below so the header row and every data row stay aligned.
    type MemberRow = (typeof members)[number];
    const columns: Array<{ header: string; value: (m: MemberRow) => string }> =
      [
        ...(flags.showTitle
          ? [
              {
                header: "Title",
                value: (m: MemberRow) => csvEscape(formatTitleLabel(m.title)),
              },
            ]
          : []),
        { header: "First Name", value: (m: MemberRow) => csvEscape(m.firstName) },
        { header: "Last Name", value: (m: MemberRow) => csvEscape(m.lastName) },
        ...(flags.showGender
          ? [
              {
                header: "Gender",
                value: (m: MemberRow) => csvEscape(formatGenderLabel(m.gender)),
              },
            ]
          : []),
        ...(flags.showOccupation
          ? [
              {
                header: "Occupation",
                value: (m: MemberRow) => csvEscape(m.occupation || ""),
              },
            ]
          : []),
        { header: "Email", value: (m: MemberRow) => csvEscape(m.email) },
        {
          header: "Phone Country Code",
          value: (m: MemberRow) => csvEscape(m.phoneCountryCode || ""),
        },
        {
          header: "Phone Area Code",
          value: (m: MemberRow) => csvEscape(m.phoneAreaCode || ""),
        },
        {
          header: "Phone Number",
          value: (m: MemberRow) => csvEscape(m.phoneNumber || ""),
        },
        {
          header: "Street Address Line 1",
          value: (m: MemberRow) => csvEscape(m.streetAddressLine1 || ""),
        },
        {
          header: "Street Address Line 2",
          value: (m: MemberRow) => csvEscape(m.streetAddressLine2 || ""),
        },
        { header: "City", value: (m: MemberRow) => csvEscape(m.streetCity || "") },
        {
          header: "Region",
          value: (m: MemberRow) => csvEscape(m.streetRegion || ""),
        },
        {
          header: "Country",
          value: (m: MemberRow) => csvEscape(m.streetCountry || ""),
        },
        {
          header: "Postal Code",
          value: (m: MemberRow) => csvEscape(m.streetPostalCode || ""),
        },
        {
          header: "Date of Birth",
          value: (m: MemberRow) =>
            m.dateOfBirth
              ? formatDateOnly(new Date(m.dateOfBirth))
              : "",
        },
        {
          header: "Life Member Date",
          value: (m: MemberRow) =>
            m.lifeMemberDate
              ? formatDateOnly(new Date(m.lifeMemberDate))
              : "",
        },
        { header: "Role", value: (m: MemberRow) => m.role },
        { header: "Age Tier", value: (m: MemberRow) => m.ageTier },
        { header: "Active", value: (m: MemberRow) => (m.active ? "Yes" : "No") },
        {
          // Emitted as an NZ date-only (yyyy-MM-dd), not a full ISO datetime,
          // so the value round-trips back through the member import: the header
          // normalizes to `cancelledat` (a cancelledDate alias) and the import
          // only accepts date-only formats. A full ISO datetime would fail
          // import parsing, and its UTC calendar date can trail the NZ date by a
          // day for an early-morning-NZ cancellation. Converting to the club
          // time zone matches how the app displays the cancellation date.
          header: "Cancelled At",
          value: (m: MemberRow) =>
            m.cancelledAt
              ? club.calendarDateOf(new Date(m.cancelledAt))
              : "",
        },
        {
          header: "Archived At",
          value: (m: MemberRow) =>
            m.archivedAt ? new Date(m.archivedAt).toISOString() : "",
        },
        {
          header: "Xero Contact ID",
          value: (m: MemberRow) => m.xeroContactId || "",
        },
        {
          header: "Subscription Status",
          value: (m: MemberRow) =>
            // #2149: membership type is the sole authority (role carries no
            // exemption); mirrors the members-list flag and the SQL filter.
            isSubscriptionNotRequiredForMembershipType({
              subscriptionBehavior: effectiveSubscriptionBehavior(
                (m.seasonalMembershipAssignments ?? [])[0]?.membershipType
                  .subscriptionBehavior,
                m.role,
              ),
              ageTier: m.ageTier,
              notRequiredAgeTiers,
              hasNotRequiredSeasonRow:
                m.subscriptions[0]?.status === "NOT_REQUIRED",
            })
              ? "NOT_REQUIRED"
              : m.subscriptions[0]?.status || "NONE",
        },
        { header: "Comments", value: (m: MemberRow) => csvEscape(m.comments || "") },
        {
          header: "Created At",
          value: (m: MemberRow) => new Date(m.createdAt).toISOString(),
        },
      ];

    const headers = columns.map((column) => column.header);
    const rows = members.map((m) => columns.map((column) => column.value(m)));

    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join(
      "\r\n",
    );
    const today = club.today();

    // Privacy audit: record that a members CSV was exported. Only the applied
    // filters and the row count are stored — never member row contents.
    await createAuditLog({
      action: "member.exported",
      memberId: guard.session.user.id,
      category: "privacy",
      severity: "info",
      outcome: "success",
      summary: "Exported members CSV",
      metadata: {
        filters: {
          q: sp.get("q"),
          role: sp.get("role"),
          lifecycleStatus: sp.get("lifecycleStatus"),
          includeArchived: sp.get("includeArchived"),
          active: sp.get("active"),
          ageTier: sp.get("ageTier"),
          membershipType: sp.get("membershipType"),
          xeroLinked: sp.get("xeroLinked"),
          financeAccess: sp.get("financeAccess"),
          inviteStatus: sp.get("inviteStatus"),
          subscription: sp.get("subscription"),
          familyGroup: sp.get("familyGroup"),
        },
        rowCount: members.length,
      },
    });

    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="tac-members-${today}.csv"`,
      },
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to export members CSV");
    return NextResponse.json(
      { error: "Failed to export members" },
      { status: 500 },
    );
  }
}
