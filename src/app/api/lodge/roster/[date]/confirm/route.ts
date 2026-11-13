import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth, kioskLodgeAuthErrorResponse, resolveKioskLodgeId } from "@/lib/lodge-auth";
import { parseDateOnly } from "@/lib/date-only";
import { validateRosterAllocationsForDate } from "@/lib/lodge-date-scoping";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import logger from "@/lib/logger";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";
import { lockRosterEligibilityMutation } from "@/lib/roster-lock";
import { dateOnlyStringSchema } from "@/lib/date-only-schema";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";

const allocationSchema = z.object({
  choreTemplateId: z.string().min(1),
  bookingGuestId: z.string().min(1),
  bookingId: z.string().min(1),
});

const bodySchema = z.object({
  allocations: z.array(allocationSchema).min(1),
  overwrite: z.boolean().optional(),
});

/**
 * POST /api/lodge/roster/[date]/confirm
 * Saves the final roster with status CONFIRMED.
 * If overwrite=true, deletes existing assignments first.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { date: dateStr } = await params;

  const authResult = await checkLodgeAuth(dateStr, { request: req });
  const { error, status, tier } = authResult;
  if (error) {
    return NextResponse.json({ error }, { status: status! });
  }

  // Roster confirmation requires hut-leader or admin tier
  if (tier !== "admin" && tier !== "hut-leader") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!dateOnlyStringSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }

  const date = parseDateOnly(dateStr);
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const lodgeId = await resolveKioskLodgeId(authResult, prisma);

    const result = await prisma.$transaction(async (tx) => {
      await lockRosterEligibilityMutation(tx, lodgeId, date);
      const allocationsAreValid = await validateRosterAllocationsForDate(
        parsed.data.allocations,
        date,
        lodgeId,
        tx,
      );
      if (!allocationsAreValid) return { invalid: "guest" as const };

      const templateIds = [...new Set(parsed.data.allocations.map((a) => a.choreTemplateId))];
      const templateCount = await tx.choreTemplate.count({
        where: {
          id: { in: templateIds },
          active: true,
          ...lodgeNullTolerantScope(lodgeId),
        },
      });
      if (templateCount !== templateIds.length) return { invalid: "template" as const };

      const existingConfirmed = await tx.choreAssignment.count({
        where: {
          date,
          status: { in: ["CONFIRMED", "COMPLETED"] },
          booking: lodgeNullTolerantScope(lodgeId),
          choreTemplate: lodgeNullTolerantScope(lodgeId),
        },
      });
      if (existingConfirmed > 0 && !parsed.data.overwrite) {
        return { conflict: true as const };
      }

      if (parsed.data.overwrite) {
        await tx.choreAssignment.deleteMany({
          where: {
            date,
            booking: lodgeNullTolerantScope(lodgeId),
            choreTemplate: lodgeNullTolerantScope(lodgeId),
          },
        });
      } else {
        // Delete only SUGGESTED ones
        await tx.choreAssignment.deleteMany({
          where: {
            date,
            status: "SUGGESTED",
            booking: lodgeNullTolerantScope(lodgeId),
            choreTemplate: lodgeNullTolerantScope(lodgeId),
          },
        });
      }

      await tx.choreAssignment.createMany({
        data: parsed.data.allocations.map((a) => ({
          choreTemplateId: a.choreTemplateId,
          bookingGuestId: a.bookingGuestId,
          bookingId: a.bookingId,
          date,
          status: "CONFIRMED" as const,
        })),
      });
      return { success: true as const };
    }, LOCK1_HOLDER_TRANSACTION_BUDGET);

    if ("invalid" in result) {
      return NextResponse.json(
        {
          code: result.invalid === "guest" ? "ROSTER_GUEST_INELIGIBLE" : "ROSTER_TEMPLATE_INVALID",
          error: result.invalid === "guest"
            ? "Allocations must reference eligible guests staying on this date for the matching booking and lodge"
            : "Allocations must reference active chores for this lodge",
        },
        { status: 400 },
      );
    }
    if ("conflict" in result) {
      return NextResponse.json(
        { error: "Roster already confirmed. Set overwrite=true to replace." },
        { status: 409 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    // The write is one lock(1) transaction (INV-LOCK-005).
    const contended = transactionContendedResponse(
      err,
      "Lodge roster confirm contended for the lock(1) budget",
      { context: { date: dateStr } },
    );
    if (contended) return contended;
    const denied = kioskLodgeAuthErrorResponse(err);
    if (denied) return denied;
    logger.error({ err }, "Error confirming roster");
    return NextResponse.json({ error: "Failed to confirm roster" }, { status: 500 });
  }
}
