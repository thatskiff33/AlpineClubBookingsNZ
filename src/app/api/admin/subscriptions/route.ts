import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { getSeasonYear } from "@/lib/utils";
import logger from "@/lib/logger";
import { getAgeTierSettings } from "@/lib/age-tier";
import {
  getXeroContactGroupMemberships,
  getXeroContactIdsForGroup,
} from "@/lib/xero";

const subscriptionStatuses = [
  "PAID",
  "UNPAID",
  "OVERDUE",
  "NOT_INVOICED",
  "NOT_REQUIRED",
] as const;
const subscriptionStatusFilterValues = [...subscriptionStatuses, "all"] as const;
const subscriptionSortBySchema = z
  .enum([
    "member",
    "email",
    "ageTier",
    "xeroContactGroup",
    "status",
    "xeroInvoice",
    "paidAt",
  ])
  .optional()
  .default("member");

const querySchema = z.object({
  seasonYear: z.coerce.number().int().min(2020).max(2040).optional(),
  status: z.enum(subscriptionStatusFilterValues).optional().default("all"),
  ageTier: z.enum(["INFANT", "CHILD", "YOUTH", "ADULT", "all"]).optional().default("all"),
  xeroContactGroup: z.string().trim().min(1).max(100).optional(),
  sortBy: subscriptionSortBySchema,
  sortDir: z.enum(["asc", "desc"]).optional().default("asc"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

type SubscriptionSortBy = z.infer<typeof subscriptionSortBySchema>;
type SubscriptionCandidate = {
  id: string;
  memberId: string;
  seasonYear: number;
  status: (typeof subscriptionStatuses)[number];
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  paidAt: Date | null;
  xeroContactGroupsLoaded: boolean;
  xeroContactGroups: Array<{ id: string; name: string }>;
  member: {
    firstName: string;
    lastName: string;
    email: string;
    ageTier: string;
    role: string;
    xeroContactId: string | null;
  };
};

function isNotRequiredMember(
  member: { role: string; ageTier: string },
  notRequiredAgeTiers: Set<string>
) {
  return member.role === "ADMIN" || notRequiredAgeTiers.has(member.ageTier);
}

function compareValues(left: string | number | Date | null, right: string | number | Date | null) {
  const normalizedLeft = left instanceof Date ? left.getTime() : left ?? "";
  const normalizedRight = right instanceof Date ? right.getTime() : right ?? "";

  if (typeof normalizedLeft === "number" && typeof normalizedRight === "number") {
    return normalizedLeft - normalizedRight;
  }

  return String(normalizedLeft).localeCompare(String(normalizedRight));
}

function subscriptionSortValue(candidate: SubscriptionCandidate, sortBy: SubscriptionSortBy) {
  switch (sortBy) {
    case "email":
      return candidate.member.email.toLowerCase();
    case "ageTier":
      return candidate.member.ageTier;
    case "xeroContactGroup":
      return candidate.xeroContactGroups.map((group) => group.name).join(", ").toLowerCase();
    case "status":
      return candidate.status;
    case "xeroInvoice":
      return candidate.xeroInvoiceNumber ?? candidate.xeroInvoiceId;
    case "paidAt":
      return candidate.paidAt;
    case "member":
    default:
      return `${candidate.member.lastName} ${candidate.member.firstName}`.toLowerCase();
  }
}

function sortSubscriptions(
  candidates: SubscriptionCandidate[],
  sortBy: SubscriptionSortBy,
  sortDir: "asc" | "desc"
) {
  const direction = sortDir === "asc" ? 1 : -1;

  return [...candidates].sort((left, right) => {
    const primary =
      compareValues(subscriptionSortValue(left, sortBy), subscriptionSortValue(right, sortBy)) *
      direction;
    if (primary !== 0) {
      return primary;
    }

    const memberFallback = compareValues(
      `${left.member.lastName} ${left.member.firstName}`.toLowerCase(),
      `${right.member.lastName} ${right.member.firstName}`.toLowerCase()
    );
    return memberFallback !== 0 ? memberFallback : left.id.localeCompare(right.id);
  });
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({
    seasonYear: searchParams.get("seasonYear") ?? undefined,
    status: searchParams.get("status") ?? undefined,
    ageTier: searchParams.get("ageTier") ?? undefined,
    xeroContactGroup: searchParams.get("xeroContactGroup") ?? undefined,
    sortBy: searchParams.get("sortBy") ?? undefined,
    sortDir: searchParams.get("sortDir") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    pageSize: searchParams.get("pageSize") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { status, ageTier, xeroContactGroup, sortBy, sortDir, page, pageSize } = parsed.data;
  const seasonYear = parsed.data.seasonYear ?? getSeasonYear(new Date());

  try {
    const ageTierSettings = await getAgeTierSettings();
    const notRequiredAgeTiers = new Set(
      ageTierSettings
        .filter((setting) => setting.subscriptionRequiredForBooking === false)
        .map((setting) => setting.tier)
    );
    const memberWhere: Prisma.MemberWhereInput = {};

    if (ageTier !== "all") {
      memberWhere.ageTier = ageTier;
    }

    if (xeroContactGroup && xeroContactGroup !== "all") {
      const groupContactIds = await getXeroContactIdsForGroup(xeroContactGroup);
      memberWhere.xeroContactId = { in: groupContactIds };
    }

    const summaryWhere: Prisma.MemberSubscriptionWhereInput = { seasonYear };
    if (Object.keys(memberWhere).length > 0) {
      summaryWhere.member = memberWhere;
    }

    const notRequiredWhere: Prisma.MemberWhereInput = {
      ...memberWhere,
      OR: [
        { role: "ADMIN" },
        ...(notRequiredAgeTiers.size > 0
          ? [{ ageTier: { in: Array.from(notRequiredAgeTiers) } }]
          : []),
      ],
    };

    const [subscriptions, notRequiredMembers] = await Promise.all([
      prisma.memberSubscription.findMany({
        where: summaryWhere,
        include: {
          member: {
            select: {
              firstName: true,
              lastName: true,
              email: true,
              ageTier: true,
              role: true,
              xeroContactId: true,
            },
          },
        },
      }),
      prisma.member.findMany({
        where: notRequiredWhere,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          ageTier: true,
          role: true,
          xeroContactId: true,
        },
      }),
    ]);

    const candidatesByMemberId = new Map<string, SubscriptionCandidate>();
    for (const subscription of subscriptions) {
      const displayStatus = isNotRequiredMember(subscription.member, notRequiredAgeTiers)
        ? "NOT_REQUIRED"
        : subscription.status;
      candidatesByMemberId.set(subscription.memberId, {
        id: subscription.id,
        memberId: subscription.memberId,
        seasonYear: subscription.seasonYear,
        status: displayStatus as SubscriptionCandidate["status"],
        xeroInvoiceId: displayStatus === "NOT_REQUIRED" ? null : subscription.xeroInvoiceId,
        xeroInvoiceNumber: displayStatus === "NOT_REQUIRED" ? null : subscription.xeroInvoiceNumber,
        paidAt: displayStatus === "NOT_REQUIRED" ? null : subscription.paidAt,
        xeroContactGroupsLoaded: true,
        xeroContactGroups: [],
        member: subscription.member,
      });
    }

    for (const member of notRequiredMembers) {
      candidatesByMemberId.set(member.id, {
        id: `not-required:${member.id}:${seasonYear}`,
        memberId: member.id,
        seasonYear,
        status: "NOT_REQUIRED",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        paidAt: null,
        xeroContactGroupsLoaded: true,
        xeroContactGroups: [],
        member,
      });
    }

    const candidates = Array.from(candidatesByMemberId.values());

    const linkedContactIds = candidates
      .map((subscription) => subscription.member.xeroContactId)
      .filter((contactId): contactId is string => Boolean(contactId));
    const xeroContactGroupsByContactId =
      linkedContactIds.length > 0
        ? await getXeroContactGroupMemberships(linkedContactIds)
        : {};
    const xeroContactGroupsLoaded =
      linkedContactIds.length === 0 ||
      linkedContactIds.every((contactId) =>
        Object.prototype.hasOwnProperty.call(xeroContactGroupsByContactId, contactId)
      );

    const enrichedCandidates = candidates.map((subscription) => ({
      ...subscription,
      xeroContactGroupsLoaded,
      xeroContactGroups: subscription.member.xeroContactId
        ? xeroContactGroupsByContactId[subscription.member.xeroContactId] ?? []
        : [],
    }));

    const filteredCandidates =
      status === "all"
        ? enrichedCandidates
        : enrichedCandidates.filter((subscription) => subscription.status === status);
    const sortedCandidates = sortSubscriptions(filteredCandidates, sortBy, sortDir);
    const data = sortedCandidates.slice((page - 1) * pageSize, page * pageSize);
    const total = filteredCandidates.length;

    const counts = {
      total: 0,
      paid: 0,
      unpaid: 0,
      overdue: 0,
      notInvoiced: 0,
      notRequired: 0,
    };
    for (const row of enrichedCandidates) {
      counts.total += 1;
      if (row.status === "PAID") counts.paid += 1;
      else if (row.status === "UNPAID") counts.unpaid += 1;
      else if (row.status === "OVERDUE") counts.overdue += 1;
      else if (row.status === "NOT_INVOICED") counts.notInvoiced += 1;
      else if (row.status === "NOT_REQUIRED") counts.notRequired += 1;
    }

    return NextResponse.json({
      data,
      total,
      page,
      pageSize,
      summary: counts,
      xeroContactGroupsLoaded,
    });
  } catch (err) {
    logger.error({ err }, "Error fetching subscriptions");
    return NextResponse.json({ error: "Failed to fetch subscriptions" }, { status: 500 });
  }
}
