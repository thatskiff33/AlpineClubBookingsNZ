import { NextRequest, NextResponse } from "next/server";
import type { AgeTier } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSeasonalMembershipChangePreview } from "@/lib/seasonal-membership-assignments";
import { requireAdmin } from "@/lib/session-guards";
import { clubTimeZone } from "@/lib/club-time/server";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { clubSeasonYear } from "@/lib/financial-year";

// Preview divergence from the single-member flow (#2107, documented): archived
// members are excluded and reported by id rather than previewed.
const LINKED_GUEST_LABEL_LIMIT = 3;

const previewSchema = z
  .object({
    ids: z
      .array(z.string().min(1))
      .min(1, "At least one member ID is required")
      .max(100),
    seasonYear: z.number().int().min(2020).max(2040),
    membershipTypeId: z.string().min(1),
    applyFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
  })
  .strict();

type SeasonalPreview = {
  previousAssignment: { membershipTypeId: string; applyFrom: string | null } | null;
  applyFrom: string | null;
  currentAgeTier: AgeTier;
  resultingAgeTier: AgeTier;
  ageTierChanged: boolean;
  linkedGuestBookings: {
    count: number;
    truncatedCount: number;
    list: Array<Record<string, unknown>>;
  };
  affectedCounts: {
    futureConfirmedBookings: number;
    draftBookings: number;
    waitlistRecords: number;
  };
  previewToken: string;
};

export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = previewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { ids, seasonYear, membershipTypeId, applyFrom } = parsed.data;
  const uniqueIds = Array.from(new Set(ids));

  // Load display names + lifecycle so archived members can be excluded and
  // reported, and not-found ids reported, without a per-member round trip.
  const members = await prisma.member.findMany({
    where: { id: { in: uniqueIds } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      archivedAt: true,
    },
  });
  const memberById = new Map(members.map((member) => [member.id, member]));

  const skipped: Array<{ memberId: string; reason: "archived" | "not_found" }> =
    [];
  const previewableIds: string[] = [];
  for (const id of uniqueIds) {
    const member = memberById.get(id);
    if (!member) {
      skipped.push({ memberId: id, reason: "not_found" });
      continue;
    }
    if (member.archivedAt) {
      skipped.push({ memberId: id, reason: "archived" });
      continue;
    }
    previewableIds.push(id);
  }

  const perMember: Array<{
    memberId: string;
    name: string;
    previewToken: string;
    affectedCounts: SeasonalPreview["affectedCounts"];
    changed: boolean;
    currentAgeTier: AgeTier;
    resultingAgeTier: AgeTier;
    ageTierChanged: boolean;
    linkedGuestBlocked: boolean;
    linkedGuestBookings: {
      count: number;
      truncatedCount: number;
      list: Array<Record<string, unknown>>;
    };
  }> = [];

  const affectedTotals = {
    futureConfirmedBookings: 0,
    draftBookings: 0,
    waitlistRecords: 0,
  };
  let changedCount = 0;
  let ageTierChangeCount = 0;
  let linkedGuestBlockCount = 0;

  // ONE read of the club's current season for the whole batch (#2870): the
  // preview judges each member's age tier against it, an age tier decides a price
  // band, and a fifty-member preview must not be able to answer in two seasons.
  // #3123 — and from the SAME single zone read, ONE club day for the whole
  // batch. The preview's `now` used to default to the environment's day, one
  // read per member, and it bounds every "still to come" booking query the
  // preview reports. Both answers now come from one `clubTimeZone()`, which is
  // React-cached for this request in any case.
  const clubZone = await clubTimeZone();
  const clubCurrentSeasonYear = clubSeasonYear(clubZone);
  const clubTodayDateOnly = dateOnlyInstantOf(clubToday(clubZone));

  for (const id of previewableIds) {
    const result = await getSeasonalMembershipChangePreview({
      memberId: id,
      seasonYear,
      membershipTypeId,
      applyFrom: applyFrom ?? null,
      now: clubTodayDateOnly,
      clubCurrentSeasonYear,
    });

    const status = result.init?.status;
    if (status && status >= 400) {
      const error = (result.body as { error?: string }).error ?? "";
      // A member that vanished between the name load and the preview is a
      // per-member not-found skip; every other 4xx here is a TYPE-level failure
      // (membership type not found / archived / invalid apply-from) that applies
      // to the whole request, so surface it as-is.
      if (status === 404 && /member not found/i.test(error)) {
        skipped.push({ memberId: id, reason: "not_found" });
        continue;
      }
      return NextResponse.json(result.body, result.init);
    }

    const preview = (result.body as { preview: SeasonalPreview }).preview;
    const member = memberById.get(id)!;
    const name = `${member.firstName} ${member.lastName}`.trim() || member.email;

    const assignmentUnchanged =
      preview.previousAssignment?.membershipTypeId === membershipTypeId &&
      (preview.previousAssignment.applyFrom ?? null) === preview.applyFrom;
    const changed = !assignmentUnchanged || preview.ageTierChanged;
    const flipsToNotApplicable =
      preview.resultingAgeTier === "NOT_APPLICABLE" &&
      preview.currentAgeTier !== "NOT_APPLICABLE";
    const linkedGuestBlocked =
      flipsToNotApplicable && preview.linkedGuestBookings.count > 0;

    if (changed) changedCount += 1;
    if (preview.ageTierChanged) ageTierChangeCount += 1;
    if (linkedGuestBlocked) linkedGuestBlockCount += 1;
    affectedTotals.futureConfirmedBookings +=
      preview.affectedCounts.futureConfirmedBookings;
    affectedTotals.draftBookings += preview.affectedCounts.draftBookings;
    affectedTotals.waitlistRecords += preview.affectedCounts.waitlistRecords;

    perMember.push({
      memberId: id,
      name,
      previewToken: preview.previewToken,
      affectedCounts: preview.affectedCounts,
      changed,
      currentAgeTier: preview.currentAgeTier,
      resultingAgeTier: preview.resultingAgeTier,
      ageTierChanged: preview.ageTierChanged,
      linkedGuestBlocked,
      // Trim the linked-guest block to counts + the first few labels for the
      // aggregate preview UI (the single-member card carries the full list).
      linkedGuestBookings: {
        count: preview.linkedGuestBookings.count,
        truncatedCount: Math.max(
          0,
          preview.linkedGuestBookings.count - LINKED_GUEST_LABEL_LIMIT,
        ),
        list: preview.linkedGuestBookings.list.slice(0, LINKED_GUEST_LABEL_LIMIT),
      },
    });
  }

  return NextResponse.json({
    seasonYear,
    membershipTypeId,
    summary: {
      requested: uniqueIds.length,
      previewed: perMember.length,
      changed: changedCount,
      unchanged: perMember.length - changedCount,
      skipped: skipped.length,
      ageTierChanges: ageTierChangeCount,
      linkedGuestBlocks: linkedGuestBlockCount,
      affectedTotals,
    },
    members: perMember,
    skipped,
  });
}
