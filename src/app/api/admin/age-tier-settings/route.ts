import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import type { AgeTier } from "@prisma/client";
import { z } from "zod";
import { ageTierEnum } from "@/lib/age-tier-schema";
import { logAudit } from "@/lib/audit";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation";
import {
  invalidateAgeTierCache,
  normalizeAgeTierSettings,
  validateAgeTierPartition,
} from "@/lib/age-tier";

type AgeTierSettingInput = {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  subscriptionRequiredForBooking: boolean;
  familyGroupRequestCreateMemberAllowed: boolean;
  sortOrder: number;
};

const putSchema = z.object({
  settings: z
    .array(
      z.object({
        // NOT_APPLICABLE is the organisation/school tier (#1440): it has no
        // age range, no Xero group, and no subscription rule, so it never
        // gets a settings row.
        tier: ageTierEnum.refine((tier) => tier !== "NOT_APPLICABLE", {
          message: "The N/A age tier is not configurable",
        }),
        minAge: z.number().int().min(0),
        maxAge: z.number().int().min(0).nullable(),
        label: z.string().min(1).max(100),
        subscriptionRequiredForBooking: z.boolean(),
        familyGroupRequestCreateMemberAllowed: z.boolean(),
        sortOrder: z.number().int().min(0),
      })
    )
    .min(1),
});

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;
  const settings = await prisma.ageTierSetting.findMany({
    orderBy: { sortOrder: "asc" },
    select: {
      tier: true,
      minAge: true,
      maxAge: true,
      label: true,
      subscriptionRequiredForBooking: true,
      familyGroupRequestCreateMemberAllowed: true,
      sortOrder: true,
    },
  });

  return NextResponse.json({ settings: normalizeAgeTierSettings(settings) });
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const body = await request.json();
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const settings: AgeTierSettingInput[] = parsed.data.settings.map((setting) => ({
    ...setting,
    tier: setting.tier as AgeTier,
  }));

  // --- Validity rule (issue #2009 — interim age-tier subset relaxation) -------
  // A club may save ANY subset of the bookable AgeTier slots (not just all four),
  // provided the saved rows still form a single, complete, non-overlapping
  // partition of [0, ∞) with ADULT as the unbounded terminal tier. The exact rule
  // (≥1 tier, no duplicate slot, ADULT present + the only unbounded tier, ranges
  // tile 0 → ∞ with no gaps/overlaps) lives in `validateAgeTierPartition` so it is
  // pure and unit-testable. Which enum identities make up the subset is otherwise
  // free (e.g. CHILD 0-17 + ADULT 18+ legally skips INFANT and YOUTH; ADULT-only
  // 0+ is legal). The canonical all-four TAC install still satisfies every clause,
  // so its behaviour is byte-unchanged.
  const validation = validateAgeTierPartition(settings);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const sorted = validation.sorted;

  // Re-index sortOrder to a canonical, gap-free 0..n-1 in ascending-age order.
  // Every consumer that orders by sortOrder (computeAgeTierWithSettings, the
  // admin UI's next-tier maxAge derivation, normalizeAgeTierSettings) then sees
  // the same age-ascending sequence regardless of the sortOrder values the client
  // sent. It also keeps a saved subset clear of the legacy-3-tier auto-migration
  // shape, which is pinned to sortOrder 1/2/3 (see isLegacyThreeTierSettings):
  // a subset saved here always uses 0-based sortOrders, so a deliberate
  // CHILD/YOUTH/ADULT subset is never mistaken for an unmigrated legacy DB. The
  // canonical four-tier save already sends 0,1,2,3 in age order, so this is a
  // no-op for it (behaviour byte-unchanged).
  const normalizedSettings = sorted.map((s, index) => ({
    ...s,
    sortOrder: index,
  }));

  // --- Tier removal safety (issue #2009) -------------------------------------
  // A subset save may DROP tiers that previously existed in the table. Deleting a
  // tier row while a person still classifies into it would orphan their stored
  // ageTier (no matching AgeTierSetting row → wrong label / price / Xero group),
  // so we fail CLOSED: a tier can only be removed when NO member (archived
  // included) and no current-or-upcoming booking guest is still classified into
  // it. Archived members are counted deliberately — an archived member sitting
  // in a removed tier would orphan the moment they are un-archived, so we block
  // now rather than surprise later. Past booking guests are frozen historical
  // snapshots and never re-priced, so they do not block.
  //
  // The guard COUNTS and the deleteMany/upserts run in ONE interactive
  // transaction: the guard reads and the delete write share the same tx, and a
  // block throws from inside it (aborting every write). This closes the
  // check-then-act race the previous pre-transaction count left open.
  const existingTiers = await prisma.ageTierSetting.findMany({
    select: { tier: true },
  });
  const keptTiers = new Set(normalizedSettings.map((s) => s.tier));
  const removedTiers = existingTiers
    .map((row) => row.tier)
    .filter((tier) => !keptTiers.has(tier));

  // Thrown from inside the transaction to abort it and carry the counts out to
  // the 409 response. Reclassifying blocked people is a manual, per-member edit
  // today; a bulk age-tier reclassify tool could be a future convenience but is
  // deliberately out of scope for #2009.
  class TierRemovalBlockedError extends Error {
    constructor(
      readonly activeMembers: number,
      readonly archivedMembers: number,
      readonly liveGuests: number,
    ) {
      super("age tier removal blocked");
    }
  }

  // `BookingGuest.stayEnd` is `@db.Date`, so the cut-off has to be a date-only value
  // from the club's calendar (#2838; INV-DATE-013). The old `new Date()` +
  // `setHours(0, 0, 0, 0)` was NZ-LOCAL midnight — the PREVIOUS UTC day under the
  // `TZ=Pacific/Auckland` server pin — which the pg adapter narrows to D-1, so a guest
  // whose stay ended YESTERDAY was still counted as live and could block a tier removal
  // for an extra day. That erred towards refusing, never towards deleting a tier someone
  // still classifies into, so it was a spurious block rather than an unsafe allow — but
  // the cut-off is now the day it says it is. The day now comes from the PERSISTED club
  // timezone (CT-4, #2870; INV-CONFIG-002), re-encoded to UTC midnight because that is
  // the only bound shape a `@db.Date` column accepts. Resolved BEFORE the transaction
  // opens, so a settings read never runs on a second connection inside a write tx —
  // and only for a save that actually DROPS a tier, because an ordinary settings PUT
  // never reaches the count and should not pay for the club-settings read.
  const liveGuestCutOff =
    removedTiers.length > 0 ? await clubTodayDateOnlyInstant() : null;

  try {
    await prisma.$transaction(async (tx) => {
      // Non-null exactly when `removedTiers` is non-empty — the same test, one
      // scope out, which is what resolved the cut-off in the first place.
      if (liveGuestCutOff !== null) {
        const [activeMembers, archivedMembers, liveGuests] = await Promise.all([
          tx.member.count({
            where: { ageTier: { in: removedTiers }, archivedAt: null },
          }),
          tx.member.count({
            where: { ageTier: { in: removedTiers }, archivedAt: { not: null } },
          }),
          tx.bookingGuest.count({
            where: { ageTier: { in: removedTiers }, stayEnd: { gte: liveGuestCutOff } },
          }),
        ]);
        if (activeMembers + archivedMembers > 0 || liveGuests > 0) {
          throw new TierRemovalBlockedError(
            activeMembers,
            archivedMembers,
            liveGuests,
          );
        }
        // Guarded above, in-tx: no person is classified into these tiers, so
        // the row can go. (It used to cascade Xero group aliases via
        // AgeTierXeroAcceptedContactGroup; that table was dropped by the E13
        // contract migration 20260720120000 in v0.12.2 — #1939.)
        await tx.ageTierSetting.deleteMany({
          where: { tier: { in: removedTiers } },
        });
      }

      for (const s of normalizedSettings) {
        await tx.ageTierSetting.upsert({
          where: { tier: s.tier },
          update: {
            minAge: s.minAge,
            maxAge: s.maxAge,
            label: s.label,
            subscriptionRequiredForBooking: s.subscriptionRequiredForBooking,
            familyGroupRequestCreateMemberAllowed:
              s.familyGroupRequestCreateMemberAllowed,
            sortOrder: s.sortOrder,
          },
          create: {
            tier: s.tier,
            minAge: s.minAge,
            maxAge: s.maxAge,
            label: s.label,
            subscriptionRequiredForBooking: s.subscriptionRequiredForBooking,
            familyGroupRequestCreateMemberAllowed:
              s.familyGroupRequestCreateMemberAllowed,
            sortOrder: s.sortOrder,
          },
          // Blue/green runtime-prep (#2130): without a `select` Prisma emits
          // RETURNING over every scalar, which is how the legacy
          // xeroContactGroupId/Name columns kept being named right up to the
          // STEP 2 contract migration that dropped them. The result
          // is discarded here (the route re-reads the full set below), so the
          // minimal `tier` projection matches config-self-heal.ts.
          select: { tier: true },
        });
      }
    });
  } catch (error) {
    if (error instanceof TierRemovalBlockedError) {
      const plural = removedTiers.length > 1;
      const totalMembers = error.activeMembers + error.archivedMembers;
      return NextResponse.json(
        {
          error:
            `Cannot remove age tier${plural ? "s" : ""} ${removedTiers.join(", ")}: ` +
            `${totalMembers} member(s) (including ${error.archivedMembers} archived) ` +
            `and ${error.liveGuests} current or upcoming booking guest(s) are still ` +
            `classified into ${plural ? "them" : "it"}. Open each affected member's ` +
            `page and change their age tier or date of birth so they map to a tier ` +
            `you are keeping (and reduce the guests on any upcoming bookings), then ` +
            `save again.`,
          removedTiers,
          activeMembers: error.activeMembers,
          archivedMembers: error.archivedMembers,
          liveGuests: error.liveGuests,
        },
        { status: 409 },
      );
    }
    throw error;
  }

  // Invalidate cache so next computeAgeTier reads fresh values
  invalidateAgeTierCache();

  await logAudit({
    action: "AGE_TIER_SETTINGS_UPDATED",
    category: "booking",
    memberId: session.user.id,
    details: JSON.stringify({ settings: normalizedSettings, removedTiers }),
  });

  const updated = await prisma.ageTierSetting.findMany({
    orderBy: { sortOrder: "asc" },
    select: {
      tier: true,
      minAge: true,
      maxAge: true,
      label: true,
      subscriptionRequiredForBooking: true,
      familyGroupRequestCreateMemberAllowed: true,
      sortOrder: true,
    },
  });

  revalidatePublicPageContent();
  return NextResponse.json({ settings: normalizeAgeTierSettings(updated) });
}
