import { DEFAULT_BOOKING_DEFAULTS } from "@/config/club-settings-defaults"
import { NextRequest, NextResponse } from "next/server"
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { logAudit } from "@/lib/audit"
import { normalizeCancellationRule } from "@/lib/cancellation-rules"
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation"

const policySchema = z
  .object({
    rules: z.array(
      z.object({
        daysBeforeStay: z.number().int().min(0),
        refundPercentage: z.number().int().min(0).max(100),
        creditRefundPercentage: z.number().int().min(0).max(100).optional(),
        fixedFeeCents: z.number().int().min(0).optional(),
        creditFixedFeeCents: z.number().int().min(0).optional(),
      })
    ),
    nonMemberHoldEnabled: z.boolean().optional(),
    nonMemberHoldDays: z.number().int().min(1).max(365).optional(),
    // Cross-lodge waitlist queue order (ADR-004 owner decision 1).
    // Club-wide, like hold days: queue fairness is a club policy.
    waitlistCrossLodgeOrder: z.enum(["OWN_LODGE_FIRST", "MERGED"]).optional(),
    // #3232 D2: whether the LINKED MOVE charges the change fee on both bookings.
    // Club-wide like the two above, and for the same kind of reason: the change-fee
    // TIERS price a lodge's own cancellation risk and are per lodge, but whether a
    // second fee is fair when the club's own supervision rule compelled the move is
    // a question about how the club treats its members, which does not differ
    // between its lodges.
    linkedMoveChargesBothChangeFees: z.boolean().optional(),
    // Per-lodge override partition (ADR-001 resolved question 3). Omitted =
    // the club-wide (null lodgeId) rules. A lodge's rows REPLACE the
    // club-wide set at runtime; an empty rules array for a lodge removes the
    // override so the lodge reverts to club-wide.
    lodgeId: z.string().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.lodgeId && data.rules.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rules"],
        message: "At least one rule is required",
      })
    }
    if (data.lodgeId && data.nonMemberHoldDays !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nonMemberHoldDays"],
        message: "Hold days are club-wide and cannot be set per lodge",
      })
    }
    if (data.lodgeId && data.nonMemberHoldEnabled !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nonMemberHoldEnabled"],
        message: "Hold enablement is club-wide and cannot be set per lodge",
      })
    }
    if (data.lodgeId && data.waitlistCrossLodgeOrder !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["waitlistCrossLodgeOrder"],
        message: "Waitlist queue order is club-wide and cannot be set per lodge",
      })
    }
    if (data.lodgeId && data.linkedMoveChargesBothChangeFees !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["linkedMoveChargesBothChangeFees"],
        message:
          "The linked-move change-fee setting is club-wide and cannot be set per lodge",
      })
    }
  })

