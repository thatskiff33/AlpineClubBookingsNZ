import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getSeasonYear } from "@/lib/utils";
import { AgeTier } from "@prisma/client";
import logger from "@/lib/logger";
import { getAgeTierSettings } from "@/lib/age-tier";

const AGE_TIER_VALUES = Object.values(AgeTier);
const SUBSCRIPTION_STATUS_FILTERS = ["PAID", "UNPAID", "OVERDUE", "NOT_INVOICED"] as const;
const MEMBER_LIFECYCLE_STATUS_FILTERS = [
  "active",
  "inactive",
  "cancelled",
  "archived",
  "all",
] as const;

/**
 * Escape a value for RFC 4180 CSV format.
 * Wraps in double-quotes if value contains comma, quote, or newline.
 */
function csvEscape(value: string): string {
  if (value.includes('"') || value.includes(",") || value.includes("\n") || value.includes("\r")) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

/**
 * GET /api/admin/members/export
 * Export members as CSV. Accepts same filter params as list endpoint.
 * SECURITY: Does NOT include passwordHash, tokens, or sensitive fields.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const sp = req.nextUrl.searchParams;
  const q = sp.get("q") || undefined;
  const now = new Date();
  const currentSeasonYear = getSeasonYear(now);
  const ageTierSettings = await getAgeTierSettings();
  const notRequiredAgeTiers = new Set(
    ageTierSettings
      .filter((setting) => setting.subscriptionRequiredForBooking === false)
      .map((setting) => setting.tier)
  );
  const notRequiredSubscriptionConditions = [
    { role: "ADMIN" },
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
  if (roleFilter && (roleFilter === "MEMBER" || roleFilter === "ADMIN")) {
    andConditions.push({ role: roleFilter });
  }

  const lifecycleStatusFilter = sp.get("lifecycleStatus");
  const lifecycleStatus = (
    lifecycleStatusFilter &&
    (MEMBER_LIFECYCLE_STATUS_FILTERS as readonly string[]).includes(lifecycleStatusFilter)
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
    andConditions.push(
      { role: { not: "ADMIN" } },
      {
        subscriptions: { none: { seasonYear: currentSeasonYear } },
      },
    );
  } else if (
    subscriptionFilter &&
    (SUBSCRIPTION_STATUS_FILTERS as readonly string[]).includes(subscriptionFilter)
  ) {
    andConditions.push(
      { role: { not: "ADMIN" } },
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
        firstName: true,
        lastName: true,
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
        subscriptions: {
          where: { seasonYear: currentSeasonYear },
          select: { status: true },
          take: 1,
        },
      },
    });

    const headers = [
      "First Name",
      "Last Name",
      "Email",
      "Phone Country Code",
      "Phone Area Code",
      "Phone Number",
      "Date of Birth",
      "Role",
      "Age Tier",
      "Active",
      "Cancelled At",
      "Archived At",
      "Xero Contact ID",
      "Subscription Status",
      "Created At",
    ];

    const rows = members.map((m) => [
      csvEscape(m.firstName),
      csvEscape(m.lastName),
      csvEscape(m.email),
      csvEscape(m.phoneCountryCode || ""),
      csvEscape(m.phoneAreaCode || ""),
      csvEscape(m.phoneNumber || ""),
      m.dateOfBirth ? new Date(m.dateOfBirth).toISOString().split("T")[0] : "",
      m.role,
      m.ageTier,
      m.active ? "Yes" : "No",
      m.cancelledAt ? new Date(m.cancelledAt).toISOString() : "",
      m.archivedAt ? new Date(m.archivedAt).toISOString() : "",
      m.xeroContactId || "",
      m.role === "ADMIN" || notRequiredAgeTiers.has(m.ageTier)
        ? "NOT_REQUIRED"
        : m.subscriptions[0]?.status || "NONE",
      new Date(m.createdAt).toISOString(),
    ]);

    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\r\n");
    const today = new Date().toISOString().split("T")[0];

    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="tac-members-${today}.csv"`,
      },
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to export members CSV");
    return NextResponse.json({ error: "Failed to export members" }, { status: 500 });
  }
}
