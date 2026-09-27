import { NextRequest, NextResponse } from "next/server"
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"
import {
  auditLateCaptureSettingChange,
  checkLateCaptureSettingChange,
  LATE_CAPTURE_SETTING_NEEDS_FINANCE_MESSAGE,
} from "@/lib/late-capture-refund-setting-change"
import { normalizeCancellationRule } from "@/lib/cancellation-rules"
import {
  clubWideDefaults,
  policySchema,
} from "@/lib/booking-policy-cancellation-schema"
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation"

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
    ...clubWideDefaults(defaults),
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
    lateCaptureRefundNeedsApproval,
    lodgeId,
  } = parsed.data

  // #3639 review F2: changing the late-capture refund choice needs finance:edit.
  const lateCapture = await checkLateCaptureSettingChange(session.user, lateCaptureRefundNeedsApproval)
  if (lateCapture.refused) {
    return NextResponse.json({ error: LATE_CAPTURE_SETTING_NEEDS_FINANCE_MESSAGE }, { status: 403 })
  }

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
      linkedMoveChargesBothChangeFees !== undefined ||
      lateCaptureRefundNeedsApproval !== undefined
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
          ...(lateCaptureRefundNeedsApproval !== undefined
            ? { lateCaptureRefundNeedsApproval }
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
          ...(lateCaptureRefundNeedsApproval !== undefined
            ? { lateCaptureRefundNeedsApproval }
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
      ...clubWideDefaults(defaults),
    }
  }, { isolationLevel: "Serializable" })

  logAudit({
    action: "cancellation-policy.update",
    category: "booking",
    memberId: session.user.id,
    details: `Updated to ${sortedRules.length} rules, holdEnabled=${nonMemberHoldEnabled ?? "unchanged"}, holdDays=${nonMemberHoldDays ?? "unchanged"}, waitlistOrder=${waitlistCrossLodgeOrder ?? "unchanged"}, linkedMoveBothFees=${linkedMoveChargesBothChangeFees ?? "unchanged"}, lateCaptureNeedsApproval=${lateCaptureRefundNeedsApproval ?? "unchanged"}, lodge=${lodgeId ?? "club-wide"}`,
  })

  if (lateCapture.changing) {
    auditLateCaptureSettingChange({ actorMemberId: session.user.id, before: lateCapture.before, after: !lateCapture.before })
  }
  revalidatePublicPageContent()
  return NextResponse.json(result)
}