export async function GET(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;
  // Exact partition, not null-tolerant: null rows are the club-wide rules
  // and a lodge's rows are its override set (replace, never merge).
  const lodgeId = req.nextUrl.searchParams.get("lodgeId")
  const policies = await prisma.cancellationPolicy.findMany({
    where: { lodgeId: lodgeId ?? null },
    orderBy: { daysBeforeStay: "desc" },
  })

  const defaults = await prisma.bookingDefaults.findUnique({
    where: { id: "default" },
  })

  return NextResponse.json({
    rules: policies.map(normalizeCancellationRule),
    nonMemberHoldEnabled: defaults?.nonMemberHoldEnabled ?? true,
    nonMemberHoldDays: defaults?.nonMemberHoldDays ?? 7,
    waitlistCrossLodgeOrder: defaults?.waitlistCrossLodgeOrder ?? "OWN_LODGE_FIRST",
    // #3232: absent row means the effective default, which is `true` — charge
    // both. A club that has never opened this page has not chosen to waive
    // anything. Read from the one home rather than restated (`INV-SSOT-001`).
    linkedMoveChargesBothChangeFees:
      defaults?.linkedMoveChargesBothChangeFees ??
      DEFAULT_BOOKING_DEFAULTS.linkedMoveChargesBothChangeFees,
    lodgeId: lodgeId ?? null,
  })
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const body = await req.json()
  const parsed = policySchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const {
    rules,
    nonMemberHoldEnabled,
    nonMemberHoldDays,
    waitlistCrossLodgeOrder,
    linkedMoveChargesBothChangeFees,
    lodgeId,
  } = parsed.data

  if (lodgeId) {
    const lodge = await prisma.lodge.findUnique({
      where: { id: lodgeId },
      select: { id: true, active: true },
    })
    if (!lodge || !lodge.active) {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 }
      )
    }
  }

  // Validate: days must be unique
  const sortedRules = [...rules]
    .map(normalizeCancellationRule)
    .sort((a, b) => b.daysBeforeStay - a.daysBeforeStay)
  const dayValues = sortedRules.map((r) => r.daysBeforeStay)
  if (new Set(dayValues).size !== dayValues.length) {
    return NextResponse.json(
      { error: "Each rule must have a unique number of days" },
      { status: 400 }
    )
  }

  // Replace the partition's rules atomically and update defaults. Scoping
  // the delete to one partition means editing the club-wide rules never
  // touches a lodge's override set and vice versa. Serializable isolation
  // keeps the replace race-free; the club-wide partition's uniqueness is
  // also DB-enforced by the CancellationPolicy_clubwide_daysBeforeStay_unique
  // partial index (WHERE "lodgeId" IS NULL, migration 20260709000100 —
  // PostgreSQL treats nulls as distinct under [lodgeId, daysBeforeStay]).
  const result = await prisma.$transaction(async (tx) => {
    await tx.cancellationPolicy.deleteMany({
      where: { lodgeId: lodgeId ?? null },
    })
    await tx.cancellationPolicy.createMany({
      data: sortedRules.map((rule) => ({
        daysBeforeStay: rule.daysBeforeStay,
        refundPercentage: rule.refundPercentage,
        creditRefundPercentage: rule.creditRefundPercentage,
        fixedFeeCents: rule.fixedFeeCents,
        creditFixedFeeCents: rule.creditFixedFeeCents,
        lodgeId: lodgeId ?? null,
      })),
    })

    if (
      nonMemberHoldDays !== undefined ||
      nonMemberHoldEnabled !== undefined ||
      waitlistCrossLodgeOrder !== undefined ||
      linkedMoveChargesBothChangeFees !== undefined
    ) {
      await tx.bookingDefaults.upsert({
        where: { id: "default" },
        update: {
          ...(nonMemberHoldEnabled !== undefined ? { nonMemberHoldEnabled } : {}),
          ...(nonMemberHoldDays !== undefined ? { nonMemberHoldDays } : {}),
          ...(waitlistCrossLodgeOrder !== undefined ? { waitlistCrossLodgeOrder } : {}),
          ...(linkedMoveChargesBothChangeFees !== undefined
            ? { linkedMoveChargesBothChangeFees }
            : {}),
        },
        create: {
          id: "default",
          nonMemberHoldEnabled: nonMemberHoldEnabled ?? true,
          nonMemberHoldDays: nonMemberHoldDays ?? 7,
          ...(waitlistCrossLodgeOrder !== undefined ? { waitlistCrossLodgeOrder } : {}),
          // #3232: only when the request said so, so an unrelated save of the
          // cancellation rules cannot stamp a decision this club never made — the
          // schema default supplies `true` on a create that omits it.
          ...(linkedMoveChargesBothChangeFees !== undefined
            ? { linkedMoveChargesBothChangeFees }
            : {}),
        },
      })
    }

    const policies = await tx.cancellationPolicy.findMany({
      where: { lodgeId: lodgeId ?? null },
      orderBy: { daysBeforeStay: "desc" },
    })

    const defaults = await tx.bookingDefaults.findUnique({
      where: { id: "default" },
    })

    return {
      rules: policies.map(normalizeCancellationRule),
      nonMemberHoldEnabled: defaults?.nonMemberHoldEnabled ?? true,
      nonMemberHoldDays: defaults?.nonMemberHoldDays ?? 7,
      waitlistCrossLodgeOrder: defaults?.waitlistCrossLodgeOrder ?? "OWN_LODGE_FIRST",
      linkedMoveChargesBothChangeFees:
        defaults?.linkedMoveChargesBothChangeFees ??
        DEFAULT_BOOKING_DEFAULTS.linkedMoveChargesBothChangeFees,
    }
  }, { isolationLevel: "Serializable" })

  logAudit({
    action: "cancellation-policy.update",
    category: "booking",
    memberId: session.user.id,
    details: `Updated to ${sortedRules.length} rules, holdEnabled=${nonMemberHoldEnabled ?? "unchanged"}, holdDays=${nonMemberHoldDays ?? "unchanged"}, waitlistOrder=${waitlistCrossLodgeOrder ?? "unchanged"}, linkedMoveBothFees=${linkedMoveChargesBothChangeFees ?? "unchanged"}, lodge=${lodgeId ?? "club-wide"}`,
  })

  revalidatePublicPageContent()
  return NextResponse.json(result)
}
