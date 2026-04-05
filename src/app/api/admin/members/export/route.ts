import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSeasonYear } from "@/lib/utils";
import logger from "@/lib/logger";

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
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const q = sp.get("q") || undefined;
  const currentSeasonYear = getSeasonYear(new Date());

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

  const activeFilter = sp.get("active");
  if (activeFilter === "true") {
    andConditions.push({ active: true });
  } else if (activeFilter === "false") {
    andConditions.push({ active: false });
  }

  const ageTierFilter = sp.get("ageTier");
  if (ageTierFilter && ["ADULT", "YOUTH", "CHILD"].includes(ageTierFilter)) {
    andConditions.push({ ageTier: ageTierFilter });
  }

  const xeroLinkedFilter = sp.get("xeroLinked");
  if (xeroLinkedFilter === "true") {
    andConditions.push({ xeroContactId: { not: null } });
  } else if (xeroLinkedFilter === "false") {
    andConditions.push({ xeroContactId: null });
  }

  const subscriptionFilter = sp.get("subscription");
  if (subscriptionFilter === "NONE") {
    andConditions.push({
      subscriptions: { none: { seasonYear: currentSeasonYear } },
    });
  } else if (
    subscriptionFilter &&
    ["PAID", "UNPAID", "OVERDUE", "NOT_INVOICED"].includes(subscriptionFilter)
  ) {
    andConditions.push({
      subscriptions: {
        some: { seasonYear: currentSeasonYear, status: subscriptionFilter },
      },
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
        phone: true,
        dateOfBirth: true,
        role: true,
        ageTier: true,
        active: true,
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
      "Phone",
      "Date of Birth",
      "Role",
      "Age Tier",
      "Active",
      "Xero Contact ID",
      "Subscription Status",
      "Created At",
    ];

    const rows = members.map((m) => [
      csvEscape(m.firstName),
      csvEscape(m.lastName),
      csvEscape(m.email),
      csvEscape(m.phone || ""),
      m.dateOfBirth ? new Date(m.dateOfBirth).toISOString().split("T")[0] : "",
      m.role,
      m.ageTier,
      m.active ? "Yes" : "No",
      m.xeroContactId || "",
      m.subscriptions[0]?.status || "",
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
