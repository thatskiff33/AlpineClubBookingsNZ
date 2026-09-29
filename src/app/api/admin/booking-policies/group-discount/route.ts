import { NextRequest, NextResponse } from "next/server";
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { getDefaultLodgeCapacity } from "@/lib/lodge-capacity";
import { DEFAULT_GROUP_DISCOUNT_SETTING } from "@/config/club-settings-defaults";
import {
  DEFAULT_LODGE_NOT_SET_UP_FOR_BOOKINGS_MESSAGE,
  lodgeGuestLimitMessage,
} from "@/lib/lodge-booking-readiness";

const groupDiscountSchema = z.object({
  minGroupSize: z.number().int().min(2).max(200),
  summerOnly: z.boolean(),
  enabled: z.boolean(),
  // #2770 (INV-MOD-026): whether a later edit earns the discount on the nights
  // it newly buys.
  //
  // OPTIONAL, and the failure modes are why. A body that predates the column —
  // an admin tab left open across the deploy, or any scripted caller — would be
  // rejected outright by a required field, losing the whole policy save over a
  // key it has never heard of. Optional cannot silently re-arm the switch
  // either: `update` is `parsed.data`, and an absent optional key is simply not
  // in that object, so Prisma leaves the column exactly as the club set it. On
  // `create` the column's own `@default(true)` applies. Absent therefore means
  // "do not touch this", which is the strictly safer of the two behaviours for a
  // field that decides what a member is charged.
  //
  // Note the deliberate asymmetry with `EditTimeGroupDiscountSettingLike`, where
  // the same field is REQUIRED: there it is being READ to price a booking, and an
  // absent value would silently withhold a discount the club left on. Here it is
  // being WRITTEN, and absent means unchanged.
  applyToEdits: z.boolean().optional(),
});

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;
  const setting = await prisma.groupDiscountSetting.findUnique({
    where: { id: "default" },
  });

  // `configured` reports whether a row is actually PERSISTED, because the body
  // below is SYNTHESISED from the built-in defaults when it is not (#2142).
  // Without it the admin card cannot tell the two apart: its draft would equal
  // its snapshot on a club that has never saved this policy, so the #2143 dirty
  // gate would leave Save permanently greyed out and creating the row would be
  // unreachable. Creating the row is a real event, so the audit entry the PUT
  // then writes is accurate — it is a no-op re-PUT of an EXISTING row that
  // #2143 rules out, not the first save.
  return NextResponse.json(
    setting
      ? { ...setting, configured: true }
      : {
          id: "default",
          ...DEFAULT_GROUP_DISCOUNT_SETTING,
          configured: false,
        },
  );
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const body = await req.json();
  const parsed = groupDiscountSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const lodgeCapacity = await getDefaultLodgeCapacity();
  if (parsed.data.minGroupSize > lodgeCapacity) {
    return NextResponse.json(
      {
        error: lodgeGuestLimitMessage(
          lodgeCapacity,
          (limit) => `Minimum group size cannot exceed lodge capacity (${limit}).`,
          DEFAULT_LODGE_NOT_SET_UP_FOR_BOOKINGS_MESSAGE,
        ),
      },
      { status: 400 },
    );
  }

  // The substitution target a qualifying discount applies to true non-members
  // (#1930, E4). A row created here (post-migration) must not carry a NULL
  // target — that would leave the discount inert but for the read-time
  // fallback — so seed it to the built-in FULL type, exactly like the
  // migration backfill. An admin-configured non-null target is never
  // overwritten; an existing NULL is healed in place.
  const fullType = await prisma.membershipType.findFirst({
    where: { key: "FULL" },
    select: { id: true },
  });
  const result = await prisma.groupDiscountSetting.upsert({
    where: { id: "default" },
    update: parsed.data,
    create: {
      id: "default",
      ...parsed.data,
      rateMembershipTypeId: fullType?.id ?? null,
    },
  });
  if (result.rateMembershipTypeId === null && fullType) {
    const healed = await prisma.groupDiscountSetting.update({
      where: { id: "default" },
      data: { rateMembershipTypeId: fullType.id },
    });
    result.rateMembershipTypeId = healed.rateMembershipTypeId;
  }

  logAudit({
    action: "group-discount.update",
    category: "booking",
    memberId: session.user.id,
    entityType: "GroupDiscountSetting",
    entityId: result.id,
    // `result.applyToEdits`, not `parsed.data.applyToEdits`: the field is
    // optional, so a body that omitted it would log `undefined` for a column that
    // in fact still holds the club's answer. The audit line states what is now
    // PERSISTED (#2770).
    details: `Group discount: minSize=${parsed.data.minGroupSize}, summerOnly=${parsed.data.summerOnly}, enabled=${parsed.data.enabled}, applyToEdits=${result.applyToEdits}`,
  });

  revalidatePublicPageContent();
  return NextResponse.json(result);
}
