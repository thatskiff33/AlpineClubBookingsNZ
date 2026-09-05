import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-booking-payment";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { recordedNightPricesSchema } from "@/lib/stored-night-price-repair";
import {
  planStrandNightPriceReconcile,
  recordStrandNightPriceReconcile,
} from "@/lib/stored-night-price-strand-reconcile";

/**
 * #3214 (epic #2797): an officer records what one guest strand's nights sold
 * for, on a booking whose stored evidence cannot be read back.
 *
 * ## What this route is, in one sentence
 *
 * It writes the amounts a person typed onto the nights a strand already holds,
 * fenced so those amounts must come to what the stay is ALREADY stored as being
 * worth - which makes the strand's total write provably a no-op, so the act can
 * turn an unreadable strand into a readable one and can do nothing else. The
 * rule, the fence and the reasoning live in
 * `stored-night-price-strand-reconcile.ts` and `stored-night-price-repair.ts`;
 * nothing here restates them (`INV-SSOT`).
 *
 * ## Why it is FINANCE and not bookings
 *
 * The path prefix says bookings and the act is money, exactly as B5's
 * `mark-paid` sibling is - so it is gated `finance:edit` and
 * `SPECIAL_ROUTE_AREA_PATTERNS` resolves the path the same way, which is what
 * keeps the declared gate and the inferred one from disagreeing.
 *
 * IT TAKES TWO TESTS TO PIN THAT AGREEMENT, one per side, and neither can stand
 * in for the other. `admin-route-area-matrix.test.ts` pins the INFERRED side: it
 * resolves this path through `getAdminRouteRequirement()` against a frozen
 * snapshot, and never reads what this handler passes to `requireAdmin`.
 * `admin-booking-stored-night-prices-route.test.ts` pins the DECLARED side, by
 * asserting the argument this handler actually calls `requireAdmin` with. Trim
 * either and the two sides can drift apart in silence.
 *
 * ## What it deliberately does not do
 *
 * It contains no arithmetic at all: it parses, calls the plan, calls the write,
 * and answers. `stored-night-price-repair-census.test.ts` scans this file for a
 * division, a rounding, a split helper or a defaulted zero, which is a fence
 * this route has to pass for the same reason the screen does - a remainder fill
 * posts a complete, reconciling vector the checker is obliged to accept, so the
 * only place it can be stopped is where it would be written.
 */

const bodySchema = z
  .object({
    /**
     * WHICH STRAND, named by the browser and re-scoped by the server.
     *
     * The finance queue's payload deliberately redacts this id, because a
     * finance-only admin there may never be able to open the booking. Here the
     * caller is on the booking's own page and already sees every guest by name,
     * so naming the strand is both correct and necessary - and the plan re-reads
     * it `where: { id, bookingId }`, so a strand belonging to some other booking
     * is a 404 that writes nothing and reveals nothing.
     */
    bookingGuestId: z.string().min(1),
    /** The shared wire shape, verbatim (`INV-SSOT`). */
    nightPrices: recordedNightPricesSchema,
    note: z.string().max(MANUAL_PAYMENT_NOTE_MAX).optional().nullable(),
    /**
     * Explicit confirmation, matching the settle route: recording what a stay
     * sold for is never a single-click accident.
     */
    confirmed: z.literal(true),
  })
  .strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid night-price request.",
        details: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  try {
    /*
      ONE TRANSACTION: plan, write, audit. The plan's re-reads have to see the
      same rows the write fences against, or the compare-and-set is comparing
      against a world that has already moved. No advisory lock is taken - the
      fences ARE the single-flight guarantee here, and
      `docs/CONCURRENCY_AND_LOCKING.md` records why.
    */
    await prisma.$transaction(async (tx) => {
      const plan = await planStrandNightPriceReconcile({
        bookingId: id,
        bookingGuestId: parsed.data.bookingGuestId,
        entries: parsed.data.nightPrices,
        store: tx,
      });
      await recordStrandNightPriceReconcile({
        plan,
        actingMemberId: guard.session.user.id,
        note: parsed.data.note ?? null,
        store: tx,
      });
    });
  } catch (err) {
    if (err instanceof ManualBookingPaymentError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error(
      { err, bookingId: id },
      "Failed to record what a booking guest's nights sold for",
    );
    return NextResponse.json(
      {
        error:
          "Those night prices could not be recorded. Nothing was changed. Reload the page and try again.",
      },
      { status: 500 },
    );
  }

  revalidatePath("/bookings/[id]", "page");
  return NextResponse.json({
    message:
      "Recorded what those nights sold for. What the stay is worth is unchanged.",
  });
}
